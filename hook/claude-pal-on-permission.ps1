# Claude Pal - PermissionRequest hook (PowerShell, v2)
# Plays sound when Claude needs permission.
$ErrorActionPreference = 'SilentlyContinue'

$hooksDir = Join-Path ($env:USERPROFILE) '.claude' 'hooks'
$muteFlag = Join-Path $hooksDir 'claude-pal-muted'
$configFile = Join-Path $hooksDir 'claude-pal-config.json'

$winSounds = @{
    'Windows Notify' = 'C:\Windows\Media\Windows Notify.wav'
    'tada'           = 'C:\Windows\Media\tada.wav'
    'chimes'         = 'C:\Windows\Media\chimes.wav'
    'chord'          = 'C:\Windows\Media\chord.wav'
    'ding'           = 'C:\Windows\Media\ding.wav'
    'notify'         = 'C:\Windows\Media\notify.wav'
    'ringin'         = 'C:\Windows\Media\ringin.wav'
    'Windows Background' = 'C:\Windows\Media\Windows Background.wav'
}

$raw = [Console]::In.ReadToEnd()
try { $data = $raw | ConvertFrom-Json } catch { exit 0 }

if (Test-Path $muteFlag) { exit 0 }

# Read config
$config = $null
try { $config = (Get-Content $configFile -Raw) | ConvertFrom-Json } catch {}

$eventCfg = if ($config -and $config.needsPermission) { $config.needsPermission } else { $null }
$level = if ($eventCfg -and $eventCfg.level) { $eventCfg.level } else { 'sound+popup' }

if ($level -eq 'off') { exit 0 }

$soundName = if ($eventCfg -and $eventCfg.sound) { $eventCfg.sound } else { '' }
$soundPath = if ($winSounds.ContainsKey($soundName)) { $winSounds[$soundName] } else { 'C:\Windows\Media\Windows Notify.wav' }

# Play sound
if ($level -eq 'sound+popup' -or $level -eq 'sound') {
    try {
        if (Test-Path $soundPath) { (New-Object Media.SoundPlayer $soundPath).PlaySync() }
        else { [console]::Beep(800, 300) }
    } catch {}
}

# OS notification
if ($level -eq 'sound+popup' -or $level -eq 'popup') {
    try {
        $tool = if ($data.tool_name) { $data.tool_name } else { 'a tool' }
        $message = "Claude needs permission to use $tool."
        Add-Type -AssemblyName System.Windows.Forms
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Information
        $n.Visible = $true
        $n.ShowBalloonTip(3000, 'Claude Pal', $message, [System.Windows.Forms.ToolTipIcon]::None)
        Start-Sleep -Milliseconds 500
        $n.Dispose()
    } catch {}
}

# Write signal for VSCode extension
try {
    Set-Content -Path (Join-Path $hooksDir 'claude-pal-signal') -Value "input $(Get-Date -UFormat %s)" -NoNewline
} catch {}
