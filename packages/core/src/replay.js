/**
 * Deterministic Strategy Replay Engine over real Pons Bonding-Curve History.
 *
 * Runs identically in Browser (`/replay`), CLI (`npx curveguard replay`), and tests (`$0` LLM cost).
 * Compares guarded exit rules (`stopLossPct`, `trailingStopPct`, `exitBeforeWall`, `takeProfitMultiple`)
 * against unguarded Buy-and-Hold on the exact same block-by-block curve trajectory.
 */

import {
  PONS_CURVE_DEFAULTS,
  quoteCurveBuy,
  quoteCurveSell,
  curveStateAtReserve,
} from "./curve.js";
import { analyzeCurveForensics } from "./forensics.js";

export function replayGuardStrategy({
  trades = [],
  deployer = "",
  creatorTaxBps = PONS_CURVE_DEFAULTS.defaultCreatorTaxBps,
  ethPriceUsd = PONS_CURVE_DEFAULTS.defaultEthPriceUsd,
  entryAfterSec = 15,
  ethIn = 0.1,
  stopLossPct = 18,
  trailingStopPct = 14,
  exitBeforeWall = true,
  takeProfitMultiple = 2.5,
}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { ok: false, reason: "No curve trades available to replay." };
  }

  // Find the entry point at or immediately after `entryAfterSec`
  let entryIdx = trades.findIndex((t) => t.dtSec >= entryAfterSec);
  if (entryIdx === -1) entryIdx = Math.min(trades.length - 1, Math.max(0, Math.floor(trades.length * 0.2)));

  const entryTrade = trades[entryIdx];
  const entryReserveEth = entryTrade.reserveAfterEth;

  // Compute forensics using ONLY trades visible up to entryIdx (zero lookahead cheat!)
  const visibleTradesAtEntry = trades.slice(0, entryIdx + 1);
  const forensicsAtEntry = analyzeCurveForensics({
    trades: visibleTradesAtEntry,
    deployer,
    creatorTaxBps,
    currentReserveEth: entryReserveEth,
    ethPriceUsd,
  });

  // Simulate our buy directly against PonsCurve (`routerFeeBps = 0` — skipping 1% bot tax!)
  const entryBuy = quoteCurveBuy({
    realReserveEth: entryReserveEth,
    grossEthIn: ethIn,
    creatorTaxBps,
    routerFeeBps: 0,
    ethPriceUsd,
  });

  const tokensHeld = entryBuy.tokensOut;
  const postEntryReserve = entryBuy.newReserveEth;

  let peakValueEth = quoteCurveSell({
    realReserveEth: postEntryReserve,
    tokensIn: tokensHeld,
    creatorTaxBps,
    routerFeeBps: 0,
    ethPriceUsd,
  }).netEthOut;

  let guardedExit = null;
  const series = [
    {
      step: entryIdx,
      dtSec: entryTrade.dtSec,
      reserveEth: Number(postEntryReserve.toFixed(4)),
      mcapUsd: Math.round(curveStateAtReserve(postEntryReserve, ethPriceUsd).mcapUsd),
      holdValueEth: Number(peakValueEth.toFixed(5)),
      guardedValueEth: Number(peakValueEth.toFixed(5)),
    },
  ];

  const safeExitReserve = forensicsAtEntry.metrics.safeExitReserveEth;

  for (let i = entryIdx + 1; i < trades.length; i++) {
    const t = trades[i];
    // Add our position's reserve offset while still in curve
    const simReserve = Math.min(
      PONS_CURVE_DEFAULTS.graduationThresholdEth,
      t.reserveAfterEth + (guardedExit ? 0 : entryBuy.netReserveIn)
    );

    const markSell = quoteCurveSell({
      realReserveEth: simReserve,
      tokensIn: tokensHeld,
      creatorTaxBps,
      routerFeeBps: 0,
      ethPriceUsd,
    });
    const curValEth = markSell.netEthOut;
    if (curValEth > peakValueEth) peakValueEth = curValEth;

    if (!guardedExit) {
      const pnlPct = ((curValEth - ethIn) / ethIn) * 100;
      const dropFromPeakPct = peakValueEth > 0 ? ((peakValueEth - curValEth) / peakValueEth) * 100 : 0;

      if (
        exitBeforeWall &&
        safeExitReserve > entryBuy.newReserveEth * 1.05 &&
        simReserve >= safeExitReserve
      ) {
        guardedExit = {
          reason: "EXIT_BEFORE_SNIPER_WALL",
          step: i,
          dtSec: t.dtSec,
          blockNumber: t.blockNumber,
          reserveEth: Number(simReserve.toFixed(4)),
          mcapUsd: Math.round(curveStateAtReserve(simReserve, ethPriceUsd).mcapUsd),
          netEthOut: Number(curValEth.toFixed(5)),
          pnlEth: Number((curValEth - ethIn).toFixed(5)),
          pnlPct: Number(pnlPct.toFixed(2)),
        };
      } else if (takeProfitMultiple > 0 && curValEth >= ethIn * takeProfitMultiple) {
        guardedExit = {
          reason: "TAKE_PROFIT_TARGET",
          step: i,
          dtSec: t.dtSec,
          blockNumber: t.blockNumber,
          reserveEth: Number(simReserve.toFixed(4)),
          mcapUsd: Math.round(curveStateAtReserve(simReserve, ethPriceUsd).mcapUsd),
          netEthOut: Number(curValEth.toFixed(5)),
          pnlEth: Number((curValEth - ethIn).toFixed(5)),
          pnlPct: Number(pnlPct.toFixed(2)),
        };
      } else if (stopLossPct > 0 && pnlPct <= -Math.abs(stopLossPct)) {
        guardedExit = {
          reason: "HARD_STOP_LOSS",
          step: i,
          dtSec: t.dtSec,
          blockNumber: t.blockNumber,
          reserveEth: Number(simReserve.toFixed(4)),
          mcapUsd: Math.round(curveStateAtReserve(simReserve, ethPriceUsd).mcapUsd),
          netEthOut: Number(curValEth.toFixed(5)),
          pnlEth: Number((curValEth - ethIn).toFixed(5)),
          pnlPct: Number(pnlPct.toFixed(2)),
        };
      } else if (
        trailingStopPct > 0 &&
        peakValueEth >= ethIn * 1.12 &&
        dropFromPeakPct >= Math.abs(trailingStopPct)
      ) {
        guardedExit = {
          reason: "TRAILING_STOP_LOCK",
          step: i,
          dtSec: t.dtSec,
          blockNumber: t.blockNumber,
          reserveEth: Number(simReserve.toFixed(4)),
          mcapUsd: Math.round(curveStateAtReserve(simReserve, ethPriceUsd).mcapUsd),
          netEthOut: Number(curValEth.toFixed(5)),
          pnlEth: Number((curValEth - ethIn).toFixed(5)),
          pnlPct: Number(pnlPct.toFixed(2)),
        };
      }
    }

    const holdMark = quoteCurveSell({
      realReserveEth: Math.min(PONS_CURVE_DEFAULTS.graduationThresholdEth, t.reserveAfterEth + entryBuy.netReserveIn),
      tokensIn: tokensHeld,
      creatorTaxBps,
      routerFeeBps: 0,
      ethPriceUsd,
    }).netEthOut;

    series.push({
      step: i,
      dtSec: t.dtSec,
      reserveEth: Number(t.reserveAfterEth.toFixed(4)),
      mcapUsd: Math.round(curveStateAtReserve(t.reserveAfterEth, ethPriceUsd).mcapUsd),
      holdValueEth: Number(holdMark.toFixed(5)),
      guardedValueEth: Number((guardedExit ? guardedExit.netEthOut : curValEth).toFixed(5)),
    });
  }

  const lastPoint = series[series.length - 1];
  const holdEndEth = lastPoint.holdValueEth;
  const holdPnlPct = ((holdEndEth - ethIn) / ethIn) * 100;
  const guardedEndEth = guardedExit ? guardedExit.netEthOut : holdEndEth;
  const guardedPnlPct = ((guardedEndEth - ethIn) / ethIn) * 100;
  const routerFeeSavedEth = Number(((ethIn + guardedEndEth) * 0.01).toFixed(5));

  return {
    ok: true,
    entry: {
      step: entryIdx,
      dtSec: entryTrade.dtSec,
      blockNumber: entryTrade.blockNumber,
      entryReserveEth: Number(entryReserveEth.toFixed(4)),
      entryMcapUsd: Math.round(curveStateAtReserve(entryReserveEth, ethPriceUsd).mcapUsd),
      ethIn,
      tokensBought: Math.round(tokensHeld),
      detectedSniperOverhangPct: forensicsAtEntry.metrics.sniperOverhangPct,
      detectedSellWallReserveEth: forensicsAtEntry.metrics.sellWallReserveEth,
      detectedSellWallMcapUsd: forensicsAtEntry.metrics.sellWallMcapUsd,
      safeExitReserveEth: safeExitReserve,
      safeExitMcapUsd: forensicsAtEntry.metrics.safeExitMcapUsd,
    },
    guardedExit: guardedExit || {
      reason: "STILL_OPEN_AT_END",
      step: trades.length - 1,
      dtSec: trades[trades.length - 1].dtSec,
      blockNumber: trades[trades.length - 1].blockNumber,
      reserveEth: Number(trades[trades.length - 1].reserveAfterEth.toFixed(4)),
      mcapUsd: lastPoint.mcapUsd,
      netEthOut: Number(guardedEndEth.toFixed(5)),
      pnlEth: Number((guardedEndEth - ethIn).toFixed(5)),
      pnlPct: Number(guardedPnlPct.toFixed(2)),
    },
    holdOutcome: {
      netEthOut: Number(holdEndEth.toFixed(5)),
      pnlEth: Number((holdEndEth - ethIn).toFixed(5)),
      pnlPct: Number(holdPnlPct.toFixed(2)),
    },
    edgeVsHoldPct: Number((guardedPnlPct - holdPnlPct).toFixed(2)),
    edgeVsHoldEth: Number((guardedEndEth - holdEndEth).toFixed(5)),
    routerFeeSavedEth,
    series,
  };
}
