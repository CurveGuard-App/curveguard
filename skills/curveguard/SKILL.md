---
name: curveguard
description: Audit Pons bonding-curve tokens on Robinhood Chain (4663) for block +1..+15 sniper overhang, coordinated 100ms multi-wallet swarms, exact mathematical sell-walls, Merkle-sealed historical audits, and zero-custody exit setpoints.
---

# CurveGuard Skill

Use CurveGuard whenever the user pastes a `0x...` token on Robinhood Chain (`4663`) / Pons, asks whether a launch is clean or sniper-loaded, wants to know where early snipers will dump (`sellWallMcapUsd`), or wants to backtest/arm a Stop-Loss or Exit-Before-Wall strategy.

## Quick Commands

```bash
# Install MCP server into Cursor, Claude Code, Codex, or Claude Desktop
npx curveguard init

# Live 0-wallet sniper-wall & swarm X-ray on any Pons token
npx curveguard scan 0xTokenAddress

# Replay Stop-Loss + Trailing-Stop + Exit-Before-Sniper-Wall on real curve blocks
npx curveguard replay 0xTokenAddress --entry-sec 15 --eth 0.1 --sl 18 --trail 14

# Arm local non-custodial curve watcher (0 keys sent to any server)
npx curveguard guard 0xTokenAddress --sl 18 --trail 14 --exit-before-wall
```

## Interpreting CurveGuard Metrics

1. **`sniperOverhangPct`**: Percentage of the `1,000,000,000` total supply still held right now by non-deployer wallets that bought in blocks `+1..+15` (`<= 1.5s` after launch), cross-checked against live ERC-20 `balanceOf` so external router sells (`0x6505...`) never mask exits.
   - `< 2.5%`: Clean floor (`CLEAN_CLIMB` candidate).
   - `8% - 15%`: Active sniper wall ahead (`WALL_AHEAD`) — place take-profit at `safeExitReserveEth` (`7%` below `sellWallReserveEth`).
   - `>= 18%`: Heavy sniper overhang (`HEAVY_SNIPER_OVERHANG`) — high risk of `$9.8K–$10.5K` brick-wall dump.
2. **`creatorTaxBps`**: `<= 200` (`<= 2.00%`) is builder-grade; `> 200` (`3.00%`) is flagged as `HIGH_CREATOR_TAX` (`8%–10%` round-trip friction).
3. **`swarmClusterCount`**: Distinct non-router wallets buying in the exact same `100ms` block (`blockNumber`), unmasking coordinated multi-wallet swarms and copy-bot farming.
