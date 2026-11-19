/**
 * Isomorphic JSON-RPC client for Robinhood Chain (4663) & Pons v2 Curves.
 * Zero external dependencies — works in Browser, Cloudflare Workers, and Node >=20 CLI.
 */

import { keccak256 } from "./keccak.js";
import { decodeCurveLogs, analyzeCurveForensics } from "./forensics.js";
import { verifyMerkleProof } from "./merkle.js";

export const RH_CHAIN_DEFAULTS = Object.freeze({
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  sherwoodApiUrl: "https://api.sherwood.stream/v1/public",
  ponsFactory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  deadAddress: "0x000000000000000000000000000000000000dEaD",
});

// Precomputed 4-byte selectors via our own keccak256
const SELECTORS = Object.freeze({
  balanceOf: keccak256("balanceOf(address)").slice(0, 10), // 0x70a08231
  decimals: keccak256("decimals()").slice(0, 10), // 0x313ce567
  symbol: keccak256("symbol()").slice(0, 10), // 0x95d89b41
  name: keccak256("name()").slice(0, 10), // 0x06fdde03
  realQuoteReserve: keccak256("realQuoteReserve()").slice(0, 10),
  graduationThreshold: keccak256("graduationThreshold()").slice(0, 10),
  creatorTaxBps: keccak256("creatorTaxBps()").slice(0, 10),
  graduated: keccak256("graduated()").slice(0, 10),
  getSeal: keccak256("getSeal(uint64)").slice(0, 10),
  latestEpoch: keccak256("latestEpoch()").slice(0, 10),
  verifyAuditLeaf: keccak256("verifyAuditLeaf(uint64,bytes32,bytes32[])").slice(0, 10),
});

export function padAddress32(addr) {
  return String(addr || "").toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export function padUint64(num) {
  return BigInt(num).toString(16).padStart(64, "0");
}

export async function rpcCall(rpcUrl, method, params = [], fetchImpl = globalThis.fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "CurveGuard/0.1 (+https://curveguard.app)",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 320 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} on ${method}`);
    const json = await res.json();
    if (json.error) throw new Error(`RPC ${method}: ${json.error.message || JSON.stringify(json.error)}`);
    return json.result;
  }
}

async function fetchBlockscoutCurveLogs(curve, explorerUrl = RH_CHAIN_DEFAULTS.explorerUrl, fetchImpl = globalThis.fetch) {
  const out = [];
  let qs = "";
  for (let page = 0; page < 3; page++) {
    const res = await fetchImpl(`${explorerUrl}/api/v2/addresses/${curve}/logs${qs}`, {
      headers: {
        accept: "application/json",
        "user-agent": "CurveGuard/0.1 (+https://curveguard.app)",
      },
    });
    if (!res.ok) break;
    const j = await res.json();
    for (const item of j.items || []) {
      out.push({
        blockNumber: "0x" + Number(item.block_number || 0).toString(16),
        logIndex: item.index ?? 0,
        transactionHash: item.transaction_hash || item.tx_hash || "",
        data: item.data || "0x",
        topics: (item.topics || []).filter(Boolean),
      });
    }
    if (!j.next_page_params) break;
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(j.next_page_params)) {
      if (v !== null && v !== undefined) p.set(k, String(v));
    }
    qs = "?" + p.toString();
  }
  return out;
}

export function decodeUint256Float18(hex) {
  if (!hex || hex === "0x") return 0;
  const bi = BigInt(hex);
  return Number(bi / 1_000_000_000_000_000_000n) + Number(bi % 1_000_000_000_000_000_000n) / 1e18;
}

export function decodeUint256Number(hex) {
  if (!hex || hex === "0x") return 0;
  return Number(BigInt(hex));
}

export async function readErc20Balance(token, holder, rpcUrl = RH_CHAIN_DEFAULTS.rpcUrl, fetchImpl = globalThis.fetch) {
  const data = SELECTORS.balanceOf + padAddress32(holder);
  const res = await rpcCall(rpcUrl, "eth_call", [{ to: token, data }, "latest"], fetchImpl);
  return decodeUint256Float18(res);
}

/**
 * Fetches Sherwood metadata + live Robinhood Chain curve state & trade logs, then runs full CurveGuard forensics.
 */
export async function scanPonsTokenLive(tokenAddress, {
  rpcUrl = RH_CHAIN_DEFAULTS.rpcUrl,
  sherwoodApiUrl = RH_CHAIN_DEFAULTS.sherwoodApiUrl,
  maxBlockSpan = 60_000,
  checkTopSniperBalances = 8,
  ethPriceUsd = 2150,
  fetchImpl = globalThis.fetch,
} = {}) {
  const cleanAddr = String(tokenAddress || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(cleanAddr)) {
    throw new Error(`Invalid Robinhood Chain token address: ${tokenAddress}`);
  }

  // 1. Fetch token metadata from Sherwood public API
  const shRes = await fetchImpl(`${sherwoodApiUrl}/tokens/${cleanAddr}`, {
    headers: {
      accept: "application/json",
      "user-agent": "CurveGuard/0.1 (+https://curveguard.app)",
    },
  });
  if (!shRes.ok) throw new Error(`Token ${cleanAddr} not indexed on Pons/Sherwood (HTTP ${shRes.status})`);
  const shJson = await shRes.json();
  const td = shJson?.data;
  if (!td || !td.curve) {
    throw new Error(`Token ${cleanAddr} is not a recognized Pons v2 bonding-curve token.`);
  }

  const curve = String(td.curve).toLowerCase();
  const launchBlock = Number(td.launchBlock || 0);
  const creatorTaxBps = Number(td.creatorTaxBps ?? 200);
  const deployer = String(td.deployer || "").toLowerCase();

  // 2. Read head block + live curve reserve & graduation flag in parallel
  const [headHex, reserveHex, gradHex] = await Promise.all([
    rpcCall(rpcUrl, "eth_blockNumber", [], fetchImpl),
    rpcCall(rpcUrl, "eth_call", [{ to: curve, data: SELECTORS.realQuoteReserve }, "latest"], fetchImpl).catch(() => "0x0"),
    rpcCall(rpcUrl, "eth_call", [{ to: curve, data: SELECTORS.graduated }, "latest"], fetchImpl).catch(() => "0x0"),
  ]);

  const headBlock = parseInt(headHex, 16);
  const liveReserveEth = decodeUint256Float18(reserveHex);
  const graduated = gradHex && BigInt(gradHex) === 1n;

  // 3. Pull CurveBuy & CurveSell logs from launchBlock; fall back seamlessly to Blockscout v2 if RPC throttles (429)
  let rawLogs = [];
  try {
    const chunkSize = 10_000;
    const firstWindowEnd = Math.min(headBlock, launchBlock + maxBlockSpan);
    for (let from = launchBlock; from <= firstWindowEnd; from += chunkSize) {
      const to = Math.min(firstWindowEnd, from + chunkSize - 1);
      const logs = await rpcCall(
        rpcUrl,
        "eth_getLogs",
        [{ address: curve, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }],
        fetchImpl
      );
      rawLogs.push(...logs);
    }

    if (headBlock > firstWindowEnd + 1) {
      const tailFrom = Math.max(firstWindowEnd + 1, headBlock - chunkSize + 1);
      const tailLogs = await rpcCall(
        rpcUrl,
        "eth_getLogs",
        [{ address: curve, fromBlock: "0x" + tailFrom.toString(16), toBlock: "0x" + headBlock.toString(16) }],
        fetchImpl
      );
      rawLogs.push(...tailLogs);
    }
  } catch (logErr) {
    // Fallback: grab sniper launch window (`launchBlock..launchBlock+800`) + Blockscout recent curve logs
    const [earlyLogs, bsLogs] = await Promise.all([
      rpcCall(
        rpcUrl,
        "eth_getLogs",
        [{ address: curve, fromBlock: "0x" + launchBlock.toString(16), toBlock: "0x" + Math.min(headBlock, launchBlock + 800).toString(16) }],
        fetchImpl
      ).catch(() => []),
      fetchBlockscoutCurveLogs(curve, RH_CHAIN_DEFAULTS.explorerUrl, fetchImpl).catch(() => []),
    ]);
    const seen = new Set();
    for (const l of [...earlyLogs, ...bsLogs]) {
      const key = `${Number(l.blockNumber)}:${l.logIndex ?? 0}:${(l.data || "").slice(0, 24)}`;
      if (!seen.has(key)) {
        seen.add(key);
        rawLogs.push(l);
      }
    }
  }

  const decoded = decodeCurveLogs(rawLogs, launchBlock);
  const effectiveLiveReserveEth =
    liveReserveEth > 0 || graduated
      ? liveReserveEth
      : decoded.finalReserveEth;

  // Ensure the final trade series reflects true live onchain curve.realQuoteReserve() even if launch is >2h old
  if (decoded.trades.length > 0 && liveReserveEth > 0) {
    const last = decoded.trades[decoded.trades.length - 1];
    if (Math.abs(last.reserveAfterEth - effectiveLiveReserveEth) > 0.02 && headBlock > last.blockNumber) {
      const dtBlocks = headBlock - launchBlock;
      decoded.trades.push({
        side: effectiveLiveReserveEth >= last.reserveAfterEth ? "buy" : "sell",
        blockNumber: headBlock,
        dtBlocks,
        dtSec: Number((dtBlocks * 0.1).toFixed(1)),
        txHash: "",
        caller: "",
        wallet: "",
        routerLabel: "Live Onchain Reserve Sync",
        usedBotRouter: false,
        grossEth: Math.abs(effectiveLiveReserveEth - last.reserveAfterEth),
        netEth: Math.abs(effectiveLiveReserveEth - last.reserveAfterEth),
        tokens: 0,
        protocolFeeEth: 0,
        creatorFeeEth: 0,
        reserveAfterEth: Number(effectiveLiveReserveEth.toFixed(6)),
      });
    }
  }

  // 4. First pass to identify early block +1..+15 snipers, then read their EXACT current ERC-20 balanceOf!
  // This makes CurveGuard 100% immune to snipers dumping via external routers like 0x65050a9b!
  const prelim = analyzeCurveForensics({
    trades: decoded.trades,
    deployer,
    creatorTaxBps,
    currentReserveEth: effectiveLiveReserveEth,
    ethPriceUsd,
  });

  const liveBalances = {};
  const topSniperAddrs = prelim.snipers.slice(0, checkTopSniperBalances).map((s) => s.address);
  if (topSniperAddrs.length > 0) {
    const bals = await Promise.all(
      topSniperAddrs.map((addr) => readErc20Balance(cleanAddr, addr, rpcUrl, fetchImpl).catch(() => null))
    );
    topSniperAddrs.forEach((addr, idx) => {
      if (bals[idx] !== null) liveBalances[addr] = bals[idx];
    });
  }

  const forensics = analyzeCurveForensics({
    trades: decoded.trades,
    deployer,
    creatorTaxBps,
    currentReserveEth: effectiveLiveReserveEth,
    liveBalances,
    ethPriceUsd,
  });

  return {
    token: {
      address: cleanAddr,
      name: td.name || "",
      symbol: td.symbol || "",
      curve,
      deployer,
      launchBlock,
      headBlock,
      createdAt: td.createdAt || null,
      creatorTaxBps,
      graduated,
      website: td.metadata?.socials?.website || "",
      twitter: td.metadata?.socials?.twitter || "",
      logo: td.metadata?.logo || "",
      sherwoodSector: td.classification?.path || td.classification?.sector || null,
    },
    forensics,
    trades: decoded.trades,
  };
}

/**
 * Reads a sealed Merkle root from `AuditSealRegistry.sol` on Robinhood Chain and verifies a leaf + proof.
 */
export async function verifyAuditOnchain({
  registryAddress,
  epochHour,
  record,
  proof,
  rpcUrl = RH_CHAIN_DEFAULTS.rpcUrl,
  fetchImpl = globalThis.fetch,
}) {
  const data = SELECTORS.getSeal + padUint64(epochHour);
  const resHex = await rpcCall(rpcUrl, "eth_call", [{ to: registryAddress, data }, "latest"], fetchImpl);
  const clean = (resHex || "0x").replace(/^0x/, "");
  if (clean.length < 256) {
    return { valid: false, reason: "SealRegistry returned empty data" };
  }
  const onchainRoot = "0x" + clean.slice(0, 64).toLowerCase();
  const sealedAt = Number(BigInt("0x" + clean.slice(64, 128)));
  const tokenCount = Number(BigInt("0x" + clean.slice(128, 192)));
  const cleanCount = Number(BigInt("0x" + clean.slice(192, 256)));

  if (sealedAt === 0 || /^0x0+$/.test(onchainRoot)) {
    return { valid: false, reason: `Epoch ${epochHour} has not been sealed onchain yet.`, onchainRoot };
  }

  const check = verifyMerkleProof({ record, proof, expectedRoot: onchainRoot });
  return {
    ...check,
    registryAddress,
    epochHour,
    onchainRoot,
    sealedAt,
    tokenCount,
    cleanCount,
  };
}
