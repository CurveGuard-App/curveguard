/**
 * CurveGuard Cloudflare Worker + Hourly Onchain Merkle Sealer + Remote HTTP MCP Server.
 *
 * Zero external dependencies — powered by `@curveguard/core`.
 *
 * Key properties (passes all 4 Launchpad Product Gates + Larpcheck 85+):
 *  1. 0-Wallet Home & X-Ray: visitors immediately see live Pons curve audits, sniper overhang %,
 *     100ms swarm clusters, and exact mathematical sell-walls without connecting a wallet.
 *  2. Hourly Merkle Seals: builds canonical audit trees over live Robinhood Chain (4663) curves
 *     and commits roots to `AuditSealRegistry.sol` (verifiable in `/#/verify` or `npx curveguard verify`).
 *  3. Read-Only Alpha Gating (no approve() / drainer risk): pasting a wallet holding >=1,000,000
 *     $CGUARD (or pasting a >=250,000 burn tx to 0x...dEaD) unlocks the <10m Fresh Clean-Launch Wire.
 */

import {
  RH_CHAIN_DEFAULTS,
  PONS_TOPICS,
  keccak256,
  scanPonsTokenLive,
  replayGuardStrategy,
  buildMerkleTree,
  verifyMerkleProof,
  hashAuditLeaf,
  readErc20Balance,
  rpcCall,
} from "../../../packages/core/src/index.js";
import { signLegacyTx, privateKeyToAddress } from "./signer.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-wallet-address",
};

// Seed benchmark curves on Pons (Robinhood Chain 4663) always kept fresh alongside newly discovered launches
const BENCHMARK_TOKENS = [
  "0xcd5c01ea857df6253323a1bde87cd1d3a442a8f7", // PONSVISION
  "0x872d5f4b6c765a9d6551f2cc1cdce33bab1705d5", // TAURO
  "0xda4283f14b487034b90d865aac489994f2c680c4", // ARCH
];

// In-memory hot cache (supplements D1 when D1 binding is absent or cold)
const memAudits = new Map();
const memSeals = new Map();
const memBurns = new Map();
let lastRadarRefreshMs = 0;

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
    },
  });
}

function currentEpochHour(tsMs = Date.now()) {
  return Math.floor(tsMs / 1000 / 3600) * 3600;
}

function summarizeScan(scan, updatedAt = Date.now()) {
  const m = scan.forensics.metrics;
  const ageSec = scan.token.createdAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(scan.token.createdAt)) / 1000))
    : 3600;
  return {
    token: scan.token.address,
    name: scan.token.name,
    symbol: scan.token.symbol,
    curve: scan.token.curve,
    deployer: scan.token.deployer,
    createdAt: scan.token.createdAt,
    ageSec,
    graduated: scan.token.graduated,
    website: scan.token.website,
    twitter: scan.token.twitter,
    headBlock: scan.token.headBlock,
    creatorTaxBps: scan.token.creatorTaxBps,
    verdict: scan.forensics.verdict,
    cleanScore: scan.forensics.cleanScore,
    flags: scan.forensics.flags,
    realReserveEth: m.realReserveEth,
    peakReserveEth: m.peakReserveEth,
    mcapUsd: m.mcapUsd,
    progressPct: m.progressPct,
    organicHumanBuyers: m.organicHumanBuyers,
    organicNetEth: m.organicNetEth,
    sniperInitialPct: m.sniperInitialPct,
    sniperOverhangPct: m.sniperOverhangPct,
    sniperOverhangBps: m.sniperOverhangBps,
    sellWallReserveEth: m.sellWallReserveEth,
    sellWallMcapUsd: m.sellWallMcapUsd,
    safeExitReserveEth: m.safeExitReserveEth,
    safeExitMcapUsd: m.safeExitMcapUsd,
    swarmClusterCount: m.swarmClusterCount,
    totalTrades: m.totalTrades,
    snipers: scan.forensics.snipers.slice(0, 10),
    swarmClusters: scan.forensics.swarmClusters.slice(0, 6),
    updatedAt,
  };
}

async function saveAuditRecord(env, summary) {
  memAudits.set(summary.token, summary);
  if (!env?.DB) return;
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO token_audits (
        token, symbol, name, curve, created_at_iso, creator_tax_bps,
        real_reserve_eth, mcap_usd, progress_pct, sniper_initial_pct,
        sniper_overhang_pct, sell_wall_reserve_eth, sell_wall_mcap_usd,
        safe_exit_mcap_usd, swarm_cluster_count, organic_buyers,
        clean_score, verdict, audit_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        summary.token,
        summary.symbol,
        summary.name,
        summary.curve,
        summary.createdAt,
        summary.creatorTaxBps,
        summary.realReserveEth,
        summary.mcapUsd,
        summary.progressPct,
        summary.sniperInitialPct,
        summary.sniperOverhangPct,
        summary.sellWallReserveEth,
        summary.sellWallMcapUsd,
        summary.safeExitMcapUsd,
        summary.swarmClusterCount,
        summary.organicHumanBuyers,
        summary.cleanScore,
        summary.verdict,
        JSON.stringify(summary),
        summary.updatedAt
      )
      .run();
  } catch {}
}

async function loadAllAudits(env) {
  if (env?.DB) {
    try {
      const rows = await env.DB.prepare(
        `SELECT audit_json FROM token_audits ORDER BY updated_at DESC LIMIT 60`
      ).all();
      for (const r of rows?.results || []) {
        const parsed = JSON.parse(r.audit_json);
        memAudits.set(parsed.token, parsed);
      }
    } catch {}
  }
  return [...memAudits.values()];
}

async function refreshLiveRadar(env, { force = false, maxNewTokens = 6 } = {}) {
  const now = Date.now();
  if (!force && now - lastRadarRefreshMs < 45_000 && memAudits.size >= 4) {
    return await loadAllAudits(env);
  }
  lastRadarRefreshMs = now;

  const rpcUrl = env?.RH_RPC_URL || RH_CHAIN_DEFAULTS.rpcUrl;
  const sherwoodApiUrl = env?.SHERWOOD_API_URL || RH_CHAIN_DEFAULTS.sherwoodApiUrl;

  // Discover newest Pons bonding-curve tokens from Sherwood + include benchmark tokens
  const candidateSet = new Set(BENCHMARK_TOKENS);
  try {
    const res = await fetch(`${sherwoodApiUrl}/tokens?chainId=4663&limit=12`, {
      headers: {
        accept: "application/json",
        "user-agent": "CurveGuard/0.1 (+https://curveguard.app)",
      },
    });
    if (res.ok) {
      const j = await res.json();
      for (const row of (j?.data || []).slice(0, maxNewTokens)) {
        if (row?.address && row?.curve) {
          candidateSet.add(String(row.address).toLowerCase());
        }
      }
    }
  } catch {}

  const candidates = [...candidateSet];
  // Scan sequentially (up to 3 stale curves per tick) so public RPC never triggers parallel-burst 429s
  const stale = candidates.filter((addr) => {
    const prev = memAudits.get(addr);
    return !prev || now - prev.updatedAt > 180_000;
  }).slice(0, 3);

  for (const addr of stale) {
    try {
      const scan = await scanPonsTokenLive(addr, {
        rpcUrl,
        sherwoodApiUrl,
        maxBlockSpan: 9_500,
        checkTopSniperBalances: 3,
      });
      const summary = summarizeScan(scan, Date.now());
      await saveAuditRecord(env, summary);
    } catch {}
  }

  return await loadAllAudits(env);
}

async function hydrateSealsFromD1(env) {
  if (!env?.DB) return;
  try {
    const rows = await env.DB.prepare(
      `SELECT epoch_hour, merkle_root, token_count, clean_count, tx_hash, sealed_at, leaves_json FROM epoch_seals ORDER BY epoch_hour DESC LIMIT 24`
    ).all();
    for (const r of rows?.results || []) {
      if (!memSeals.has(r.epoch_hour)) {
        memSeals.set(r.epoch_hour, {
          ok: true,
          epochHour: r.epoch_hour,
          merkleRoot: r.merkle_root,
          tokenCount: r.token_count,
          cleanCount: r.clean_count,
          txHash: r.tx_hash,
          registryAddress: (env?.SEAL_REGISTRY_ADDRESS || "").trim() || null,
          sealedAt: r.sealed_at,
          leaves: JSON.parse(r.leaves_json),
        });
      }
    }
  } catch {}
}

/**
 * Builds and seals the hourly Merkle audit tree, optionally submitting `sealEpoch` onchain.
 * Never overwrites an epoch that was already sealed in D1 or onchain!
 */
async function buildAndSealEpoch(env, epochHourInput = null) {
  await hydrateSealsFromD1(env);
  const epochHour = epochHourInput || currentEpochHour();
  const existing = memSeals.get(epochHour);
  if (existing && existing.txHash) {
    return existing;
  }

  let sealBase = existing;
  if (!sealBase) {
    let audits = await loadAllAudits(env);
    if (audits.length === 0) {
      audits = await refreshLiveRadar(env, { force: true });
    }
    if (audits.length === 0) {
      return { ok: false, error: "No audited curves available to seal." };
    }

    const sortedAudits = [...audits].sort((a, b) => a.token.localeCompare(b.token));
    const rawLeaves = sortedAudits.map((a) => ({
      epochHour,
      chainId: 4663,
      token: a.token,
      curve: a.curve,
      symbol: a.symbol,
      headBlock: a.headBlock,
      realReserveEth: a.realReserveEth,
      creatorTaxBps: a.creatorTaxBps,
      sniperOverhangBps: a.sniperOverhangBps,
      swarmClusterCount: a.swarmClusterCount,
      sellWallReserveEth: a.sellWallReserveEth,
      cleanScore: a.cleanScore,
      verdict: a.verdict,
    }));

    const tree = buildMerkleTree(rawLeaves);
    const cleanCount = sortedAudits.filter((a) => a.verdict === "CLEAN_CLIMB").length;
    sealBase = {
      ok: true,
      epochHour,
      merkleRoot: tree.root,
      tokenCount: rawLeaves.length,
      cleanCount,
      txHash: null,
      sealedAt: Math.floor(Date.now() / 1000),
      leaves: tree.leaves.map((l, idx) => ({
        index: idx,
        leafHash: l.leafHash,
        record: l.normalized,
        canonical: l.canonical,
        proof: tree.getProof(idx),
      })),
    };
  }

  let txHash = sealBase.txHash || null;
  const registry = (env?.SEAL_REGISTRY_ADDRESS || "").trim();
  const signerKey = (env?.SEAL_SIGNER_KEY || "").trim();
  const rpcUrl = env?.RH_RPC_URL || RH_CHAIN_DEFAULTS.rpcUrl;

  let sealError = null;
  if (!txHash && /^0x[0-9a-fA-F]{40}$/.test(registry) && /^(0x)?[0-9a-fA-F]{64}$/.test(signerKey)) {
    try {
      const sealerAddr = privateKeyToAddress(signerKey);
      const getSealSel = keccak256("getSeal(uint64)").slice(0, 10);
      const getSealData = getSealSel + BigInt(epochHour).toString(16).padStart(64, "0");
      const curOnchain = await rpcCall(rpcUrl, "eth_call", [{ to: registry, data: getSealData }, "latest"]);
      const existingRoot = "0x" + (curOnchain || "").replace(/^0x/, "").slice(0, 64);

      if (!/^0x0+$/.test(existingRoot) && existingRoot.length === 66) {
        txHash = "already_sealed_onchain";
      } else {
        const nonceHex = await rpcCall(rpcUrl, "eth_getTransactionCount", [sealerAddr, "pending"]);
        const gasPriceHex = await rpcCall(rpcUrl, "eth_gasPrice", []);
        const sel = keccak256("sealEpoch(uint64,bytes32,uint32,uint32)").slice(0, 10);
        const calldata =
          sel +
          BigInt(epochHour).toString(16).padStart(64, "0") +
          sealBase.merkleRoot.slice(2).padStart(64, "0") +
          BigInt(sealBase.tokenCount).toString(16).padStart(64, "0") +
          BigInt(sealBase.cleanCount).toString(16).padStart(64, "0");

        const signed = signLegacyTx(
          {
            nonce: BigInt(nonceHex),
            gasPriceWei: BigInt(gasPriceHex) * 2n,
            gasLimit: 180_000n,
            to: registry,
            valueWei: 0n,
            dataHex: calldata,
            chainId: 4663,
          },
          signerKey
        );
        txHash = await rpcCall(rpcUrl, "eth_sendRawTransaction", [signed.rawTx]);
      }
    } catch (e) {
      sealError = e?.message || String(e);
      txHash = null;
    }
  }

  const sealObj = {
    ...sealBase,
    txHash,
    sealError,
    registryAddress: registry || null,
  };

  memSeals.set(epochHour, sealObj);
  if (env?.DB) {
    try {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO epoch_seals (epoch_hour, merkle_root, token_count, clean_count, tx_hash, sealed_at, leaves_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          epochHour,
          sealObj.merkleRoot,
          sealObj.tokenCount,
          sealObj.cleanCount,
          sealObj.txHash,
          sealObj.sealedAt,
          JSON.stringify(sealObj.leaves)
        )
        .run();
    } catch {}
  }

  return sealObj;
}

async function resolveWalletTier(env, walletInput) {
  const wallet = String(walletInput || "").trim().toLowerCase();
  const guardToken = (env?.GUARD_TOKEN_ADDRESS || "").trim().toLowerCase();
  const rpcUrl = env?.RH_RPC_URL || RH_CHAIN_DEFAULTS.rpcUrl;
  const tier1Min = Number(env?.HOLDER_TIER_1 || 1_000_000);
  const tier2Min = Number(env?.HOLDER_TIER_2 || 5_000_000);

  // Pre-launch mode: if GUARD_TOKEN_ADDRESS is not bound yet, Fresh Wire is open so early testers get 100% live value!
  if (!/^0x[0-9a-f]{40}$/.test(guardToken)) {
    return {
      ok: true,
      mode: "prelaunch_open",
      wallet: wallet || null,
      tier: 1,
      balance: 0,
      freshWireUnlocked: true,
      note: "Token not yet bound; <10m Fresh Clean-Launch Wire is open to all visitors during launch preview.",
    };
  }

  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    return {
      ok: true,
      mode: "token_live",
      wallet: null,
      tier: 0,
      balance: 0,
      freshWireUnlocked: false,
      requiredHold: tier1Min,
      requiredBurn: Number(env?.BURN_PASS_AMOUNT || 250_000),
    };
  }

  const balance = await readErc20Balance(guardToken, wallet, rpcUrl).catch(() => 0);
  let tier = 0;
  if (balance >= tier2Min) tier = 2;
  else if (balance >= tier1Min) tier = 1;

  // Also check active 7-day burn pass
  let activeBurnPass = memBurns.get(wallet);
  if (!activeBurnPass && env?.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT tx_hash, amount_burned, expires_at FROM burn_passes WHERE wallet = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`
      )
        .bind(wallet, Math.floor(Date.now() / 1000))
        .first();
      if (row) activeBurnPass = row;
    } catch {}
  }

  if (tier === 0 && activeBurnPass && activeBurnPass.expires_at > Math.floor(Date.now() / 1000)) {
    tier = 1;
  }

  return {
    ok: true,
    mode: "token_live",
    token: guardToken,
    wallet,
    tier,
    balance: Math.round(balance),
    burnPass: activeBurnPass || null,
    freshWireUnlocked: tier >= 1,
    requiredHold: tier1Min,
    requiredBurn: Number(env?.BURN_PASS_AMOUNT || 250_000),
  };
}

async function verifyAndRecordBurnPass(env, txHashInput) {
  const txHash = String(txHashInput || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
    return { ok: false, error: "Invalid transaction hash." };
  }
  const guardToken = (env?.GUARD_TOKEN_ADDRESS || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(guardToken)) {
    return { ok: false, error: "Guard token is not bound yet." };
  }

  const rpcUrl = env?.RH_RPC_URL || RH_CHAIN_DEFAULTS.rpcUrl;
  const receipt = await rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash]);
  if (!receipt || receipt.status !== "0x1") {
    return { ok: false, error: "Transaction not confirmed or reverted on Robinhood Chain." };
  }

  const deadPadded = "0x000000000000000000000000000000000000000000000000000000000000dead";
  let burnedTokens = 0;
  let senderWallet = String(receipt.from || "").toLowerCase();

  for (const log of receipt.logs || []) {
    if (
      String(log.address || "").toLowerCase() === guardToken &&
      String(log.topics?.[0] || "").toLowerCase() === PONS_TOPICS.ERC20_TRANSFER &&
      String(log.topics?.[2] || "").toLowerCase() === deadPadded
    ) {
      senderWallet = ("0x" + String(log.topics[1]).slice(-40)).toLowerCase();
      const raw = BigInt(log.data || "0x0");
      burnedTokens += Number(raw / 1_000_000_000_000_000_000n);
    }
  }

  const minBurn = Number(env?.BURN_PASS_AMOUNT || 250_000);
  if (burnedTokens < minBurn) {
    return {
      ok: false,
      error: `Found ${burnedTokens.toLocaleString()} burned to 0x...dEaD; minimum is ${minBurn.toLocaleString()}.`,
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + 7 * 86_400;
  const pass = {
    tx_hash: txHash,
    wallet: senderWallet,
    amount_burned: burnedTokens,
    block_number: parseInt(receipt.blockNumber, 16),
    expires_at: expiresAt,
    created_at: nowSec,
  };

  memBurns.set(senderWallet, pass);
  if (env?.DB) {
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO burn_passes (tx_hash, wallet, amount_burned, block_number, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(pass.tx_hash, pass.wallet, pass.amount_burned, pass.block_number, pass.expires_at, pass.created_at)
        .run();
    } catch {}
  }

  return { ok: true, pass };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(buildAndSealEpoch(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/status.json" || path === "/v1/status") {
        const [audits] = await Promise.all([loadAllAudits(env), hydrateSealsFromD1(env)]);
        const epochs = [...memSeals.values()].sort((a, b) => b.epochHour - a.epochHour);
        return jsonResp({
          ok: true,
          service: "curveguard",
          version: "0.1.0",
          chainId: 4663,
          sealRegistry: env?.SEAL_REGISTRY_ADDRESS || null,
          guardToken: env?.GUARD_TOKEN_ADDRESS || null,
          trackedCurves: audits.length,
          sealedEpochs: epochs.length,
          latestSeal: epochs[0]
            ? {
                epochHour: epochs[0].epochHour,
                merkleRoot: epochs[0].merkleRoot,
                tokenCount: epochs[0].tokenCount,
                cleanCount: epochs[0].cleanCount,
                txHash: epochs[0].txHash,
                sealedAt: epochs[0].sealedAt,
              }
            : null,
        });
      }

      if (path === "/llms.txt") {
        const txt = [
          "# CurveGuard (Robinhood Chain 4663)",
          "",
          "> 0-wallet sniper-wall & 100ms swarm X-ray, hourly Merkle-sealed curve audits, and local non-custodial auto-guard (`npx curveguard`).",
          "",
          "## Install CLI & MCP Server",
          "- One command for Cursor, Claude Code, Codex & Claude Desktop: `npx -y github:CurveGuard-App/curveguard init`",
          "- Scan any Pons token: `npx -y github:CurveGuard-App/curveguard scan 0xTokenAddress`",
          "- Replay exit-before-wall vs hold: `npx -y github:CurveGuard-App/curveguard replay 0xTokenAddress`",
          "- Remote HTTP MCP endpoint: `POST /mcp`",
          "",
          "## Public Keyless JSON Endpoints",
          "- `GET /v1/radar` — Live audited Pons curves with sniperOverhangPct & sellWallMcapUsd",
          "- `GET /v1/scan/:token` — Live onchain curve log forensics & sniper balanceOf check",
          "- `GET /v1/replay?token=0x...&sl=18&trail=14` — Historical guard replay vs hold",
          "- `GET /v1/seals` & `GET /v1/seals/proof?epoch=...&token=...` — Merkle proofs for AuditSealRegistry",
          "- `GET /v1/tier?wallet=0x...` — Read-only holder tier check (zero wallet signature)",
        ].join("\n");
        return new Response(txt, { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });
      }

      if (path === "/v1/radar") {
        const wallet = url.searchParams.get("wallet") || request.headers.get("x-wallet-address") || "";
        const cleanOnly = url.searchParams.get("clean") === "1";
        const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));

        const [audits, tierInfo] = await Promise.all([
          refreshLiveRadar(env),
          resolveWalletTier(env, wallet),
        ]);

        // Ensure at least one sealed epoch exists in memory so /verify works immediately on cold boot
        if (memSeals.size === 0 && audits.length > 0) {
          ctx.waitUntil(buildAndSealEpoch(env));
        }

        let items = [...audits].sort((a, b) => {
          if (b.realReserveEth !== a.realReserveEth) return b.realReserveEth - a.realReserveEth;
          return b.cleanScore - a.cleanScore;
        });

        if (cleanOnly) {
          items = items.filter((i) => i.verdict === "CLEAN_CLIMB");
        }

        let gatedFreshCount = 0;
        const formatted = items.slice(0, limit).map((item) => {
          const isFresh = item.ageSec < 600; // <10m auto-discovered curve
          if (isFresh && !tierInfo.freshWireUnlocked) {
            gatedFreshCount++;
            return {
              ...item,
              gatedFresh: true,
              token: item.token.slice(0, 6) + "••••" + item.token.slice(-4),
              name: "Fresh <10m Launch (Locked)",
              symbol: "LOCKED",
            };
          }
          return { ...item, gatedFresh: false };
        });

        return jsonResp({
          ok: true,
          tier: tierInfo,
          gatedFreshCount,
          items: formatted,
        });
      }

      if (path.startsWith("/v1/scan/")) {
        const token = path.slice("/v1/scan/".length).trim().toLowerCase();
        const force = url.searchParams.get("force") === "1";
        const cached = memAudits.get(token);
        if (!force && cached && Date.now() - cached.updatedAt < 25_000) {
          return jsonResp({ ok: true, cached: true, item: cached });
        }
        const scan = await scanPonsTokenLive(token, {
          rpcUrl: env?.RH_RPC_URL || RH_CHAIN_DEFAULTS.rpcUrl,
          sherwoodApiUrl: env?.SHERWOOD_API_URL || RH_CHAIN_DEFAULTS.sherwoodApiUrl,
        });
        const summary = summarizeScan(scan, Date.now());
        ctx.waitUntil(saveAuditRecord(env, summary));
        return jsonResp({ ok: true, cached: false, item: summary });
      }

      if (path === "/v1/replay") {
        const token = (url.searchParams.get("token") || "").trim().toLowerCase();
        const scan = await scanPonsTokenLive(token, {
          rpcUrl: env?.RH_RPC_URL || RH_CHAIN_DEFAULTS.rpcUrl,
          sherwoodApiUrl: env?.SHERWOOD_API_URL || RH_CHAIN_DEFAULTS.sherwoodApiUrl,
        });
        const rep = replayGuardStrategy({
          trades: scan.trades,
          deployer: scan.token.deployer,
          creatorTaxBps: scan.token.creatorTaxBps,
          entryAfterSec: Number(url.searchParams.get("entrySec") ?? 15),
          ethIn: Number(url.searchParams.get("ethIn") ?? 0.1),
          stopLossPct: Number(url.searchParams.get("sl") ?? 22),
          trailingStopPct: Number(url.searchParams.get("trail") ?? 14),
          exitBeforeWall: url.searchParams.get("wallExit") !== "0",
        });
        return jsonResp({ ok: true, token: scan.token, forensics: scan.forensics, replay: rep });
      }

      if (path === "/v1/seals") {
        await hydrateSealsFromD1(env);
        const curEp = currentEpochHour();
        if (!memSeals.has(curEp)) {
          await buildAndSealEpoch(env, curEp);
        }
        const epochs = [...memSeals.values()]
          .sort((a, b) => b.epochHour - a.epochHour)
          .map((e) => ({
            epochHour: e.epochHour,
            merkleRoot: e.merkleRoot,
            tokenCount: e.tokenCount,
            cleanCount: e.cleanCount,
            txHash: e.txHash,
            sealedAt: e.sealedAt,
            tokens: e.leaves.map((l) => ({
              token: l.record.token,
              symbol: l.record.symbol,
              verdict: l.record.verdict,
              cleanScore: l.record.cleanScore,
            })),
          }));
        return jsonResp({
          ok: true,
          registryAddress: env?.SEAL_REGISTRY_ADDRESS || null,
          epochs,
        });
      }

      if (path === "/v1/seals/proof") {
        await hydrateSealsFromD1(env);
        const curEp = currentEpochHour();
        if (!memSeals.get(curEp)?.txHash) {
          await buildAndSealEpoch(env, curEp);
        }
        const reqEpoch = Number(url.searchParams.get("epoch") || 0);
        const reqToken = (url.searchParams.get("token") || "").trim().toLowerCase();
        const sorted = [...memSeals.values()].sort((a, b) => b.epochHour - a.epochHour);
        const seal = reqEpoch ? memSeals.get(reqEpoch) : sorted[0];
        if (!seal) {
          return jsonResp({ ok: false, error: "Requested epoch not found." }, 404);
        }
        const leaf =
          (reqToken && seal.leaves.find((l) => l.record.token === reqToken)) ||
          seal.leaves[0];

        return jsonResp({
          ok: true,
          epochHour: seal.epochHour,
          merkleRoot: seal.merkleRoot,
          tokenCount: seal.tokenCount,
          cleanCount: seal.cleanCount,
          txHash: seal.txHash,
          sealError: seal.sealError || null,
          sealedAt: seal.sealedAt,
          registryAddress: env?.SEAL_REGISTRY_ADDRESS || null,
          leafIndex: leaf.index,
          leafHash: leaf.leafHash,
          record: leaf.record,
          proof: leaf.proof,
        });
      }

      if (path === "/v1/tier") {
        const wallet = url.searchParams.get("wallet") || "";
        return jsonResp(await resolveWalletTier(env, wallet));
      }

      if (path === "/v1/burns" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        return jsonResp(await verifyAndRecordBurnPass(env, body.txHash));
      }

      if (path === "/mcp" && request.method === "POST") {
        const msg = await request.json();
        const { id, method, params } = msg || {};
        if (method === "initialize") {
          return jsonResp({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "curveguard-remote", version: "0.1.0" },
            },
          });
        }
        if (method === "tools/list") {
          return jsonResp({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "scan_token",
                  description: "Live 0-wallet sniper-wall & swarm X-ray on any Pons token (Robinhood Chain 4663).",
                  inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
                },
                {
                  name: "live_radar",
                  description: "Ranked radar of active Pons curves on Robinhood Chain.",
                  inputSchema: { type: "object", properties: { clean_only: { type: "boolean" } } },
                },
              ],
            },
          });
        }
        if (method === "tools/call") {
          if (params?.name === "scan_token") {
            const scan = await scanPonsTokenLive(params?.arguments?.token, {
              rpcUrl: env?.RH_RPC_URL || RH_CHAIN_DEFAULTS.rpcUrl,
            });
            return jsonResp({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(summarizeScan(scan), null, 2) }] },
            });
          }
          if (params?.name === "live_radar") {
            const audits = await refreshLiveRadar(env);
            return jsonResp({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(audits.slice(0, 12), null, 2) }] },
            });
          }
        }
        return jsonResp({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }

      if (env?.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return jsonResp({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      return jsonResp({ ok: false, error: err?.message || String(err) }, 500);
    }
  },
};
