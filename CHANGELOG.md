# Changelog

All notable changes to CurveGuard follow Keep a Changelog and Semantic Versioning.

## [0.1.0] - 2026-11-19

### Added
- **`@curveguard/core` (0 external dependencies):**
  - Exact Pons v2 constant-product bonding-curve math (`1.68 ETH` phantom reserve, `4.20 ETH` graduation threshold, `creatorTaxBps` + `100 bps` curve fee, `solveReserveForTargetExit`).
  - Live `CurveBuy` / `CurveSell` log forensics cross-referenced with ERC-20 `balanceOf` so external bot-router sells (`0x6505...`) never mask remaining early sniper bags.
  - Same-block (`100ms`) multi-wallet swarm detector.
  - Zero-lookahead `replayGuardStrategy` engine (`Stop-Loss`, `Trailing-Stop`, `Exit-Before-Sniper-Wall`).
  - Pure-JS `keccak256` and sorted-pair binary Merkle tree builder & proof verifier.
- **`curveguard` CLI & stdio MCP server (`packages/cli`):**
  - `scan`, `radar`, `quote`, `replay`, `guard`, `verify`, `init`, `doctor`, and `mcp` (8 tools).
  - Multi-client bootstrapper (`Cursor`, `Claude Code`, `Codex`, `Claude Desktop`) with transient `_npx` PATH guard and `.curveguard-bak` backups.
- **`AuditSealRegistry.sol` (`contracts/`, Solidity `0.8.24`):**
  - Append-only hourly Merkle audit root registry on Robinhood Chain (`4663`) with zero ETH/token custody and zero `approve()` surface.
- **0-Wallet Web Terminal & Worker (`apps/site`, `apps/worker`):**
  - Live Radar, Token & Swarm X-Ray, Wall Replay Studio, interactive Merkle Seal Verifier, and remote HTTP `/mcp`.

## [Planned: 0.2.0 — T+3h Post-Launch]
- Local auto-broadcast trailing stop (`--key-env`) with automatic gas-bump on rapid reserve drops.
- Wallet-level PnL X-ray (`npx curveguard wallet 0x...`) separating real trading profit from bridge top-ups.

## [Planned: 0.3.0 — T+12h Post-Launch]
- Post-graduation Uniswap v4 pool handoff (`25% / 25% / 50%` exit ladder across `UniversalRouter`).

## [Planned: 0.4.0 — Day 2]
- Real-time Webhook & Telegram alerts on sniper-cluster dumps and `<10m` Clean-Climb graduations.
