# curveguard

0-wallet sniper-wall & 100ms swarm X-ray, Keccak-256 Merkle seal verifier, and stdio MCP server for **Pons bonding curves on Robinhood Chain (`4663`)**.

## Install & Wire MCP

```bash
# Configure Cursor, Claude Code, Codex, and Claude Desktop automatically
npx curveguard init

# Optional global install for <0.25s startup
npm install -g curveguard
curveguard doctor
```

## CLI Commands

```bash
curveguard scan <0xToken> [--json]
curveguard radar [--clean-only] [--limit 12] [--json]
curveguard quote <0xToken> [--buy 0.1 | --sell 1000000] [--json]
curveguard replay <0xToken> [--entry-sec 15] [--eth 0.1] [--sl 18] [--trail 14] [--json]
curveguard guard <0xToken> [--sl 18] [--trail 14] [--exit-before-wall] [--once]
curveguard verify [--epoch <hour>] [--token <0xToken>] [--json]
curveguard init [--cursor] [--claude-code] [--codex] [--claude-desktop] [--dry-run]
curveguard doctor [--json]
curveguard mcp
```

MIT License. Zero external runtime dependencies.
