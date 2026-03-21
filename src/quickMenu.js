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
const { changeSoundPicker, getEventSoundLabel } = require('./notifier');

function buildProgressBar(percent, width = 20) {
    const clamped = Math.max(0, Math.min(100, percent || 0));
    const filled = Math.round((clamped / 100) * width);
    const empty = width - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Show permissions sub-menu. Returns true if user wants to go back.
 */
async function showPermissionsMenu(usageData, onAfter) {
    const permissionMode = getCurrentMode();
    const modeItems = [MODES.YOLO, MODES.YOLO_SAFE, MODES.NORMAL].map(m => ({
        label: m === permissionMode ? `$(check) ${m}` : `     ${m}`,
        description: m === MODES.YOLO ? 'Auto-approve all'
            : m === MODES.YOLO_SAFE ? 'Auto-approve non-destructive'
            : 'Ask before each action',
        mode: m,
    }));
    modeItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    modeItems.push({ label: '$(arrow-left) Back', mode: '__back__' });
    modeItems.push({ label: '$(close) Close', mode: '__close__' });

    const picked = await vscode.window.showQuickPick(modeItems, { placeHolder: 'Select permission mode' });
    if (!picked || picked.mode === '__close__') return false;
    if (picked.mode === '__back__') return true;

    await vscode.commands.executeCommand(`claudePal.setMode.${picked.mode}`);
    if (onAfter) await onAfter();
    return true; // go back to main after applying
}

/**
 * Show sound picker sub-menu with preview. Returns true if user wants to go back.
 * @param {"prompt"|"done"} eventType
 * @param {() => Promise<void>} onAfter
 */
function showSoundSubMenu(eventType, onAfter) {
    return new Promise((resolve) => {
        changeSoundPicker(eventType, onAfter, () => resolve(true));
    });
}

/**
 * Show the quick pick menu. Uses cached data — no fetching.
 * Loops back to itself when sub-menus return.
 * @param {object|null} usageData - current usage data
 * @param {() => Promise<void>} onAfter - callback to refresh status bar after action
 */
async function showQuickMenu(usageData, onAfter) {
    let keepOpen = true;

    while (keepOpen) {
        const permissionMode = getCurrentMode();
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

        // Actions
        items.push({
            label: '$(sync) Refresh Now',
            description: 'Fetch latest usage from Claude.ai',
            action: async () => { await vscode.commands.executeCommand(COMMANDS.FETCH_NOW); return true; },
        });
        items.push({
            label: '$(megaphone) Prompt Sound',
            description: getEventSoundLabel('prompt'),
            action: () => showSoundSubMenu('prompt', onAfter),
        });
        items.push({
            label: '$(play) Done Sound',
            description: getEventSoundLabel('done'),
            action: () => showSoundSubMenu('done', onAfter),
        });
        items.push({
            label: `$(shield) Permissions: ${permissionMode}`,
            description: 'Claude Code permission mode',
            action: () => showPermissionsMenu(usageData, onAfter),
        });

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Claude Pal',
            matchOnDescription: false,
            matchOnDetail: false,
        });

        if (!picked || !picked.action) {
            keepOpen = false;
        } else {
            keepOpen = await picked.action();
        }
    }

    if (onAfter) await onAfter();
}

module.exports = { showQuickMenu };
