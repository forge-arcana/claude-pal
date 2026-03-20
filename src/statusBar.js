// Project:   Claude Pal
// File:      statusBar.js
// Purpose:   Three-item status bar: Label + Session + Weekly
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const vscode = require('vscode');
const { COMMANDS, THRESHOLDS } = require('./utils');
const { fetchServiceStatus, getStatusDisplay } = require('./serviceStatus');
const { MODES } = require('./permissionsManager');

// Spinner characters used in status bar text during fetch
const SPINNER_CHARS = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const SPINNER_REGEX = new RegExp(` [${SPINNER_CHARS}](\\s*)$`);
const SPINNER_STRIP_REGEX = new RegExp(` [${SPINNER_CHARS}]$`);

// Service status state
let currentServiceStatus = null;

// Spinner state
const spinnerFrames = [...SPINNER_CHARS];
let spinnerIndex = 0;
let spinnerInterval = null;
let isSpinnerActive = false;

// Single unified status bar item
let statusBarItems = {
    label: null,
};

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

// Hardcoded defaults (removed from user settings)
const STATUS_BAR_ALIGNMENT = vscode.StatusBarAlignment.Right;
const STATUS_BAR_PRIORITY = 100;
const WARNING_THRESHOLD = THRESHOLDS.WARNING_PERCENT;
const ERROR_THRESHOLD = THRESHOLDS.ERROR_PERCENT;

const SEVERITY_ORDER = { error: 2, warning: 1, normal: 0 };

function pickWorstStatus(a, b) {
    return (SEVERITY_ORDER[a.level] || 0) >= (SEVERITY_ORDER[b.level] || 0) ? a : b;
}

function getIconAndColor(percent, warningThreshold = 80, errorThreshold = 90) {
    if (percent >= errorThreshold) {
        return {
            icon: '$(error)',
            color: new vscode.ThemeColor('errorForeground'),
            level: 'error'
        };
    } else if (percent >= warningThreshold) {
        return {
            icon: '$(warning)',
            color: new vscode.ThemeColor('editorWarning.foreground'),
            level: 'warning'
        };
    }
    return { icon: '', color: undefined, level: 'normal' };
}

// ---------------------------------------------------------------------------
// Label text (model/plan tier + service status icon)
// ---------------------------------------------------------------------------

/**
 * Get label text for the first status bar item.
 * Shows: "Claude - {Model} - Thinking ({Level})" when model info is available,
 * otherwise falls back to "Claude".
 * Prepends a warning icon when service is degraded.
 * @param {object|null} credentialsInfo
 * @param {object|null} modelInfo - { model, modelDisplay, hasThinking, effortLevel }
 * @param {string|null} permissionMode - 'normal', 'yolo-safe', or 'yolo'
 * @returns {string}
 */
function getLabelText(credentialsInfo, modelInfo, permissionMode) {
    let text = '$(robot)';

    if (modelInfo && modelInfo.modelDisplay) {
        text = `$(robot) ${modelInfo.modelDisplay}`;
        if (modelInfo.hasThinking && modelInfo.effortLevel) {
            text += ` - Thinking (${modelInfo.effortLevel})`;
        } else if (modelInfo.hasThinking) {
            text += ' - Thinking';
        }
    }

    // YOLO badge
    if (permissionMode === MODES.YOLO) {
        text += ' $(zap)';
    } else if (permissionMode === MODES.YOLO_SAFE) {
        text += ' $(shield)';
    }

    if (currentServiceStatus && currentServiceStatus.indicator !== 'none') {
        const display = getStatusDisplay(currentServiceStatus.indicator);
        return `${display.icon} ${text}`;
    }
    return text;
}

function getServiceStatusColor() {
    if (currentServiceStatus) {
        const display = getStatusDisplay(currentServiceStatus.indicator);
        if (display.color) {
            return new vscode.ThemeColor(display.color);
        }
    }
    return undefined;
}

async function refreshServiceStatus() {
    try {
        currentServiceStatus = await fetchServiceStatus();

        // Update label if initialized and spinner isn't running
        if (statusBarItems.label && !isSpinnerActive) {
            // Label text depends on credentialsInfo which we don't have here,
            // but service status only adds/removes the warning icon prefix.
            // We'll just re-render the icon prefix on the current text.
            const currentText = statusBarItems.label.text.trim();
            // Strip any existing codicon prefix
            const stripped = currentText.replace(/^\$\([^)]+\)\s*/, '');
            if (currentServiceStatus.indicator !== 'none') {
                const display = getStatusDisplay(currentServiceStatus.indicator);
                statusBarItems.label.text = `${display.icon} ${stripped}  `;
            } else {
                statusBarItems.label.text = `${stripped}  `;
            }
            statusBarItems.label.color = getServiceStatusColor();
        }

        return currentServiceStatus;
    } catch (error) {
        currentServiceStatus = null;
        return null;
    }
}

// ---------------------------------------------------------------------------
// Tooltip helpers
// ---------------------------------------------------------------------------

function setAllTooltips(tooltip) {
    if (statusBarItems.label) {
        statusBarItems.label.tooltip = tooltip;
    }
}

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------

function createStatusBarItem(context) {
    statusBarItems.label = vscode.window.createStatusBarItem(STATUS_BAR_ALIGNMENT, STATUS_BAR_PRIORITY);
    statusBarItems.label.command = COMMANDS.SHOW_MENU;
    statusBarItems.label.text = 'Claude';
    statusBarItems.label.show();
    context.subscriptions.push(statusBarItems.label);

    return statusBarItems.label;
}

function updateStatusBar(item, usageData, credentialsInfo = null, modelInfo = null, permissionMode = null) {

    // --- No data yet ---
    if (!usageData) {
        if (!isSpinnerActive) {
            if (statusBarItems.label) {
                statusBarItems.label.text = getLabelText(credentialsInfo, modelInfo, permissionMode);
                statusBarItems.label.color = getServiceStatusColor();
            }
            setAllTooltips('Click for usage details');
        }
        return;
    }

    // --- Usage levels (for status bar color) ---
    let sessionStatus = { icon: '', color: undefined, level: 'normal' };
    let weeklyStatus = { icon: '', color: undefined, level: 'normal' };

    if (usageData.usagePercent != null) {
        sessionStatus = getIconAndColor(usageData.usagePercent, WARNING_THRESHOLD, ERROR_THRESHOLD);
    }
    if (usageData.usagePercentWeek != null) {
        weeklyStatus = getIconAndColor(usageData.usagePercentWeek, WARNING_THRESHOLD, ERROR_THRESHOLD);
    }

    // Simple tooltip — detail is in the click menu
    if (!isSpinnerActive) {
        setAllTooltips('Click for usage details');
    }

    // --- Render unified status bar text ---
    // Usage numbers are in the click menu; status bar shows label + warning color only
    if (!isSpinnerActive && statusBarItems.label) {
        statusBarItems.label.text = getLabelText(credentialsInfo, modelInfo, permissionMode);

        // Color reflects worst usage state (error > warning > normal)
        const worst = pickWorstStatus(sessionStatus, weeklyStatus);
        statusBarItems.label.color = worst.color || getServiceStatusColor();
    }
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function startSpinner() {
    if (spinnerInterval) return;

    spinnerIndex = 0;
    isSpinnerActive = true;

    setAllTooltips('Checking Claude...');

    if (statusBarItems.label) {
        spinnerInterval = setInterval(() => {
            const currentBase = statusBarItems.label.text.replace(SPINNER_REGEX, '').trim();
            statusBarItems.label.text = `${currentBase} ${spinnerFrames[spinnerIndex]}`;
            spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
        }, 80);
    }
}

function stripSpinner(text) {
    return text.replace(SPINNER_STRIP_REGEX, '').trim();
}

function buildErrorTooltip(lines) {
    const md = new vscode.MarkdownString(lines.join('  \n'));
    md.isTrusted = true;
    md.supportThemeIcons = true;
    return md;
}

function stopSpinner(webError = null) {
    if (spinnerInterval) {
        clearInterval(spinnerInterval);
        spinnerInterval = null;
    }
    isSpinnerActive = false;

    if (webError) {
        setAllTooltips(buildErrorTooltip([
            '**Fetch Failed**',
            '',
            `Error: ${webError.message}`,
            '',
            '[$(sync) Retry](command:claudePal.fetchNow)' +
            ' · [$(output) Debug](command:claudePal.showDebug)' +
            ' · [$(trash) Clear Session](command:claudePal.clearSession)'
        ]));

        if (statusBarItems.label) {
            statusBarItems.label.text = `${stripSpinner(statusBarItems.label.text)} ⚠`;
            statusBarItems.label.color = new vscode.ThemeColor('editorWarning.foreground');
        }
    } else {
        if (statusBarItems.label) {
            statusBarItems.label.text = `${stripSpinner(statusBarItems.label.text)}  `;
            statusBarItems.label.color = getServiceStatusColor();
        }
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    createStatusBarItem,
    updateStatusBar,
    startSpinner,
    stopSpinner,
    refreshServiceStatus,
};
