# Claude Pal

Complete Claude.ai monitoring for VS Code: usage limits, model detection, sound notifications, and permission management — all in one status bar.

## Features

- **Unified Status Bar** — Model, usage percentages, and reset countdowns in a single line: `Claude - Opus 4.6 🛡️ | 17% 2h 58m | 24% 5d 8h`
- **Model & Plan Display** — Auto-detects current model (Opus 4.6, Sonnet 4.5, etc.), thinking mode, and effort level from Claude Code sessions
- **Sound Notifications** — Platform-native sounds when Claude needs tool permission or finishes a task (macOS, Windows, Linux)
- **Service Status** — Live indicator when Claude services are degraded or experiencing outages
- **YOLO Permissions** — Quick-toggle Claude Code permission modes (YOLO / Safe / Normal) from the tooltip
- **Sound Picker** — Choose from available system sounds with live preview per event type

## How It Works

Claude Pal fetches your usage data from Claude.ai using your browser session cookie. On first use, it opens claude.ai in your browser — you copy your `sessionKey` cookie from DevTools and paste it into VS Code. After that, it refreshes automatically.

For Claude Code users, it also reads local JSONL session files to detect your current model, thinking mode, and context window usage.

## Tooltip Control Panel

Hover over the status bar to see the full control panel:

- **Subscription details** — Plan type (Pro, Max 5x/20x), rate limit tier, and current model
- **Session usage** — Current 5-hour session percentage with reset countdown
- **Weekly usage** — 7-day percentage with Sonnet/Opus breakdown
- **Credits** — Extra usage and prepaid credit balances
- **Permissions** — Toggle YOLO / Safe / Normal modes for Claude Code
- **Sound** — Toggle on/off, pick Prompt and Done sounds with live preview
- **Refresh** — Manually resync usage data

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudePal.autoRefreshMinutes` | `5` | Refresh interval (1-60 minutes) |
| `claudePal.debug` | `false` | Enable debug logging |

Sound selection is managed through the tooltip control panel (click Prompt or Done to pick sounds).

## Requirements

- **VS Code** 1.109.0 or later
- **Claude.ai account** (Pro, Max, or Free)
- A browser for first-time login (to copy your session cookie)

## Commands

Access via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- **Claude Pal: Fetch Claude Usage Now** — Force refresh usage data
- **Claude Pal: Resync Account** — Clear session and re-login
- **Claude Pal: Toggle Sound Notifications** — Mute/unmute sounds
- **Claude Pal: Change Prompt Sound** — Pick sound for permission prompts
- **Claude Pal: Change Done Sound** — Pick sound for task completion
- **Claude Pal: Show Debug Output** — Open debug log channel

## Development

### Build & Install Locally

```bash
npm install               # install dev dependencies
npm run build             # production build
npm run package           # creates claude-pal-x.x.x.vsix
code --install-extension claude-pal-1.0.0.vsix --force
```

Then reload VS Code: `Ctrl+Shift+P` → **Developer: Reload Window**

Note: you must reload **each open VS Code window** separately — installing a .vsix updates files on disk but running windows keep the old version in memory.

### F5 Debugging

Open the project in VS Code and press `F5` to launch the Extension Development Host with live reload.

### Publish to Marketplace

1. Create a publisher account at https://marketplace.visualstudio.com/manage
2. Create publisher **"forge"** (must match `package.json`)
3. Generate a Personal Access Token (PAT) from [Azure DevOps](https://dev.azure.com) → User Settings → Personal Access Tokens (scope: **Marketplace > Manage**)
4. `npx vsce login forge`
5. `npx vsce publish`

## License

MIT
