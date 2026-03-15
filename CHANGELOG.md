# Changelog

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
