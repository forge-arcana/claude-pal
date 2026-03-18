// Project:   Claude Pal
// File:      statusBar.js
// Purpose:   Three-item status bar: Label + Session + Weekly
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const vscode = require('vscode');
const { COMMANDS, THRESHOLDS, calculateResetClockTime, calculateResetClockTimeExpanded, getCurrencySymbol } = require('./utils');
const { fetchServiceStatus, getStatusDisplay, formatStatusTime, STATUS_PAGE_URL } = require('./serviceStatus');
const { formatSubscriptionType, formatRateLimitTier } = require('./credentialsReader');
const { isSoundMuted } = require('./notifier');

// Service status state
let currentServiceStatus = null;
let serviceStatusError = null;

// Spinner state
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
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

function formatPercent(percent) {
    return `${percent}%`;
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
    let text = 'Claude';

    if (modelInfo && modelInfo.modelDisplay) {
        text = `Claude - ${modelInfo.modelDisplay}`;
        if (modelInfo.hasThinking && modelInfo.effortLevel) {
            text += ` - Thinking (${modelInfo.effortLevel})`;
        } else if (modelInfo.hasThinking) {
            text += ' - Thinking';
        }
    }

    // YOLO badge
    if (permissionMode === 'yolo') {
        text += ' $(zap)';
    } else if (permissionMode === 'yolo-safe') {
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

// ---------------------------------------------------------------------------
// Service status
// ---------------------------------------------------------------------------

function getServiceStatusTooltipLines() {
    const lines = [];
    if (currentServiceStatus) {
        const display = getStatusDisplay(currentServiceStatus.indicator);
        lines.push('');
        lines.push(`**Service Status:** ${display.label}`);
        if (currentServiceStatus.description && currentServiceStatus.description !== display.label) {
            lines.push(`${currentServiceStatus.description}`);
        }
        if (currentServiceStatus.updatedAt) {
            lines.push(`Last checked: ${formatStatusTime(currentServiceStatus.updatedAt)}`);
        }
        lines.push(`[View status page](${STATUS_PAGE_URL})`);
    } else if (serviceStatusError) {
        lines.push('');
        lines.push('**Service Status:** Unable to fetch');
    }

    return lines;
}

async function refreshServiceStatus() {
    try {
        currentServiceStatus = await fetchServiceStatus();
        serviceStatusError = null;

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
        serviceStatusError = error;
        currentServiceStatus = null;
        return null;
    }
}

function getServiceStatus() {
    return currentServiceStatus;
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
// Tooltip action links (command links rendered in hover panel)
// ---------------------------------------------------------------------------

function buildHeaderLine(title, credentialsInfo, modelInfo) {
    const parts = [];
    if (credentialsInfo) {
        const plan = formatSubscriptionType(credentialsInfo.subscriptionType);
        const tier = formatRateLimitTier(credentialsInfo.rateLimitTier);
        if (plan && tier && tier.startsWith(plan)) {
            parts.push(tier);
        } else if (plan && tier && tier !== plan) {
            parts.push(`${plan} · ${tier}`);
        } else if (tier) {
            parts.push(tier);
        } else if (plan) {
            parts.push(plan);
        }
    }
    if (modelInfo && modelInfo.modelDisplay) {
        parts.push(modelInfo.modelDisplay);
        if (modelInfo.hasThinking && modelInfo.effortLevel) {
            parts.push(`Thinking (${modelInfo.effortLevel})`);
        } else if (modelInfo.hasThinking) {
            parts.push('Thinking');
        }
    }
    if (parts.length > 0) {
        return `**${title}** — ${parts.join(' · ')}`;
    }
    return `**${title}**`;
}

function buildPermissionLinks(currentMode) {
    const lines = [];
    const modes = [
        { mode: 'yolo', label: '$(zap) YOLO', desc: 'Approve All' },
        { mode: 'yolo-safe', label: '$(shield) Safe', desc: 'Non-destructive' },
        { mode: 'normal', label: '$(lock) Normal', desc: 'Ask Permission' },
    ];
    const parts = modes.map(m => {
        if (m.mode === currentMode) return `**${m.label}**`;
        return `[${m.label}](command:claudePal.setMode.${m.mode})`;
    });
    lines.push(`Permissions: ${parts.join(' · ')}`);
    return lines;
}

function buildActionLinks(currentMode) {
    const lines = [];
    lines.push(...buildPermissionLinks(currentMode));
    const muted = isSoundMuted();
    lines.push(`Sound: [$(unmute) On](command:claudePal.soundOn)${!muted ? ' ✓' : ''} · [$(mute) Off](command:claudePal.soundOff)${muted ? ' ✓' : ''} · [$(play) Prompt](command:claudePal.changePromptSound) · [$(play) Done](command:claudePal.changeDoneSound)`);
    lines.push('[$(gear) Extension Settings](command:workbench.action.openSettings?"claudePal")');
    lines.push('[$(sync) Refresh Usage](command:claudePal.resyncAccount)');
    return lines;
}

function buildTooltipWithActions(currentMode, credentialsInfo = null, modelInfo = null) {
    const header = buildHeaderLine('Claude Pal', credentialsInfo, modelInfo);
    const lines = [header];

    lines.push('');
    lines.push(...buildActionLinks(currentMode));

    const md = new vscode.MarkdownString(lines.join('  \n'));
    md.isTrusted = true;
    md.supportThemeIcons = true;
    return md;
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

function updateStatusBar(item, usageData, activityStats = null, _sessionData = null, credentialsInfo = null, modelInfo = null, permissionMode = null) {
    const sessionThresholds = { warning: WARNING_THRESHOLD, error: ERROR_THRESHOLD };
    const weeklyThresholds = { warning: WARNING_THRESHOLD, error: ERROR_THRESHOLD };

    // --- No data yet ---
    if (!usageData) {
        if (!isSpinnerActive) {
            if (statusBarItems.label) {
                statusBarItems.label.text = getLabelText(credentialsInfo, modelInfo, permissionMode);
                statusBarItems.label.color = getServiceStatusColor();
            }
            const noDataTooltip = buildTooltipWithActions(permissionMode, credentialsInfo, modelInfo);
            setAllTooltips(noDataTooltip);
        }
        return;
    }

    // --- Build tooltip ---
    const tooltipLines = [];

    // Account + plan + model header (single line)
    const rawAccountName = usageData.accountInfo?.name;
    const accountName = rawAccountName
        ? rawAccountName.replace(/'s Organi[sz]ation$/, '')
        : null;
    const headerTitle = accountName || 'Claude Pal';
    tooltipLines.push(buildHeaderLine(headerTitle, credentialsInfo, modelInfo));
    tooltipLines.push('');

    // Session
    let sessionPercent = null;
    let sessionResetTime = null;
    let sessionStatus = { icon: '', color: undefined, level: 'normal' };

    if (usageData.usagePercent !== undefined && usageData.usagePercent !== null) {
        sessionPercent = usageData.usagePercent;
        sessionResetTime = calculateResetClockTime(usageData.resetTime);
        const sessionResetTimeExpanded = calculateResetClockTimeExpanded(usageData.resetTime);
        sessionStatus = getIconAndColor(sessionPercent, sessionThresholds.warning, sessionThresholds.error);

        tooltipLines.push(`**Session ${sessionPercent}%** — Resets ${sessionResetTimeExpanded}`);
    }

    // Weekly
    let weeklyPercent = null;
    let weeklyResetTime = null;
    let weeklyStatus = { icon: '', color: undefined, level: 'normal' };

    if (usageData.usagePercentWeek !== undefined && usageData.usagePercentWeek !== null) {
        weeklyPercent = usageData.usagePercentWeek;
        weeklyResetTime = calculateResetClockTime(usageData.resetTimeWeek);
        const weeklyResetTimeExpanded = calculateResetClockTimeExpanded(usageData.resetTimeWeek);
        weeklyStatus = getIconAndColor(weeklyPercent, weeklyThresholds.warning, weeklyThresholds.error);

        tooltipLines.push('');
        tooltipLines.push(`**Weekly ${weeklyPercent}%** — Resets ${weeklyResetTimeExpanded}`);

        // Sonnet/Opus percentages in tooltip only
        if (usageData.usagePercentSonnet !== null && usageData.usagePercentSonnet !== undefined) {
            tooltipLines.push(`Sonnet: ${usageData.usagePercentSonnet}%`);
        }
        if (usageData.usagePercentOpus !== null && usageData.usagePercentOpus !== undefined) {
            tooltipLines.push(`Opus: ${usageData.usagePercentOpus}%`);
        }
    }

    // Credits (tooltip only)
    if (usageData.monthlyCredits) {
        const credits = usageData.monthlyCredits;
        const currencySymbol = getCurrencySymbol(credits.currency);
        const usedFormatted = `${currencySymbol}${credits.used.toLocaleString()}`;
        const limitFormatted = `${currencySymbol}${credits.limit.toLocaleString()}`;

        tooltipLines.push('');
        tooltipLines.push('**Extra Usage**');
        tooltipLines.push(`Used: ${usedFormatted} / ${limitFormatted} ${credits.currency} (${credits.percent}%)`);

        if (usageData.prepaidCredits) {
            const prepaid = usageData.prepaidCredits;
            const prepaidSymbol = getCurrencySymbol(prepaid.currency);
            tooltipLines.push(`Balance: ${prepaidSymbol}${prepaid.balance.toLocaleString()} ${prepaid.currency}`);
        }
    } else if (usageData.prepaidCredits) {
        const prepaid = usageData.prepaidCredits;
        const prepaidSymbol = getCurrencySymbol(prepaid.currency);
        tooltipLines.push('');
        tooltipLines.push('**Credits**');
        tooltipLines.push(`Balance: ${prepaidSymbol}${prepaid.balance.toLocaleString()} ${prepaid.currency}`);
    }

    // Activity description
    if (activityStats && activityStats.description) {
        tooltipLines.push('');
        tooltipLines.push(`*${activityStats.description.quirky}*`);
    }

    // Service status
    tooltipLines.push(...getServiceStatusTooltipLines());

    // Actions
    tooltipLines.push('');
    tooltipLines.push(...buildActionLinks(permissionMode));

    // Footer
    tooltipLines.push('');
    if (usageData.timestamp) {
        tooltipLines.push(`Updated: ${usageData.timestamp.toLocaleTimeString()}`);
    }

    const markdown = new vscode.MarkdownString(tooltipLines.join('  \n'));
    markdown.isTrusted = true;
    markdown.supportThemeIcons = true;
    if (!isSpinnerActive) {
        setAllTooltips(markdown);
    }

    // --- Render unified status bar text ---
    if (!isSpinnerActive && statusBarItems.label) {
        const parts = [getLabelText(credentialsInfo, modelInfo, permissionMode)];

        if (sessionPercent !== null) {
            parts.push(`${formatPercent(sessionPercent)} ${sessionResetTime}`);
        }
        if (weeklyPercent !== null) {
            parts.push(`${formatPercent(weeklyPercent)} ${weeklyResetTime}`);
        }

        statusBarItems.label.text = parts.join(' | ');

        // Use the worst color (error > warning > normal)
        const worstStatus = sessionStatus.level === 'error' || weeklyStatus.level === 'error'
            ? sessionStatus.level === 'error' ? sessionStatus : weeklyStatus
            : sessionStatus.level === 'warning' || weeklyStatus.level === 'warning'
                ? sessionStatus.level === 'warning' ? sessionStatus : weeklyStatus
                : { color: getServiceStatusColor() };
        statusBarItems.label.color = worstStatus.color || getServiceStatusColor();
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
            const currentBase = statusBarItems.label.text.replace(/ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](\s*)$/, '').trim();
            statusBarItems.label.text = `${currentBase} ${spinnerFrames[spinnerIndex]}`;
            spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
        }, 80);
    }
}

function stopSpinner(webError = null, tokenError = null) {
    if (spinnerInterval) {
        clearInterval(spinnerInterval);
        spinnerInterval = null;
    }
    isSpinnerActive = false;

    if (webError && tokenError) {
        const errorLines = [
            '**Complete Fetch Failed**',
            '',
            `Web: ${webError.message}`,
            `Tokens: ${tokenError.message}`,
            '',
            '**Debug Info**',
            `Time: ${new Date().toLocaleString()}`,
            '',
            '**Actions**',
            '• Click to retry',
            '• Run "Claude Pal: Show Debug Output" for details',
            '[$(output) Debug](command:claudePal.showDebug) · [$(trash) Clear Session](command:claudePal.clearSession)'
        ];
        const md1 = new vscode.MarkdownString(errorLines.join('  \n'));
        md1.isTrusted = true;
        md1.supportThemeIcons = true;
        setAllTooltips(md1);

        if (statusBarItems.label) {
            statusBarItems.label.text = `${statusBarItems.label.text.replace(/ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/, '').trim()} ✗`;
            statusBarItems.label.color = new vscode.ThemeColor('errorForeground');
        }
    } else if (webError) {
        const errorLines = [
            '**Web Fetch Failed**',
            '',
            `Error: ${webError.message}`,
            '',
            '[$(sync) Retry](command:claudePal.fetchNow)' +
            ' · [$(output) Debug](command:claudePal.showDebug)' +
            ' · [$(trash) Clear Session](command:claudePal.clearSession)'
        ];
        const md2 = new vscode.MarkdownString(errorLines.join('  \n'));
        md2.isTrusted = true;
        md2.supportThemeIcons = true;
        setAllTooltips(md2);

        if (statusBarItems.label) {
            statusBarItems.label.text = `${statusBarItems.label.text.replace(/ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/, '').trim()} ⚠`;
            statusBarItems.label.color = new vscode.ThemeColor('editorWarning.foreground');
        }
    } else {
        if (statusBarItems.label) {
            statusBarItems.label.text = `${statusBarItems.label.text.replace(/ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/, '').trim()}  `;
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
    getServiceStatus
};
