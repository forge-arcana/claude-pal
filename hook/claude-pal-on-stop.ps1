# Claude Pal - Stop hook (PowerShell, v2)
# Plays "task completed" or "question asked" sound when Claude finishes.
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

if ($data.stop_hook_active) { exit 0 }
if (Test-Path $muteFlag) { exit 0 }

$reason = 'done'

$transcript = $data.transcript_path
if ($transcript -and (Test-Path $transcript)) {
    try {
        $lines = Get-Content $transcript -Tail 20
        for ($i = $lines.Count - 1; $i -ge 0; $i--) {
            try {
                $msg = $lines[$i] | ConvertFrom-Json
                if ($msg.role -eq 'assistant' -and $msg.content -and $msg.content.Count -gt 0) {
                    $last = $msg.content[$msg.content.Count - 1]
                    if ($last.type -eq 'tool_use' -and $last.name -eq 'AskUserQuestion') {
                        $reason = 'question'
                    } elseif ($last.type -eq 'text' -and $last.text -and $last.text.Trim().EndsWith('?')) {
                        $reason = 'question'
                    }
                    break
                }
            } catch {}
        }
    } catch {}
}

# Read config
$config = $null
try { $config = (Get-Content $configFile -Raw) | ConvertFrom-Json } catch {}

$configKey = if ($reason -eq 'question') { 'asksQuestion' } else { 'taskCompleted' }
$eventCfg = if ($config -and $config.$configKey) { $config.$configKey } else { $null }
$level = if ($eventCfg -and $eventCfg.level) { $eventCfg.level } else { 'sound' }

if ($level -eq 'off') { exit 0 }

$defaultSounds = @{ question = 'C:\Windows\Media\Windows Notify.wav'; done = 'C:\Windows\Media\tada.wav' }
$soundName = if ($eventCfg -and $eventCfg.sound) { $eventCfg.sound } else { '' }
$soundPath = if ($winSounds.ContainsKey($soundName)) { $winSounds[$soundName] } else { $defaultSounds[$reason] }

# Play sound
if ($level -ne 'off') {
    try {
        if (Test-Path $soundPath) { (New-Object Media.SoundPlayer $soundPath).PlaySync() }
        else { [console]::Beep(800, 300) }
    } catch {}
}
