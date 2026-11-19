# CurveGuard

**See the sniper wall before you buy. Exit before they dump.**

0-wallet sniper-wall & 100ms swarm X-ray, hourly Keccak-256 Merkle-sealed curve audits (`AuditSealRegistry.sol`), and a zero-dependency CLI + stdio MCP server (`npx curveguard`) for **Pons bonding curves on Robinhood Chain (`4663`)**.

- **Web Terminal:** [https://curveguard.app](https://curveguard.app)
- **GitHub:** [https://github.com/CurveGuard-App/curveguard](https://github.com/CurveGuard-App/curveguard)
- **X:** [https://x.com/curveguardapp](https://x.com/curveguardapp)

## Quickstart (CLI & MCP)

Requires Node.js 20+. Zero external npm dependencies, zero signup, zero wallet connection required.

```bash
# Auto-detect and wire Cursor, Claude Code, Codex & Claude Desktop
npx curveguard init

# Live 0-wallet sniper-wall & swarm X-ray on any Robinhood Chain / Pons token
npx curveguard scan 0xcd5c01ea857df6253323a1bde87cd1d3a442a8f7

# Replay Stop-Loss + Trailing-Stop + Exit-Before-Sniper-Wall on historical curve blocks
npx curveguard replay 0xda4283f14b487034b90d865aac489994f2c680c4 --entry-sec 12 --eth 0.1 --sl 25 --trail 14

# Arm local curve watcher (0 keys leave your machine)
npx curveguard guard 0xcd5c01ea857df6253323a1bde87cd1d3a442a8f7 --sl 18 --trail 14 --exit-before-wall
```

## Architecture

| Package | Role | Runtime Dependencies |
|---|---|---|
| `packages/core` | Constant-product Pons v2 curve math, `CurveBuy`/`CurveSell` log forensics, ERC-20 `balanceOf` sniper verification, zero-lookahead replay engine, pure-JS `keccak256` & sorted-pair Merkle proofs | `0` |
| `packages/cli` | Standalone `curveguard` binary (`scan`, `radar`, `quote`, `replay`, `guard`, `verify`, `init`, `doctor`, `mcp`) | `0` |
| `contracts` | `AuditSealRegistry.sol` (`solc 0.8.24`, Sourcify v2 `exact_match` ready) — append-only hourly Merkle roots, zero custody, zero `approve()` | Solidity `0.8.24` |
| `apps/worker` & `apps/site` | Live Robinhood Chain indexer, hourly Merkle sealer, remote HTTP `/mcp`, and 0-wallet web terminal (`Live Radar`, `Token X-Ray`, `Wall Replay`, `Verify Seals`) | `0` |

## Claim & Status Matrix

| Claim | Status | Verification |
|---|---|---|
| Exact Pons v2 constant-product math (`1.68 ETH` phantom, `4.20 ETH` graduation, `creatorTaxBps`) | **Live** | `packages/core/src/curve.js`, `npm test` |
| Block `+1..+15` (`1.5s`) sniper overhang cross-checked with live ERC-20 `balanceOf` (immune to router obfuscation) | **Live** | `npx curveguard scan <0xToken>` |
| Same-block (`100ms`) multi-wallet swarm detector | **Live** | `packages/core/src/forensics.js` |
| Zero-lookahead Wall Replay Studio in browser & CLI | **Live** | `/#/replay`, `npx curveguard replay` |
| Sorted-pair Keccak-256 Merkle audit proofs & `AuditSealRegistry.sol` (zero custody / zero token approvals) | **Live** | `/#/verify`, `contracts/src/AuditSealRegistry.sol` |
| Multi-client MCP installer (`Cursor`, `Claude Code`, `Codex`, `Claude Desktop`) with `_npx` PATH guard & `.curveguard-bak` backups | **Live** | `packages/cli/test/cli.test.js` |
| v0.2 Local auto-broadcast trailing stop · v0.3 Post-graduation Uniswap v4 TWAP · v0.4 Telegram/Webhook dump alerts | **Scheduled (48h)** | Tracked in `CHANGELOG.md` |

## Known Limits

- Sniper sell-wall reserve (`sellWallReserveEth`) models remaining early snipers taking profit around `1.55x` net ETH (`~+55%`), calibrated on empirical Pons v2 dumps (`$9.8K–$11.3K` MCAP). Real actors can sell earlier or hold past graduation.
- `AuditSealRegistry` proves that an hourly audit record was committed at `sealedAt` and never altered afterward; missed worker cron runs leave `sealedAt == 0` rather than backfilling.
- Independent software reading public Robinhood Chain RPC data. Not affiliated with Pons or Robinhood. Not investment advice.
