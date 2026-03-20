// Project:   Claude Pal
// File:      serviceStatus.js
// Purpose:   Fetch Claude service status from status.claude.com
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const { TIMEOUTS, EXTENSION_VERSION } = require('./utils');

const STATUS_API_URL = 'https://status.claude.com/api/v2/status.json';
const STATUS_PAGE_URL = 'https://status.claude.com';

// Status indicators from Atlassian Statuspage
// none = operational, minor = degraded, major = partial outage, critical = major outage
const STATUS_INDICATORS = {
    none: {
        icon: '$(check)',
        label: 'Operational',
        color: undefined,  // default/green
        level: 'operational'
    },
    minor: {
        icon: '$(warning)',
        label: 'Degraded',
        color: 'editorWarning.foreground',
        level: 'degraded'
    },
    major: {
        icon: '$(error)',
        label: 'Partial Outage',
        color: 'errorForeground',
        level: 'outage'
    },
    critical: {
        icon: '$(error)',
        label: 'Major Outage',
        color: 'errorForeground',
        level: 'critical'
    },
    unknown: {
        icon: '$(question)',
        label: 'Unknown',
        color: undefined,
        level: 'unknown'
    }
};

let cachedStatus = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = TIMEOUTS.SERVICE_STATUS_CACHE_TTL;

/**
 * Fetch service status from status.claude.com API
 * @returns {Promise<{indicator: string, description: string, updatedAt: string}>}
 */
async function fetchServiceStatus() {
    // Return cached result if still fresh
    const now = Date.now();
    if (cachedStatus && (now - lastFetchTime) < CACHE_TTL_MS) {
        return cachedStatus;
    }

    const res = await fetch(STATUS_API_URL, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': `ClaudePal-VSCode/${EXTENSION_VERSION}`,
        },
        signal: AbortSignal.timeout(TIMEOUTS.SERVICE_STATUS_REQUEST),
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    const result = {
        indicator: json.status?.indicator || 'unknown',
        description: json.status?.description || 'Status unknown',
        updatedAt: json.page?.updated_at || null,
        pageUrl: STATUS_PAGE_URL,
    };

    cachedStatus = result;
    lastFetchTime = now;

    return result;
}

/**
 * Get display info for a status indicator
 * @param {string} indicator - Status indicator from API (none, minor, major, critical)
 * @returns {{icon: string, label: string, color: string|undefined, level: string}}
 */
function getStatusDisplay(indicator) {
    return STATUS_INDICATORS[indicator] || STATUS_INDICATORS.unknown;
}

module.exports = {
    fetchServiceStatus,
    getStatusDisplay,
    STATUS_PAGE_URL,
};
