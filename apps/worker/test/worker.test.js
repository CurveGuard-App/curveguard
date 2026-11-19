import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { verifyMerkleProof } from "../../../packages/core/src/merkle.js";

const mockCtx = {
  waitUntil(p) {
    Promise.resolve(p).catch(() => {});
  },
};

test("Worker serves /llms.txt, /v1/radar, /v1/seals/proof, /v1/tier & remote /mcp with valid Merkle proofs", async () => {
  const llmsRes = await worker.fetch(new Request("https://curveguard.test/llms.txt"), {}, mockCtx);
  assert.equal(llmsRes.status, 200);
  const llmsTxt = await llmsRes.text();
  assert.ok(llmsTxt.includes("npx curveguard init"));

  const radarRes = await worker.fetch(new Request("https://curveguard.test/v1/radar?limit=5"), {}, mockCtx);
  assert.equal(radarRes.status, 200);
  const radar = await radarRes.json();
  assert.equal(radar.ok, true);
  assert.ok(radar.items.length >= 3);

  const proofRes = await worker.fetch(new Request("https://curveguard.test/v1/seals/proof"), {}, mockCtx);
  assert.equal(proofRes.status, 200);
  const proofData = await proofRes.json();
  assert.equal(proofData.ok, true);
  assert.ok(/^0x[0-9a-f]{64}$/.test(proofData.merkleRoot));

  // Verify the returned record + proof locally using @curveguard/core
  const check = verifyMerkleProof({
    record: proofData.record,
    proof: proofData.proof,
    expectedRoot: proofData.merkleRoot,
  });
  assert.equal(check.valid, true);

  // Remote MCP initialize + tools/list
  const mcpRes = await worker.fetch(
    new Request("https://curveguard.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    }),
    {},
    mockCtx
  );
  const mcpJson = await mcpRes.json();
  assert.equal(mcpJson.result.tools.length, 2);
});
