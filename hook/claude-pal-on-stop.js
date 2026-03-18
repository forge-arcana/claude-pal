#!/usr/bin/env node
// Claude Pal — Stop hook script (v3)
// Plays "task completed" or "question asked" sound when Claude finishes.
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

  const soundName = eventCfg.sound || getDefaultSound(reason === "question" ? "prompt" : "done");
  const sound = resolveSound(soundName);

  if (sound) playSound(sound);

  // Write signal for VSCode extension
  try {
    fs.writeFileSync(path.join(HOOKS_DIR, "claude-pal-signal"), reason + " " + Date.now());
  } catch {}

  process.exit(0);
});
