// Project:   Claude Pal
// File:      utils.js
// Purpose:   Shared constants and utility functions
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const CONFIG_NAMESPACE = 'claudePal';

// Split text into lines, handling both Unix (\n) and Windows (\r\n) line endings
function splitLines(text) {
    return text.split(/\r?\n/);
}

// Command IDs (must match package.json contributes.commands)
const COMMANDS = {
    FETCH_NOW: 'claudePal.fetchNow',
    OPEN_SETTINGS: 'claudePal.openSettings',
    SHOW_DEBUG: 'claudePal.showDebug',
    CLEAR_SESSION: 'claudePal.clearSession',
    OPEN_BROWSER: 'claudePal.openBrowser',
    RESYNC_ACCOUNT: 'claudePal.resyncAccount',
    TOGGLE_SOUND: 'claudePal.toggleSound',
    SHOW_MENU: 'claudePal.showMenu',
};

// Cross-platform config directory following OS conventions
// macOS: ~/Library/Application Support/claude-pal
// Linux: ~/.config/claude-pal (XDG spec)
// Windows: %APPDATA%\claude-pal
function getConfigDir() {
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-pal');
    } else if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'claude-pal');
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-pal');
}

const CONFIG_DIR = getConfigDir();

const PATHS = {
    CONFIG_DIR: CONFIG_DIR,
    SESSION_COOKIE_FILE: path.join(CONFIG_DIR, 'session-cookie.json'),
};

// Claude Code default context window (tokens)
const DEFAULT_TOKEN_LIMIT = 200000;

// File-based debug logging with instance identification
// Each instance identified by short hash + project name for easy differentiation
let fileLoggerInstance = null;

class FileLogger {
    constructor(workspacePath = null) {
        this.workspacePath = workspacePath;
        this.instanceId = this.generateInstanceId(workspacePath);
        this.logFile = this.getLogFilePath();
        this.maxSizeBytes = this.getMaxSizeBytes();
    }

    getLogFilePath() {
        return path.join(PATHS.CONFIG_DIR, 'debug.log');
    }

    getMaxSizeBytes() {
        return THRESHOLDS.LOG_MAX_BYTES;
    }

    generateInstanceId(workspacePath) {
        if (!workspacePath) {
            return '[global]';
        }
        // Short hash (8 chars) + project name for identification
        const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 8);
        const projectName = path.basename(workspacePath);
        return `[${hash}:${projectName}]`;
    }

    trimIfNeeded() {
        try {
            if (!fs.existsSync(this.logFile)) return;

            const stats = fs.statSync(this.logFile);
            if (stats.size >= this.maxSizeBytes) {
                // FIFO trim: keep newest ~75% of max size, discard oldest entries
                const content = fs.readFileSync(this.logFile, 'utf-8');
                const lines = splitLines(content);
                const targetSize = Math.floor(this.maxSizeBytes * 0.75);

                // Find cut point to keep ~targetSize bytes from the end
                let keptSize = 0;
                let cutIndex = lines.length;
                for (let i = lines.length - 1; i >= 0; i--) {
                    keptSize += lines[i].length + 1; // +1 for newline
                    if (keptSize >= targetSize) {
                        cutIndex = i;
                        break;
                    }
                }

                const trimmedContent = lines.slice(cutIndex).join('\n');
                fs.writeFileSync(this.logFile, trimmedContent);
            }
        } catch (e) {
            // Ignore trim errors
        }
    }

    log(message) {
        if (!isDebugEnabled()) return;

        try {
            const dir = path.dirname(this.logFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            this.trimIfNeeded();

            const timestamp = new Date().toISOString();
            const line = `${timestamp} ${this.instanceId} ${message}\n`;
            fs.appendFileSync(this.logFile, line);
        } catch (e) {
            // Silently ignore write errors to avoid blocking
        }
    }

    clear() {
        try {
            if (fs.existsSync(this.logFile)) {
                fs.unlinkSync(this.logFile);
            }
        } catch (e) {
            // Ignore
        }
    }
}

function initFileLogger(workspacePath) {
    fileLoggerInstance = new FileLogger(workspacePath);
    return fileLoggerInstance;
}

function getFileLogger() {
    if (!fileLoggerInstance) {
        fileLoggerInstance = new FileLogger(null);
    }
    return fileLoggerInstance;
}

function fileLog(message) {
    getFileLogger().log(message);
}

const TIMEOUTS = {
    SESSION_DURATION: 3600000, // 1 hour
    STARTUP_DELAY: 2000,
    SERVICE_STATUS_REFRESH: 5 * 60 * 1000, // 5 minutes
    SERVICE_STATUS_CACHE_TTL: 60000, // 1 minute
    SERVICE_STATUS_REQUEST: 10000, // 10 seconds
    SOUND_PLAY: 5000,
};

const THRESHOLDS = {
    WARNING_PERCENT: 80,
    ERROR_PERCENT: 90,
    LOG_MAX_BYTES: 256 * 1024, // 256 KB
};

// Read version from package.json at module load time
const EXTENSION_VERSION = (() => {
    try { return require('../package.json').version; } catch { return '0.0.0'; }
})();

const CLAUDE_URLS = {
    BASE: 'https://claude.ai',
    LOGIN: 'https://claude.ai/login',
    USAGE: 'https://claude.ai/settings/usage',
    API_ORGS: 'https://claude.ai/api/organizations'
};

// Debug output channel (lazy initialised)
let debugChannel = null;
let runningInDevMode = false;

function setDevMode(isDev) {
    runningInDevMode = isDev;
}

function isDebugEnabled() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const userEnabled = config.get('debug', false);
    return userEnabled || runningInDevMode;
}

function getDebugChannel() {
    if (!debugChannel) {
        debugChannel = vscode.window.createOutputChannel('Claude Pal - API Debug');
    }
    return debugChannel;
}

function disposeDebugChannel() {
    if (debugChannel) {
        debugChannel.dispose();
        debugChannel = null;
    }
}

function getTokenLimit() {
    return DEFAULT_TOKEN_LIMIT;
}

// Format countdown string for status bar (e.g., "2h 15m", "5d 21h")
function calculateResetClockTime(resetTime) {
    try {
        const days = resetTime.match(/(\d+)d/);
        const hours = resetTime.match(/(\d+)h/);
        const minutes = resetTime.match(/(\d+)m/);

        const parts = [];
        if (days) parts.push(`${parseInt(days[1])}d`);
        if (hours) parts.push(`${parseInt(hours[1])}h`);
        if (minutes && !days) parts.push(`${parseInt(minutes[1])}m`);

        return parts.join(' ') || '0m';
    } catch (error) {
        return '??';
    }
}

// Full datetime format for tooltips (uses system locale)
function calculateResetClockTimeExpanded(resetTime) {
    try {
        const days = resetTime.match(/(\d+)d/);
        const hours = resetTime.match(/(\d+)h/);
        const minutes = resetTime.match(/(\d+)m/);

        let totalMinutes = 0;
        if (days) totalMinutes += parseInt(days[1]) * 24 * 60;
        if (hours) totalMinutes += parseInt(hours[1]) * 60;
        if (minutes) totalMinutes += parseInt(minutes[1]);

        const now = new Date();
        const resetDate = new Date(now.getTime() + totalMinutes * 60 * 1000);

        return resetDate.toLocaleString(undefined, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            hour: 'numeric',
            minute: '2-digit'
        });
    } catch (error) {
        return 'Unknown';
    }
}

function getCurrencySymbol(currency) {
    const symbols = {
        USD: '$',
        AUD: '$',
        CAD: '$',
        EUR: '€',
        GBP: '£',
        JPY: '¥',
        CNY: '¥',
        KRW: '₩',
        INR: '₹',
        BRL: 'R$',
        MXN: '$',
        CHF: 'CHF ',
        SEK: 'kr',
        NOK: 'kr',
        DKK: 'kr',
        NZD: '$',
        SGD: '$',
        HKD: '$',
    };
    return symbols[currency] || '';
}

// Format model ID to display name
// "claude-opus-4-6-20250901" → "Opus 4.6"
// "claude-sonnet-4-5-20250514" → "Sonnet 4.5"
// "claude-haiku-4-5-20251001" → "Haiku 4.5"
// "claude-3-5-sonnet-20241022" → "Sonnet 3.5" (old format)
function formatModelName(modelId) {
    if (!modelId) return null;
    // New format: claude-{family}-{major}-{minor}[-{date}]
    let match = modelId.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
    if (match) {
        const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
        return `${name} ${match[2]}.${match[3]}`;
    }
    // Old format: claude-{major}-{minor}-{family}[-{date}]
    match = modelId.match(/^claude-(\d+)-(\d+)-([a-z]+)/);
    if (match) {
        const name = match[3].charAt(0).toUpperCase() + match[3].slice(1);
        return `${name} ${match[1]}.${match[2]}`;
    }
    return modelId;
}

// Capitalize first letter
function capitalizeFirst(str) {
    if (!str) return null;
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

module.exports = {
    CONFIG_NAMESPACE,
    COMMANDS,
    PATHS,
    DEFAULT_TOKEN_LIMIT,
    TIMEOUTS,
    THRESHOLDS,
    CLAUDE_URLS,
    EXTENSION_VERSION,
    getTokenLimit,
    setDevMode,
    isDebugEnabled,
    getDebugChannel,
    disposeDebugChannel,
    calculateResetClockTime,
    calculateResetClockTimeExpanded,
    getCurrencySymbol,
    formatModelName,
    capitalizeFirst,
    initFileLogger,
    getFileLogger,
    fileLog,
    splitLines
};
