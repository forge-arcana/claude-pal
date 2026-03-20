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
const { ClaudeHttpFetcher, SessionError } = require('./src/httpFetcher');
const { createStatusBarItem, updateStatusBar, startSpinner, stopSpinner, refreshServiceStatus } = require('./src/statusBar');
const { setupNotifier, teardownNotifier, toggleSound, setSoundEnabled, changeSoundPicker } = require('./src/notifier');
const { CONFIG_NAMESPACE, COMMANDS, TIMEOUTS, setDevMode, getDebugChannel, disposeDebugChannel, initFileLogger, fileLog, formatModelName, capitalizeFirst } = require('./src/utils');
const { ClaudeDataLoader } = require('./src/claudeDataLoader');
const { MODES, getCurrentMode, setMode } = require('./src/permissionsManager');
const { showQuickMenu } = require('./src/quickMenu');
const { CREDENTIALS_PATH, readCredentials, formatSubscriptionType, formatRateLimitTier } = require('./src/credentialsReader');
const { readSettings } = require('./src/claudeSettings');

let statusBarItem;
let httpFetcher = null;

/** Prompt user for session key — UI lives here, not in the fetcher (DIP). */
async function promptForSessionKey() {
    const { CLAUDE_URLS } = require('./src/utils');
    await vscode.env.openExternal(vscode.Uri.parse(CLAUDE_URLS.LOGIN));
    return vscode.window.showInputBox({
        title: 'Claude Pal — Paste Session Cookie',
        prompt: 'Log in to claude.ai, then copy your sessionKey cookie from DevTools (F12 → Application → Cookies → claude.ai → sessionKey)',
        placeHolder: 'sk-ant-...',
        ignoreFocusOut: true,
        password: true,
    });
}

function ensureFetcher() {
    if (!httpFetcher) httpFetcher = new ClaudeHttpFetcher();
    return httpFetcher;
}
let usageData = null;
let credentialsInfo = null;
let autoRefreshTimer;
let serviceStatusTimer;
let startupTimer;
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
        stopSpinner(webError);
        await updateStatusBarWithAllData();
    }

    return { webError, loginCancelled: loginWasCancelled };
}

// Fetch usage data from Claude.ai via HTTP
async function fetchUsage(isManualRetry = false) {
    fileLog(`fetchUsage() called (isManualRetry=${isManualRetry})`);

    ensureFetcher();

    try {
        fileLog('Calling fetchUsageData()...');
        usageData = await httpFetcher.fetchUsageData();
        fileLog('fetchUsageData() completed successfully');
        return { webError: null, loginCancelled: false };
    } catch (error) {
        fileLog(`fetchUsage() error: ${error.message}`);

        if (error instanceof SessionError) {
            usageData = null; // Clear stale data so status bar shows login prompt
            if (!isManualRetry) {
                const msg = error.code === 'NO_ORG_ID'
                    ? 'No Claude Code credentials found. Install and run Claude Code first.'
                    : 'No session. Click status bar to login.';
                return { webError: new Error(msg), loginCancelled: false };
            }

            // Manual retry: trigger login flow
            try {
                fileLog('Triggering login flow...');
                await httpFetcher.login(promptForSessionKey);
                fileLog('Login completed, retrying fetch...');
                usageData = await httpFetcher.fetchUsageData();
                fileLog('Post-login fetch successful');
                return { webError: null, loginCancelled: false };
            } catch (loginError) {
                fileLog(`Login/fetch error: ${loginError.message}`);
                if (loginError instanceof SessionError && loginError.code === 'LOGIN_CANCELLED') {
                    return { webError: new Error('Login cancelled. Click status bar to retry.'), loginCancelled: true };
                }
                return { webError: loginError, loginCancelled: false };
            }
        }

        if (error instanceof SessionError && error.code === 'LOGIN_IN_PROGRESS') {
            console.log('Claude Pal: Another instance is logging in, skipping this fetch');
            return { webError: null, loginCancelled: false };
        }

        console.error('Web fetch failed:', error);
        return { webError: error, loginCancelled: false };
    }
}

function readEffortLevel() {
    const settings = readSettings();
    return settings.effortLevel ? capitalizeFirst(settings.effortLevel) : null;
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
    const permissionMode = getCurrentMode();
    updateStatusBar(statusBarItem, usageData, credentialsInfo, currentModelInfo, permissionMode);
}

function createAutoRefreshTimer(minutes) {
    const clampedMinutes = Math.max(1, Math.min(60, minutes));

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
    }, TIMEOUTS.SERVICE_STATUS_REFRESH);
    context.subscriptions.push({ dispose: () => { if (serviceStatusTimer) { clearInterval(serviceStatusTimer); serviceStatusTimer = null; } } });

    setupCredentialsMonitoring(context);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.SHOW_MENU, async () => {
            await showQuickMenu(usageData, updateStatusBarWithAllData);
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
                ensureFetcher();
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
                ensureFetcher();
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
                ensureFetcher();
                await httpFetcher.login(promptForSessionKey);
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
    startupTimer = setTimeout(async () => {
        ensureFetcher();
        if (!httpFetcher.hasExistingSession()) {
            fileLog('No session cookie found on startup -- skipping (click status bar to login)');
            return;
        }

        console.log('Claude Pal: Starting fetch on startup...');
        try {
            const result = await performFetch();
            if (result.webError) {
                console.log('Claude Pal: Startup fetch web error:', result.webError.message);
            }
            console.log('Claude Pal: Fetch on startup complete');
        } catch (error) {
            console.error('Claude Pal: Fetch on startup failed:', error);
        }
    }, TIMEOUTS.STARTUP_DELAY);

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
    if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
    }

    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }

    if (serviceStatusTimer) {
        clearInterval(serviceStatusTimer);
        serviceStatusTimer = null;
    }

    if (credentialsWatcher) {
        credentialsWatcher.dispose();
        credentialsWatcher = null;
    }

    teardownNotifier();
}

module.exports = {
    activate,
    deactivate
};
