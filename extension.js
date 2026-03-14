// Project:   Claude Pal v2 (Streamlined)
// File:      extension.js
// Purpose:   VS Code extension entry point and lifecycle management
// Language:  JavaScript (CommonJS)
//
// v2 replaces Puppeteer browser automation with streamlined HTTP cookie-based
// fetching. The legacy browser scraper is retained as an opt-in fallback via
// the "claudePal.useLegacyScraper" setting.
//
// License:   MIT
// Copyright: (c) 2026 forge

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ClaudeHttpFetcher } = require('./src/httpFetcher');

// Legacy scraper is lazy-loaded only when useLegacyScraper is enabled.
// This avoids loading puppeteer-core (an external dependency not bundled in the VSIX)
// at startup when it's not needed.
let _scraperModule = null;
function getScraperModule() {
    if (!_scraperModule) {
        _scraperModule = require('./src/scraper');
    }
    return _scraperModule;
}
function getLegacyBrowserState() {
    return getScraperModule().BrowserState;
}
const { createStatusBarItem, updateStatusBar, startSpinner, stopSpinner, refreshServiceStatus } = require('./src/statusBar');
const { ActivityMonitor } = require('./src/activityMonitor');
const { setupNotifier, teardownNotifier, toggleSound } = require('./src/notifier');
const { CONFIG_NAMESPACE, COMMANDS, PATHS, setDevMode, isDebugEnabled, getDebugChannel, disposeDebugChannel, initFileLogger, fileLog, getDefaultDebugLogPath, formatModelName, capitalizeFirst } = require('./src/utils');
const { ClaudeDataLoader } = require('./src/claudeDataLoader');
const { MODES, getCurrentMode, setMode, getModeDisplay } = require('./src/permissionsManager');
const { CREDENTIALS_PATH, readCredentials, formatSubscriptionType, formatRateLimitTier } = require('./src/credentialsReader');

let statusBarItem;
let httpFetcher;
let scraper; // Legacy browser-based scraper
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

function isLegacyMode() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    return config.get('useLegacyScraper', false);
}

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
    const fetcher = isLegacyMode() ? scraper : httpFetcher;
    if (!isManualRetry && fetcher && !fetcher.hasExistingSession()) {
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

// Fetch usage data from Claude.ai
async function fetchUsage(isManualRetry = false) {
    fileLog(`fetchUsage() called (isManualRetry=${isManualRetry}, legacy=${isLegacyMode()})`);

    if (isLegacyMode()) {
        return fetchUsageLegacy(isManualRetry);
    }

    return fetchUsageHttp(isManualRetry);
}

// v2 default: HTTP cookie-based fetching
async function fetchUsageHttp(isManualRetry = false) {
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
        fileLog(`fetchUsageHttp() error: ${error.message}`);

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
                } else if (loginError.message === 'LOGIN_IN_PROGRESS') {
                    return { webError: null, loginCancelled: false };
                } else if (loginError.message === 'LOGIN_TIMEOUT') {
                    return { webError: new Error('Login timed out. Click status bar to retry.'), loginCancelled: false };
                } else if (loginError.message === 'CHROME_NOT_FOUND') {
                    return { webError: new Error('Chromium-based browser required. Install Chrome, Chromium, Brave, or Edge to fetch Claude.ai usage stats.'), loginCancelled: false };
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

// Legacy: browser-based scraping (fallback if HTTP method breaks)
async function fetchUsageLegacy(isManualRetry = false) {
    if (!scraper) {
        scraper = new (getScraperModule().ClaudeUsageScraper)();
        fileLog('Created new ClaudeUsageScraper instance (legacy mode)');
    }

    try {
        const hasSession = scraper.hasExistingSession();
        fileLog(`Legacy: hasExistingSession() = ${hasSession}`);

        if (hasSession) {
            fileLog('Legacy: Initializing scraper (headless)...');
            await scraper.initialize(false);
        }

        if (isManualRetry) {
            getLegacyBrowserState().clear();
        }

        fileLog('Legacy: Calling ensureLoggedIn()...');
        await scraper.ensureLoggedIn();
        fileLog('Legacy: ensureLoggedIn() completed');

        fileLog('Legacy: Calling fetchUsageData()...');
        usageData = await scraper.fetchUsageData();
        fileLog('Legacy: fetchUsageData() completed successfully');

        return { webError: null, loginCancelled: false };
    } catch (error) {
        fileLog(`Legacy: fetchUsage() error: ${error.message}`);
        if (error.message === 'CHROME_NOT_FOUND') {
            return { webError: new Error('Chromium-based browser required. Install Chrome, Chromium, Brave, or Edge to fetch Claude.ai usage stats.'), loginCancelled: false };
        } else if (error.message === 'LOGIN_CANCELLED') {
            return { webError: new Error('Login cancelled. Click status bar to retry.'), loginCancelled: true };
        } else if (error.message === 'LOGIN_FAILED_SHARED') {
            return { webError: new Error('Login failed in another window. Running in token-only mode.'), loginCancelled: true };
        } else if (error.message === 'LOGIN_IN_PROGRESS') {
            return { webError: null, loginCancelled: false };
        } else if (error.message === 'LOGIN_TIMEOUT') {
            return { webError: new Error('Login timed out. Click status bar to retry.'), loginCancelled: false };
        } else if (error.message.includes('Browser busy')) {
            return { webError: new Error('Another Claude Pal is logging in. Please wait and retry.'), loginCancelled: false };
        }
        return { webError: error, loginCancelled: false };
    } finally {
        if (scraper) {
            fileLog('Legacy: Closing scraper...');
            await scraper.close();
            fileLog('Legacy: Scraper closed');
        }
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

            // Detect account switch by orgId change (including null transitions for
            // personal <-> org switches). Token fields are NOT used -- Claude routinely
            // rotates refresh tokens during normal OAuth refresh cycles, which would
            // cause false positives if we tracked them.
            // Personal -> personal switches cannot be detected this way; the
            // "Resync Account" command (claudePal.resyncAccount) handles that case.
            const orgChanged = previous && credentialsInfo.orgId !== previous.orgId;

            if (orgChanged) {
                const fmt = id => id ? `${id.slice(0, 8)}...` : 'personal';
                const hint = `${fmt(previous.orgId)} -> ${fmt(credentialsInfo.orgId)}`;
                fileLog(`Account switched (${hint})`);
                fileLog(`New plan: ${formatSubscriptionType(credentialsInfo.subscriptionType)} (${formatRateLimitTier(credentialsInfo.rateLimitTier)})`);

                // Clear session so next fetch uses the new account
                if (isLegacyMode()) {
                    getLegacyBrowserState().clear();
                    if (fs.existsSync(PATHS.BROWSER_SESSION_DIR)) {
                        try {
                            fs.rmSync(PATHS.BROWSER_SESSION_DIR, { recursive: true, force: true });
                            fileLog('Browser session cleared for account switch');
                        } catch (e) {
                            fileLog(`Failed to clear browser session: ${e.message}`);
                        }
                    }
                } else if (httpFetcher) {
                    // Clear login browser cache so the browser opens fresh for the
                    // new account rather than auto-logging in as the old one
                    httpFetcher.clearSession({ clearLoginBrowserCache: true });
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

// Auto-populate debugLogFile setting on first run
async function initializeDebugLogPath() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const currentPath = config.get('debugLogFile', '');

    if (!currentPath || !currentPath.trim()) {
        const defaultPath = getDefaultDebugLogPath();
        try {
            await config.update('debugLogFile', defaultPath, vscode.ConfigurationTarget.Global);
            console.log(`Claude Pal: Initialized debugLogFile to ${defaultPath}`);
        } catch (error) {
            console.error('Failed to initialize debugLogFile setting:', error);
        }
    }
}

// Migrate deprecated boolean settings to new enum settings
async function migrateDeprecatedSettings() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    // Migrate use24HourTime (boolean) -> timeFormat (enum)
    const use24Hour = config.inspect('statusBar.use24HourTime');
    if (use24Hour?.globalValue === true) {
        await config.update('statusBar.timeFormat', '24hour', vscode.ConfigurationTarget.Global);
        await config.update('statusBar.use24HourTime', undefined, vscode.ConfigurationTarget.Global);
        console.log('Claude Pal: Migrated use24HourTime=true -> timeFormat=24hour');
    }
    if (use24Hour?.workspaceValue === true) {
        await config.update('statusBar.timeFormat', '24hour', vscode.ConfigurationTarget.Workspace);
        await config.update('statusBar.use24HourTime', undefined, vscode.ConfigurationTarget.Workspace);
    }

    // Migrate useCountdownTimer (boolean) -> timeFormat (enum)
    const useCountdown = config.inspect('statusBar.useCountdownTimer');
    if (useCountdown?.globalValue === true) {
        await config.update('statusBar.timeFormat', 'countdown', vscode.ConfigurationTarget.Global);
        await config.update('statusBar.useCountdownTimer', undefined, vscode.ConfigurationTarget.Global);
        console.log('Claude Pal: Migrated useCountdownTimer=true -> timeFormat=countdown');
    }
    if (useCountdown?.workspaceValue === true) {
        await config.update('statusBar.timeFormat', 'countdown', vscode.ConfigurationTarget.Workspace);
        await config.update('statusBar.useCountdownTimer', undefined, vscode.ConfigurationTarget.Workspace);
    }

    // Migrate useProgressBars (boolean) -> usageFormat (enum)
    const useProgressBars = config.inspect('statusBar.useProgressBars');
    if (useProgressBars?.globalValue === true) {
        await config.update('statusBar.usageFormat', 'barLight', vscode.ConfigurationTarget.Global);
        await config.update('statusBar.useProgressBars', undefined, vscode.ConfigurationTarget.Global);
        console.log('Claude Pal: Migrated useProgressBars=true -> usageFormat=barLight');
    }
    if (useProgressBars?.workspaceValue === true) {
        await config.update('statusBar.usageFormat', 'barLight', vscode.ConfigurationTarget.Workspace);
        await config.update('statusBar.useProgressBars', undefined, vscode.ConfigurationTarget.Workspace);
    }
}

async function activate(context) {
    // Enable debug mode in Extension Development Host (F5)
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        setDevMode(true);
    }

    // Migrate any deprecated boolean settings to new enum settings
    await migrateDeprecatedSettings();

    // Auto-populate debugLogFile setting if empty
    await initializeDebugLogPath();

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
    }, 5 * 60 * 1000);  // 5 minutes

    activityMonitor = new ActivityMonitor();
    activityMonitor.startMonitoring(context);

    setupCredentialsMonitoring(context);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.SHOW_MENU, async () => {
            const currentMode = getCurrentMode();
            const modeLabel = currentMode === MODES.YOLO ? '$(zap) YOLO'
                : currentMode === MODES.YOLO_SAFE ? '$(shield) YOLO Safe'
                : '$(lock) Normal';

            const items = [
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                { label: `Permissions: ${modeLabel}`, kind: vscode.QuickPickItemKind.Separator },
                {
                    label: currentMode === MODES.YOLO ? '$(check) YOLO — Approve All' : '$(zap) YOLO — Approve All',
                    description: currentMode === MODES.YOLO ? '(active)' : '',
                    action: 'yolo',
                },
                {
                    label: currentMode === MODES.YOLO_SAFE ? '$(check) YOLO Safe — Non-destructive Only' : '$(shield) YOLO Safe — Non-destructive Only',
                    description: currentMode === MODES.YOLO_SAFE ? '(active)' : '',
                    action: 'yolo-safe',
                },
                {
                    label: currentMode === MODES.NORMAL ? '$(check) Normal — Ask for Permission' : '$(lock) Normal — Ask for Permission',
                    description: currentMode === MODES.NORMAL ? '(active)' : '',
                    action: 'normal',
                },
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                { label: '$(sync) Fetch Usage Now', command: COMMANDS.FETCH_NOW },
                { label: '$(account) Resync Account', command: COMMANDS.RESYNC_ACCOUNT },
                { label: '$(globe) Open Claude.ai Settings', command: COMMANDS.OPEN_SETTINGS },
                { label: '$(browser) Login to Claude.ai', command: COMMANDS.OPEN_BROWSER },
                { label: '$(unmute) Toggle Sound', command: COMMANDS.TOGGLE_SOUND },
                { label: '$(trash) Clear Session', command: COMMANDS.CLEAR_SESSION },
                { label: '$(output) Show Debug Output', command: COMMANDS.SHOW_DEBUG },
            ];
            const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Claude Pal' });
            if (!picked) return;
            if (picked.action) {
                setMode(picked.action);
                await updateStatusBarWithAllData();
            } else if (picked.command) {
                vscode.commands.executeCommand(picked.command);
            }
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
        vscode.commands.registerCommand(COMMANDS.START_SESSION, async () => {
            fileLog('Start session command is deprecated');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.SHOW_DEBUG, async () => {
            const debugChannel = getDebugChannel();

            debugChannel.appendLine(`\n=== DIAGNOSTICS (${new Date().toLocaleString()}) ===`);
            debugChannel.appendLine(`Mode: ${isLegacyMode() ? 'Legacy (browser scraper)' : 'HTTP (streamlined)'}`);

            if (isLegacyMode() && scraper) {
                const diag = scraper.getDiagnostics();
                debugChannel.appendLine('Scraper State (Legacy):');
                debugChannel.appendLine(`  Initialised: ${diag.isInitialized}`);
                debugChannel.appendLine(`  Has Browser: ${diag.hasBrowser}`);
                debugChannel.appendLine(`  Has API Endpoint: ${diag.hasApiEndpoint}`);
                debugChannel.appendLine(`  Org ID: ${diag.currentOrgId || 'none'}`);
                debugChannel.appendLine(`  Account: ${diag.accountName || 'unknown'}`);
            } else if (httpFetcher) {
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
        vscode.commands.registerCommand(COMMANDS.RESET_CONNECTION, async () => {
            if (!isLegacyMode()) {
                fileLog('Reset Connection is only available in legacy scraper mode');
                return;
            }
            try {
                if (scraper) {
                    const result = await scraper.reset();
                    fileLog(`Reset: ${result.message}`);
                }
            } catch (error) {
                fileLog(`Reset failed: ${error.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.CLEAR_SESSION, async () => {
            try {
                if (isLegacyMode()) {
                    if (!scraper) scraper = new (getScraperModule().ClaudeUsageScraper)();
                    scraper.clearSession();
                } else {
                    if (!httpFetcher) httpFetcher = new ClaudeHttpFetcher();
                    httpFetcher.clearSession();
                }
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
                httpFetcher.clearSession({ clearLoginBrowserCache: true });
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
                if (isLegacyMode()) {
                    if (!scraper) scraper = new (getScraperModule().ClaudeUsageScraper)();
                    await scraper.forceOpenBrowser();
                } else {
                    if (!httpFetcher) httpFetcher = new ClaudeHttpFetcher();
                    await httpFetcher.login();
                    await performFetch(true);
                }
            } catch (error) {
                fileLog(`Open browser failed: ${error.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.TOGGLE_SOUND, () => toggleSound())
    );

    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    if (config.get('fetchOnStartup', true)) {
        console.log('Claude Pal: Scheduling fetch on startup...');
        setTimeout(async () => {
            // Check if we have a session before fetching
            const fetcher = isLegacyMode() ? null : new ClaudeHttpFetcher();
            const hasSession = isLegacyMode()
                ? (getScraperModule().ClaudeUsageScraper.prototype.hasExistingSession
                    ? new (getScraperModule().ClaudeUsageScraper)().hasExistingSession()
                    : false)
                : (fetcher && fetcher.hasExistingSession());

            if (!hasSession && !isLegacyMode()) {
                // No session cookie -- skip silently. User can click status bar to login.
                httpFetcher = fetcher;
                fileLog('No session cookie found on startup -- skipping (click status bar to login)');
                return;
            }

            console.log('Claude Pal: Starting fetch on startup...');
            try {
                if (fetcher && !isLegacyMode()) httpFetcher = fetcher;
                const result = await performFetch();
                if (result.webError) {
                    console.log('Claude Pal: Startup fetch web error:', result.webError.message);
                }
                console.log('Claude Pal: Fetch on startup complete');
            } catch (error) {
                console.error('Claude Pal: Fetch on startup failed:', error);
            }
        }, 2000);
    }

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

            if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBar`)) {
                await updateStatusBarWithAllData();
            }

            if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.thresholds`)) {
                await updateStatusBarWithAllData();
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

    if (scraper) {
        try {
            await scraper.close();
        } catch (err) {
            console.error('Error closing scraper:', err);
        }
    }
}

module.exports = {
    activate,
    deactivate
};
