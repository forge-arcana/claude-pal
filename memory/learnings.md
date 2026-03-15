# Learnings

## PS1 hooks defaulted to sound+popup, JS hooks to sound-only (2026-03-15)
The PowerShell hook scripts (.ps1) for native Windows had `sound+popup` as the default notification level, while the JS hooks (WSL/Mac/Linux) correctly defaulted to `sound` only. The popup creates Windows balloon notifications via `System.Windows.Forms.NotifyIcon` which is redundant with VS Code's built-in UI. Always keep defaults consistent across platform variants.
