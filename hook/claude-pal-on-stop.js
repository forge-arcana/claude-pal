#!/usr/bin/env node
// Claude Pal — Stop hook script (v2)
// Plays "task completed" or "question asked" sound when Claude finishes.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const HOOKS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".claude", "hooks");
const MUTE_FLAG = path.join(HOOKS_DIR, "claude-pal-muted");
const IS_WIN = process.platform === "win32";
const IS_WSL = !IS_WIN && process.platform === "linux" && (() => {
  try { return fs.readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft"); } catch { return false; }
})();
const USE_WIN = IS_WIN || IS_WSL;
const PS_BIN = IS_WSL ? "powershell.exe" : "powershell";

const MACOS_SOUNDS = {
  Basso: "/System/Library/Sounds/Basso.aiff", Blow: "/System/Library/Sounds/Blow.aiff",
  Bottle: "/System/Library/Sounds/Bottle.aiff", Frog: "/System/Library/Sounds/Frog.aiff",
  Funk: "/System/Library/Sounds/Funk.aiff", Glass: "/System/Library/Sounds/Glass.aiff",
  Hero: "/System/Library/Sounds/Hero.aiff", Morse: "/System/Library/Sounds/Morse.aiff",
  Ping: "/System/Library/Sounds/Ping.aiff", Pop: "/System/Library/Sounds/Pop.aiff",
  Purr: "/System/Library/Sounds/Purr.aiff", Sosumi: "/System/Library/Sounds/Sosumi.aiff",
  Submarine: "/System/Library/Sounds/Submarine.aiff", Tink: "/System/Library/Sounds/Tink.aiff",
};
const WIN_SOUNDS = {
  "Windows Notify": "C:\\Windows\\Media\\Windows Notify.wav", "tada": "C:\\Windows\\Media\\tada.wav",
  "chimes": "C:\\Windows\\Media\\chimes.wav", "chord": "C:\\Windows\\Media\\chord.wav",
  "ding": "C:\\Windows\\Media\\ding.wav", "notify": "C:\\Windows\\Media\\notify.wav",
  "ringin": "C:\\Windows\\Media\\ringin.wav", "Windows Background": "C:\\Windows\\Media\\Windows Background.wav",
};

function resolveSound(name, defaultMac, defaultWin) {
  if (USE_WIN) return WIN_SOUNDS[name] || defaultWin;
  return MACOS_SOUNDS[name] || defaultMac;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, "claude-pal-config.json"), "utf-8")); }
  catch { return null; }
}

const DEFAULT_SOUNDS = {
  question: { mac: "/System/Library/Sounds/Pop.aiff", win: "C:\\Windows\\Media\\Windows Notify.wav" },
  done: { mac: "/System/Library/Sounds/Hero.aiff", win: "C:\\Windows\\Media\\tada.wav" },
};

const MESSAGES = {
  question: "Claude is asking you a question.",
  done: "Claude has finished the task.",
};

let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  if (input.stop_hook_active) process.exit(0);
  if (fs.existsSync(MUTE_FLAG)) process.exit(0);

  let reason = "done";
  const transcript = input.transcript_path || "";

  if (transcript && fs.existsSync(transcript)) {
    try {
      const data = fs.readFileSync(transcript, "utf-8").trim();
      const lines = data.split("\n").slice(-20);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.role === "assistant" && Array.isArray(msg.content) && msg.content.length > 0) {
            const last = msg.content[msg.content.length - 1];
            if (last.type === "tool_use" && last.name === "AskUserQuestion") {
              reason = "question";
            } else if (last.type === "text" && last.text && last.text.trim().endsWith("?")) {
              reason = "question";
            }
            break;
          }
        } catch {}
      }
    } catch {}
  }

  const config = readConfig();
  const configKey = reason === "question" ? "asksQuestion" : "taskCompleted";
  const eventCfg = config?.[configKey] ?? {};
  const level = eventCfg.level ?? "sound+popup";

  if (level === "off") process.exit(0);

  const sound = resolveSound(eventCfg.sound, DEFAULT_SOUNDS[reason].mac, DEFAULT_SOUNDS[reason].win);

  // Play sound
  if (level === "sound+popup" || level === "sound") {
    try {
      if (USE_WIN) {
        const ps = `$s='${sound}'; if(Test-Path $s){(New-Object Media.SoundPlayer $s).PlaySync()}else{[console]::Beep(800,300)}`;
        execSync(`${PS_BIN} -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}`, { stdio: "ignore", timeout: 5000 });
      } else {
        execSync(`afplay "${sound}"`, { stdio: "ignore" });
      }
    } catch {}
  }

  // OS notification
  const message = MESSAGES[reason];
  if (level === "sound+popup" || level === "popup") {
    try {
      if (USE_WIN) {
        const safeMsg = message.replace(/'/g, "''");
        const ps = `Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(3000,'Claude Pal','${safeMsg}',[System.Windows.Forms.ToolTipIcon]::None); Start-Sleep -m 500; $n.Dispose()`;
        execSync(`${PS_BIN} -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}`, { stdio: "ignore", timeout: 5000 });
      } else {
        execSync(`osascript -e 'display notification "${message}" with title "Claude Pal"'`, { stdio: "ignore" });
      }
    } catch {}
  }

  // Write signal for VSCode extension
  try {
    fs.writeFileSync(path.join(HOOKS_DIR, "claude-pal-signal"), reason + " " + Date.now());
  } catch {}

  process.exit(0);
});
