import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findGlobalBinary } from "./init.js";

export function runDoctor({ homeDir = os.homedir(), envPath = process.env.PATH || "", platform = process.platform } = {}) {
  const checks = [];

  // 1. Node version >= 20
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: major >= 20 ? "PASS" : "FAIL",
    detail: `Node.js v${process.versions.node}`,
    hint: major >= 20 ? null : "Install Node.js 20 or newer.",
  });

  // 2. Global binary vs npx mode
  const globalBin = findGlobalBinary("curveguard", envPath, platform);
  checks.push({
    name: "binary",
    status: globalBin ? "PASS" : "WARN",
    detail: globalBin ? `Installed at ${globalBin}` : "Running via npx (not installed globally on PATH)",
    hint: globalBin ? null : "Optional faster cold start: npm install -g curveguard",
  });

  // 3. Cursor MCP config
  const cursorMcp = path.join(homeDir, ".cursor", "mcp.json");
  if (fs.existsSync(cursorMcp)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cursorMcp, "utf8"));
      const has = Boolean(parsed?.mcpServers?.curveguard);
      checks.push({
        name: "mcp (cursor)",
        status: has ? "PASS" : "WARN",
        detail: has ? `Configured in ${cursorMcp}` : `Missing from ${cursorMcp}`,
        hint: has ? null : "Run: npx curveguard init --cursor",
      });
    } catch {
      checks.push({
        name: "mcp (cursor)",
        status: "FAIL",
        detail: `Invalid JSON in ${cursorMcp}`,
        hint: "Fix syntax error in ~/.cursor/mcp.json",
      });
    }
  }

  // 4. Claude Code MCP config
  const claudeJson = path.join(homeDir, ".claude.json");
  if (fs.existsSync(claudeJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(claudeJson, "utf8"));
      const has = Boolean(parsed?.mcpServers?.curveguard);
      checks.push({
        name: "mcp (claude-code)",
        status: has ? "PASS" : "WARN",
        detail: has ? `Configured in ${claudeJson}` : `Missing from ${claudeJson}`,
        hint: has ? null : "Run: npx curveguard init --claude-code",
      });
    } catch {
      checks.push({
        name: "mcp (claude-code)",
        status: "FAIL",
        detail: `Invalid JSON in ${claudeJson}`,
        hint: "Fix syntax error in ~/.claude.json",
      });
    }
  }

  // 5. Codex config
  const codexToml = path.join(homeDir, ".codex", "config.toml");
  if (fs.existsSync(codexToml)) {
    const raw = fs.readFileSync(codexToml, "utf8");
    const has = raw.includes("[mcp_servers.curveguard]");
    checks.push({
      name: "mcp (codex)",
      status: has ? "PASS" : "WARN",
      detail: has ? `Configured in ${codexToml}` : `Missing from ${codexToml}`,
      hint: has ? null : "Run: npx curveguard init --codex",
    });
  }

  return checks;
}
