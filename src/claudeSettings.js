// Project:   Claude Pal
// File:      claudeSettings.js
// Purpose:   Shared read/write for ~/.claude/settings.json
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');

function readSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch {
        return {};
    }
}

function writeSettings(settings) {
    const dir = path.dirname(SETTINGS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = path.join(dir, `.settings.${process.pid}.tmp`);
    fs.writeFileSync(tmpFile, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmpFile, SETTINGS_FILE);
}

module.exports = {
    CLAUDE_DIR,
    SETTINGS_FILE,
    readSettings,
    writeSettings,
};
