/**
 * CurveGuard Stdio MCP Server (JSON-RPC 2.0, newline-delimited stdio, protocol 2025-06-18).
 * Exposes 8 deterministic onchain curve-forensics & guard tools to Cursor, Claude Code, Codex, and Hermes.
 */

import readline from "node:readline";
import core from "./core-bridge.js";

const DEFAULT_API_URL = process.env.CURVEGUARD_API_URL || "https://curveguard.app";
const DEFAULT_RPC_URL = process.env.CURVEGUARD_RPC_URL || core.RH_CHAIN_DEFAULTS.rpcUrl;

export const MCP_TOOLS = [
  {
    name: "scan_token",
    description: "Run a live 0-wallet CurveGuard X-ray on any Pons v2 token on Robinhood Chain (4663): sniper overhang %, exact mathematical sell-wall ($MCAP & ETH reserve), safe front-run exit setpoint, same-block 100ms swarms, and creator tax check.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "0x token contract address on Robinhood Chain (4663)" },
      },
      required: ["token"],
    },
  },
  {
    name: "live_radar",
    description: "Fetch the live CurveGuard radar of active Pons bonding curves ranked by Clean-Climb score vs early sniper overhang.",
    inputSchema: {
      type: "object",
      properties: {
        clean_only: { type: "boolean", description: "Only return curves with CLEAN_CLIMB verdict" },
        limit: { type: "number", description: "Max tokens to return (default 12)" },
      },
    },
  },
  {
    name: "quote_curve",
    description: "Compute exact constant-product buy or sell quote on a Pons v2 curve at a given ETH reserve and compare 0% direct curve execution vs 1% bot-router fee bleed.",
    inputSchema: {
      type: "object",
      properties: {
        reserve_eth: { type: "number", description: "Current curve realQuoteReserve in ETH (0..4.20)" },
        eth_in: { type: "number", description: "ETH amount to buy (optional if tokens_in provided)" },
        tokens_in: { type: "number", description: "Token amount to sell (optional if eth_in provided)" },
        creator_tax_bps: { type: "number", description: "Creator tax in bps (default 200)" },
      },
      required: ["reserve_eth"],
    },
  },
  {
    name: "sniper_wall",
    description: "Calculate the exact curve ETH reserve and $MCAP where an early sniper bag reaches its target profit multiple, plus the recommended safe exit setpoint 7% below the wall.",
    inputSchema: {
      type: "object",
      properties: {
        sniper_tokens: { type: "number", description: "Tokens held by early sniper cluster" },
        sniper_cost_eth: { type: "number", description: "ETH spent by early sniper cluster" },
        profit_multiple: { type: "number", description: "Target net ETH multiple (default 1.55)" },
        creator_tax_bps: { type: "number", description: "Creator tax in bps (default 200)" },
      },
      required: ["sniper_tokens", "sniper_cost_eth"],
    },
  },
  {
    name: "replay_guard",
    description: "Replay a Stop-Loss + Trailing-Stop + Exit-Before-Sniper-Wall strategy on a real Pons token's historical curve blocks vs passive Buy & Hold.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "0x token contract address on Robinhood Chain" },
        entry_after_sec: { type: "number", description: "Seconds after launch to simulate entry (default 15)" },
        eth_in: { type: "number", description: "Simulated buy size in ETH (default 0.1)" },
        stop_loss_pct: { type: "number", description: "Hard stop loss % (default 18)" },
        trailing_stop_pct: { type: "number", description: "Trailing stop % from peak (default 14)" },
        exit_before_wall: { type: "boolean", description: "Auto-exit 7% before the sniper sell wall (default true)" },
      },
      required: ["token"],
    },
  },
  {
    name: "verify_seal",
    description: "Verify a Merkle-sealed CurveGuard audit record against AuditSealRegistry on Robinhood Chain.",
    inputSchema: {
      type: "object",
      properties: {
        epoch_hour: { type: "number", description: "Optional sealed epoch hour timestamp (defaults to latest)" },
        token: { type: "string", description: "Optional 0x token address to verify in that epoch" },
      },
    },
  },
  {
    name: "check_holder_tier",
    description: "Read-only balance check (zero wallet signature) for CurveGuard Clean-Feed & Live Alert tier on Robinhood Chain.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "0x wallet address to check" },
      },
      required: ["wallet"],
    },
  },
  {
    name: "guard_command",
    description: "Generate the exact local zero-custody CLI guard command (`npx curveguard guard ...`) for a token based on its live sniper wall and volatility.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "0x token contract address" },
      },
      required: ["token"],
    },
  },
];

export async function executeMcpTool(name, args = {}, { apiUrl = DEFAULT_API_URL, rpcUrl = DEFAULT_RPC_URL, fetchImpl = globalThis.fetch } = {}) {
  switch (name) {
    case "scan_token": {
      const scan = await core.scanPonsTokenLive(args.token, { rpcUrl, fetchImpl });
      return {
        token: scan.token,
        verdict: scan.forensics.verdict,
        cleanScore: scan.forensics.cleanScore,
        flags: scan.forensics.flags,
        metrics: scan.forensics.metrics,
        topSnipers: scan.forensics.snipers.slice(0, 8),
        swarmClusters: scan.forensics.swarmClusters.slice(0, 5),
      };
    }
    case "live_radar": {
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 12));
      const res = await fetchImpl(`${apiUrl}/v1/radar?limit=${limit}${args.clean_only ? "&clean=1" : ""}`);
      if (!res.ok) throw new Error(`Radar API HTTP ${res.status}`);
      return await res.json();
    }
    case "quote_curve": {
      const reserveEth = Number(args.reserve_eth) || 0;
      const tax = Number(args.creator_tax_bps ?? 200);
      if (args.tokens_in) {
        const direct = core.quoteCurveSell({ realReserveEth: reserveEth, tokensIn: Number(args.tokens_in), creatorTaxBps: tax, routerFeeBps: 0 });
        const botRouter = core.quoteCurveSell({ realReserveEth: reserveEth, tokensIn: Number(args.tokens_in), creatorTaxBps: tax, routerFeeBps: 100 });
        return { side: "sell", directCurve: direct, via1PctBotRouter: botRouter, savedEth: Number((direct.netEthOut - botRouter.netEthOut).toFixed(6)) };
      }
      const ethIn = Number(args.eth_in ?? 0.1);
      const direct = core.quoteCurveBuy({ realReserveEth: reserveEth, grossEthIn: ethIn, creatorTaxBps: tax, routerFeeBps: 0 });
      const botRouter = core.quoteCurveBuy({ realReserveEth: reserveEth, grossEthIn: ethIn, creatorTaxBps: tax, routerFeeBps: 100 });
      return { side: "buy", directCurve: direct, via1PctBotRouter: botRouter, extraTokensDirect: Math.round(direct.tokensOut - botRouter.tokensOut) };
    }
    case "sniper_wall": {
      const mult = Number(args.profit_multiple ?? 1.55);
      const tax = Number(args.creator_tax_bps ?? 200);
      const wallRes = core.solveReserveForTargetExit({
        tokensHeld: Number(args.sniper_tokens) * 0.45,
        targetNetEthOut: Number(args.sniper_cost_eth) * 0.45 * mult,
        creatorTaxBps: tax,
      });
      const wallState = core.curveStateAtReserve(wallRes);
      const safeRes = Number((wallRes * 0.93).toFixed(4));
      const safeState = core.curveStateAtReserve(safeRes);
      return {
        sellWallReserveEth: wallRes,
        sellWallMcapUsd: Math.round(wallState.mcapUsd),
        safeExitReserveEth: safeRes,
        safeExitMcapUsd: Math.round(safeState.mcapUsd),
      };
    }
    case "replay_guard": {
      const scan = await core.scanPonsTokenLive(args.token, { rpcUrl, fetchImpl });
      return core.replayGuardStrategy({
        trades: scan.trades,
        deployer: scan.token.deployer,
        creatorTaxBps: scan.token.creatorTaxBps,
        entryAfterSec: Number(args.entry_after_sec ?? 15),
        ethIn: Number(args.eth_in ?? 0.1),
        stopLossPct: Number(args.stop_loss_pct ?? 18),
        trailingStopPct: Number(args.trailing_stop_pct ?? 14),
        exitBeforeWall: args.exit_before_wall !== false,
      });
    }
    case "verify_seal": {
      const q = new URLSearchParams();
      if (args.epoch_hour) q.set("epoch", String(args.epoch_hour));
      if (args.token) q.set("token", String(args.token));
      const res = await fetchImpl(`${apiUrl}/v1/seals/proof?${q.toString()}`);
      if (!res.ok) throw new Error(`Seal proof API HTTP ${res.status}`);
      const payload = await res.json();
      if (!payload.ok) return payload;
      const localVerify = core.verifyMerkleProof({
        record: payload.record,
        proof: payload.proof,
        expectedRoot: payload.merkleRoot,
      });
      return { ...payload, localMerkleVerification: localVerify };
    }
    case "check_holder_tier": {
      const res = await fetchImpl(`${apiUrl}/v1/tier?wallet=${encodeURIComponent(args.wallet)}`);
      if (!res.ok) throw new Error(`Tier API HTTP ${res.status}`);
      return await res.json();
    }
    case "guard_command": {
      const scan = await core.scanPonsTokenLive(args.token, { rpcUrl, fetchImpl });
      const m = scan.forensics.metrics;
      const wallFlag = m.sellWallReserveEth > 0 ? ` --exit-before-wall` : "";
      const cmd = `npx curveguard guard ${scan.token.address} --sl 18 --trail 14${wallFlag}`;
      return {
        symbol: scan.token.symbol,
        verdict: scan.forensics.verdict,
        sniperOverhangPct: m.sniperOverhangPct,
        sellWallMcapUsd: m.sellWallMcapUsd,
        safeExitMcapUsd: m.safeExitMcapUsd,
        recommendedCommand: cmd,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleMcpRequest(msg, opts = {}) {
  const { id, method, params } = msg || {};

  if (method === "notifications/initialized" || id === undefined) {
    return null;
  }

  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "curveguard", version: "0.1.0" },
        },
      };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    }
    if (method === "resources/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            {
              uri: "curveguard://guide/overview",
              name: "CurveGuard Robinhood Chain Reference",
              mimeType: "text/plain",
              description: "Pons v2 curve constants, sniper-wall math, and non-custodial guard usage.",
            },
          ],
        },
      };
    }
    if (method === "resources/read") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri: params?.uri || "curveguard://guide/overview",
              mimeType: "text/plain",
              text: "CurveGuard (Robinhood Chain 4663): Pons v2 curves start at 1.68 ETH phantom reserve and graduate at 4.20 ETH real reserve. Block +1..+15 snipers typically dump at ~1.55x net ETH (~$9.8K-$10.5K MCAP when overhang >15%). Use scan_token before buying and replay_guard or `npx curveguard guard` to exit 7% below the sniper wall.",
            },
          ],
        },
      };
    }
    if (method === "tools/call") {
      const out = await executeMcpTool(params?.name, params?.arguments || {}, opts);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: `Error: ${err?.message || err}` }],
      },
    };
  }
}

export function startStdioMcpServer(opts = {}) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"
      );
      return;
    }
    const resp = await handleMcpRequest(msg, opts);
    if (resp) {
      process.stdout.write(JSON.stringify(resp) + "\n");
    }
  });
  return new Promise((resolve) => rl.on("close", resolve));
}
