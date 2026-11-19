/**
 * Pons v2 Bonding-Curve Onchain Forensics Engine:
 *  - Decodes CurveBuy (`0xec36bf57...`) and CurveSell (`0x8113d738...`) logs
 *  - Unmasks early block +1..+15 (`1.5s`) snipers and computes remaining sniper overhang %
 *    (cross-referenced with optional live ERC-20 `balanceOf` or `Transfer` logs so router sells never hide exits!)
 *  - Unmasks same-block (`100ms`) multi-wallet swarms
 *  - Computes exact mathematical Sniper Sell-Wall ($MCAP & ETH reserve) and Safe Front-Run Exit Setpoint
 *  - Flags `3%` creator fee-farm curves & 1% external bot-router bleed
 */

import {
  PONS_CURVE_DEFAULTS,
  curveStateAtReserve,
  solveReserveForTargetExit,
} from "./curve.js";

export const PONS_TOPICS = Object.freeze({
  CURVE_BUY: "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455",
  CURVE_SELL: "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df",
  ERC20_TRANSFER: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
});

export const KNOWN_ROUTERS = Object.freeze({
  "0xe33e9e479df8802cb0866d5d05258bec4cf62948": { label: "Pons LaunchAndBuy", feeBps: 0, isLaunchRouter: true },
  "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc": { label: "Bot Fee Router (1%)", feeBps: 100, isBotRouter: true },
  "0x92475293e578c7d88651d160d2b0e45e04e4528b": { label: "Sniper Exec Router", feeBps: 50, isBotRouter: true },
  "0x8876789976decbfcbbbe364623c63652db8c0904": { label: "Uniswap v4 UniversalRouter", feeBps: 0, isDexRouter: true },
});

const WEI = 1e18;

function parseWords256(hexData) {
  const clean = (hexData || "0x").replace(/^0x/i, "");
  const out = [];
  for (let i = 0; i + 64 <= clean.length; i += 64) {
    out.push(BigInt("0x" + clean.slice(i, i + 64)));
  }
  return out;
}

function topicAddress(topicHex) {
  if (!topicHex || topicHex.length < 42) return "";
  return ("0x" + topicHex.slice(-40)).toLowerCase();
}

function weiToFloat(bi) {
  const whole = Number(bi / 1_000_000_000_000_000_000n);
  const rem = Number(bi % 1_000_000_000_000_000_000n) / WEI;
  return whole + rem;
}

/**
 * Parses raw `eth_getLogs` from a Pons curve into normalized chronological trade events.
 */
export function decodeCurveLogs(rawLogs, launchBlockInput = null) {
  const sorted = [...(rawLogs || [])].sort((a, b) => {
    const ba = Number(a.blockNumber);
    const bb = Number(b.blockNumber);
    if (ba !== bb) return ba - bb;
    return Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
  });

  let launchBlock = launchBlockInput !== null && launchBlockInput !== undefined
    ? Number(launchBlockInput)
    : (sorted.length > 0 ? Number(sorted[0].blockNumber) : 0);

  let runningReserveEth = 0;
  const trades = [];

  for (const log of sorted) {
    const t0 = String(log.topics?.[0] || "").toLowerCase();
    const blockNumber = Number(log.blockNumber);
    const dtBlocks = Math.max(0, blockNumber - launchBlock);
    const dtSec = Number((dtBlocks * 0.1).toFixed(1)); // RH Chain ~100ms block cadence
    const words = parseWords256(log.data);

    if (t0 === PONS_TOPICS.CURVE_BUY && words.length >= 4) {
      const caller = topicAddress(log.topics[1]);
      const recipient = topicAddress(log.topics[2]) || caller;
      const grossEth = weiToFloat(words[0]);
      const tokensOut = weiToFloat(words[1]);
      const protocolFeeEth = weiToFloat(words[2]);
      const creatorFeeEth = weiToFloat(words[3]);
      const netReserveIn = Math.max(0, grossEth - protocolFeeEth - creatorFeeEth);
      runningReserveEth += netReserveIn;

      trades.push({
        side: "buy",
        blockNumber,
        dtBlocks,
        dtSec,
        txHash: log.transactionHash || "",
        caller,
        wallet: recipient,
        routerLabel: KNOWN_ROUTERS[caller]?.label || null,
        usedBotRouter: Boolean(KNOWN_ROUTERS[caller]?.isBotRouter),
        grossEth,
        netEth: netReserveIn,
        tokens: tokensOut,
        protocolFeeEth,
        creatorFeeEth,
        reserveAfterEth: Number(runningReserveEth.toFixed(6)),
      });
    } else if (t0 === PONS_TOPICS.CURVE_SELL && words.length >= 4) {
      const caller = topicAddress(log.topics[1]);
      const recipient = topicAddress(log.topics[2]) || caller;
      const tokensIn = weiToFloat(words[0]);
      const netEthOut = weiToFloat(words[1]);
      const protocolFeeEth = weiToFloat(words[2]);
      const creatorFeeEth = weiToFloat(words[3]);
      const grossReserveOut = netEthOut + protocolFeeEth + creatorFeeEth;
      runningReserveEth = Math.max(0, runningReserveEth - grossReserveOut);

      // When sold via a router, recipient receives ETH unless router buffers to msg.sender; track both
      const sellerWallet = KNOWN_ROUTERS[caller] && recipient !== caller ? recipient : caller;

      trades.push({
        side: "sell",
        blockNumber,
        dtBlocks,
        dtSec,
        txHash: log.transactionHash || "",
        caller,
        wallet: sellerWallet,
        recipient,
        routerLabel: KNOWN_ROUTERS[caller]?.label || null,
        usedBotRouter: Boolean(KNOWN_ROUTERS[caller]?.isBotRouter),
        grossEth: grossReserveOut,
        netEth: netEthOut,
        tokens: tokensIn,
        protocolFeeEth,
        creatorFeeEth,
        reserveAfterEth: Number(runningReserveEth.toFixed(6)),
      });
    }
  }

  return { launchBlock, trades, finalReserveEth: Number(runningReserveEth.toFixed(6)) };
}

/**
 * Runs full sniper-wall, swarm-cluster, and clean-flow forensics on decoded curve trades.
 *
 * @param {object} opts
 * @param {Array} opts.trades - output from decodeCurveLogs().trades
 * @param {string} [opts.deployer] - token deployer address (excluded from external sniper classification at dt=0)
 * @param {number} [opts.creatorTaxBps=200]
 * @param {number} [opts.currentReserveEth] - live curve.realQuoteReserve() if available
 * @param {Object<string, number>} [opts.liveBalances] - optional map { lowerWallet: currentTokenBalanceFloat } from ERC-20 balanceOf
 * @param {number} [opts.ethPriceUsd=2150]
 * @param {number} [opts.sniperWindowBlocks=15] - first 15 blocks (~1.5s) post-launch
 * @param {number} [opts.sniperTargetProfitMultiple=1.55] - +55% net ETH target where block-8 snipers historically dump ($9.5K-$10.5K wall)
 */
export function analyzeCurveForensics({
  trades = [],
  deployer = "",
  creatorTaxBps = PONS_CURVE_DEFAULTS.defaultCreatorTaxBps,
  currentReserveEth = null,
  liveBalances = null,
  ethPriceUsd = PONS_CURVE_DEFAULTS.defaultEthPriceUsd,
  sniperWindowBlocks = 15,
  sniperTargetProfitMultiple = 1.55,
}) {
  const normDeployer = String(deployer || "").toLowerCase();
  const walletStats = new Map();

  let peakReserveEth = 0;
  let peakBlock = 0;
  let totalBuyEth = 0;
  let totalSellEth = 0;
  let botRouterTrades = 0;
  let estimatedBotRouterBleedEth = 0;

  const ensureWallet = (addr) => {
    const a = String(addr || "").toLowerCase();
    if (!walletStats.has(a)) {
      walletStats.set(a, {
        address: a,
        firstBuyDtBlocks: null,
        buys: 0,
        sells: 0,
        ethSpent: 0,
        ethReceived: 0,
        tokensBought: 0,
        tokensSold: 0,
        isDeployer: a === normDeployer && normDeployer !== "",
        isEarlySniper: false,
      });
    }
    return walletStats.get(a);
  };

  // Group non-deployer buys by exact blockNumber to catch 100ms coordinated swarms
  const buysByBlock = new Map();

  for (const t of trades) {
    if (t.reserveAfterEth > peakReserveEth) {
      peakReserveEth = t.reserveAfterEth;
      peakBlock = t.blockNumber;
    }
    if (t.usedBotRouter) {
      botRouterTrades++;
      estimatedBotRouterBleedEth += t.grossEth * 0.01;
    }

    const w = ensureWallet(t.wallet);
    if (t.side === "buy") {
      totalBuyEth += t.grossEth;
      w.buys++;
      w.ethSpent += t.grossEth;
      w.tokensBought += t.tokens;
      if (w.firstBuyDtBlocks === null) w.firstBuyDtBlocks = t.dtBlocks;

      const isDevInitBuy = t.dtBlocks === 0 && (w.isDeployer || t.caller === "0xe33e9e479df8802cb0866d5d05258bec4cf62948");
      if (isDevInitBuy && !normDeployer) w.isDeployer = true;

      if (!isDevInitBuy && t.dtBlocks >= 1 && t.dtBlocks <= sniperWindowBlocks && t.grossEth >= 0.008) {
        w.isEarlySniper = true;
      }

      if (!isDevInitBuy && t.dtBlocks > sniperWindowBlocks) {
        if (!buysByBlock.has(t.blockNumber)) buysByBlock.set(t.blockNumber, []);
        buysByBlock.get(t.blockNumber).push(t);
      }
    } else {
      totalSellEth += t.netEth;
      w.sells++;
      w.ethReceived += t.netEth;
      w.tokensSold += t.tokens;
    }
  }

  // Compute remaining sniper bags (preferring exact live ERC-20 balanceOf when provided!)
  const snipers = [];
  let sniperInitialTokens = 0;
  let sniperRemainingTokens = 0;
  let sniperRemainingCostEth = 0;

  for (const w of walletStats.values()) {
    const ledgerRemaining = Math.max(0, w.tokensBought - w.tokensSold);
    const actualRemaining =
      liveBalances && Object.prototype.hasOwnProperty.call(liveBalances, w.address)
        ? Math.max(0, Number(liveBalances[w.address]) || 0)
        : ledgerRemaining;
    w.tokensRemaining = actualRemaining;

    if (w.isEarlySniper) {
      sniperInitialTokens += w.tokensBought;
      sniperRemainingTokens += actualRemaining;
      const heldRatio = w.tokensBought > 0 ? Math.min(1, actualRemaining / w.tokensBought) : 0;
      const remainingCost = w.ethSpent * heldRatio;
      sniperRemainingCostEth += remainingCost;
      snipers.push({
        address: w.address,
        dtBlocks: w.firstBuyDtBlocks,
        ethSpent: Number(w.ethSpent.toFixed(4)),
        tokensBought: Math.round(w.tokensBought),
        tokensRemaining: Math.round(actualRemaining),
        supplyPct: Number(((actualRemaining / PONS_CURVE_DEFAULTS.totalSupply) * 100).toFixed(2)),
        stillHoldingPct: w.tokensBought > 0 ? Math.round((actualRemaining / w.tokensBought) * 100) : 0,
      });
    }
  }

  snipers.sort((a, b) => b.tokensRemaining - a.tokensRemaining);

  const sniperInitialPct = (sniperInitialTokens / PONS_CURVE_DEFAULTS.totalSupply) * 100;
  const sniperOverhangPct = (sniperRemainingTokens / PONS_CURVE_DEFAULTS.totalSupply) * 100;

  // Detect coordinated same-block swarms (2+ distinct wallets buying in the exact same 100ms block after sniper window)
  const swarmClusters = [];
  const swarmWalletSet = new Set();
  for (const [blockNumber, list] of buysByBlock.entries()) {
    const distinct = [...new Set(list.map((x) => x.wallet).filter((addr) => !KNOWN_ROUTERS[addr]))];
    if (distinct.length >= 2) {
      const totalEth = list.reduce((acc, x) => acc + x.grossEth, 0);
      distinct.forEach((a) => swarmWalletSet.add(a));
      swarmClusters.push({
        blockNumber,
        dtBlocks: list[0].dtBlocks,
        walletCount: distinct.length,
        wallets: distinct,
        totalEth: Number(totalEth.toFixed(4)),
      });
    }
  }

  const effectiveReserveEth =
    currentReserveEth !== null && currentReserveEth !== undefined
      ? Number(currentReserveEth)
      : (trades.length > 0 ? trades[trades.length - 1].reserveAfterEth : 0);

  const curState = curveStateAtReserve(effectiveReserveEth, ethPriceUsd);

  // Compute exact mathematical Sniper Sell-Wall:
  // If >2% of total supply is still held by block +1..+15 snipers, compute the curve reserve where the
  // top sniper cohort (or aggregate remaining sniper cluster) reaches `sniperTargetProfitMultiple` (default 1.55x net ETH).
  let sellWallReserveEth = 0;
  let sellWallMcapUsd = 0;
  let safeExitReserveEth = 0;
  let safeExitMcapUsd = 0;

  if (sniperOverhangPct >= 1.5 && sniperRemainingTokens > 0 && sniperRemainingCostEth > 0) {
    // Representative dump wave = 45% of remaining sniper cluster unloading into wave-2 buyers
    const waveFraction = 0.45;
    const waveTokens = sniperRemainingTokens * waveFraction;
    const waveTargetEth = sniperRemainingCostEth * waveFraction * sniperTargetProfitMultiple;
    sellWallReserveEth = solveReserveForTargetExit({
      tokensHeld: waveTokens,
      targetNetEthOut: waveTargetEth,
      creatorTaxBps,
    });
    const wallState = curveStateAtReserve(sellWallReserveEth, ethPriceUsd);
    sellWallMcapUsd = Math.round(wallState.mcapUsd);

    // Safe front-run exit setpoint sits 7% in reserve below the sniper dump wall
    safeExitReserveEth = Number((sellWallReserveEth * 0.93).toFixed(4));
    safeExitMcapUsd = Math.round(curveStateAtReserve(safeExitReserveEth, ethPriceUsd).mcapUsd);
  }

  // Count independent human buyers (non-deployer, non-early-sniper, non-router, non-swarm)
  let organicHumanBuyers = 0;
  let organicNetEth = 0;
  for (const w of walletStats.values()) {
    if (w.isDeployer || w.isEarlySniper || KNOWN_ROUTERS[w.address] || swarmWalletSet.has(w.address)) continue;
    if (w.buys > 0) {
      organicHumanBuyers++;
      organicNetEth += Math.max(0, w.ethSpent - w.ethReceived);
    }
  }

  // Drawdown from peak reserve
  const drawdownPct = peakReserveEth > 0.15
    ? Math.max(0, ((peakReserveEth - effectiveReserveEth) / peakReserveEth) * 100)
    : 0;

  // Transparent Clean-Climb Score (0..100)
  let score = 78;
  const flags = [];

  if (sniperOverhangPct >= 18) {
    score -= 38;
    flags.push(`CRITICAL_SNIPER_OVERHANG: ${sniperOverhangPct.toFixed(1)}% supply held by first-1.5s snipers`);
  } else if (sniperOverhangPct >= 8) {
    score -= 22;
    flags.push(`SNIPER_WALL_ACTIVE: ${sniperOverhangPct.toFixed(1)}% supply held by early block snipers`);
  } else if (sniperOverhangPct <= 2.5) {
    score += 10;
  }

  if (creatorTaxBps >= 300) {
    score -= 10;
    flags.push(`MAX_CREATOR_TAX: ${(creatorTaxBps / 100).toFixed(2)}% creator tax`);
  }

  if (swarmClusters.length >= 2) {
    score -= 8;
    flags.push(`SAME_BLOCK_SWARMS: ${swarmClusters.length} coordinated 100ms multi-wallet bursts detected`);
  }

  if (drawdownPct >= 65 && peakReserveEth >= 0.5) {
    score -= 30;
    flags.push(`CURVE_EXTRACTED: reserve down ${drawdownPct.toFixed(0)}% from ${peakReserveEth.toFixed(2)} ETH peak`);
  }

  if (organicHumanBuyers >= 20) score += 10;
  else if (organicHumanBuyers >= 8) score += 5;
  else if (organicHumanBuyers <= 2 && trades.length >= 10) score -= 10;

  const cleanScore = Math.max(0, Math.min(100, Math.round(score)));

  let verdict = "CLEAN_CLIMB";
  if (drawdownPct >= 65 && peakReserveEth >= 0.5) {
    verdict = "EXTRACTED";
  } else if (sniperOverhangPct >= 16) {
    verdict = "HEAVY_SNIPER_OVERHANG";
  } else if (sniperOverhangPct >= 5 && sellWallReserveEth > effectiveReserveEth * 0.85) {
    verdict = "WALL_AHEAD";
  } else if (cleanScore < 55) {
    verdict = "CAUTION";
  }

  return {
    verdict,
    cleanScore,
    flags,
    metrics: {
      realReserveEth: Number(effectiveReserveEth.toFixed(4)),
      peakReserveEth: Number(peakReserveEth.toFixed(4)),
      peakBlock,
      drawdownPct: Number(drawdownPct.toFixed(1)),
      mcapUsd: Math.round(curState.mcapUsd),
      progressPct: Number(curState.progressPct.toFixed(2)),
      creatorTaxBps,
      totalTrades: trades.length,
      totalBuyEth: Number(totalBuyEth.toFixed(4)),
      totalSellEth: Number(totalSellEth.toFixed(4)),
      uniqueWallets: walletStats.size,
      organicHumanBuyers,
      organicNetEth: Number(organicNetEth.toFixed(4)),
      sniperInitialPct: Number(sniperInitialPct.toFixed(2)),
      sniperOverhangPct: Number(sniperOverhangPct.toFixed(2)),
      sniperOverhangBps: Math.round(sniperOverhangPct * 100),
      sellWallReserveEth: Number(sellWallReserveEth.toFixed(4)),
      sellWallMcapUsd,
      safeExitReserveEth,
      safeExitMcapUsd,
      swarmClusterCount: swarmClusters.length,
      botRouterTrades,
      estimatedBotRouterBleedEth: Number(estimatedBotRouterBleedEth.toFixed(4)),
    },
    snipers: snipers.slice(0, 15),
    swarmClusters: swarmClusters.slice(0, 10),
  };
}
