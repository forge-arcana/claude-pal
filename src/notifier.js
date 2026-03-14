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
const HOOK_EXT = IS_WIN ? ".ps1" : ".js";

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
 * Write VS Code claudePal.notifications config to disk so hook scripts
 * can read which sounds to play.
 */
function syncConfig() {
  const cfg = vscode.workspace.getConfiguration("claudePal");
  const config = {
    toolPrompt: {
      sound: cfg.get("notifications.toolPrompt.sound", "Glass"),
    },
    taskComplete: {
      sound: cfg.get("notifications.taskComplete.sound", "Hero"),
    },
  };
  try {
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
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
  // Delete deployed files
  for (const file of [
    STOP_HOOK,
    PERMISSION_HOOK,
    SIGNAL_FILE,
    MUTE_FLAG,
    CONFIG_FILE,
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

  // Re-sync config when VS Code settings change
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("claudePal")) {
      syncConfig();
    }
  });
  context.subscriptions.push(configListener);
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

module.exports = {
  setupNotifier,
  teardownNotifier,
  isSoundMuted,
  toggleSound,
};
