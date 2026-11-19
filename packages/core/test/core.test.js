import test from "node:test";
import assert from "node:assert/strict";
import {
  keccak256,
  PONS_CURVE_DEFAULTS,
  curveStateAtReserve,
  quoteCurveBuy,
  quoteCurveSell,
  solveReserveForTargetExit,
  buildMerkleTree,
  verifyMerkleProof,
  hashAuditLeaf,
  analyzeCurveForensics,
  replayGuardStrategy,
} from "../src/index.js";

test("keccak256 matches official Ethereum test vectors and multi-block messages", () => {
  assert.equal(
    keccak256(""),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
  );
  assert.equal(
    keccak256("abc"),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
  );
  assert.equal(keccak256("balanceOf(address)").slice(0, 10), "0x70a08231");
  assert.equal(keccak256("realQuoteReserve()").slice(0, 10), "0x4f1f58fd");

  // >136 byte multi-block input
  const longStr = "curveguard-robinhood-chain-4663-".repeat(12);
  const h1 = keccak256(longStr);
  const h2 = keccak256(longStr);
  assert.equal(h1, h2);
  assert.equal(h1.length, 66);
});

test("Pons v2 curve math invariants hold at floor, mid-curve, and 4.20 ETH graduation", () => {
  const floor = curveStateAtReserve(0, 2000);
  assert.equal(floor.virtualQuoteEth, 1.68);
  assert.equal(floor.tokensCirculating, 0);
  assert.ok(Math.abs(floor.mcapUsd - 3360) < 1);

  const grad = curveStateAtReserve(PONS_CURVE_DEFAULTS.graduationThresholdEth, 2000);
  assert.equal(grad.progressPct, 100);
  assert.ok(Math.abs(grad.tokensCirculating - 714_285_714.2857) < 1);

  // Zero-tax buy followed immediately by sell returns identical reserve & quote
  const buy = quoteCurveBuy({ realReserveEth: 0.8, grossEthIn: 0.25, creatorTaxBps: 0, protocolFeeBps: 0 });
  const sell = quoteCurveSell({ realReserveEth: buy.newReserveEth, tokensIn: buy.tokensOut, creatorTaxBps: 0, protocolFeeBps: 0 });
  assert.ok(Math.abs(sell.netEthOut - 0.25) < 1e-9);
  assert.ok(Math.abs(sell.newReserveEth - 0.8) < 1e-9);
});

test("solveReserveForTargetExit finds exact sell-wall reserve across 30 randomized bags", () => {
  for (let i = 1; i <= 30; i++) {
    const tokensHeld = 5_000_000 + i * 2_500_000;
    const targetNetEthOut = 0.03 + i * 0.015;
    const tax = i % 2 === 0 ? 195 : 300;
    const solvedRes = solveReserveForTargetExit({
      tokensHeld,
      targetNetEthOut,
      creatorTaxBps: tax,
    });
    const check = quoteCurveSell({
      realReserveEth: solvedRes,
      tokensIn: tokensHeld,
      creatorTaxBps: tax,
    });
    assert.ok(Math.abs(check.netEthOut - targetNetEthOut) < 1e-3);
  }
});

test("Merkle tree builds valid proofs across odd/even sizes and rejects any single-bit tamper", () => {
  for (const count of [1, 2, 5, 14, 23]) {
    const records = Array.from({ length: count }, (_, idx) => ({
      epochHour: 1795082400,
      chainId: 4663,
      token: `0x${(idx + 1).toString(16).padStart(40, "a")}`,
      curve: `0x${(idx + 1).toString(16).padStart(40, "b")}`,
      symbol: `TOK${idx}`,
      headBlock: 118000000 + idx,
      realReserveEth: 0.25 * (idx + 1),
      creatorTaxBps: 195,
      sniperOverhangBps: idx * 80,
      swarmClusterCount: idx % 3,
      sellWallReserveEth: 1.5,
      cleanScore: 88 - idx,
      verdict: "CLEAN_CLIMB",
    }));

    const tree = buildMerkleTree(records);
    for (let idx = 0; idx < count; idx++) {
      const proof = tree.getProof(idx);
      const ok = verifyMerkleProof({
        record: records[idx],
        proof,
        expectedRoot: tree.root,
      });
      assert.equal(ok.valid, true);

      // Tamper cleanScore by +1 -> must fail!
      const tampered = { ...records[idx], cleanScore: records[idx].cleanScore + 1 };
      const bad = verifyMerkleProof({
        record: tampered,
        proof,
        expectedRoot: tree.root,
      });
      assert.equal(bad.valid, false);
      assert.notEqual(hashAuditLeaf(tampered).leafHash, ok.computedLeaf);
    }
  }
});

test("Forensics & Replay unmask early snipers, honor live balanceOf router exits, and front-run the wall", () => {
  const deployer = "0x1111111111111111111111111111111111111111";
  const sniperA = "0x2222222222222222222222222222222222222222";
  const sniperB = "0x3333333333333333333333333333333333333333";
  const swarm1 = "0x4444444444444444444444444444444444444444";
  const swarm2 = "0x5555555555555555555555555555555555555555";

  const trades = [
    { side: "buy", blockNumber: 100, dtBlocks: 0, dtSec: 0, caller: deployer, wallet: deployer, grossEth: 0.05, netEth: 0.0485, tokens: 28_000_000, reserveAfterEth: 0.0485 },
    { side: "buy", blockNumber: 105, dtBlocks: 5, dtSec: 0.5, caller: sniperA, wallet: sniperA, grossEth: 0.22, netEth: 0.2134, tokens: 105_000_000, reserveAfterEth: 0.2619 },
    { side: "buy", blockNumber: 108, dtBlocks: 8, dtSec: 0.8, caller: sniperB, wallet: sniperB, grossEth: 0.22, netEth: 0.2134, tokens: 90_000_000, reserveAfterEth: 0.4753 },
    // Same-block 100ms swarm at block 140
    { side: "buy", blockNumber: 140, dtBlocks: 40, dtSec: 4.0, caller: swarm1, wallet: swarm1, grossEth: 0.12, netEth: 0.1164, tokens: 36_000_000, reserveAfterEth: 0.5917 },
    { side: "buy", blockNumber: 140, dtBlocks: 40, dtSec: 4.0, caller: swarm2, wallet: swarm2, grossEth: 0.12, netEth: 0.1164, tokens: 34_000_000, reserveAfterEth: 0.7081 },
    // Climb into sniper wall zone, then snipers dump hard
    { side: "buy", blockNumber: 250, dtBlocks: 150, dtSec: 15.0, caller: "0x6666666666666666666666666666666666666666", wallet: "0x6666666666666666666666666666666666666666", grossEth: 0.85, netEth: 0.8245, tokens: 165_000_000, reserveAfterEth: 1.5326 },
    { side: "sell", blockNumber: 260, dtBlocks: 160, dtSec: 16.0, caller: sniperA, wallet: sniperA, grossEth: 0.75, netEth: 0.72, tokens: 105_000_000, reserveAfterEth: 0.7826 },
    { side: "sell", blockNumber: 262, dtBlocks: 162, dtSec: 16.2, caller: sniperB, wallet: sniperB, grossEth: 0.58, netEth: 0.56, tokens: 90_000_000, reserveAfterEth: 0.2026 },
  ];

  // At block 140 (before dump), snipers hold 19.5% of supply -> HEAVY_SNIPER_OVERHANG
  const earlyAudit = analyzeCurveForensics({
    trades: trades.slice(0, 5),
    deployer,
    creatorTaxBps: 300,
  });
  assert.equal(earlyAudit.verdict, "HEAVY_SNIPER_OVERHANG");
  assert.equal(earlyAudit.metrics.sniperOverhangPct, 19.5);
  assert.equal(earlyAudit.metrics.swarmClusterCount, 1);
  assert.ok(earlyAudit.metrics.sellWallReserveEth > 0.85);

  // If liveBalances shows snipers already sold out via an external router, overhang drops to 0%
  const routerAdjusted = analyzeCurveForensics({
    trades: trades.slice(0, 5),
    deployer,
    creatorTaxBps: 195,
    liveBalances: { [sniperA]: 0, [sniperB]: 0 },
  });
  assert.equal(routerAdjusted.metrics.sniperOverhangPct, 0);

  // Replay entering at T+4s exits BEFORE sniper dump instead of riding down to 0.20 ETH
  const rep = replayGuardStrategy({
    trades,
    deployer,
    creatorTaxBps: 195,
    entryAfterSec: 4,
    ethIn: 0.1,
    stopLossPct: 25,
    trailingStopPct: 14,
    exitBeforeWall: true,
  });
  assert.equal(rep.ok, true);
  assert.equal(rep.guardedExit.reason, "EXIT_BEFORE_SNIPER_WALL");
  assert.ok(rep.edgeVsHoldPct > 40);
});
