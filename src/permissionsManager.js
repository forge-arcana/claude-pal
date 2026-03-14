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
const YOLO_SAFE_PERMISSIONS = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebFetch(*)', 'WebSearch(*)',
    'Agent', 'TodoWrite', 'NotebookEdit',
    // Git (read-only / local)
    'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)',
    'Bash(git add*)', 'Bash(git commit*)', 'Bash(git branch*)',
    'Bash(git checkout*)', 'Bash(git switch*)', 'Bash(git stash*)',
    'Bash(git fetch*)', 'Bash(git rebase*)', 'Bash(git merge*)',
    'Bash(git cherry-pick*)', 'Bash(git show*)', 'Bash(git tag*)',
    'Bash(git blame*)', 'Bash(git shortlog*)', 'Bash(git describe*)',
    'Bash(git rev-parse*)', 'Bash(git ls-files*)', 'Bash(git remote*)',
    'Bash(git config*)', 'Bash(git -C *)',
    // Node / build
    'Bash(node *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(pnpm *)',
    'Bash(tsx *)', 'Bash(tsc*)', 'Bash(vitest*)', 'Bash(playwright*)',
    'Bash(eslint*)', 'Bash(prettier*)',
    // Shell basics (read-only)
    'Bash(ls*)', 'Bash(pwd)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)',
    'Bash(wc *)', 'Bash(sort *)', 'Bash(uniq *)', 'Bash(tr *)', 'Bash(cut *)',
    'Bash(echo *)', 'Bash(printf *)', 'Bash(test *)',
    'Bash(find *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(ag *)',
    'Bash(which *)', 'Bash(whereis *)', 'Bash(type *)',
    'Bash(file *)', 'Bash(stat *)', 'Bash(diff *)',
    'Bash(basename *)', 'Bash(dirname *)', 'Bash(realpath *)',
    // File ops (non-destructive)
    'Bash(mkdir *)', 'Bash(cp *)', 'Bash(mv *)', 'Bash(touch *)',
    'Bash(chmod *)', 'Bash(sed *)', 'Bash(awk *)', 'Bash(xargs *)',
    // Network / tools
    'Bash(curl *)', 'Bash(wget *)', 'Bash(ping *)',
    'Bash(ps *)', 'Bash(lsof *)', 'Bash(du *)',
    'Bash(python *)', 'Bash(python3 *)', 'Bash(gh *)',
    'Bash(docker *)', 'Bash(bash *)', 'Bash(source *)',
    'Bash(timeout *)', 'Bash(bc *)',
    'Bash(export *)', 'Bash(set *)',
];

// Explicitly NOT in YOLO Safe: rm, git push, git reset --hard, git clean, git restore, kill

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
