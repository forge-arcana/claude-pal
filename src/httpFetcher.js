// HTTP-based Claude.ai usage data fetching.
// Uses native fetch() with a stored sessionKey cookie to call Claude.ai API
// endpoints directly. Login is handled by opening claude.ai in the user's
// browser and having them paste their sessionKey cookie.

const path = require('path');
const fs = require('fs');
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
    TIMEOUTS,
    isDebugEnabled,
    getDebugChannel,
    fileLog,
    calculateResetTimeFromISO,
} = require('./utils');

const { readCredentials } = require('./credentialsReader');

// Typed errors for control flow (not string comparison)
class SessionError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'SessionError';
    }
}

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
        this._cachedOrgId = null;
    }

    // --- Cookie Management ---

    _readCookie() {
        try {
            if (!fs.existsSync(PATHS.SESSION_COOKIE_FILE)) {
                return null;
            }
            const data = JSON.parse(fs.readFileSync(PATHS.SESSION_COOKIE_FILE, 'utf-8'));
            if (!data.sessionKey) return null;
            // Reject cookies with CRLF chars (header injection prevention)
            if (/[\r\n]/.test(data.sessionKey)) {
                fileLog('Session cookie contains invalid characters');
                return null;
            }
            return data;
        } catch (error) {
            fileLog(`Error reading session cookie: ${error.message}`);
            return null;
        }
    }

    _saveCookie(sessionKey, expires, orgId) {
        const dir = path.dirname(PATHS.SESSION_COOKIE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        const data = {
            sessionKey,
            expires,
            savedAt: new Date().toISOString(),
            orgId: orgId || null,
        };
        fs.writeFileSync(PATHS.SESSION_COOKIE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
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
            signal: AbortSignal.timeout(TIMEOUTS.API_REQUEST),
        });
        if (!response.ok) return null;
        return response.json();
    }

    async _fetchEndpoint(url) {
        const cookie = this._readCookie();
        if (!cookie) throw new SessionError('NO_SESSION');

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                ...BROWSER_HEADERS,
                'Cookie': `sessionKey=${cookie.sessionKey}`,
            },
            signal: AbortSignal.timeout(TIMEOUTS.API_REQUEST),
        });

        if (response.status === 401 || response.status === 403) {
            // Check if it's a Cloudflare challenge vs actual auth failure
            const text = await response.text();
            if (text.includes('permission_error') || text.includes('account_session_invalid') || text.includes('"type":"error"')) {
                throw new SessionError('SESSION_EXPIRED');
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
            throw new SessionError('NO_ORG_ID');
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
            throw new SessionError('NO_SESSION');
        }

        // Check cookie expiry
        if (cookie.expires && cookie.expires <= Date.now() / 1000) {
            throw new SessionError('SESSION_EXPIRED');
        }

        const orgId = await this._resolveOrgId();
        const baseUrl = `${CLAUDE_URLS.BASE}/api/organizations/${orgId}`;
        const usageUrl = `${baseUrl}/usage`;
        const creditsUrl = `${baseUrl}/prepaid/credits`;
        const overageUrl = `${baseUrl}/overage_spend_limit`;

        if (debug) {
            debugChannel.appendLine(`\n=== HTTP FETCH (${new Date().toLocaleString()}) ===`);
            debugChannel.appendLine(`Org ID: ${orgId.slice(0, 8)}...`);
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
            debugChannel.appendLine(`Has credits data: ${!!creditsData}`);
            debugChannel.appendLine(`Has overage data: ${!!overageData}`);
        }

        fileLog('Usage data fetched successfully');

        return this._processApiResponse(usageData, creditsData, overageData);
    }

    _processApiResponse(apiResponse, creditsData = null, overageData = null) {
        try {
            const data = extractFromSchema(apiResponse, USAGE_API_SCHEMA);
            const monthlyCredits = processOverageData(overageData);
            const prepaidCredits = processPrepaidData(creditsData);

            return {
                usagePercent: data.fiveHour.utilization,
                resetTime: calculateResetTimeFromISO(data.fiveHour.resetsAt),
                usagePercentWeek: data.sevenDay.utilization,
                resetTimeWeek: calculateResetTimeFromISO(data.sevenDay.resetsAt),
                usagePercentSonnet: data.sevenDaySonnet.utilization,
                resetTimeSonnet: calculateResetTimeFromISO(data.sevenDaySonnet.resetsAt),
                usagePercentOpus: data.sevenDayOpus.utilization,
                resetTimeOpus: calculateResetTimeFromISO(data.sevenDayOpus.resetsAt),
                extraUsage: data.extraUsage.value,
                prepaidCredits: prepaidCredits,
                monthlyCredits: monthlyCredits,
                accountInfo: this.accountInfo,
                timestamp: new Date(),
            };
        } catch (error) {
            console.error('Error processing API response:', error);
            throw new Error('Failed to process API response data');
        }
    }

    // --- Login Flow ---

    /**
     * Authenticate with a session key obtained externally.
     * The caller (extension.js) handles UI — this class stays UI-free.
     * @param {() => Promise<string|null>} getSessionKey - callback that returns a session key or null if cancelled
     */
    async login(getSessionKey) {
        fileLog('Login flow started');

        const sessionKey = await getSessionKey();

        if (!sessionKey) {
            fileLog('Login cancelled by user');
            throw new SessionError('LOGIN_CANCELLED');
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

        const redactId = id => id ? `${id.slice(0, 8)}...` : null;
        const redactEmail = email => {
            if (!email) return null;
            const [user, domain] = email.split('@');
            return `${user[0]}***@${domain}`;
        };

        return {
            hasCookie: !!cookie,
            cookieExpires: cookie?.expires ? new Date(cookie.expires * 1000).toISOString() : null,
            cookieSavedAt: cookie?.savedAt || null,
            orgId: redactId(creds?.orgId || cookie?.orgId),
            subscriptionType: creds?.subscriptionType || null,
            rateLimitTier: creds?.rateLimitTier || null,
            accountName: this.accountInfo?.name || null,
            accountEmail: redactEmail(this.accountInfo?.email),
            schemaVersion: schemaInfo.version,
        };
    }
}

module.exports = {
    ClaudeHttpFetcher,
    SessionError,
};
