// Project:   Claude Pal
// File:      extension.js
// Purpose:   VS Code extension entry point and lifecycle management
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ClaudeHttpFetcher } = require('./src/httpFetcher');
const { createStatusBarItem, updateStatusBar, startSpinner, stopSpinner, refreshServiceStatus } = require('./src/statusBar');
const { ActivityMonitor } = require('./src/activityMonitor');
const { setupNotifier, teardownNotifier, toggleSound, setSoundEnabled, changeSoundPicker } = require('./src/notifier');
const { CONFIG_NAMESPACE, COMMANDS, setDevMode, isDebugEnabled, getDebugChannel, disposeDebugChannel, initFileLogger, fileLog, formatModelName, capitalizeFirst } = require('./src/utils');
const { ClaudeDataLoader } = require('./src/claudeDataLoader');
const { MODES, getCurrentMode, setMode, getModeDisplay } = require('./src/permissionsManager');
const { CREDENTIALS_PATH, readCredentials, formatSubscriptionType, formatRateLimitTier } = require('./src/credentialsReader');

let statusBarItem;
let httpFetcher;
let usageData = null;
let credentialsInfo = null;
let autoRefreshTimer;
let serviceStatusTimer;
let activityMonitor;
let credentialsWatcher;
let currentWorkspacePath = null;
let claudeDataLoader = null;
let currentModelInfo = null;

// Prevents auto-retry after user closes login browser
let loginWasCancelled = false;

// Fetch with spinner, error handling, and login state management
async function performFetch(isManualRetry = false) {
    let webError = null;

    // Skip web fetch if user previously cancelled login (unless they clicked to retry)
    if (loginWasCancelled && !isManualRetry) {
        console.log('Claude Pal: Skipping web fetch (login was cancelled). Click status bar to retry.');
        await updateStatusBarWithAllData();
        return { webError: new Error('Login cancelled. Click status bar to retry.'), loginCancelled: true };
    }

    // Don't prompt for login on auto-refresh - only when user explicitly clicks
    if (!isManualRetry && httpFetcher && !httpFetcher.hasExistingSession()) {
        console.log('Claude Pal: No session exists, skipping auto-refresh web fetch. Click status bar to login.');
        await updateStatusBarWithAllData();
        return { webError: new Error('No session. Click status bar to login.'), loginCancelled: false };
    }

    try {
        startSpinner();

        if (isManualRetry && loginWasCancelled) {
            console.log('Claude Pal: Manual retry - attempting login again');
            loginWasCancelled = false;
        }

        const result = await fetchUsage(isManualRetry);
        webError = result.webError;
        const wasLoginCancelled = result.loginCancelled || false;

        if (wasLoginCancelled) {
            loginWasCancelled = true;
        }
    } catch (error) {
        webError = webError || error;
        console.error('Failed to fetch usage:', error);
    } finally {
        stopSpinner(webError, null);
        await updateStatusBarWithAllData();
    }

    return { webError, loginCancelled: loginWasCancelled };
}

// Fetch usage data from Claude.ai via HTTP
async function fetchUsage(isManualRetry = false) {
    fileLog(`fetchUsage() called (isManualRetry=${isManualRetry})`);

    if (!httpFetcher) {
        httpFetcher = new ClaudeHttpFetcher();
        fileLog('Created new ClaudeHttpFetcher instance');
    }

    try {
        fileLog('Calling fetchUsageData()...');
        usageData = await httpFetcher.fetchUsageData();
        fileLog('fetchUsageData() completed successfully');
        return { webError: null, loginCancelled: false };
    } catch (error) {
        fileLog(`fetchUsage() error: ${error.message}`);

        if (error.message === 'NO_SESSION' || error.message === 'SESSION_EXPIRED' || error.message === 'NO_ORG_ID') {
            if (!isManualRetry) {
                const msg = error.message === 'NO_ORG_ID'
                    ? 'No Claude Code credentials found. Install and run Claude Code first.'
                    : 'No session. Click status bar to login.';
                return { webError: new Error(msg), loginCancelled: false };
            }

            // Manual retry: trigger login flow
            try {
                fileLog('Triggering login flow...');
                await httpFetcher.login();
                fileLog('Login completed, retrying fetch...');
                usageData = await httpFetcher.fetchUsageData();
                fileLog('Post-login fetch successful');
                return { webError: null, loginCancelled: false };
            } catch (loginError) {
                fileLog(`Login/fetch error: ${loginError.message}`);
                if (loginError.message === 'LOGIN_CANCELLED') {
                    return { webError: new Error('Login cancelled. Click status bar to retry.'), loginCancelled: true };
                }
                return { webError: loginError, loginCancelled: false };
            }
        }

        if (error.message === 'LOGIN_IN_PROGRESS') {
            console.log('Claude Pal: Another instance is logging in, skipping this fetch');
            return { webError: null, loginCancelled: false };
        }

        console.error('Web fetch failed:', error);
        return { webError: error, loginCancelled: false };
    }
}

// Read effortLevel from ~/.claude/settings.json
function readEffortLevel() {
    try {
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        if (fs.existsSync(settingsPath)) {
            const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            return data.effortLevel ? capitalizeFirst(data.effortLevel) : null;
        }
    } catch { /* ignore */ }
    return null;
}

async function refreshModelInfo() {
    if (!claudeDataLoader) return;
    try {
        const raw = await claudeDataLoader.getCurrentModelInfo();
        if (raw && raw.model) {
            currentModelInfo = {
                model: raw.model,
                modelDisplay: formatModelName(raw.model),
                hasThinking: raw.hasThinking,
                effortLevel: readEffortLevel(),
            };
        }
    } catch (error) {
        fileLog(`refreshModelInfo error: ${error.message}`);
    }
}

async function updateStatusBarWithAllData() {
    await refreshModelInfo();
    const activityStats = activityMonitor ? activityMonitor.getStats(usageData, null) : null;
    const permissionMode = getCurrentMode();
    updateStatusBar(statusBarItem, usageData, activityStats, null, credentialsInfo, currentModelInfo, permissionMode);
}

function createAutoRefreshTimer(minutes) {
    const clampedMinutes = Math.max(1, Math.min(60, minutes));

    if (clampedMinutes <= 0) return null;

    console.log(`Web auto-refresh enabled: fetching Claude.ai usage every ${clampedMinutes} minutes`);

    return setInterval(async () => {
        await performFetch();
    }, clampedMinutes * 60 * 1000);
}

function setupCredentialsMonitoring(context) {
    // Read credentials on startup
    credentialsInfo = readCredentials();
    if (credentialsInfo) {
        fileLog(`Credentials loaded: ${formatSubscriptionType(credentialsInfo.subscriptionType)} (${formatRateLimitTier(credentialsInfo.rateLimitTier)})`);
    } else {
        fileLog('No Claude Code credentials found');
    }

    // Watch for account switches
    const credentialsDir = path.dirname(CREDENTIALS_PATH);
    if (fs.existsSync(credentialsDir)) {
        credentialsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(credentialsDir, '.credentials.json')
        );

        const handleCredentialsChange = async () => {
            const previous = credentialsInfo;
            credentialsInfo = readCredentials();

            if (!credentialsInfo) return;

            const orgChanged = previous && credentialsInfo.orgId !== previous.orgId;

            if (orgChanged) {
                const fmt = id => id ? `${id.slice(0, 8)}...` : 'personal';
                const hint = `${fmt(previous.orgId)} -> ${fmt(credentialsInfo.orgId)}`;
                fileLog(`Account switched (${hint})`);
                fileLog(`New plan: ${formatSubscriptionType(credentialsInfo.subscriptionType)} (${formatRateLimitTier(credentialsInfo.rateLimitTier)})`);

                // Clear session so next fetch uses the new account
                if (httpFetcher) {
                    httpFetcher.clearSession();
                }
                loginWasCancelled = false;

                // Auto-fetch for the new account
                performFetch(true).catch(err => {
                    fileLog(`Post-switch fetch failed: ${err.message}`);
                });
            } else {
                await updateStatusBarWithAllData();
            }
        };

        credentialsWatcher.onDidChange(handleCredentialsChange);
        credentialsWatcher.onDidCreate(handleCredentialsChange);
        context.subscriptions.push(credentialsWatcher);
        fileLog('Watching ~/.claude/.credentials.json for account changes');
    }
}

async function activate(context) {
    // Enable debug mode in Extension Development Host (F5)
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        setDevMode(true);
    }

    // Log version on startup for debugging
    const version = context.extension.packageJSON.version;
    fileLog(`Claude Pal v${version} starting`);

    currentWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || null;
    initFileLogger(currentWorkspacePath);
    claudeDataLoader = new ClaudeDataLoader(currentWorkspacePath, fileLog);

    if (currentWorkspacePath) {
        fileLog(`Extension activated for workspace: ${currentWorkspacePath}`);
    } else {
        fileLog('Extension activated (no workspace)');
    }

    statusBarItem = createStatusBarItem(context);

    // Set up sound notifier (hook deployment, signal watcher)
    setupNotifier(context);

    // Fetch service status immediately and set up periodic refresh (every 5 minutes)
    refreshServiceStatus().then(() => updateStatusBarWithAllData()).catch(err => {
        console.log('Claude Pal: Initial service status fetch failed:', err.message);
    });
    serviceStatusTimer = setInterval(() => {
        refreshServiceStatus().then(() => updateStatusBarWithAllData()).catch(err => {
            console.log('Claude Pal: Service status refresh failed:', err.message);
        });
    }, 5 * 60 * 1000);

    activityMonitor = new ActivityMonitor();
    activityMonitor.startMonitoring(context);

    setupCredentialsMonitoring(context);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.SHOW_MENU, async () => {
            await updateStatusBarWithAllData();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.FETCH_NOW, async () => {
            const { webError } = await performFetch(true);
            if (webError) {
                fileLog(`Fetch failed: ${webError.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.OPEN_SETTINGS, async () => {
            await vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/settings'));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.SHOW_DEBUG, async () => {
            const debugChannel = getDebugChannel();

            debugChannel.appendLine(`\n=== DIAGNOSTICS (${new Date().toLocaleString()}) ===`);

            if (httpFetcher) {
                const diag = httpFetcher.getDiagnostics();
                debugChannel.appendLine('Fetcher State:');
                debugChannel.appendLine(`  Has Cookie: ${diag.hasCookie}`);
                debugChannel.appendLine(`  Cookie Expires: ${diag.cookieExpires || 'N/A'}`);
                debugChannel.appendLine(`  Cookie Saved At: ${diag.cookieSavedAt || 'N/A'}`);
                debugChannel.appendLine(`  Org ID: ${diag.orgId || 'none'}`);
                debugChannel.appendLine(`  Subscription: ${diag.subscriptionType || 'unknown'}`);
                debugChannel.appendLine(`  Rate Limit Tier: ${diag.rateLimitTier || 'unknown'}`);
            } else {
                debugChannel.appendLine('Fetcher not initialised');
            }

            debugChannel.appendLine('');
            debugChannel.appendLine('Usage Data State:');
            if (usageData) {
                debugChannel.appendLine(`  Last Updated: ${usageData.timestamp}`);
                debugChannel.appendLine(`  Account: ${usageData.accountInfo?.name || 'unknown'}`);
                debugChannel.appendLine(`  Session Usage: ${usageData.usagePercent}%`);
                debugChannel.appendLine(`  Weekly Usage: ${usageData.usagePercentWeek}%`);
                debugChannel.appendLine(`  Has Monthly Credits: ${!!usageData.monthlyCredits}`);
            } else {
                debugChannel.appendLine('  No usage data available');
            }

            debugChannel.appendLine('=== END DIAGNOSTICS ===');
            debugChannel.show(true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.CLEAR_SESSION, async () => {
            try {
                if (!httpFetcher) httpFetcher = new ClaudeHttpFetcher();
                httpFetcher.clearSession();
                loginWasCancelled = false;
                fileLog('Session cleared');
            } catch (error) {
                fileLog(`Clear session failed: ${error.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.RESYNC_ACCOUNT, async () => {
            try {
                if (!httpFetcher) httpFetcher = new ClaudeHttpFetcher();
                httpFetcher.clearSession();
                loginWasCancelled = false;
                fileLog('Resync Account: session cleared, starting login flow');
                const { webError } = await performFetch(true);
                if (webError) {
                    fileLog(`Resync login failed: ${webError.message}`);
                }
            } catch (error) {
                fileLog(`Resync failed: ${error.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.OPEN_BROWSER, async () => {
            try {
                if (!httpFetcher) httpFetcher = new ClaudeHttpFetcher();
                await httpFetcher.login();
                await performFetch(true);
            } catch (error) {
                fileLog(`Open browser failed: ${error.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.TOGGLE_SOUND, () => toggleSound())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('claudePal.soundOn', () => {
            setSoundEnabled(true);
            updateStatusBarWithAllData();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('claudePal.soundOff', () => {
            setSoundEnabled(false);
            updateStatusBarWithAllData();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('claudePal.changePromptSound', () => {
            changeSoundPicker('prompt', updateStatusBarWithAllData);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('claudePal.changeDoneSound', () => {
            changeSoundPicker('done', updateStatusBarWithAllData);
        })
    );

    // Permission mode commands (triggered from tooltip command links)
    for (const mode of [MODES.YOLO, MODES.YOLO_SAFE, MODES.NORMAL]) {
        context.subscriptions.push(
            vscode.commands.registerCommand(`claudePal.setMode.${mode}`, async () => {
                setMode(mode);
                fileLog(`Permission mode set to: ${mode}`);
                await updateStatusBarWithAllData();
            })
        );
    }

    // Always fetch on startup
    console.log('Claude Pal: Scheduling fetch on startup...');
    setTimeout(async () => {
        const fetcher = new ClaudeHttpFetcher();
        if (!fetcher.hasExistingSession()) {
            httpFetcher = fetcher;
            fileLog('No session cookie found on startup -- skipping (click status bar to login)');
            return;
        }

        console.log('Claude Pal: Starting fetch on startup...');
        try {
            httpFetcher = fetcher;
            const result = await performFetch();
            if (result.webError) {
                console.log('Claude Pal: Startup fetch web error:', result.webError.message);
            }
            console.log('Claude Pal: Fetch on startup complete');
        } catch (error) {
            console.error('Claude Pal: Fetch on startup failed:', error);
        }
    }, 2000);

    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const autoRefreshMinutes = config.get('autoRefreshMinutes', 5);
    autoRefreshTimer = createAutoRefreshTimer(autoRefreshMinutes);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.autoRefreshMinutes`)) {
                if (autoRefreshTimer) {
                    clearInterval(autoRefreshTimer);
                    autoRefreshTimer = null;
                }

                const newConfig = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
                const newAutoRefresh = newConfig.get('autoRefreshMinutes', 5);
                autoRefreshTimer = createAutoRefreshTimer(newAutoRefresh);
            }
        })
    );

    context.subscriptions.push({
        dispose: () => disposeDebugChannel()
    });
}

async function deactivate() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }

    if (serviceStatusTimer) {
        clearInterval(serviceStatusTimer);
        serviceStatusTimer = null;
    }

    teardownNotifier();
}

module.exports = {
    activate,
    deactivate
};
