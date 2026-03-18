// Claude Pal — Shared sound maps and player
// Deployed to ~/.claude/hooks/ alongside hook scripts

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const IS_WSL = !IS_WIN && process.platform === "linux" && (() => {
  try { return fs.readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft"); } catch { return false; }
})();
const IS_MAC = process.platform === "darwin";
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
    "Windows Notify": "C:\\Windows\\Media\\Windows Notify.wav",
    "tada": "C:\\Windows\\Media\\tada.wav",
    "chimes": "C:\\Windows\\Media\\chimes.wav",
    "chord": "C:\\Windows\\Media\\chord.wav",
    "ding": "C:\\Windows\\Media\\ding.wav",
    "notify": "C:\\Windows\\Media\\notify.wav",
    "ringin": "C:\\Windows\\Media\\ringin.wav",
    "Windows Background": "C:\\Windows\\Media\\Windows Background.wav",
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

const DEFAULTS = {
  prompt: { mac: "Glass", win: "Windows Notify", linux: "bell" },
  done: { mac: "Hero", win: "tada", linux: "complete" },
};

function getPlatformKey() {
  if (IS_MAC) return "mac";
  if (IS_WIN || IS_WSL) return "win";
  return "linux";
}

function getSoundMap() {
  return SOUND_MAPS[getPlatformKey()];
}

function resolveSound(name) {
  return getSoundMap()[name] || null;
}

function getDefaultSound(eventType) {
  return DEFAULTS[eventType]?.[getPlatformKey()] || null;
}

function readConfig() {
  try {
    const configFile = path.join(__dirname, "claude-pal-config.json");
    return JSON.parse(fs.readFileSync(configFile, "utf-8"));
  } catch { return null; }
}

function playSound(soundPath) {
  if (!soundPath) return;
  const pk = getPlatformKey();
  try {
    if (pk === "win") {
      const ps = `$s='${soundPath}'; if(Test-Path $s){(New-Object Media.SoundPlayer $s).PlaySync()}else{[console]::Beep(800,300)}`;
      execSync(`${PS_BIN} -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}`, { stdio: "ignore", timeout: 5000 });
    } else if (pk === "mac") {
      execSync(`afplay "${soundPath}"`, { stdio: "ignore", timeout: 5000 });
    } else {
      try { execSync(`paplay "${soundPath}"`, { stdio: "ignore", timeout: 5000 }); }
      catch { try { execSync(`aplay "${soundPath}"`, { stdio: "ignore", timeout: 5000 }); }
      catch { process.stdout.write("\x07"); } }
    }
  } catch {}
}

function playSoundByName(name) {
  playSound(resolveSound(name));
}

module.exports = {
  SOUND_MAPS,
  DEFAULTS,
  getPlatformKey,
  getSoundMap,
  resolveSound,
  getDefaultSound,
  readConfig,
  playSound,
  playSoundByName,
};
