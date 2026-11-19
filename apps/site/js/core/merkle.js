/**
 * Deterministic Canonical Leaf & Sorted-Pair Keccak-256 Merkle Tree.
 *
 * Matches `AuditSealRegistry.sol` byte-for-byte:
 *  - Leaf hash: keccak256(utf8("curveguard:audit:v1:" + canonicalJson(record)))
 *  - Internal node: keccak256(abi.encodePacked(min(a, b), max(a, b))) (sorted 32-byte pair)
 *
 * Sorted pairs mean proof verification needs NO left/right index array and costs ~600 gas per level onchain.
 */

import { keccak256, hexToBytes, bytesToHex } from "./keccak.js";

export const LEAF_DOMAIN_PREFIX = "curveguard:audit:v1:";

/**
 * Deterministic recursive key-sorted JSON serializer with normalized numbers/addresses.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") +
    "}"
  );
}

export function normalizeAuditLeaf(raw) {
  return {
    epochHour: Number(raw.epochHour),
    chainId: Number(raw.chainId ?? 4663),
    token: String(raw.token || "").toLowerCase(),
    curve: String(raw.curve || "").toLowerCase(),
    symbol: String(raw.symbol || ""),
    headBlock: Number(raw.headBlock),
    realReserveEth: Number(Number(raw.realReserveEth || 0).toFixed(6)),
    creatorTaxBps: Number(raw.creatorTaxBps ?? 0),
    sniperOverhangBps: Math.round(Number(raw.sniperOverhangBps ?? 0)),
    swarmClusterCount: Number(raw.swarmClusterCount ?? 0),
    sellWallReserveEth: Number(Number(raw.sellWallReserveEth ?? 0).toFixed(6)),
    cleanScore: Math.round(Number(raw.cleanScore ?? 0)),
    verdict: String(raw.verdict || "UNKNOWN"),
  };
}

export function hashAuditLeaf(record) {
  const normalized = normalizeAuditLeaf(record);
  const payload = LEAF_DOMAIN_PREFIX + canonicalJson(normalized);
  return {
    normalized,
    canonical: payload,
    leafHash: keccak256(payload),
  };
}

export function hashSortedPair(hexA, hexB) {
  const a = hexA.toLowerCase();
  const b = hexB.toLowerCase();
  const [first, second] = a <= b ? [a, b] : [b, a];
  const bytesA = hexToBytes(first);
  const bytesB = hexToBytes(second);
  const combined = new Uint8Array(64);
  combined.set(bytesA, 0);
  combined.set(bytesB, 32);
  return keccak256(combined);
}

/**
 * Builds a deterministic sorted-pair Merkle tree from an array of audit leaf objects (or raw 0x32-byte hashes).
 */
export function buildMerkleTree(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("buildMerkleTree requires at least 1 leaf");
  }

  // Sort deterministically by leafHash (or token) if objects are passed
  const prepared = items.map((item, idx) => {
    if (typeof item === "string" && /^0x[0-9a-fA-F]{64}$/.test(item)) {
      return { index: idx, leafHash: item.toLowerCase(), normalized: null, canonical: null };
    }
    const h = hashAuditLeaf(item);
    return { index: idx, ...h, leafHash: h.leafHash.toLowerCase() };
  });

  const layers = [prepared.map((p) => p.leafHash)];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const left = cur[i];
      const right = i + 1 < cur.length ? cur[i + 1] : cur[i];
      next.push(hashSortedPair(left, right));
    }
    layers.push(next);
  }

  const root = layers[layers.length - 1][0];

  function getProof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= prepared.length) {
      throw new RangeError(`Leaf index out of range: ${leafIndex}`);
    }
    const proof = [];
    let idx = leafIndex;
    for (let level = 0; level < layers.length - 1; level++) {
      const layer = layers[level];
      const pairIdx = idx % 2 === 0 ? (idx + 1 < layer.length ? idx + 1 : idx) : idx - 1;
      proof.push(layer[pairIdx]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  return {
    root,
    leaves: prepared,
    layers,
    getProof,
  };
}

/**
 * Verifies a Merkle proof for either an audit record object or a raw 32-byte leaf hash.
 */
export function verifyMerkleProof({ record, leafHash, proof, expectedRoot }) {
  const computedLeaf = leafHash
    ? leafHash.toLowerCase()
    : hashAuditLeaf(record).leafHash.toLowerCase();

  let acc = computedLeaf;
  for (const sibling of proof || []) {
    acc = hashSortedPair(acc, sibling);
  }
  const normRoot = String(expectedRoot || "").toLowerCase();
  return {
    valid: acc === normRoot,
    computedLeaf,
    computedRoot: acc,
    expectedRoot: normRoot,
  };
}
