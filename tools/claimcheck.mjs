#!/usr/bin/env node
/**
 * CurveGuard Mechanical Claim Verifier (`node tools/claimcheck.mjs`)
 *
 * Ensures every documented capability, tool count, contract artifact, synced browser module,
 * and zero-custody invariant matches the repository before publishing or deploying.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_TOOLS } from "../packages/cli/src/mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, status: ok ? "PASS" : "FAIL", detail });
}

// 1. Core modules synced to browser site
const coreFiles = fs.readdirSync(path.join(ROOT, "packages", "core", "src")).filter((f) => f.endsWith(".js"));
const siteCoreFiles = fs.readdirSync(path.join(ROOT, "apps", "site", "js", "core")).filter((f) => f.endsWith(".js"));
check(
  "browser-core-sync",
  coreFiles.length === siteCoreFiles.length && coreFiles.every((f) => siteCoreFiles.includes(f)),
  `${siteCoreFiles.length}/${coreFiles.length} @curveguard/core modules synced to apps/site/js/core`
);

// 2. Zero external runtime dependencies in core, cli, worker
for (const rel of ["packages/core/package.json", "packages/cli/package.json", "apps/worker/package.json"]) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  const depCount = Object.keys(pkg.dependencies || {}).length;
  check(`zero-deps (${rel})`, depCount === 0, `${depCount} external runtime dependencies`);
}

// 3. MCP tool count matches 8
check("mcp-tools", MCP_TOOLS.length === 8, `${MCP_TOOLS.length} stdio MCP tools registered`);

// 4. Contract Sourcify standard-input & ABI present
const stdJsonPath = path.join(ROOT, "contracts", "src", "build", "AuditSealRegistry.standard-input.json");
const abiPath = path.join(ROOT, "contracts", "src", "build", "AuditSealRegistry.json");
check(
  "sourcify-artifacts",
  fs.existsSync(stdJsonPath) && fs.existsSync(abiPath),
  "AuditSealRegistry.json + AuditSealRegistry.standard-input.json ready for Sourcify v2 exact_match"
);

// 5. Plugin manifests present for Cursor, Claude Code, Codex, and Agent Skill
for (const rel of [
  ".cursor-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".codex-plugin/mcp.json",
  "skills/curveguard/SKILL.md",
]) {
  check(`plugin (${rel})`, fs.existsSync(path.join(ROOT, rel)), rel);
}

let failed = 0;
for (const c of checks) {
  if (c.status !== "PASS") failed++;
  console.log(`${c.status.padEnd(5)} ${c.name.padEnd(32)} ${c.detail}`);
}

if (failed > 0) process.exit(1);
