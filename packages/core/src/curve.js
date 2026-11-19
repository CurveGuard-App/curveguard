/**
 * Exact Pons v2 (Robinhood Chain 4663) Constant-Product Bonding Curve Math.
 *
 * Verified against onchain PonsCurve contracts (Config 0):
 *  - Total token supply: 1,000,000,000 (18 decimals)
 *  - Virtual (phantom) quote reserve at r=0: 1.68 ETH
 *  - Real quote graduation threshold: 4.20 ETH (total virtual+real at grad = 5.88 ETH)
 *  - Virtual token reserve at r=0: 1,000,000,000 -> invariant K = 1.68 * 1e9 = 1,680,000,000
 *  - Tokens sold at graduation (r=4.20): 1e9 - (1.68e9 / 5.88) = 714,285,714.285714 (71.43%)
 *  - Protocol curve fee: 100 bps (1.00%) + creatorTaxBps (0..300 bps)
 */

export const PONS_CURVE_DEFAULTS = Object.freeze({
  totalSupply: 1_000_000_000,
  phantomQuoteEth: 1.68,
  graduationThresholdEth: 4.20,
  protocolFeeBps: 100,
  defaultCreatorTaxBps: 200,
  defaultEthPriceUsd: 2150,
});

const K_INVARIANT = PONS_CURVE_DEFAULTS.phantomQuoteEth * PONS_CURVE_DEFAULTS.totalSupply; // 1.68e9

export function clampReserve(realReserveEth) {
  const r = Number(realReserveEth) || 0;
  return Math.max(0, Math.min(PONS_CURVE_DEFAULTS.graduationThresholdEth, r));
}

/**
 * Computes exact curve state (virtual reserves, spot price, MCAP, progress %) at any real ETH reserve.
 */
export function curveStateAtReserve(realReserveEth, ethPriceUsd = PONS_CURVE_DEFAULTS.defaultEthPriceUsd) {
  const r = Math.max(0, Number(realReserveEth) || 0);
  const virtualQuote = PONS_CURVE_DEFAULTS.phantomQuoteEth + r;
  const virtualTokens = K_INVARIANT / virtualQuote;
  const tokensCirculating = PONS_CURVE_DEFAULTS.totalSupply - virtualTokens;
  const spotPriceEth = virtualQuote / virtualTokens; // = virtualQuote^2 / 1.68e9
  const mcapEth = spotPriceEth * PONS_CURVE_DEFAULTS.totalSupply;
  const mcapUsd = mcapEth * ethPriceUsd;
  const spotPriceUsd = spotPriceEth * ethPriceUsd;
  const progressPct = Math.min(100, (r / PONS_CURVE_DEFAULTS.graduationThresholdEth) * 100);

  return {
    realReserveEth: r,
    virtualQuoteEth: virtualQuote,
    virtualTokens,
    tokensCirculating,
    circulatingPct: (tokensCirculating / PONS_CURVE_DEFAULTS.totalSupply) * 100,
    spotPriceEth,
    spotPriceUsd,
    mcapEth,
    mcapUsd,
    progressPct,
    remainingToGradEth: Math.max(0, PONS_CURVE_DEFAULTS.graduationThresholdEth - r),
  };
}

/**
 * Exact constant-product buy quote from current realReserveEth.
 */
export function quoteCurveBuy({
  realReserveEth = 0,
  grossEthIn,
  creatorTaxBps = PONS_CURVE_DEFAULTS.defaultCreatorTaxBps,
  protocolFeeBps = PONS_CURVE_DEFAULTS.protocolFeeBps,
  routerFeeBps = 0,
  ethPriceUsd = PONS_CURVE_DEFAULTS.defaultEthPriceUsd,
}) {
  const gross = Math.max(0, Number(grossEthIn) || 0);
  const routerFeeEth = gross * (routerFeeBps / 10_000);
  const intoCurveEth = gross - routerFeeEth;
  const totalCurveTaxBps = protocolFeeBps + creatorTaxBps;
  const protocolFeeEth = intoCurveEth * (protocolFeeBps / 10_000);
  const creatorFeeEth = intoCurveEth * (creatorTaxBps / 10_000);
  const netReserveIn = intoCurveEth * (1 - totalCurveTaxBps / 10_000);

  const before = curveStateAtReserve(realReserveEth, ethPriceUsd);
  const cappedNetIn = Math.min(netReserveIn, before.remainingToGradEth);
  const newReserveEth = before.realReserveEth + cappedNetIn;
  const after = curveStateAtReserve(newReserveEth, ethPriceUsd);
  const tokensOut = Math.max(0, before.virtualTokens - after.virtualTokens);
  const effectiveEntryEthPerToken = tokensOut > 0 ? gross / tokensOut : 0;
  const priceImpactPct = before.spotPriceEth > 0
    ? ((after.spotPriceEth - before.spotPriceEth) / before.spotPriceEth) * 100
    : 0;

  return {
    grossEthIn: gross,
    netReserveIn: cappedNetIn,
    routerFeeEth,
    protocolFeeEth,
    creatorFeeEth,
    tokensOut,
    supplyPct: (tokensOut / PONS_CURVE_DEFAULTS.totalSupply) * 100,
    effectiveEntryEthPerToken,
    newReserveEth,
    newMcapUsd: after.mcapUsd,
    newProgressPct: after.progressPct,
    priceImpactPct,
  };
}

/**
 * Exact constant-product sell quote from current realReserveEth.
 */
export function quoteCurveSell({
  realReserveEth = 0,
  tokensIn,
  creatorTaxBps = PONS_CURVE_DEFAULTS.defaultCreatorTaxBps,
  protocolFeeBps = PONS_CURVE_DEFAULTS.protocolFeeBps,
  routerFeeBps = 0,
  ethPriceUsd = PONS_CURVE_DEFAULTS.defaultEthPriceUsd,
}) {
  const tok = Math.max(0, Number(tokensIn) || 0);
  const before = curveStateAtReserve(realReserveEth, ethPriceUsd);
  if (tok <= 0 || before.realReserveEth <= 0) {
    return {
      tokensIn: tok,
      grossReserveOut: 0,
      protocolFeeEth: 0,
      creatorFeeEth: 0,
      routerFeeEth: 0,
      netEthOut: 0,
      newReserveEth: before.realReserveEth,
      newMcapUsd: before.mcapUsd,
    };
  }

  const newVirtualTokens = before.virtualTokens + tok;
  const newVirtualQuote = K_INVARIANT / newVirtualTokens;
  const rawGrossOut = Math.max(0, before.virtualQuoteEth - newVirtualQuote);
  const grossReserveOut = Math.min(before.realReserveEth, rawGrossOut);

  const protocolFeeEth = grossReserveOut * (protocolFeeBps / 10_000);
  const creatorFeeEth = grossReserveOut * (creatorTaxBps / 10_000);
  const afterCurveTaxEth = Math.max(0, grossReserveOut - protocolFeeEth - creatorFeeEth);
  const routerFeeEth = afterCurveTaxEth * (routerFeeBps / 10_000);
  const netEthOut = Math.max(0, afterCurveTaxEth - routerFeeEth);

  const newReserveEth = Math.max(0, before.realReserveEth - grossReserveOut);
  const after = curveStateAtReserve(newReserveEth, ethPriceUsd);

  return {
    tokensIn: tok,
    grossReserveOut,
    protocolFeeEth,
    creatorFeeEth,
    routerFeeEth,
    netEthOut,
    newReserveEth,
    newMcapUsd: after.mcapUsd,
  };
}

/**
 * Finds the exact real ETH reserve at which selling `tokensHeld` yields `targetNetEthOut`
 * (used to compute the exact Sniper Sell-Wall reserve & safe front-run exit setpoint).
 */
export function solveReserveForTargetExit({
  tokensHeld,
  targetNetEthOut,
  creatorTaxBps = PONS_CURVE_DEFAULTS.defaultCreatorTaxBps,
  protocolFeeBps = PONS_CURVE_DEFAULTS.protocolFeeBps,
  routerFeeBps = 0,
}) {
  const tok = Number(tokensHeld) || 0;
  const target = Number(targetNetEthOut) || 0;
  if (tok <= 0 || target <= 0) return 0;

  let lo = 0;
  let hi = PONS_CURVE_DEFAULTS.graduationThresholdEth * 2.5;
  for (let iter = 0; iter < 52; iter++) {
    const mid = (lo + hi) / 2;
    const q = quoteCurveSell({
      realReserveEth: mid,
      tokensIn: tok,
      creatorTaxBps,
      protocolFeeBps,
      routerFeeBps,
    });
    if (q.netEthOut >= target) hi = mid;
    else lo = mid;
  }
  return Number(hi.toFixed(6));
}
