// Project:   Claude Pal
// File:      quickMenu.js
// Purpose:   Quick pick menu shown on status bar click
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const vscode = require('vscode');
const { COMMANDS, calculateResetClockTime } = require('./utils');
const { MODES, getCurrentMode } = require('./permissionsManager');
const { isSoundMuted } = require('./notifier');

function buildProgressBar(percent, width = 20) {
    const clamped = Math.max(0, Math.min(100, percent || 0));
    const filled = Math.round((clamped / 100) * width);
    const empty = width - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Show the quick pick menu. Uses cached data — no fetching.
 * @param {object|null} usageData - current usage data
 * @param {() => Promise<void>} onAfter - callback to refresh status bar after action
 */
async function showQuickMenu(usageData, onAfter) {
    const permissionMode = getCurrentMode();
    const muted = isSoundMuted();

    const items = [];

    // Usage info items (non-actionable)
    if (usageData) {
        if (usageData.usagePercent != null) {
            const bar = buildProgressBar(usageData.usagePercent);
            const reset = calculateResetClockTime(usageData.resetTime);
            items.push({
                label: `$(pulse) Session ${usageData.usagePercent}%`,
                description: bar,
                detail: `Resets in ${reset}`,
                kind: vscode.QuickPickItemKind.Default,
                action: null,
            });
        }
        if (usageData.usagePercentWeek != null) {
            const bar = buildProgressBar(usageData.usagePercentWeek);
            const reset = calculateResetClockTime(usageData.resetTimeWeek);
            items.push({
                label: `$(graph) Weekly ${usageData.usagePercentWeek}%`,
                description: bar,
                detail: `Resets in ${reset}`,
                action: null,
            });
        }
        if (usageData.usagePercentSonnet != null) {
            items.push({ label: `     Sonnet: ${usageData.usagePercentSonnet}%`, description: buildProgressBar(usageData.usagePercentSonnet), action: null });
        }
        if (usageData.usagePercentOpus != null) {
            items.push({ label: `     Opus: ${usageData.usagePercentOpus}%`, description: buildProgressBar(usageData.usagePercentOpus), action: null });
        }
    } else {
        items.push({ label: '$(warning) No usage data', detail: 'Click Refresh or Re-login', action: null });
    }

    // Separator
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    // Actions — each item carries its own handler (OCP: add without editing a switch)
    items.push({ label: '$(sync) Refresh Now', action: () => vscode.commands.executeCommand(COMMANDS.FETCH_NOW) });
    items.push({ label: muted ? '$(unmute) Sound On' : '$(mute) Sound Off', action: () => vscode.commands.executeCommand(COMMANDS.TOGGLE_SOUND) });
    items.push({
        label: `$(shield) Permissions: ${permissionMode}`,
        action: async () => {
            const modeItems = [MODES.YOLO, MODES.YOLO_SAFE, MODES.NORMAL].map(m => ({
                label: m === permissionMode ? `$(check) ${m}` : `     ${m}`,
                mode: m,
            }));
            const modePick = await vscode.window.showQuickPick(modeItems, { placeHolder: 'Select permission mode' });
            if (modePick) await vscode.commands.executeCommand(`claudePal.setMode.${modePick.mode}`);
        },
    });
    items.push({ label: '$(globe) Open Claude Settings', action: () => vscode.commands.executeCommand(COMMANDS.OPEN_SETTINGS) });
    items.push({
        label: '$(key) Re-login',
        action: async () => {
            await vscode.commands.executeCommand(COMMANDS.CLEAR_SESSION);
            await vscode.commands.executeCommand(COMMANDS.OPEN_BROWSER);
        },
    });
    items.push({ label: '$(output) Show Debug Log', action: () => vscode.commands.executeCommand(COMMANDS.SHOW_DEBUG) });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Claude Pal',
        matchOnDescription: false,
        matchOnDetail: false,
    });

    if (picked?.action) await picked.action();
    if (onAfter) await onAfter();
}

module.exports = { showQuickMenu };
