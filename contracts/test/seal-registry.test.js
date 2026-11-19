import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "../../packages/core/src/keccak.js";
import { privateKeyToAddress, signLegacyTx } from "../../apps/worker/src/signer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_JSON = path.resolve(HERE, "..", "src", "build", "AuditSealRegistry.json");

test("AuditSealRegistry artifact compiles cleanly with zero payable/transferFrom custody functions", () => {
  assert.equal(fs.existsSync(BUILD_JSON), true, "AuditSealRegistry.json artifact exists");
  const artifact = JSON.parse(fs.readFileSync(BUILD_JSON, "utf8"));
  const fns = artifact.abi.filter((x) => x.type === "function");

  // Zero custody / zero drainer invariant: no payable functions, no approve/transferFrom
  for (const fn of fns) {
    assert.notEqual(fn.stateMutability, "payable", `Function ${fn.name} must not accept ETH`);
    assert.equal(/approve|transferFrom|withdraw/i.test(fn.name), false, `Forbidden custody function ${fn.name}`);
  }

  const names = new Set(fns.map((f) => f.name));
  for (const req of ["sealEpoch", "getSeal", "verifyAuditLeaf", "bindToken", "tierOf", "latestEpoch"]) {
    assert.equal(names.has(req), true, `Missing required contract method ${req}`);
  }

  assert.equal(keccak256("getSeal(uint64)").slice(0, 10), "0x6547c800");
  assert.equal(keccak256("balanceOf(address)").slice(0, 10), "0x70a08231");
});

test("Pure-BigInt secp256k1 signer matches standard Ethereum test vector & EIP-155 chainId 4663", () => {
  // Standard Hardhat/Foundry test vector #0 & #1
  const pk0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const pk1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  assert.equal(privateKeyToAddress(pk0), "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  assert.equal(privateKeyToAddress(pk1), "0x70997970c51812dc3a010c7d01b50e0d17dc79c8");

  const signed = signLegacyTx(
    {
      nonce: 7n,
      gasPriceWei: 100_000_000n,
      gasLimit: 140_000n,
      to: "0x1111111111111111111111111111111111111111",
      valueWei: 0n,
      dataHex: "0x12345678",
      chainId: 4663,
    },
    pk1
  );

  assert.ok(signed.rawTx.startsWith("0xf8"));
  assert.equal(signed.txHash.length, 66);
});
