# Learnings

## PS1 hooks defaulted to sound+popup, JS hooks to sound-only (2026-03-15)
The PowerShell hook scripts (.ps1) for native Windows had `sound+popup` as the default notification level, while the JS hooks (WSL/Mac/Linux) correctly defaulted to `sound` only. The popup creates Windows balloon notifications via `System.Windows.Forms.NotifyIcon` which is redundant with VS Code's built-in UI. Always keep defaults consistent across platform variants.

## Keep YOLO Safe permissions synced with CLAUDE.md auto-allowed list (2026-03-15)
The `YOLO_SAFE_PERMISSIONS` array in `permissionsManager.js` is the source of truth for Safe mode. It must stay in sync with the global `~/.claude/CLAUDE.md` Bash Permissions auto-allowed list. When the CLAUDE.md list changes, update the extension's Safe list to match. Destructive commands (rm, git push, git reset, git clean, git restore) stay excluded from Safe regardless.
