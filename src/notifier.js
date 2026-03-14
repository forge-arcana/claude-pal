// @ts-check
/**
 * Claude Pal — Sound Notifier Module
 *
 * Deploys hook scripts to ~/.claude/hooks/ so Claude Code plays sounds
 * on two events: toolPrompt (PermissionRequest) and taskComplete (Stop).
 *
 * Hooks write a signal file that this module watches to show VS Code messages.
 */

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || process.env.USERPROFILE || "~";
const CLAUDE_DIR = path.join(HOME, ".claude");
const HOOKS_DIR = path.join(CLAUDE_DIR, "hooks");
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const IS_WSL = !IS_WIN && process.platform === "linux" && (() => {
  try { return fs.readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft"); } catch { return false; }
})();
const IS_LINUX = process.platform === "linux" && !IS_WSL;
const HOOK_EXT = IS_WIN ? ".ps1" : ".js";

// Platform sound maps: name → file path
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

function getPlatformKey() {
  if (IS_MAC) return "mac";
  if (IS_WIN || IS_WSL) return "win";
  return "linux";
}

function getSoundMap() {
  return SOUND_MAPS[getPlatformKey()];
}

const STOP_HOOK = path.join(HOOKS_DIR, `claude-pal-on-stop${HOOK_EXT}`);
const PERMISSION_HOOK = path.join(HOOKS_DIR, `claude-pal-on-permission${HOOK_EXT}`);
const MUTE_FLAG = path.join(HOOKS_DIR, "claude-pal-muted");
const SIGNAL_FILE = path.join(HOOKS_DIR, "claude-pal-signal");
const CONFIG_FILE = path.join(HOOKS_DIR, "claude-pal-config.json");
const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");

const HOOK_TYPES = ["Stop", "PermissionRequest"];
const HOOK_PREFIX = "claude-pal";

/** @type {fs.FSWatcher | null} */
let watcher = null;
let soundEnabled = true;

/**
 * Build the shell command to run a hook script.
 * @param {string} hookPath
 */
function hookCmd(hookPath) {
  if (IS_WIN) {
    return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${hookPath}"`;
  }
  return `node "${hookPath}"`;
}

// ── Settings.json helpers ──────────────────────────────────────────

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}

// ── Config sync ────────────────────────────────────────────────────

/**
 * Ensure hook config file exists with platform-appropriate defaults.
 * Does not overwrite existing config — the QuickPick manages sound selection.
 */
function getDefaultSounds() {
  const pk = getPlatformKey();
  if (pk === "mac") return { prompt: "Glass", done: "Hero" };
  if (pk === "win") return { prompt: "Windows Notify", done: "tada" };
  return { prompt: "bell", done: "complete" };
}

function syncConfig() {
  try {
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
      const d = getDefaultSounds();
      const defaults = {
        asksQuestion: { sound: d.prompt },
        taskCompleted: { sound: d.done },
      };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2) + "\n");
    }
  } catch {}
}

// ── Hook deployment ────────────────────────────────────────────────

/**
 * Copy bundled hook scripts from extension's hook/ dir to ~/.claude/hooks/.
 * Only overwrites if content differs.
 * @param {vscode.ExtensionContext} context
 */
function deployHookScripts(context) {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });

  const pairs = [
    [`claude-pal-on-stop${HOOK_EXT}`, STOP_HOOK],
    [`claude-pal-on-permission${HOOK_EXT}`, PERMISSION_HOOK],
  ];

  for (const [bundled, dest] of pairs) {
    const src = path.join(context.extensionPath, "hook", bundled);
    try {
      const srcContent = fs.readFileSync(src, "utf-8");
      let destContent = "";
      try {
        destContent = fs.readFileSync(dest, "utf-8");
      } catch {}
      if (srcContent !== destContent) {
        fs.writeFileSync(dest, srcContent, { mode: 0o755 });
      }
    } catch {}
  }
}

/**
 * Register our hooks in ~/.claude/settings.json.
 * Skips writing if already correctly configured.
 */
function registerHooks() {
  const settings = readSettings();
  const expectedPrefix = IS_WIN ? "powershell" : "node";

  const hasHook = (type, needle) =>
    settings.hooks?.[type]?.some((entry) =>
      entry.hooks?.some(
        (h) =>
          h.command?.includes(needle) &&
          h.command?.startsWith(expectedPrefix)
      )
    );

  if (
    hasHook("Stop", "claude-pal-on-stop") &&
    hasHook("PermissionRequest", "claude-pal-on-permission")
  ) {
    return; // Already configured correctly
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Remove stale claude-pal entries
  for (const hookType of HOOK_TYPES) {
    if (settings.hooks[hookType]) {
      settings.hooks[hookType] = settings.hooks[hookType].filter(
        (entry) =>
          !entry.hooks?.some((h) => h.command?.includes(HOOK_PREFIX))
      );
      if (settings.hooks[hookType].length === 0) {
        delete settings.hooks[hookType];
      }
    }
  }

  // Stop hook — task completed
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  settings.hooks.Stop.push({
    hooks: [{ type: "command", command: hookCmd(STOP_HOOK) }],
  });

  // PermissionRequest hook — needs permission
  if (!settings.hooks.PermissionRequest)
    settings.hooks.PermissionRequest = [];
  settings.hooks.PermissionRequest.push({
    hooks: [{ type: "command", command: hookCmd(PERMISSION_HOOK) }],
  });

  writeSettings(settings);
}

/**
 * Remove our hooks from settings.json and delete deployed files.
 */
function unregisterHooks() {
  // Delete deployed files (keep CONFIG_FILE to persist sound selections)
  for (const file of [
    STOP_HOOK,
    PERMISSION_HOOK,
    SIGNAL_FILE,
    MUTE_FLAG,
  ]) {
    try {
      fs.unlinkSync(file);
    } catch {}
  }

  // Clean up both .js and .ps1 variants
  for (const name of ["claude-pal-on-stop", "claude-pal-on-permission"]) {
    for (const ext of [".js", ".ps1"]) {
      try {
        fs.unlinkSync(path.join(HOOKS_DIR, `${name}${ext}`));
      } catch {}
    }
  }

  // Remove entries from settings.json
  const settings = readSettings();
  for (const hookType of HOOK_TYPES) {
    if (settings.hooks?.[hookType]) {
      settings.hooks[hookType] = settings.hooks[hookType].filter(
        (entry) =>
          !entry.hooks?.some((h) => h.command?.includes(HOOK_PREFIX))
      );
      if (settings.hooks[hookType].length === 0) {
        delete settings.hooks[hookType];
      }
    }
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  writeSettings(settings);
}

// ── Signal file watcher ────────────────────────────────────────────

function handleSignal() {
  // Signal file is written by hook scripts to trigger sounds.
  // No VS Code notification needed — permission prompts and task
  // completion are already handled by VS Code's built-in UI.
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Set up the notifier: deploy hooks, sync config, start signal watcher.
 * @param {vscode.ExtensionContext} context
 */
function setupNotifier(context) {
  deployHookScripts(context);
  registerHooks();
  syncConfig();

  soundEnabled = !fs.existsSync(MUTE_FLAG);

  // Ensure signal file exists so fs.watch doesn't fail
  if (!fs.existsSync(SIGNAL_FILE)) {
    fs.writeFileSync(SIGNAL_FILE, "");
  }

  // Watch signal file for changes from hook scripts
  watcher = fs.watch(SIGNAL_FILE, (eventType) => {
    if (eventType === "change") {
      handleSignal();
    }
  });
  context.subscriptions.push({ dispose: () => watcher?.close() });
}

/**
 * Tear down the notifier: close watcher, remove hooks and files.
 */
function teardownNotifier() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  unregisterHooks();
}

/**
 * @returns {boolean} Whether sound is currently muted.
 */
function isSoundMuted() {
  return !soundEnabled;
}

/**
 * Toggle the mute state. Creates or removes the mute flag file.
 */
function toggleSound() {
  soundEnabled = !soundEnabled;
  if (soundEnabled) {
    try {
      fs.unlinkSync(MUTE_FLAG);
    } catch {}
  } else {
    fs.writeFileSync(MUTE_FLAG, "");
  }
  console.log(`Claude Pal sound: ${soundEnabled ? "ON" : "OFF"}`);
}

/**
 * Explicitly set sound on or off.
 */
function setSoundEnabled(enabled) {
  if (enabled === soundEnabled) return;
  toggleSound();
}

/**
 * Get the list of sound names available on this platform.
 */
function getAvailableSounds() {
  return Object.keys(getSoundMap());
}

/**
 * Play a single sound by name using the platform's player.
 */
function playSound(name) {
  const { execSync } = require("child_process");
  const map = getSoundMap();
  const soundPath = map[name];
  if (!soundPath) return;
  try {
    const pk = getPlatformKey();
    if (pk === "win") {
      const ps = `$s='${soundPath}'; if(Test-Path $s){(New-Object Media.SoundPlayer $s).PlaySync()}else{[console]::Beep(800,300)}`;
      const psBin = IS_WSL ? "powershell.exe" : "powershell";
      execSync(`${psBin} -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}`, { stdio: "ignore", timeout: 5000 });
    } else if (pk === "mac") {
      execSync(`afplay "${soundPath}"`, { stdio: "ignore", timeout: 5000 });
    } else {
      // Linux: try paplay first, fall back to aplay, then terminal bell
      try {
        execSync(`paplay "${soundPath}"`, { stdio: "ignore", timeout: 5000 });
      } catch {
        try {
          execSync(`aplay "${soundPath}"`, { stdio: "ignore", timeout: 5000 });
        } catch {
          process.stdout.write("\x07"); // terminal bell
        }
      }
    }
  } catch {}
}

/**
 * Read the current hook config.
 */
function readHookConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Show a QuickPick to change a sound, with preview on select.
 * @param {"prompt"|"done"} eventType
 * @param {function} onUpdate - callback after sound is changed
 */
async function changeSoundPicker(eventType, onUpdate) {
  const sounds = getAvailableSounds();
  const config = readHookConfig();
  const configKey = eventType === "prompt" ? "asksQuestion" : "taskCompleted";
  const d = getDefaultSounds();
  const currentSound = config[configKey]?.sound || (eventType === "prompt" ? d.prompt : d.done);

  const items = sounds.map(s => ({
    label: s === currentSound ? `${s} ✓` : s,
    sound: s,
  }));

  const picker = vscode.window.createQuickPick();
  picker.title = eventType === "prompt" ? "Prompt Sound" : "Done Sound";
  picker.placeholder = `Current: ${currentSound}. Select to preview, Enter to save.`;
  picker.items = items;

  // Preview sound on highlight
  picker.onDidChangeActive((items) => {
    if (items.length > 0) {
      playSound(items[0].sound);
    }
  });

  picker.onDidAccept(() => {
    const selected = picker.selectedItems[0];
    if (selected) {
      config[configKey] = { sound: selected.sound };
      try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
      } catch {}
      if (onUpdate) onUpdate();
    }
    picker.dispose();
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
}

module.exports = {
  setupNotifier,
  teardownNotifier,
  isSoundMuted,
  setSoundEnabled,
  toggleSound,
  changeSoundPicker,
};
