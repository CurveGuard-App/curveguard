/**
 * CurveGuard CLI (`npx curveguard <command>`).
 *
 * Commands:
 *   scan <0xToken>                Live 0-wallet sniper-wall & swarm X-ray on Robinhood Chain
 *   radar                         Live ranked table of Pons curves (Clean-Climb vs Sniper Overhang)
 *   quote <0xToken>               Exact curve buy/sell quote + 1% bot-router bleed comparison
 *   replay <0xToken>              Deterministic block-by-block guard strategy replay vs hold
 *   guard <0xToken>               Local non-custodial curve watcher & exit-setpoint monitor
 *   verify                        Verify Merkle-sealed audit leaf against AuditSealRegistry onchain
 *   init                          Configure Cursor, Claude Code, Codex & Claude Desktop MCP
 *   doctor                        Check local Node, binary PATH & MCP configuration health
 *   mcp                           Start stdio MCP server (JSON-RPC 2.0)
 */

import core from "./core-bridge.js";
import { runInit } from "./init.js";
import { runDoctor } from "./doctor.js";
import { startStdioMcpServer, executeMcpTool } from "./mcp.js";

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a === "-h") {
      flags.help = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const HELP_TEXT = `CurveGuard v0.1.0 — 0-wallet sniper-wall X-ray & local curve guard for Robinhood Chain (4663)

Usage:
  npx curveguard scan <0xToken> [--json]
  npx curveguard radar [--clean-only] [--limit 12] [--api URL] [--json]
  npx curveguard quote <0xToken> [--buy 0.1 | --sell 1000000] [--json]
  npx curveguard replay <0xToken> [--entry-sec 15] [--eth 0.1] [--sl 18] [--trail 14] [--json]
  npx curveguard guard <0xToken> [--eth 0.1] [--sl 18] [--trail 14] [--exit-before-wall] [--once]
  npx curveguard verify [--epoch <hour>] [--token <0xToken>] [--api URL] [--json]
  npx curveguard init [--cursor] [--claude-code] [--codex] [--claude-desktop] [--all] [--dry-run]
  npx curveguard doctor [--json]
  npx curveguard mcp
`;

function pad(str, len) {
  const s = String(str ?? "");
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

export async function runCli(argv, io = { out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n") }) {
  const { positional, flags } = parseFlags(argv);
  const cmd = positional[0] || (flags.help ? "help" : "help");
  const rpcUrl = flags.rpc || process.env.CURVEGUARD_RPC_URL || core.RH_CHAIN_DEFAULTS.rpcUrl;
  const apiUrl = flags.api || process.env.CURVEGUARD_API_URL || "https://curveguard.app";

  if (cmd === "help" || flags.help) {
    io.out(HELP_TEXT.trim());
    return 0;
  }

  if (cmd === "version" || flags.version) {
    io.out("0.1.0");
    return 0;
  }

  if (cmd === "mcp") {
    await startStdioMcpServer({ apiUrl, rpcUrl });
    return 0;
  }

  if (cmd === "init") {
    const targets = [];
    for (const k of ["cursor", "claude-code", "codex", "claude-desktop", "all"]) {
      if (flags[k]) targets.push(k);
    }
    const res = runInit({ targets, dryRun: Boolean(flags["dry-run"]) });
    if (flags.json) {
      io.out(JSON.stringify(res, null, 2));
      return 0;
    }
    io.out(`CurveGuard MCP setup (${res.dryRun ? "dry-run" : "applied"}):`);
    for (const a of res.actions) {
      io.out(`  [${a.status.toUpperCase()}] ${a.client} -> ${a.filePath}`);
    }
    return 0;
  }

  if (cmd === "doctor") {
    const checks = runDoctor();
    const failed = checks.some((c) => c.status === "FAIL");
    if (flags.json) {
      io.out(JSON.stringify(checks, null, 2));
      return failed ? 1 : 0;
    }
    for (const c of checks) {
      io.out(`${pad(c.status, 5)} ${pad(c.name, 18)} ${c.detail}${c.hint ? `  (hint: ${c.hint})` : ""}`);
    }
    return failed ? 1 : 0;
  }

  if (cmd === "scan") {
    const token = positional[1];
    if (!token) {
      io.err("Usage: curveguard scan <0xToken>");
      return 2;
    }
    const res = await core.scanPonsTokenLive(token, { rpcUrl });
    if (flags.json) {
      io.out(JSON.stringify(res, null, 2));
      return 0;
    }
    const m = res.forensics.metrics;
    io.out(`=== ${res.token.name} ($${res.token.symbol}) · ${res.forensics.verdict} (Score ${res.forensics.cleanScore}/100) ===`);
    io.out(`Token:          ${res.token.address}`);
    io.out(`Curve:          ${res.token.curve} (${m.realReserveEth} / 4.20 ETH · ${m.progressPct}%)`);
    io.out(`Est. MCAP:      $${m.mcapUsd.toLocaleString()} | Creator Tax: ${(m.creatorTaxBps / 100).toFixed(2)}%`);
    io.out(`Human Buyers:   ${m.organicHumanBuyers} organic wallets (${m.organicNetEth} net ETH)`);
    io.out(`Sniper Bag:     ${m.sniperOverhangPct}% of 1B supply still held by first-1.5s snipers (initial ${m.sniperInitialPct}%)`);
    if (m.sellWallReserveEth > 0) {
      io.out(`Sniper Wall:    ~$${m.sellWallMcapUsd.toLocaleString()} MCAP (${m.sellWallReserveEth} ETH reserve)`);
      io.out(`Safe Exit:      ~$${m.safeExitMcapUsd.toLocaleString()} MCAP (${m.safeExitReserveEth} ETH reserve — 7% below wall)`);
    } else {
      io.out(`Sniper Wall:    None (<1.5% early sniper overhang remaining)`);
    }
    io.out(`Swarm Bursts:   ${m.swarmClusterCount} same-block (100ms) multi-wallet clusters`);
    if (res.forensics.flags.length > 0) {
      io.out(`Flags:`);
      for (const f of res.forensics.flags) io.out(`  - ${f}`);
    }
    return 0;
  }

  if (cmd === "radar") {
    const data = await executeMcpTool("live_radar", {
      clean_only: Boolean(flags["clean-only"]),
      limit: Number(flags.limit || 12),
    }, { apiUrl, rpcUrl });

    if (flags.json) {
      io.out(JSON.stringify(data, null, 2));
      return 0;
    }
    const items = data.items || [];
    io.out(`CurveGuard Live Radar (${items.length} Pons curves on Robinhood Chain 4663):`);
    io.out(`${pad("SYMBOL", 12)} ${pad("VERDICT", 22)} ${pad("SCORE", 6)} ${pad("RESERVE", 11)} ${pad("SNIPERS", 9)} ${pad("WALL MCAP", 11)} TOKEN`);
    for (const it of items) {
      io.out(
        `${pad(it.symbol, 12)} ${pad(it.verdict, 22)} ${pad(it.cleanScore, 6)} ${pad(it.realReserveEth + " ETH", 11)} ${pad(it.sniperOverhangPct + "%", 9)} ${pad(it.sellWallMcapUsd ? "$" + it.sellWallMcapUsd : "—", 11)} ${it.token}`
      );
    }
    return 0;
  }

  if (cmd === "quote") {
    const token = positional[1];
    if (!token) {
      io.err("Usage: curveguard quote <0xToken> [--buy 0.1 | --sell 1000000]");
      return 2;
    }
    const scan = await core.scanPonsTokenLive(token, { rpcUrl, maxBlockSpan: 2000, checkTopSniperBalances: 0 });
    const q = await executeMcpTool("quote_curve", {
      reserve_eth: scan.forensics.metrics.realReserveEth,
      eth_in: flags.buy ? Number(flags.buy) : 0.1,
      tokens_in: flags.sell ? Number(flags.sell) : undefined,
      creator_tax_bps: scan.token.creatorTaxBps,
    }, { apiUrl, rpcUrl });

    if (flags.json) {
      io.out(JSON.stringify(q, null, 2));
      return 0;
    }
    if (q.side === "buy") {
      io.out(`Buy ${q.directCurve.grossEthIn} ETH on $${scan.token.symbol} (reserve ${scan.forensics.metrics.realReserveEth} ETH, creator tax ${(scan.token.creatorTaxBps / 100).toFixed(2)}%):`);
      io.out(`  Direct PonsCurve (0% router fee): ${Math.round(q.directCurve.tokensOut).toLocaleString()} ${scan.token.symbol}`);
      io.out(`  1% Bot Router (0x6505...):        ${Math.round(q.via1PctBotRouter.tokensOut).toLocaleString()} ${scan.token.symbol} (-${q.extraTokensDirect.toLocaleString()} tokens bled)`);
    } else {
      io.out(`Sell ${q.directCurve.tokensIn.toLocaleString()} $${scan.token.symbol}:`);
      io.out(`  Direct PonsCurve: ${q.directCurve.netEthOut.toFixed(5)} ETH | 1% Bot Router: ${q.via1PctBotRouter.netEthOut.toFixed(5)} ETH (saves ${q.savedEth} ETH)`);
    }
    return 0;
  }

  if (cmd === "replay") {
    const token = positional[1];
    if (!token) {
      io.err("Usage: curveguard replay <0xToken> [--entry-sec 15] [--eth 0.1] [--sl 18] [--trail 14]");
      return 2;
    }
    const rep = await executeMcpTool("replay_guard", {
      token,
      entry_after_sec: flags["entry-sec"] ? Number(flags["entry-sec"]) : 15,
      eth_in: flags.eth ? Number(flags.eth) : 0.1,
      stop_loss_pct: flags.sl ? Number(flags.sl) : 18,
      trailing_stop_pct: flags.trail ? Number(flags.trail) : 14,
      exit_before_wall: !flags["no-wall-exit"],
    }, { apiUrl, rpcUrl });

    if (flags.json) {
      io.out(JSON.stringify(rep, null, 2));
      return 0;
    }
    if (!rep.ok) {
      io.err(rep.reason);
      return 1;
    }
    io.out(`Replay on ${token} (entry at T+${rep.entry.dtSec}s, $${rep.entry.entryMcapUsd.toLocaleString()} MCAP, ${rep.entry.ethIn} ETH):`);
    io.out(`  Detected Sniper Overhang at Entry: ${rep.entry.detectedSniperOverhangPct}% | Wall: $${rep.entry.detectedSellWallMcapUsd.toLocaleString()} | Safe Exit: $${rep.entry.safeExitMcapUsd.toLocaleString()}`);
    io.out(`  CurveGuard Exit: ${rep.guardedExit.reason} at T+${rep.guardedExit.dtSec}s ($${rep.guardedExit.mcapUsd.toLocaleString()}) -> ${rep.guardedExit.netEthOut} ETH (${rep.guardedExit.pnlPct >= 0 ? "+" : ""}${rep.guardedExit.pnlPct}%)`);
    io.out(`  Passive Hold:    ${rep.holdOutcome.netEthOut} ETH (${rep.holdOutcome.pnlPct >= 0 ? "+" : ""}${rep.holdOutcome.pnlPct}%)`);
    io.out(`  Guard Edge:      ${rep.edgeVsHoldPct >= 0 ? "+" : ""}${rep.edgeVsHoldPct}% (${rep.edgeVsHoldEth >= 0 ? "+" : ""}${rep.edgeVsHoldEth} ETH) + ${rep.routerFeeSavedEth} ETH saved vs 1% bot router`);
    return 0;
  }

  if (cmd === "guard") {
    const token = positional[1];
    if (!token) {
      io.err("Usage: curveguard guard <0xToken> [--eth 0.1] [--sl 18] [--trail 14] [--exit-before-wall] [--once]");
      return 2;
    }
    const scan = await core.scanPonsTokenLive(token, { rpcUrl });
    const m = scan.forensics.metrics;
    const slPct = Number(flags.sl ?? 18);
    const trailPct = Number(flags.trail ?? 14);
    const entryReserve = m.realReserveEth;
    let peakReserve = entryReserve;
    const stopReserve = Number((entryReserve * (1 - slPct / 100)).toFixed(4));
    const wallExit = m.safeExitReserveEth > entryReserve ? m.safeExitReserveEth : 0;

    io.out(`[CurveGuard Local Watcher] Armed on $${scan.token.symbol} (${scan.token.address}) — 0 keys leave your machine.`);
    io.out(`  Entry Reserve: ${entryReserve} ETH ($${m.mcapUsd.toLocaleString()}) | Hard SL Reserve: <= ${stopReserve} ETH (-${slPct}%) | Trail: -${trailPct}%${wallExit ? ` | Front-Run Sniper Wall: >= ${wallExit} ETH ($${m.safeExitMcapUsd.toLocaleString()})` : ""}`);

    if (flags.once) {
      io.out(`  Status: ARMED_OK (current reserve ${entryReserve} ETH, sniper overhang ${m.sniperOverhangPct}%)`);
      return 0;
    }

    const pollMs = Math.max(250, Number(flags["poll-ms"] ?? 1000));
    const selectReserve = core.keccak256("realQuoteReserve()").slice(0, 10);

    while (true) {
      await new Promise((r) => setTimeout(r, pollMs));
      const hex = await core.rpcCall(rpcUrl, "eth_call", [{ to: scan.token.curve, data: selectReserve }, "latest"]);
      const curRes = core.decodeUint256Float18(hex);
      if (curRes > peakReserve) peakReserve = curRes;
      const trailFloor = peakReserve >= entryReserve * 1.12 ? peakReserve * (1 - trailPct / 100) : 0;

      if (wallExit > 0 && curRes >= wallExit) {
        io.out(`\x07[TRIGGER: EXIT_BEFORE_SNIPER_WALL] Reserve hit ${curRes.toFixed(4)} ETH >= safe setpoint ${wallExit} ETH! Execute direct sell on curve ${scan.token.curve} now.`);
        return 0;
      }
      if (curRes <= stopReserve) {
        io.out(`\x07[TRIGGER: HARD_STOP_LOSS] Reserve dropped to ${curRes.toFixed(4)} ETH <= ${stopReserve} ETH! Execute direct sell on curve ${scan.token.curve} now.`);
        return 0;
      }
      if (trailFloor > 0 && curRes <= trailFloor) {
        io.out(`\x07[TRIGGER: TRAILING_STOP] Reserve pulled back from ${peakReserve.toFixed(4)} ETH to ${curRes.toFixed(4)} ETH! Execute direct sell on curve ${scan.token.curve} now.`);
        return 0;
      }
    }
  }

  if (cmd === "verify") {
    const res = await executeMcpTool("verify_seal", {
      epoch_hour: flags.epoch ? Number(flags.epoch) : undefined,
      token: flags.token || positional[1],
    }, { apiUrl, rpcUrl });

    if (flags.json) {
      io.out(JSON.stringify(res, null, 2));
      return res.localMerkleVerification?.valid ? 0 : 1;
    }
    if (!res.ok) {
      io.err(`Seal check: ${res.error || "No sealed epoch available yet."}`);
      return 1;
    }
    const v = res.localMerkleVerification;
    io.out(`Epoch ${res.epochHour} · Root ${res.merkleRoot} · Local Keccak-256 Proof: ${v.valid ? "VALID (MATCH)" : "INVALID (TAMPERED)"}`);
    return v.valid ? 0 : 1;
  }

  io.err(`Unknown command: ${cmd}\nRun 'curveguard --help' for usage.`);
  return 2;
}
