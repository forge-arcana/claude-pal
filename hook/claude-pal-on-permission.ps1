# Claude Pal - PermissionRequest hook (PowerShell, v2)
# Plays sound when Claude needs permission.
$ErrorActionPreference = 'SilentlyContinue'

$hooksDir = Join-Path ($env:USERPROFILE) '.claude' 'hooks'
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

# Read config
$config = $null
try { $config = (Get-Content $configFile -Raw) | ConvertFrom-Json } catch {}

$eventCfg = if ($config -and $config.asksQuestion) { $config.asksQuestion } else { $null }
$level = if ($eventCfg -and $eventCfg.level) { $eventCfg.level } else { 'sound' }

if ($level -eq 'off') { exit 0 }

$soundName = if ($eventCfg -and $eventCfg.sound) { $eventCfg.sound } else { '' }
$soundPath = if ($winSounds.ContainsKey($soundName)) { $winSounds[$soundName] } else { 'C:\Windows\Media\Windows Notify.wav' }

# Play sound
try {
    if (Test-Path $soundPath) { (New-Object Media.SoundPlayer $soundPath).PlaySync() }
    else { [console]::Beep(800, 300) }
} catch {}
