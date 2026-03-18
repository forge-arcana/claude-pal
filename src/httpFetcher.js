// HTTP-based Claude.ai usage data fetching.
// Uses native fetch() with a stored sessionKey cookie to call Claude.ai API
// endpoints directly. Login is handled by opening claude.ai in the user's
// browser and having them paste their sessionKey cookie.

const path = require('path');
const fs = require('fs');
const vscode = require('vscode');

const {
    USAGE_API_SCHEMA,
    extractFromSchema,
    processOverageData,
    processPrepaidData,
    getSchemaInfo,
} = require('./apiSchema');

const {
    PATHS,
    CLAUDE_URLS,
    isDebugEnabled,
    getDebugChannel,
    fileLog,
} = require('./utils');

const { readCredentials } = require('./credentialsReader');

// Browser-like headers to pass Cloudflare challenge
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Referer': 'https://claude.ai/settings/usage',
    'Origin': 'https://claude.ai',
};



class ClaudeHttpFetcher {
    constructor() {
        this.accountInfo = null;
    }

    // --- Cookie Management ---

    _readCookie() {
        try {
            if (!fs.existsSync(PATHS.SESSION_COOKIE_FILE)) {
                return null;
            }
            const data = JSON.parse(fs.readFileSync(PATHS.SESSION_COOKIE_FILE, 'utf-8'));
            if (!data.sessionKey) return null;
            return data;
        } catch (error) {
            fileLog(`Error reading session cookie: ${error.message}`);
            return null;
        }
    }

    _saveCookie(sessionKey, expires, orgId) {
        const dir = path.dirname(PATHS.SESSION_COOKIE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const data = {
            sessionKey,
            expires,
            savedAt: new Date().toISOString(),
            orgId: orgId || null,
        };
        fs.writeFileSync(PATHS.SESSION_COOKIE_FILE, JSON.stringify(data, null, 2));
        fileLog('Session cookie saved');
    }

    hasExistingSession() {
        const cookie = this._readCookie();
        if (!cookie) return false;
        // Check expiry if available
        if (cookie.expires && cookie.expires <= Date.now() / 1000) {
            fileLog('Session cookie expired');
            return false;
        }
        return true;
    }

    clearSession() {
        try {
            if (fs.existsSync(PATHS.SESSION_COOKIE_FILE)) {
                fs.unlinkSync(PATHS.SESSION_COOKIE_FILE);
                fileLog('Session cookie deleted');
            }
            this._cachedOrgId = null;
            return { success: true, message: 'Session cleared. Next fetch will prompt for login.' };
        } catch (error) {
            fileLog(`Error clearing session: ${error.message}`);
            return { success: false, message: `Failed to clear session: ${error.message}` };
        }
    }

    // --- HTTP Fetching ---

    // Fetch bootstrap using an explicit sessionKey (before it's saved to disk).
    async _fetchBootstrapWithKey(sessionKey) {
        const response = await fetch(`${CLAUDE_URLS.BASE}/api/bootstrap`, {
            method: 'GET',
            headers: {
                ...BROWSER_HEADERS,
                'Cookie': `sessionKey=${sessionKey}`,
            },
        });
        if (!response.ok) return null;
        return response.json();
    }

    // Fetch bootstrap using the CLI OAuth access token as a Bearer token.
    // Returns the account email if successful, null if the token doesn't work.
    async _fetchBootstrapWithCliToken() {
        const creds = readCredentials();
        if (!creds?.accessToken) return null;
        try {
            const response = await fetch(`${CLAUDE_URLS.BASE}/api/bootstrap`, {
                method: 'GET',
                headers: {
                    ...BROWSER_HEADERS,
                    'Authorization': `Bearer ${creds.accessToken}`,
                },
            });
            if (!response.ok) return null;
            const data = await response.json();
            return data?.account?.email_address || null;
        } catch {
            return null;
        }
    }

    async _fetchEndpoint(url) {
        const cookie = this._readCookie();
        if (!cookie) throw new Error('NO_SESSION');

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                ...BROWSER_HEADERS,
                'Cookie': `sessionKey=${cookie.sessionKey}`,
            },
        });

        if (response.status === 401 || response.status === 403) {
            // Check if it's a Cloudflare challenge vs actual auth failure
            const text = await response.text();
            if (text.includes('permission_error') || text.includes('account_session_invalid') || text.includes('"type":"error"')) {
                throw new Error('SESSION_EXPIRED');
            }
            // Cloudflare challenge or other issue
            throw new Error(`API_ERROR_${response.status}`);
        }

        if (!response.ok) {
            throw new Error(`API_ERROR_${response.status}`);
        }

        return response.json();
    }

    // Resolve the correct web org UUID via /api/bootstrap.
    // The CLI credentials orgId differs from the web session orgId.
    async _resolveOrgId() {
        if (this._cachedOrgId) return this._cachedOrgId;

        fileLog('Resolving web org UUID via /api/bootstrap...');
        const data = await this._fetchEndpoint(`${CLAUDE_URLS.BASE}/api/bootstrap`);
        const memberships = data?.account?.memberships;
        if (!memberships || memberships.length === 0) {
            throw new Error('NO_ORG_ID');
        }

        // Use first org (personal account). If there are multiple,
        // prefer the one matching the CLI credentials org name.
        const orgUuid = memberships[0].organization.uuid;
        const orgName = memberships[0].organization.name;
        this._cachedOrgId = orgUuid;

        this.accountInfo = {
            name: data.account?.display_name || data.account?.full_name,
            email: data.account?.email_address,
            orgName,
        };

        fileLog(`Resolved org: ${orgUuid.slice(0, 8)}... (${orgName})`);
        return orgUuid;
    }

    async fetchUsageData() {
        const debug = isDebugEnabled();
        const debugChannel = getDebugChannel();

        const cookie = this._readCookie();
        if (!cookie || !cookie.sessionKey) {
            throw new Error('NO_SESSION');
        }

        // Check cookie expiry
        if (cookie.expires && cookie.expires <= Date.now() / 1000) {
            throw new Error('SESSION_EXPIRED');
        }

        const orgId = await this._resolveOrgId();
        const baseUrl = `${CLAUDE_URLS.BASE}/api/organizations/${orgId}`;
        const usageUrl = `${baseUrl}/usage`;
        const creditsUrl = `${baseUrl}/prepaid/credits`;
        const overageUrl = `${baseUrl}/overage_spend_limit`;

        if (debug) {
            debugChannel.appendLine(`\n=== HTTP FETCH (${new Date().toLocaleString()}) ===`);
            debugChannel.appendLine(`Org ID: ${orgId}`);
            debugChannel.appendLine(`Account: ${this.accountInfo?.name || 'unknown'}`);
            debugChannel.appendLine(`Fetching: ${usageUrl}`);
        }

        fileLog(`Fetching usage data for org ${orgId.slice(0, 8)}...`);

        // Fetch all 3 endpoints in parallel
        const [usageResult, creditsResult, overageResult] = await Promise.allSettled([
            this._fetchEndpoint(usageUrl),
            this._fetchEndpoint(creditsUrl),
            this._fetchEndpoint(overageUrl),
        ]);

        if (usageResult.status === 'rejected') {
            const err = usageResult.reason;
            if (debug) {
                debugChannel.appendLine(`Usage fetch FAILED: ${err.message}`);
            }
            throw err;
        }

        const usageData = usageResult.value;
        const creditsData = creditsResult.status === 'fulfilled' ? creditsResult.value : null;
        const overageData = overageResult.status === 'fulfilled' ? overageResult.value : null;

        if (debug) {
            debugChannel.appendLine('Usage fetch SUCCESS');
            debugChannel.appendLine(JSON.stringify(usageData, null, 2));
            if (creditsData) debugChannel.appendLine(`Credits: ${JSON.stringify(creditsData)}`);
            if (overageData) debugChannel.appendLine(`Overage: ${JSON.stringify(overageData)}`);
        }

        fileLog('Usage data fetched successfully');

        return this._processApiResponse(usageData, creditsData, overageData);
    }

    _calculateResetTime(isoTimestamp) {
        if (!isoTimestamp) return 'Unknown';

        try {
            const resetDate = new Date(isoTimestamp);
            const now = new Date();
            const diffMs = resetDate - now;

            if (diffMs <= 0) return 'Soon';

            const hours = Math.floor(diffMs / (1000 * 60 * 60));
            const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

            if (hours > 24) {
                const days = Math.floor(hours / 24);
                const remainingHours = hours % 24;
                return `${days}d ${remainingHours}h`;
            } else if (hours > 0) {
                return `${hours}h ${minutes}m`;
            } else {
                return `${minutes}m`;
            }
        } catch (error) {
            console.error('Error calculating reset time:', error);
            return 'Unknown';
        }
    }

    _processApiResponse(apiResponse, creditsData = null, overageData = null) {
        try {
            const data = extractFromSchema(apiResponse, USAGE_API_SCHEMA);
            const monthlyCredits = processOverageData(overageData);
            const prepaidCredits = processPrepaidData(creditsData);

            return {
                usagePercent: data.fiveHour.utilization,
                resetTime: this._calculateResetTime(data.fiveHour.resetsAt),
                usagePercentWeek: data.sevenDay.utilization,
                resetTimeWeek: this._calculateResetTime(data.sevenDay.resetsAt),
                usagePercentSonnet: data.sevenDaySonnet.utilization,
                resetTimeSonnet: this._calculateResetTime(data.sevenDaySonnet.resetsAt),
                usagePercentOpus: data.sevenDayOpus.utilization,
                resetTimeOpus: this._calculateResetTime(data.sevenDayOpus.resetsAt),
                extraUsage: data.extraUsage.value,
                prepaidCredits: prepaidCredits,
                monthlyCredits: monthlyCredits,
                accountInfo: this.accountInfo,
                timestamp: new Date(),
                rawData: apiResponse,
                schemaVersion: getSchemaInfo().version,
            };
        } catch (error) {
            console.error('Error processing API response:', error);
            throw new Error('Failed to process API response data');
        }
    }

    // --- Login Flow (browser cookie paste) ---

    async login() {
        fileLog('Login flow started');

        // Open claude.ai in the user's default browser
        const loginUrl = vscode.Uri.parse(CLAUDE_URLS.LOGIN);
        await vscode.env.openExternal(loginUrl);

        // Ask user to paste their sessionKey cookie
        const sessionKey = await vscode.window.showInputBox({
            title: 'Claude Pal — Paste Session Cookie',
            prompt: 'Log in to claude.ai, then copy your sessionKey cookie from DevTools (F12 → Application → Cookies → claude.ai → sessionKey)',
            placeHolder: 'sk-ant-...',
            ignoreFocusOut: true,
            password: true,
        });

        if (!sessionKey) {
            fileLog('Login cancelled by user');
            throw new Error('LOGIN_CANCELLED');
        }

        // Validate the cookie by fetching bootstrap
        fileLog('Validating session cookie...');
        const bootstrapData = await this._fetchBootstrapWithKey(sessionKey.trim());
        if (!bootstrapData || !bootstrapData.account) {
            throw new Error('Invalid session cookie — could not authenticate');
        }

        fileLog('Login successful');

        const creds = readCredentials();
        this._saveCookie(sessionKey.trim(), null, creds?.orgId);
    }

    // --- Diagnostics ---

    getDiagnostics() {
        const cookie = this._readCookie();
        const creds = readCredentials();
        const schemaInfo = getSchemaInfo();

        return {
            hasCookie: !!cookie,
            cookieExpires: cookie?.expires ? new Date(cookie.expires * 1000).toISOString() : null,
            cookieSavedAt: cookie?.savedAt || null,
            orgId: creds?.orgId || cookie?.orgId || null,
            subscriptionType: creds?.subscriptionType || null,
            rateLimitTier: creds?.rateLimitTier || null,
            accountName: this.accountInfo?.name || null,
            accountEmail: this.accountInfo?.email || null,
            schemaVersion: schemaInfo.version,
            schemaFields: schemaInfo.usageFields,
            schemaEndpoints: schemaInfo.endpoints,
        };
    }
}

module.exports = {
    ClaudeHttpFetcher,
};
