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
const { getSoundMap, playSoundByName, playSoundByNameAsync } = soundModule;

const STOP_HOOK = path.join(HOOKS_DIR, `claude-pal-on-stop${HOOK_EXT}`);
const PERMISSION_HOOK = path.join(HOOKS_DIR, `claude-pal-on-permission${HOOK_EXT}`);
const CONFIG_FILE = path.join(HOOKS_DIR, "claude-pal-config.json");
const HOOK_TYPES = ["Stop", "PermissionRequest"];
const HOOK_PREFIX = "claude-pal";
const HOOK_ENTRY_TYPE = "command";

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
 * Set up the notifier: deploy hooks, sync config.
 * @param {vscode.ExtensionContext} context
 */
function setupNotifier(context) {
  deployHookScripts(context);
  registerHooks();
  syncConfig();

  // Migrate legacy global mute flag to per-event config
  const legacyMuteFlag = path.join(HOOKS_DIR, "claude-pal-muted");
  if (fs.existsSync(legacyMuteFlag)) {
    const config = readHookConfig();
    const d = getDefaultSounds();
    config.asksQuestion = { sound: config.asksQuestion?.sound || d.prompt, level: 'off' };
    config.taskCompleted = { sound: config.taskCompleted?.sound || d.done, level: 'off' };
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
      fs.unlinkSync(legacyMuteFlag);
    } catch {}
  }
}

/**
 * Tear down the notifier: close watcher, remove hooks and files.
 */
function teardownNotifier() {
  unregisterHooks();
}

/**
 * Get the list of sound names available on this platform.
 */
function getAvailableSounds() {
  return Object.keys(getSoundMap());
}

/**
 * Play a single sound by name (blocking).
 */
function playSound(name) {
  playSoundByName(name);
}

/**
 * Play a single sound by name (non-blocking, for UI contexts).
 */
function playSoundNonBlocking(name) {
  playSoundByNameAsync(name);
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
 * Get display label for an event's current sound setting.
 * @param {"prompt"|"done"} eventType
 * @returns {string} Sound name or "Off"
 */
function getEventSoundLabel(eventType) {
  const config = readHookConfig();
  const configKey = eventType === "prompt" ? "asksQuestion" : "taskCompleted";
  const d = getDefaultSounds();
  const eventCfg = config[configKey] ?? {};
  if (eventCfg.level === "off") return "Off";
  return eventCfg.sound || (eventType === "prompt" ? d.prompt : d.done);
}

/**
 * Show a QuickPick to change a sound, with preview on select.
 * Includes "No sound" option to disable per-event sounds.
 * @param {"prompt"|"done"} eventType
 * @param {function} onUpdate - callback after sound is changed
 * @param {function} [onBack] - callback when picker closes (for menu navigation)
 */
function changeSoundPicker(eventType, onUpdate, onBack) {
  const sounds = getAvailableSounds();
  let config = readHookConfig();
  const configKey = eventType === "prompt" ? "asksQuestion" : "taskCompleted";
  const d = getDefaultSounds();
  let selectedSound = config[configKey]?.sound || (eventType === "prompt" ? d.prompt : d.done);
  let selectedLevel = config[configKey]?.level ?? "sound";

  function buildItems() {
    const isOff = selectedLevel === "off";
    const items = [];
    items.push({
      label: isOff ? "$(check) No sound" : "     No sound",
      sound: "__none__",
    });
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator, sound: null });
    for (const s of sounds) {
      items.push({
        label: !isOff && s === selectedSound ? `$(check) ${s}` : `     ${s}`,
        sound: s,
      });
    }
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator, sound: null });
    items.push({ label: "$(arrow-left) Back", sound: "__back__" });
    items.push({ label: "$(close) Close", sound: "__close__" });
    return items;
  }

  const picker = vscode.window.createQuickPick();
  picker.title = eventType === "prompt" ? "Prompt Sound" : "Done Sound";
  picker.placeholder = "Click to preview & select. Back when done.";
  picker.items = buildItems();

  picker.onDidAccept(() => {
    const selected = picker.selectedItems[0];
    if (!selected) return;

    // Navigation items close the picker
    if (selected.sound === "__close__") {
      picker.dispose();
      return;
    }
    if (selected.sound === "__back__") {
      picker.dispose();
      if (onBack) onBack();
      return;
    }

    // Sound selection: preview, save, update checkmark — stay open
    if (selected.sound === "__none__") {
      selectedLevel = "off";
    } else {
      selectedSound = selected.sound;
      selectedLevel = "sound";
      playSoundNonBlocking(selected.sound);
    }

    // Save to config
    config = readHookConfig();
    if (selectedLevel === "off") {
      config[configKey] = { ...config[configKey], level: "off" };
    } else {
      config[configKey] = { ...config[configKey], sound: selectedSound, level: "sound" };
    }
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
    } catch {}
    if (onUpdate) onUpdate();

    // Rebuild items to move checkmark, restore active position
    const clickedSound = selected.sound;
    const newItems = buildItems();
    picker.items = newItems;
    const activeItem = newItems.find(i => i.sound === clickedSound);
    if (activeItem) picker.activeItems = [activeItem];
  });

  picker.onDidHide(() => {
    picker.dispose();
    if (onBack) onBack();
  });
  picker.show();
}

module.exports = {
  setupNotifier,
  teardownNotifier,
  changeSoundPicker,
  getEventSoundLabel,
};
