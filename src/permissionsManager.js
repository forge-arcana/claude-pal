// Project:   Claude Pal
// File:      permissionsManager.js
// Purpose:   YOLO mode — toggle Claude Code permission levels
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fileLog } = require('./utils');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const BACKUP_FILE = path.join(CLAUDE_DIR, '.claude-pal-permissions-backup.json');

// Three permission modes
const MODES = {
    NORMAL: 'normal',
    YOLO_SAFE: 'yolo-safe',
    YOLO: 'yolo',
};

// YOLO: approve everything
const YOLO_PERMISSIONS = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebFetch(*)', 'WebSearch(*)',
    'Bash(*)',
    'Agent', 'TodoWrite', 'NotebookEdit',
];

// YOLO Safe: approve all tools + non-destructive Bash patterns
// Synced with global CLAUDE.md auto-allowed commands (2026-03-15)
const YOLO_SAFE_PERMISSIONS = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebFetch(*)', 'WebSearch(*)',
    'Agent', 'TodoWrite', 'NotebookEdit',
    // Shell basics
    'Bash(cd *)', 'Bash(ls*)', 'Bash(pwd)', 'Bash(cat *)', 'Bash(head *)',
    'Bash(tail *)', 'Bash(echo *)', 'Bash(printf *)', 'Bash(wc *)',
    'Bash(sort *)', 'Bash(uniq *)', 'Bash(tr *)', 'Bash(cut *)',
    'Bash(tee *)', 'Bash(test *)',
    // File operations (non-destructive)
    'Bash(mkdir *)', 'Bash(cp *)', 'Bash(mv *)', 'Bash(touch *)',
    'Bash(chmod *)', 'Bash(basename *)', 'Bash(dirname *)', 'Bash(realpath *)',
    // File inspection
    'Bash(file *)', 'Bash(stat *)', 'Bash(diff *)',
    'Bash(which *)', 'Bash(whereis *)', 'Bash(type *)',
    // Text processing
    'Bash(sed *)', 'Bash(awk *)', 'Bash(xargs *)',
    // Search
    'Bash(find *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(ag *)',
    // Node.js / build
    'Bash(node *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(pnpm *)',
    'Bash(tsx *)', 'Bash(tsc*)', 'Bash(vitest*)', 'Bash(playwright*)',
    'Bash(eslint*)', 'Bash(prettier*)',
    // Network
    'Bash(curl *)', 'Bash(wget *)', 'Bash(ping *)',
    'Bash(ipconfig*)', 'Bash(ip *)', 'Bash(ss *)', 'Bash(netstat*)',
    // Process (read-only)
    'Bash(ps *)', 'Bash(kill *)', 'Bash(lsof *)', 'Bash(tasklist*)',
    // WSL / Docker
    'Bash(wsl *)', 'Bash(docker *)',
    'Bash(powershell *)', 'Bash(powershell.exe *)', 'Bash(cmd *)',
    // Git (safe — excludes push, reset, clean, restore)
    'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)',
    'Bash(git add*)', 'Bash(git commit*)', 'Bash(git branch*)',
    'Bash(git checkout*)', 'Bash(git switch*)', 'Bash(git stash*)',
    'Bash(git fetch*)', 'Bash(git rebase*)', 'Bash(git merge*)',
    'Bash(git cherry-pick*)', 'Bash(git show*)', 'Bash(git tag*)',
    'Bash(git rm*)', 'Bash(git mv*)', 'Bash(git check-ignore*)',
    'Bash(git config*)', 'Bash(git remote*)', 'Bash(git rev-parse*)',
    'Bash(git ls-files*)', 'Bash(git blame*)', 'Bash(git shortlog*)',
    'Bash(git describe*)', 'Bash(git -C *)',
    // Other
    'Bash(gh *)', 'Bash(bc *)', 'Bash(python *)', 'Bash(python3 *)',
    'Bash(bash *)', 'Bash(source *)', 'Bash(timeout *)',
    'Bash(for *)', 'Bash(du *)', 'Bash(start *)', 'Bash(pandoc *)',
    // Env vars
    'Bash(export *)', 'Bash(set *)',
    'Bash(DATABASE_URL=*)', 'Bash(PORT=*)', 'Bash(CI=*)',
    'Bash(DEBUG=*)', 'Bash(NODE_OPTIONS=*)', 'Bash(TMPDIR=*)',
    'Bash(E2E_DATABASE_URL=*)',
];

// Explicitly NOT in YOLO Safe: rm, git push, git reset, git clean, git restore

function readSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch {
        return {};
    }
}

function writeSettings(settings) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

function backupPermissions(settings) {
    const backup = {
        allow: settings.permissions?.allow || [],
        deny: settings.permissions?.deny || [],
        savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
    fileLog('Permissions backed up');
}

function restorePermissions() {
    try {
        if (!fs.existsSync(BACKUP_FILE)) return null;
        return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
    } catch {
        return null;
    }
}

function getCurrentMode() {
    const settings = readSettings();
    const allow = settings.permissions?.allow || [];

    // Check if YOLO (has Bash(*))
    if (allow.includes('Bash(*)')) return MODES.YOLO;

    // Check if YOLO Safe (has our safe bash patterns but not Bash(*))
    const hasSafeMarkers = allow.includes('Bash(git status*)') &&
        allow.includes('Bash(node *)') &&
        allow.includes('Bash(npm *)') &&
        !allow.includes('Bash(*)');
    if (hasSafeMarkers && allow.length >= YOLO_SAFE_PERMISSIONS.length * 0.8) {
        return MODES.YOLO_SAFE;
    }

    return MODES.NORMAL;
}

function setMode(mode) {
    const settings = readSettings();

    if (mode === MODES.NORMAL) {
        const backup = restorePermissions();
        if (backup) {
            if (!settings.permissions) settings.permissions = {};
            settings.permissions.allow = backup.allow;
            if (backup.deny.length > 0) {
                settings.permissions.deny = backup.deny;
            }
            writeSettings(settings);
            // Clean up backup
            try { fs.unlinkSync(BACKUP_FILE); } catch { /* ignore */ }
            fileLog('Permissions restored to normal');
        } else {
            // No backup — just remove the broad permissions
            if (settings.permissions) {
                delete settings.permissions.allow;
            }
            writeSettings(settings);
            fileLog('Permissions reset (no backup found)');
        }
        return;
    }

    // Back up current permissions before changing (only if not already in a YOLO mode)
    const currentMode = getCurrentMode();
    if (currentMode === MODES.NORMAL) {
        backupPermissions(settings);
    }

    if (!settings.permissions) settings.permissions = {};

    if (mode === MODES.YOLO) {
        settings.permissions.allow = YOLO_PERMISSIONS;
        fileLog('YOLO mode enabled — all permissions approved');
    } else if (mode === MODES.YOLO_SAFE) {
        settings.permissions.allow = YOLO_SAFE_PERMISSIONS;
        fileLog('YOLO Safe mode enabled — non-destructive permissions approved');
    }

    writeSettings(settings);
}

function getModeDisplay(mode) {
    switch (mode) {
        case MODES.YOLO: return { label: 'YOLO', icon: '$(zap)' };
        case MODES.YOLO_SAFE: return { label: 'Safe', icon: '$(shield)' };
        default: return { label: null, icon: null };
    }
}

module.exports = {
    MODES,
    getCurrentMode,
    setMode,
    getModeDisplay,
};
