// Project:   Claude Pal
// File:      credentialsReader.js
// Purpose:   Read Claude Code credentials for account detection
// Language:  JavaScript (CommonJS)
//
// License:   MIT
// Copyright: (c) 2026 forge

const fs = require('fs');
const path = require('path');
const os = require('os');
const { capitalizeFirst } = require('./utils');

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

function readCredentials() {
    try {
        if (!fs.existsSync(CREDENTIALS_PATH)) {
            return null;
        }

        const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
        const data = JSON.parse(raw);

        const oauth = data.claudeAiOauth || {};

        return {
            orgId: data.organizationUuid || null,
            subscriptionType: oauth.subscriptionType || null,
            rateLimitTier: oauth.rateLimitTier || null,
        };
    } catch (error) {
        console.warn('Claude Pal: Failed to read credentials:', error.message);
        return null;
    }
}

function formatSubscriptionType(type) {
    return capitalizeFirst(type);
}

function formatRateLimitTier(tier) {
    if (!tier) return null;
    // "default_claude_max_20x" → "Max 20x"
    // "default_claude_pro" → "Pro"
    const match = tier.match(/default_claude_(\w+?)(?:_(\d+x))?$/);
    if (match) {
        const plan = capitalizeFirst(match[1]);
        return match[2] ? `${plan} ${match[2]}` : plan;
    }
    return tier;
}

module.exports = {
    CREDENTIALS_PATH,
    readCredentials,
    formatSubscriptionType,
    formatRateLimitTier,
};
