// @ts-check
/**
 * Claude Pal — Sound Notifier Module
 *
 * Deploys hook scripts to ~/.claude/hooks/ so Claude Code plays sounds
 * on two events: toolPrompt (PermissionRequest) and taskComplete (Stop).
 */

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const { CLAUDE_DIR, readSettings, writeSettings } = require("./claudeSettings");
const HOOKS_DIR = path.join(CLAUDE_DIR, "hooks");
const IS_WIN = process.platform === "win32";
const HOOK_EXT = IS_WIN ? ".ps1" : ".js";

// Sound maps loaded from shared module (single source of truth)
const soundModule = require("../hook/claude-pal-sounds");
const { getSoundMap, playSoundByName } = soundModule;

const STOP_HOOK = path.join(HOOKS_DIR, `claude-pal-on-stop${HOOK_EXT}`);
const PERMISSION_HOOK = path.join(HOOKS_DIR, `claude-pal-on-permission${HOOK_EXT}`);
const MUTE_FLAG = path.join(HOOKS_DIR, "claude-pal-muted");
const CONFIG_FILE = path.join(HOOKS_DIR, "claude-pal-config.json");
const HOOK_TYPES = ["Stop", "PermissionRequest"];
const HOOK_PREFIX = "claude-pal";
const HOOK_ENTRY_TYPE = "command";

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

// ── Config sync ────────────────────────────────────────────────────

/**
 * Ensure hook config file exists with platform-appropriate defaults.
 * Does not overwrite existing config — the QuickPick manages sound selection.
 */
function getDefaultSounds() {
  return {
    prompt: soundModule.getDefaultSound("prompt"),
    done: soundModule.getDefaultSound("done"),
  };
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

  const SOUNDS_MODULE = path.join(HOOKS_DIR, "claude-pal-sounds.js");

  const pairs = [
    [`claude-pal-on-stop${HOOK_EXT}`, STOP_HOOK],
    [`claude-pal-on-permission${HOOK_EXT}`, PERMISSION_HOOK],
    ["claude-pal-sounds.js", SOUNDS_MODULE],
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
    hooks: [{ type: HOOK_ENTRY_TYPE, command: hookCmd(STOP_HOOK) }],
  });

  // PermissionRequest hook — needs permission
  if (!settings.hooks.PermissionRequest)
    settings.hooks.PermissionRequest = [];
  settings.hooks.PermissionRequest.push({
    hooks: [{ type: HOOK_ENTRY_TYPE, command: hookCmd(PERMISSION_HOOK) }],
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
}

/**
 * Tear down the notifier: close watcher, remove hooks and files.
 */
function teardownNotifier() {
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
  playSoundByName(name);
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
