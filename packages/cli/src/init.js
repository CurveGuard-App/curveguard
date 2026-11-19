/**
 * Multi-client MCP bootstrapper (`curveguard init`).
 *
 * Configures Claude Code, Cursor, Codex, Claude Desktop, and Hermes idempotently:
 *  - Creates `.curveguard-bak` once before first modification
 *  - Never strips existing user MCP servers
 *  - Avoids the transient `_npx` / `node_modules/.bin` PATH trap by checking real global PATH entries
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isTransientRunnerDir(dirPath) {
  const norm = String(dirPath || "").replace(/\\/g, "/").toLowerCase();
  return norm.includes("/_npx/") || norm.includes("/node_modules/.bin") || norm.endsWith("/node_modules/.bin");
}

export function findGlobalBinary(binName = "curveguard", envPath = process.env.PATH || "", platform = process.platform) {
  const sep = platform === "win32" ? ";" : ":";
  const exts = platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const dirs = envPath.split(sep).map((d) => d.trim()).filter(Boolean);

  for (const dir of dirs) {
    if (isTransientRunnerDir(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, binName + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {}
    }
  }
  return null;
}

export const NPX_PACKAGE_SPEC = "github:CurveGuard-App/curveguard";

export function buildMcpCommandSpec({ globalInstalled = false, platform = process.platform, forGuiApp = false } = {}) {
  if (globalInstalled && !forGuiApp) {
    if (platform === "win32") {
      return { command: "cmd", args: ["/c", "curveguard", "mcp"] };
    }
    return { command: "curveguard", args: ["mcp"] };
  }
  if (platform === "win32" && forGuiApp) {
    return { command: "cmd", args: ["/c", "npx", "-y", NPX_PACKAGE_SPEC, "mcp"] };
  }
  return { command: "npx", args: ["-y", NPX_PACKAGE_SPEC, "mcp"] };
}

function backupOnce(filePath) {
  const bak = `${filePath}.curveguard-bak`;
  if (fs.existsSync(filePath) && !fs.existsSync(bak)) {
    fs.copyFileSync(filePath, bak);
    return bak;
  }
  return null;
}

function upsertJsonMcpConfig(filePath, serverKey, spec, dryRun = false) {
  let current = {};
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8");
    try {
      current = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return { status: "skipped", filePath, reason: "Existing JSON could not be parsed safely; left untouched." };
    }
  }

  if (!current.mcpServers || typeof current.mcpServers !== "object") {
    current.mcpServers = {};
  }

  const prev = current.mcpServers[serverKey];
  const unchanged =
    prev &&
    prev.command === spec.command &&
    JSON.stringify(prev.args || []) === JSON.stringify(spec.args || []);

  if (unchanged) {
    return { status: "unchanged", filePath };
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    backupOnce(filePath);
    current.mcpServers[serverKey] = spec;
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, filePath);
  }

  return { status: dryRun ? "would-write" : "configured", filePath, spec };
}

function upsertCodexToml(filePath, spec, dryRun = false) {
  const blockHeader = "[mcp_servers.curveguard]";
  const block = [
    blockHeader,
    `command = ${JSON.stringify(spec.command)}`,
    `args = [${spec.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    "",
  ].join("\n");

  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf8");
    if (existing.includes(blockHeader)) {
      return { status: "unchanged", filePath };
    }
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    backupOnce(filePath);
    const sep = existing && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "";
    fs.writeFileSync(filePath, existing + sep + block, "utf8");
  }

  return { status: dryRun ? "would-write" : "configured", filePath, spec };
}

export function runInit({
  homeDir = os.homedir(),
  platform = process.platform,
  envPath = process.env.PATH || "",
  targets = [], // ["cursor", "claude-code", "codex", "claude-desktop", "all"]
  dryRun = false,
} = {}) {
  const globalBin = findGlobalBinary("curveguard", envPath, platform);
  const cliSpec = buildMcpCommandSpec({ globalInstalled: Boolean(globalBin), platform, forGuiApp: false });
  const guiSpec = buildMcpCommandSpec({ globalInstalled: Boolean(globalBin), platform, forGuiApp: true });

  const wantAll = targets.includes("all");
  const explicit = new Set(targets.filter((t) => t !== "all"));

  const cursorDir = path.join(homeDir, ".cursor");
  const claudeDir = path.join(homeDir, ".claude");
  const codexDir = path.join(homeDir, ".codex");
  const claudeDesktopPath =
    platform === "win32"
      ? path.join(process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : platform === "darwin"
      ? path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : path.join(homeDir, ".config", "Claude", "claude_desktop_config.json");

  const autoDetect = explicit.size === 0 && !wantAll;
  const actions = [];

  if (wantAll || explicit.has("cursor") || (autoDetect && fs.existsSync(cursorDir))) {
    actions.push({
      client: "cursor",
      ...upsertJsonMcpConfig(path.join(cursorDir, "mcp.json"), "curveguard", guiSpec, dryRun),
    });
  }

  if (wantAll || explicit.has("claude-code") || (autoDetect && fs.existsSync(claudeDir))) {
    actions.push({
      client: "claude-code",
      ...upsertJsonMcpConfig(path.join(homeDir, ".claude.json"), "curveguard", cliSpec, dryRun),
    });
  }

  if (wantAll || explicit.has("codex") || (autoDetect && fs.existsSync(codexDir))) {
    actions.push({
      client: "codex",
      ...upsertCodexToml(path.join(codexDir, "config.toml"), cliSpec, dryRun),
    });
  }

  if (wantAll || explicit.has("claude-desktop") || (autoDetect && fs.existsSync(path.dirname(claudeDesktopPath)))) {
    actions.push({
      client: "claude-desktop",
      ...upsertJsonMcpConfig(claudeDesktopPath, "curveguard", guiSpec, dryRun),
    });
  }

  if (actions.length === 0) {
    // Fallback: configure Cursor mcp.json if nothing detected so user always gets a concrete setup
    actions.push({
      client: "cursor",
      ...upsertJsonMcpConfig(path.join(cursorDir, "mcp.json"), "curveguard", guiSpec, dryRun),
    });
  }

  return {
    dryRun,
    globalBin,
    actions,
  };
}
