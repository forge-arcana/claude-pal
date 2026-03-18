// Forge: Claude Pal — uninstall cleanup
// Removes hook scripts and config files from ~/.claude/hooks/

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOKS_DIR = path.join(os.homedir(), '.claude', 'hooks');
const FILES_TO_CLEAN = [
    'claude-pal-on-stop.js',
    'claude-pal-on-stop.ps1',
    'claude-pal-on-permission.js',
    'claude-pal-on-permission.ps1',
    'claude-pal-on-question.js',
    'claude-pal-on-question.ps1',
    'claude-pal-config.json',
    'claude-pal-signal',
    'claude-pal-muted',
    // Also clean up old claude-notifier files (migration)
    'claude-notifier-on-stop.js',
    'claude-notifier-on-stop.ps1',
    'claude-notifier-on-permission.js',
    'claude-notifier-on-permission.ps1',
    'claude-notifier-on-question.js',
    'claude-notifier-on-question.ps1',
    'claude-notifier-config.json',
    'claude-signal',
    'claude-notifier-muted',
];

for (const file of FILES_TO_CLEAN) {
    const filePath = path.join(HOOKS_DIR, file);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (e) {
        // Ignore cleanup errors
    }
}

// Remove hook entries from ~/.claude/settings.json
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
try {
    if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.hooks) {
            for (const [hookType, hooks] of Object.entries(settings.hooks)) {
                if (Array.isArray(hooks)) {
                    settings.hooks[hookType] = hooks.filter(entry =>
                        !entry.hooks?.some(h => h.command?.includes('claude-pal'))
                    );
                }
            }
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        }
    }
} catch (e) {
    // Ignore
}
