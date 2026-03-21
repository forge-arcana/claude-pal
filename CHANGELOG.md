# Changelog

## 1.1.0 — 2026-03-21

- Replace global Sound On/Off toggle with per-event "No sound" option in each sound picker
- Sound picker stays open on click: instant preview+select with checkmark update, Back/Close navigation
- Non-blocking sound preview using async exec (no UI freezes)
- 2x volume boost on macOS (afplay -v 2) and Linux (paplay --volume=131072)
- Main click menu stays open after sub-actions with descriptions on all items
- Remove Open Claude Settings, Re-login, Show Debug Log from click menu
- Remove toggleSound command and related dead code

## 1.0.5 — 2026-03-20

- Replace tooltip with click-to-open QuickPick menu showing usage data, progress bars, and actions
- Compact status bar label: `$(robot) Opus 4.6` with mode/service icons
- Add API fetch timeouts (30s) to prevent hung connections blocking auto-refresh
- Atomic settings.json writes (write-tmp-then-rename) to prevent corruption
- Redact PII from debug channel output (org ID, raw API responses)
- Remove 7+ dead exported functions across all modules
- Extract quickMenu.js module from extension.js (SRP)
- Register all timers as VS Code disposables for proper lifecycle cleanup
- Remove stale PS1 signal file writes
- Fix .vscodeignore to exclude dev artifacts (memory/, .vscode/) and protect hook/
- Guard progress bar against NaN/undefined input
- Derive spinner frame array from character string (DRY)

## 1.0.4 — 2026-03-18

- Fix Windows PS1 permission hook reading wrong config key — sound preferences now apply
- Clear stale usage data on session expiry — status bar shows login prompt instead of old data
- Extract shared sound-player module (single source of truth for sound maps across all hooks)
- Extract shared settings module (eliminates race condition from duplicate read/write)
- Replace manual https.get with native fetch for service status
- Convert ActivityMonitor to plain functions, centralize magic numbers
- Remove dead signal watcher, if(true) guards, and unused code
- Fix uninstall script hook filtering, fix prepaid data fallback chain
- Dynamic User-Agent version from package.json

## 1.0.3 — 2026-03-15

- Add missing changelog entries for v1.0.1 and v1.0.2

## 1.0.2 — 2026-03-15

- Sync Safe mode permissions with global CLAUDE.md auto-allowed list
- Update repository URL to final-forge/claude-pal

## 1.0.1 — 2026-03-15

- Remove Windows balloon popup notifications from PS1 hooks (sound-only default)

## 1.0.0 — 2026-03-14

Initial release.

- Unified single-line status bar: model, session %, weekly %, reset countdowns
- Model and thinking mode detection from Claude Code JSONL sessions
- Subscription plan and rate limit tier display in tooltip
- Platform-aware sound notifications (macOS/Windows/Linux) with sound picker and live preview
- Live service status from status.claude.com
- YOLO / Safe / Normal permission mode toggling from tooltip
- Tooltip control panel with inline actions (permissions, sound, refresh)
- Session cookie-based authentication (paste from browser DevTools)
- Credits and extra usage tracking
- Zero runtime dependencies (no puppeteer, no bundled browsers)
