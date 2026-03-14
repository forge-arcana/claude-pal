// Project:   Claude Pal
// File:      statusBar.js
// Purpose:   Three-item status bar: Label + Session + Weekly
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const vscode = require('vscode');
const { COMMANDS, CONFIG_NAMESPACE, calculateResetClockTime, calculateResetClockTimeExpanded, getCurrencySymbol, getUse24HourTime, formatModelName, capitalizeFirst } = require('./utils');
const { fetchServiceStatus, getStatusDisplay, formatStatusTime, STATUS_PAGE_URL } = require('./serviceStatus');
const { formatSubscriptionType, formatRateLimitTier } = require('./credentialsReader');

// Service status state
let currentServiceStatus = null;
let serviceStatusError = null;

// Spinner state
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIndex = 0;
let spinnerInterval = null;
let isSpinnerActive = false;

// Status bar items (3 only: label, session, weekly)
let statusBarItems = {
    label: null,
    session: null,
    weekly: null
};

// Track last displayed values to avoid unnecessary DOM updates
let lastDisplayedValues = {
    sessionText: null,
    weeklyText: null
};

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function isServiceStatusEnabled() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    return config.get('statusBar.showServiceStatus', true);
}

function getStatusBarAlignment() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const alignment = config.get('statusBar.alignment', 'right');
    return alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
}

function getStatusBarPriority() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    return config.get('statusBar.priority', 100);
}

function getUsageFormat() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    return config.get('statusBar.usageFormat', 'barCircle');
}

// ---------------------------------------------------------------------------
// Bar rendering
// ---------------------------------------------------------------------------

const BAR_STYLES = {
    barLight: { filled: '▓', empty: '░' },
    barSolid: { filled: '█', empty: '░' },
    barSquare: { filled: '■', empty: '□' },
    barCircle: { filled: '●', empty: '○' }
};

function formatAsBar(percent, style, width = 5) {
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round(clamped / 100 * width);
    const chars = BAR_STYLES[style] || BAR_STYLES.barLight;
    return chars.filled.repeat(filled) + chars.empty.repeat(width - filled);
}

function formatPercent(percent) {
    const format = getUsageFormat();
    if (format !== 'percent') {
        return formatAsBar(percent, format);
    }
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

    if (isServiceStatusEnabled() && currentServiceStatus && currentServiceStatus.indicator !== 'none') {
        const display = getStatusDisplay(currentServiceStatus.indicator);
        return `${display.icon} ${text}`;
    }
    return text;
}

function getServiceStatusColor() {
    if (isServiceStatusEnabled() && currentServiceStatus) {
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
    if (!isServiceStatusEnabled()) return lines;

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
    if (!isServiceStatusEnabled()) return null;

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
    Object.values(statusBarItems).forEach(item => {
        if (item) {
            item.tooltip = tooltip;
        }
    });
}

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------

function createStatusBarItem(context) {
    const alignment = getStatusBarAlignment();
    const basePriority = getStatusBarPriority();

    statusBarItems.label = vscode.window.createStatusBarItem(alignment, basePriority);
    statusBarItems.label.command = COMMANDS.SHOW_MENU;
    statusBarItems.label.text = 'Claude  ';
    statusBarItems.label.show();
    context.subscriptions.push(statusBarItems.label);

    statusBarItems.session = vscode.window.createStatusBarItem(alignment, basePriority - 1);
    statusBarItems.session.command = COMMANDS.SHOW_MENU;
    context.subscriptions.push(statusBarItems.session);

    statusBarItems.weekly = vscode.window.createStatusBarItem(alignment, basePriority - 2);
    statusBarItems.weekly.command = COMMANDS.SHOW_MENU;
    context.subscriptions.push(statusBarItems.weekly);

    return statusBarItems.label;
}

function updateStatusBar(item, usageData, activityStats = null, sessionData = null, credentialsInfo = null, modelInfo = null, permissionMode = null) {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    const globalWarning = config.get('thresholds.warning', 80);
    const globalError = config.get('thresholds.error', 90);

    const getThresholds = (gauge) => {
        const warning = config.get(`thresholds.${gauge}.warning`);
        const error = config.get(`thresholds.${gauge}.error`);
        return {
            warning: (warning !== undefined && warning !== null && warning > 0) ? warning : globalWarning,
            error: (error !== undefined && error !== null && error > 0) ? error : globalError
        };
    };

    const sessionThresholds = getThresholds('session');
    const weeklyThresholds = getThresholds('weekly');

    // --- No data yet ---
    if (!usageData) {
        if (!isSpinnerActive) {
            if (statusBarItems.label) {
                statusBarItems.label.text = `${getLabelText(credentialsInfo, modelInfo, permissionMode)}  `;
                statusBarItems.label.color = getServiceStatusColor();
            }
            setAllTooltips('Click to fetch Claude usage data');
            statusBarItems.session.hide();
            statusBarItems.weekly.hide();
        }
        return;
    }

    // --- Update label ---
    if (!isSpinnerActive && statusBarItems.label) {
        statusBarItems.label.text = `${getLabelText(credentialsInfo, modelInfo, permissionMode)}  `;
        statusBarItems.label.color = getServiceStatusColor();
    }

    // --- Build tooltip ---
    const tooltipLines = [];

    // Account + plan header
    const rawAccountName = usageData.accountInfo?.name;
    const accountName = rawAccountName
        ? rawAccountName.replace(/'s Organi[sz]ation$/, '')
        : null;
    if (accountName) {
        tooltipLines.push(`**${accountName}**`);
    }
    if (credentialsInfo) {
        const plan = formatSubscriptionType(credentialsInfo.subscriptionType);
        const tier = formatRateLimitTier(credentialsInfo.rateLimitTier);
        if (plan && tier && tier !== plan) {
            tooltipLines.push(`${plan} · ${tier}`);
        } else if (plan) {
            tooltipLines.push(plan);
        }
    }
    if (accountName || credentialsInfo) {
        tooltipLines.push('');
    }

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
        const weeklyPrecisionThreshold = config.get('statusBar.weeklyPrecisionThreshold', 75);
        const resetTimeStr = usageData.resetTimeWeek || '';
        const isWithin24hrs = !resetTimeStr.includes('d');
        const needsMinutePrecision = isWithin24hrs && weeklyPercent >= weeklyPrecisionThreshold;
        const weeklyTimeFormat = needsMinutePrecision
            ? { hour: 'numeric', minute: '2-digit' }
            : { hour: 'numeric' };
        weeklyResetTime = calculateResetClockTime(usageData.resetTimeWeek, weeklyTimeFormat);
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

    // Footer
    tooltipLines.push('');
    if (usageData.timestamp) {
        tooltipLines.push(`Updated: ${usageData.timestamp.toLocaleTimeString(undefined, { hour12: !getUse24HourTime() })}`);
    }
    const extVersion = vscode.extensions.getExtension('forge.claude-pal')?.packageJSON?.version;
    if (extVersion) {
        tooltipLines.push(`Claude Pal v${extVersion}`);
    }
    tooltipLines.push('[Click to resync account](command:claudePal.resyncAccount)');

    const markdown = new vscode.MarkdownString(tooltipLines.join('  \n'));
    markdown.isTrusted = true;
    if (!isSpinnerActive) {
        setAllTooltips(markdown);
    }

    // --- Render session bar item ---
    let newSessionText = null;
    if (sessionPercent !== null) {
        const sessionDisplay = formatPercent(sessionPercent);
        newSessionText = `${sessionStatus.icon ? sessionStatus.icon + ' ' : ''}Se ${sessionDisplay} $(history) ${sessionResetTime}`;
    }

    if (newSessionText !== lastDisplayedValues.sessionText) {
        if (newSessionText) {
            statusBarItems.session.text = newSessionText;
            statusBarItems.session.color = sessionStatus.color;
            statusBarItems.session.show();
        } else {
            statusBarItems.session.hide();
        }
        lastDisplayedValues.sessionText = newSessionText;
    }

    // --- Render weekly bar item ---
    let newWeeklyText = null;
    if (weeklyPercent !== null) {
        const weeklyDisplay = formatPercent(weeklyPercent);
        newWeeklyText = `${weeklyStatus.icon ? weeklyStatus.icon + ' ' : ''}Wk ${weeklyDisplay} $(history) ${weeklyResetTime}`;
    }

    if (newWeeklyText !== lastDisplayedValues.weeklyText) {
        if (newWeeklyText) {
            statusBarItems.weekly.text = newWeeklyText;
            statusBarItems.weekly.color = weeklyStatus.color;
            statusBarItems.weekly.show();
        } else {
            statusBarItems.weekly.hide();
        }
        lastDisplayedValues.weeklyText = newWeeklyText;
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
            '• Run "Claude Pal: Clear Session (Re-login)" to re-authenticate'
        ];
        setAllTooltips(new vscode.MarkdownString(errorLines.join('  \n')));

        if (statusBarItems.label) {
            statusBarItems.label.text = `${statusBarItems.label.text.replace(/ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/, '').trim()} ✗`;
            statusBarItems.label.color = new vscode.ThemeColor('errorForeground');
        }
    } else if (webError) {
        const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        const isLoginCancelled = webError.message.includes('Login cancelled');
        const isTokenOnlyMode = webError.message.includes('token-only mode') || config.get('tokenOnlyMode', false);

        let errorLines;
        if (isLoginCancelled || isTokenOnlyMode) {
            errorLines = [
                '**Token-Only Mode**',
                '',
                isLoginCancelled
                    ? 'Login was cancelled. Showing Claude Code tokens only.'
                    : 'Token-only mode enabled. Showing Claude Code tokens only.',
                '',
                'Claude.ai web usage (session/weekly limits) not available.',
                '',
                '**Actions**',
                '• **Click to retry login**',
                '• Or enable `claudePal.tokenOnlyMode` in settings to disable this message'
            ];
        } else {
            errorLines = [
                '**Web Fetch Failed**',
                '',
                `Error: ${webError.message}`,
                '',
                '**Debug Info**',
                `Time: ${new Date().toLocaleString()}`,
                '',
                '**Actions**',
                '• Click to retry',
                '• Run "Claude Pal: Show Debug Output" for details',
                '• Run "Claude Pal: Clear Session (Re-login)" to re-authenticate'
            ];
        }
        setAllTooltips(new vscode.MarkdownString(errorLines.join('  \n')));

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
