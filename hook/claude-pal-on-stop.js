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
const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux" && !IS_WSL;
const PS_BIN = IS_WSL ? "powershell.exe" : "powershell";

const SOUND_MAPS = {
  mac: {
    Basso: "/System/Library/Sounds/Basso.aiff", Blow: "/System/Library/Sounds/Blow.aiff",
    Bottle: "/System/Library/Sounds/Bottle.aiff", Frog: "/System/Library/Sounds/Frog.aiff",
    Funk: "/System/Library/Sounds/Funk.aiff", Glass: "/System/Library/Sounds/Glass.aiff",
    Hero: "/System/Library/Sounds/Hero.aiff", Morse: "/System/Library/Sounds/Morse.aiff",
    Ping: "/System/Library/Sounds/Ping.aiff", Pop: "/System/Library/Sounds/Pop.aiff",
    Purr: "/System/Library/Sounds/Purr.aiff", Sosumi: "/System/Library/Sounds/Sosumi.aiff",
    Submarine: "/System/Library/Sounds/Submarine.aiff", Tink: "/System/Library/Sounds/Tink.aiff",
  },
  win: {
    "Windows Notify": "C:\\Windows\\Media\\Windows Notify.wav", "tada": "C:\\Windows\\Media\\tada.wav",
    "chimes": "C:\\Windows\\Media\\chimes.wav", "chord": "C:\\Windows\\Media\\chord.wav",
    "ding": "C:\\Windows\\Media\\ding.wav", "notify": "C:\\Windows\\Media\\notify.wav",
    "ringin": "C:\\Windows\\Media\\ringin.wav", "Windows Background": "C:\\Windows\\Media\\Windows Background.wav",
  },
  linux: {
    "bell": "/usr/share/sounds/freedesktop/stereo/bell.oga",
    "complete": "/usr/share/sounds/freedesktop/stereo/complete.oga",
    "message": "/usr/share/sounds/freedesktop/stereo/message.oga",
    "service-login": "/usr/share/sounds/freedesktop/stereo/service-login.oga",
    "service-logout": "/usr/share/sounds/freedesktop/stereo/service-logout.oga",
    "suspend-error": "/usr/share/sounds/freedesktop/stereo/suspend-error.oga",
    "dialog-warning": "/usr/share/sounds/freedesktop/stereo/dialog-warning.oga",
    "dialog-information": "/usr/share/sounds/freedesktop/stereo/dialog-information.oga",
  },
};

function getPlatformKey() {
  if (IS_MAC) return "mac";
  if (IS_WIN || IS_WSL) return "win";
  return "linux";
}

function resolveSound(name) {
  const map = SOUND_MAPS[getPlatformKey()];
  return map[name] || null;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, "claude-pal-config.json"), "utf-8")); }
  catch { return null; }
}

const DEFAULT_SOUNDS = {
  question: { mac: "Glass", win: "Windows Notify", linux: "bell" },
  done: { mac: "Hero", win: "tada", linux: "complete" },
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
  const level = eventCfg.level ?? "sound";

  if (level === "off") process.exit(0);

  const pk = getPlatformKey();
  const soundName = eventCfg.sound || DEFAULT_SOUNDS[reason][pk];
  const sound = resolveSound(soundName);

  // Play sound
  if ((level === "sound+popup" || level === "sound") && sound) {
    try {
      if (pk === "win") {
        const ps = `$s='${sound}'; if(Test-Path $s){(New-Object Media.SoundPlayer $s).PlaySync()}else{[console]::Beep(800,300)}`;
        execSync(`${PS_BIN} -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}`, { stdio: "ignore", timeout: 5000 });
      } else if (pk === "mac") {
        execSync(`afplay "${sound}"`, { stdio: "ignore", timeout: 5000 });
      } else {
        try { execSync(`paplay "${sound}"`, { stdio: "ignore", timeout: 5000 }); }
        catch { try { execSync(`aplay "${sound}"`, { stdio: "ignore", timeout: 5000 }); } catch {} }
      }
    } catch {}
  }

  // Write signal for VSCode extension
  try {
    fs.writeFileSync(path.join(HOOKS_DIR, "claude-pal-signal"), reason + " " + Date.now());
  } catch {}

  process.exit(0);
});
