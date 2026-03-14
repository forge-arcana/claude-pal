// Project:   Claude Pal
// File:      claudeDataLoader.js
// Purpose:   Parse Claude Code JSONL files for token usage
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { getTokenLimit, TIMEOUTS, splitLines } = require('./utils');

class ClaudeDataLoader {
    constructor(workspacePath = null, debugLogger = null) {
        this.claudeConfigPaths = this.getClaudeConfigPaths();
        this.workspacePath = workspacePath;
        this.projectDirName = workspacePath ? this.convertPathToClaudeDir(workspacePath) : null;
        this.log = debugLogger || console.log.bind(console);
        this.log(`ClaudeDataLoader initialised with workspace: ${workspacePath || '(none)'}`);
        if (this.projectDirName) {
            this.log(`   Looking for project dir: ${this.projectDirName}`);
        }
    }

    // Claude replaces path separators with dashes in directory names
    // Works for both Unix (/) and Windows (\) paths
    convertPathToClaudeDir(workspacePath) {
        // Replace both forward and back slashes with dashes
        // Also handle Windows drive letters (C: -> C)
        return workspacePath
            .replace(/\\/g, '-')  // Windows backslashes
            .replace(/\//g, '-')  // Unix forward slashes
            .replace(/:/g, '');   // Remove colons from Windows drive letters
    }

    setWorkspacePath(workspacePath) {
        this.workspacePath = workspacePath;
        this.projectDirName = workspacePath ? this.convertPathToClaudeDir(workspacePath) : null;
        this.log(`ClaudeDataLoader workspace set to: ${workspacePath}`);
        this.log(`   Project dir name: ${this.projectDirName}`);
    }

    async getProjectDataDirectory() {
        if (!this.projectDirName) {
            this.log('No workspace path set, falling back to global search');
            return null;
        }

        const baseDir = await this.findClaudeDataDirectory();
        if (!baseDir) {
            return null;
        }

        const projectDir = path.join(baseDir, this.projectDirName);
        try {
            const stat = await fs.stat(projectDir);
            if (stat.isDirectory()) {
                this.log(`Found project-specific directory: ${projectDir}`);
                return projectDir;
            }
        } catch (error) {
            this.log(`Project directory not found: ${projectDir}`);
        }

        return null;
    }

    getClaudeConfigPaths() {
        const paths = [];
        const homeDir = os.homedir();

        const envPath = process.env.CLAUDE_CONFIG_DIR;
        if (envPath) {
            paths.push(...envPath.split(',').map(p => p.trim()));
        }

        // Standard locations (cross-platform)
        paths.push(path.join(homeDir, '.config', 'claude', 'projects'));
        paths.push(path.join(homeDir, '.claude', 'projects'));

        // Windows-specific: AppData and Program Files locations
        if (process.platform === 'win32') {
            const appData = process.env.APPDATA;
            const localAppData = process.env.LOCALAPPDATA;
            const programData = process.env.ProgramData || 'C:\\ProgramData';
            if (appData) {
                paths.push(path.join(appData, 'claude', 'projects'));
                paths.push(path.join(appData, 'Claude', 'projects'));
            }
            if (localAppData) {
                paths.push(path.join(localAppData, 'claude', 'projects'));
                paths.push(path.join(localAppData, 'Claude', 'projects'));
            }
            // New Anthropic path (March 2026+)
            paths.push('C:\\Program Files\\ClaudeCode\\projects');
            // Legacy enterprise managed path
            paths.push(path.join(programData, 'ClaudeCode', 'projects'));
        }

        return paths;
    }

    async findClaudeDataDirectory() {
        for (const dirPath of this.claudeConfigPaths) {
            try {
                const stat = await fs.stat(dirPath);
                if (stat.isDirectory()) {
                    this.log(`Found Claude data directory: ${dirPath}`);
                    return dirPath;
                }
            } catch (error) {
                continue;
            }
        }
        console.warn('Could not find Claude data directory in any standard location');
        return null;
    }

    async findJsonlFiles(dirPath) {
        const jsonlFiles = [];

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    const subFiles = await this.findJsonlFiles(fullPath);
                    jsonlFiles.push(...subFiles);
                } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    jsonlFiles.push(fullPath);
                }
            }
        } catch (error) {
            console.error(`Error reading directory ${dirPath}:`, error.message);
        }

        return jsonlFiles;
    }

    // Extract cache_read from most recent assistant message as session context size
    // Only searches project-specific directory when workspace is set to avoid cross-project data
    async getCurrentSessionUsage() {
        this.log('getCurrentSessionUsage() - extracting cache size from most recent message');
        this.log(`   this.projectDirName = ${this.projectDirName}`);
        this.log(`   this.workspacePath = ${this.workspacePath}`);

        const sessionStart = Date.now() - TIMEOUTS.SESSION_DURATION;

        let dataDir;
        let isProjectSpecific = false;

        if (this.projectDirName) {
            dataDir = await this.getProjectDataDirectory();
            isProjectSpecific = !!dataDir;
            this.log(`   Project-specific dataDir = ${dataDir}`);

            if (!dataDir) {
                this.log(`Project directory not found for: ${this.projectDirName}`);
                this.log('   Not falling back to global search to avoid cross-project data');
                return {
                    totalTokens: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreationTokens: 0,
                    cacheReadTokens: 0,
                    messageCount: 0,
                    isActive: false
                };
            }
        } else {
            this.log('   No projectDirName set, using global search');
            dataDir = await this.findClaudeDataDirectory();
        }

        if (!dataDir) {
            this.log('Claude data directory not found');
            return {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                messageCount: 0,
                isActive: false
            };
        }

        try {
            const allJsonlFiles = await this.findJsonlFiles(dataDir);
            this.log(`Found ${allJsonlFiles.length} JSONL files in ${isProjectSpecific ? 'project' : 'global'} directory`);

            // Filter to main session files (UUID format), excluding agent-* subprocesses
            const mainSessionFiles = allJsonlFiles.filter(filePath => {
                const filename = path.basename(filePath);
                if (filename.startsWith('agent-')) {
                    return false;
                }
                const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
                return uuidPattern.test(filename);
            });

            this.log(`Filtered to ${mainSessionFiles.length} main session files (excluding agent files)`);

            const recentFiles = [];
            for (const filePath of mainSessionFiles) {
                try {
                    const stats = await fs.stat(filePath);
                    if (stats.mtimeMs >= sessionStart) {
                        recentFiles.push({
                            path: filePath,
                            modified: stats.mtimeMs
                        });
                    }
                } catch (statError) {
                    continue;
                }
            }

            recentFiles.sort((a, b) => b.modified - a.modified);

            this.log(`Found ${recentFiles.length} main session file(s) modified in last hour`);

            if (recentFiles.length === 0) {
                this.log('No recently modified files - conversation may be inactive');
                return {
                    totalTokens: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreationTokens: 0,
                    cacheReadTokens: 0,
                    messageCount: 0,
                    isActive: false,
                    activeSessionCount: 0
                };
            }

            // Scan ALL recent session files and track the highest cache_read value
            // This handles multiple Claude Code sessions in the same project
            let highestCacheRead = 0;
            let highestCacheCreation = 0;
            let highestMessageCount = 0;
            let highestSessionFile = null;
            let activeSessionCount = 0;

            for (const fileInfo of recentFiles) {
                try {
                    const content = await fs.readFile(fileInfo.path, 'utf-8');
                    const lines = splitLines(content.trim());

                    // Parse from end to find last assistant message with cache data
                    for (let i = lines.length - 1; i >= 0; i--) {
                        try {
                            const entry = JSON.parse(lines[i]);

                            if (entry.type === 'assistant' && entry.message?.usage) {
                                const usage = entry.message.usage;
                                const cacheRead = usage.cache_read_input_tokens || 0;

                                if (cacheRead > 0) {
                                    activeSessionCount++;

                                    if (cacheRead > highestCacheRead) {
                                        highestCacheRead = cacheRead;
                                        highestCacheCreation = usage.cache_creation_input_tokens || 0;
                                        highestMessageCount = lines.length;
                                        highestSessionFile = path.basename(fileInfo.path);
                                    }
                                    break;
                                }
                            }
                        } catch (parseError) {
                            continue;
                        }
                    }
                } catch (readError) {
                    this.log(`Error reading ${path.basename(fileInfo.path)}: ${readError.message}`);
                    continue;
                }
            }

            if (highestCacheRead > 0) {
                this.log(`Found ${activeSessionCount} active session(s), showing highest usage:`);
                this.log(`   File: ${highestSessionFile}`);
                this.log(`   Cache creation: ${highestCacheCreation.toLocaleString()}`);
                this.log(`   Cache read: ${highestCacheRead.toLocaleString()}`);
                this.log(`   Session total (cache_read): ${highestCacheRead.toLocaleString()} tokens`);
                this.log(`   Percentage: ${((highestCacheRead / getTokenLimit()) * 100).toFixed(2)}%`);
            }

            return {
                totalTokens: highestCacheRead,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: highestCacheCreation,
                cacheReadTokens: highestCacheRead,
                messageCount: highestMessageCount,
                isActive: highestCacheRead > 0,
                activeSessionCount: activeSessionCount
            };

        } catch (error) {
            console.error(`Error getting current session usage: ${error.message}`);
            return {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                messageCount: 0,
                isActive: false,
                activeSessionCount: 0
            };
        }
    }

    // Get the current model and thinking state from the most recent main session
    async getCurrentModelInfo() {
        const sessionStart = Date.now() - TIMEOUTS.SESSION_DURATION;

        let dataDir;
        if (this.projectDirName) {
            dataDir = await this.getProjectDataDirectory();
            if (!dataDir) return null;
        } else {
            dataDir = await this.findClaudeDataDirectory();
        }
        if (!dataDir) return null;

        try {
            const allFiles = await this.findJsonlFiles(dataDir);
            const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
            const mainFiles = allFiles.filter(f => {
                const name = path.basename(f);
                return !name.startsWith('agent-') && uuidPattern.test(name);
            });

            // Find most recently modified file within session window
            let newest = null;
            let newestMtime = 0;
            for (const f of mainFiles) {
                try {
                    const s = await fs.stat(f);
                    if (s.mtimeMs > newestMtime && s.mtimeMs >= sessionStart) {
                        newest = f;
                        newestMtime = s.mtimeMs;
                    }
                } catch { continue; }
            }

            if (!newest) return null;

            const content = await fs.readFile(newest, 'utf-8');
            const lines = splitLines(content.trim());

            // Scan from end for the most recent assistant message with a model
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);
                    if (entry.type === 'assistant' && entry.message?.model) {
                        const hasThinking = Array.isArray(entry.message.content) &&
                            entry.message.content.some(b => b.type === 'thinking');
                        return {
                            model: entry.message.model,
                            hasThinking,
                        };
                    }
                } catch { continue; }
            }
        } catch (error) {
            this.log(`getCurrentModelInfo error: ${error.message}`);
        }

        return null;
    }

}

module.exports = { ClaudeDataLoader };
