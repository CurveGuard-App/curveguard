import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTransientRunnerDir, findGlobalBinary, runInit } from "../src/init.js";
import { runDoctor } from "../src/doctor.js";
import { handleMcpRequest, MCP_TOOLS } from "../src/mcp.js";

test("isTransientRunnerDir filters out _npx and node_modules/.bin shims", () => {
  assert.equal(isTransientRunnerDir("/Users/dev/.npm/_npx/12345/node_modules/.bin"), true);
  assert.equal(isTransientRunnerDir("C:\\Users\\Admin\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\.bin"), true);
  assert.equal(isTransientRunnerDir("C:\\project\\node_modules\\.bin"), true);
  assert.equal(isTransientRunnerDir("/usr/local/bin"), false);
  assert.equal(isTransientRunnerDir("C:\\Users\\Admin\\AppData\\Roaming\\npm"), false);
});

test("runInit configures Cursor, Claude Code & Codex idempotently with .curveguard-bak backups", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cg-init-test-"));
  try {
    const cursorDir = path.join(tmpHome, ".cursor");
    const claudeDir = path.join(tmpHome, ".claude");
    const codexDir = path.join(tmpHome, ".codex");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });

    // Pre-populate existing MCP server to ensure we never clobber user config
    const cursorMcpPath = path.join(cursorDir, "mcp.json");
    fs.writeFileSync(cursorMcpPath, JSON.stringify({ mcpServers: { existingServer: { command: "node", args: ["a.js"] } } }, null, 2));

    // Simulate running from transient _npx PATH -> should register `npx -y curveguard mcp`, NOT `curveguard mcp`
    const fakeNpxBin = path.join(tmpHome, "_npx", "999", "node_modules", ".bin");
    fs.mkdirSync(fakeNpxBin, { recursive: true });
    fs.writeFileSync(path.join(fakeNpxBin, "curveguard.cmd"), "@echo off\n");

    assert.equal(findGlobalBinary("curveguard", fakeNpxBin, "win32"), null);

    const res1 = runInit({ homeDir: tmpHome, platform: "linux", envPath: fakeNpxBin });
    assert.equal(res1.globalBin, null);

    const written = JSON.parse(fs.readFileSync(cursorMcpPath, "utf8"));
    assert.ok(written.mcpServers.existingServer, "preserved existing user MCP server");
    assert.deepEqual(written.mcpServers.curveguard, { command: "npx", args: ["-y", "github:CurveGuard-App/curveguard", "mcp"] });
    assert.equal(fs.existsSync(`${cursorMcpPath}.curveguard-bak`), true, "wrote backup once");

    // Running a second time is a no-op (`unchanged`)
    const res2 = runInit({ homeDir: tmpHome, platform: "linux", envPath: fakeNpxBin });
    const cursorAction = res2.actions.find((a) => a.client === "cursor");
    assert.equal(cursorAction.status, "unchanged");

    // Doctor passes all configured clients
    const doc = runDoctor({ homeDir: tmpHome, platform: "linux", envPath: fakeNpxBin });
    assert.equal(doc.some((d) => d.status === "FAIL"), false);
    assert.equal(doc.find((d) => d.name === "mcp (cursor)")?.status, "PASS");
    assert.equal(doc.find((d) => d.name === "mcp (codex)")?.status, "PASS");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("MCP JSON-RPC handler exposes all 8 tools and computes deterministic curve quotes & sniper walls", async () => {
  const initResp = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(initResp.result.serverInfo.name, "curveguard");

  const listResp = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(listResp.result.tools.length, 8);
  assert.equal(MCP_TOOLS.length, 8);

  const quoteResp = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "quote_curve",
      arguments: { reserve_eth: 1.2, eth_in: 0.1, creator_tax_bps: 195 },
    },
  });
  const quoteData = JSON.parse(quoteResp.result.content[0].text);
  assert.equal(quoteData.side, "buy");
  assert.ok(quoteData.extraTokensDirect > 0);

  const wallResp = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "sniper_wall",
      arguments: { sniper_tokens: 200_000_000, sniper_cost_eth: 0.75, profit_multiple: 1.55, creator_tax_bps: 200 },
    },
  });
  const wallData = JSON.parse(wallResp.result.content[0].text);
  assert.ok(wallData.sellWallMcapUsd > 8000);
  assert.ok(wallData.safeExitReserveEth < wallData.sellWallReserveEth);
});
