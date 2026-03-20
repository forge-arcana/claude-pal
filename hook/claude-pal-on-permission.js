#!/usr/bin/env node
// Claude Pal — PermissionRequest hook script (v3)
// Plays a sound when Claude needs permission to use a tool.
const fs = require("fs");
const path = require("path");

const HOOKS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".claude", "hooks");
const MUTE_FLAG = path.join(HOOKS_DIR, "claude-pal-muted");
const { resolveSound, getDefaultSound, readConfig, playSound } = require(path.join(HOOKS_DIR, "claude-pal-sounds"));

let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { process.stderr.write("claude-pal: failed to parse stdin\n"); process.exit(0); }

  if (fs.existsSync(MUTE_FLAG)) process.exit(0);

  // Skip AskUserQuestion — handled by the stop hook
  if (input.tool_name === "AskUserQuestion") process.exit(0);

  const config = readConfig();
  const eventCfg = config?.asksQuestion ?? {};
  const level = eventCfg.level ?? "sound";

  if (level === "off") process.exit(0);

  const soundName = eventCfg.sound || getDefaultSound("prompt");
  const sound = resolveSound(soundName);

  if (sound) playSound(sound);

  process.exit(0);
});
