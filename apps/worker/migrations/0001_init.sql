-- CurveGuard D1 Schema (Robinhood Chain 4663)
CREATE TABLE IF NOT EXISTS token_audits (
  token TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  curve TEXT NOT NULL,
  created_at_iso TEXT,
  creator_tax_bps INTEGER NOT NULL DEFAULT 200,
  real_reserve_eth REAL NOT NULL DEFAULT 0,
  mcap_usd INTEGER NOT NULL DEFAULT 0,
  progress_pct REAL NOT NULL DEFAULT 0,
  sniper_initial_pct REAL NOT NULL DEFAULT 0,
  sniper_overhang_pct REAL NOT NULL DEFAULT 0,
  sell_wall_reserve_eth REAL NOT NULL DEFAULT 0,
  sell_wall_mcap_usd INTEGER NOT NULL DEFAULT 0,
  safe_exit_mcap_usd INTEGER NOT NULL DEFAULT 0,
  swarm_cluster_count INTEGER NOT NULL DEFAULT 0,
  organic_buyers INTEGER NOT NULL DEFAULT 0,
  clean_score INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT 'UNKNOWN',
  audit_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_audits_updated ON token_audits(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_audits_score ON token_audits(clean_score DESC);

CREATE TABLE IF NOT EXISTS epoch_seals (
  epoch_hour INTEGER PRIMARY KEY,
  merkle_root TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  clean_count INTEGER NOT NULL,
  tx_hash TEXT,
  sealed_at INTEGER NOT NULL,
  leaves_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS burn_passes (
  tx_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  amount_burned REAL NOT NULL,
  block_number INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_burn_passes_wallet ON burn_passes(wallet, expires_at DESC);
