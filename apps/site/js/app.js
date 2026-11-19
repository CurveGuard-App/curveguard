import {
  RH_CHAIN_DEFAULTS,
  quoteCurveBuy,
  verifyMerkleProof,
  hashAuditLeaf,
  scanPonsTokenLive,
  replayGuardStrategy,
  verifyAuditOnchain,
} from "./core/index.js";

const CONFIG = {
  tokenCa: "0xb664e4e875c1d3130D1f0b263cf5574C9432549F", // Populated automatically at T=0
  sealRegistry: "0xa663a02c98d18f18f1a5212967a2674bad8294a2", // Populated when AuditSealRegistry.sol is deployed on 4663
  rpcUrl: RH_CHAIN_DEFAULTS.rpcUrl,
  defaultToken: "0xcd5c01ea857df6253323a1bde87cd1d3a442a8f7",
  defaultReplayToken: "0xda4283f14b487034b90d865aac489994f2c680c4",
};

const state = {
  route: "radar",
  selectedToken: CONFIG.defaultToken,
  radarItems: [],
  radarTier: null,
  savedWallet: localStorage.getItem("cg_read_wallet") || "",
  currentScan: null,
  currentReplay: null,
  seals: [],
  currentProof: null,
};

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortAddr(a) {
  if (!a || a.length < 12) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v).toLocaleString()}`;
}

function fmtAge(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function verdictBadge(verdict) {
  if (verdict === "CLEAN_CLIMB") return `<span class="badge badge-clean">CLEAN CLIMB</span>`;
  if (verdict === "WALL_AHEAD") return `<span class="badge badge-warn">WALL AHEAD</span>`;
  if (verdict === "CAUTION") return `<span class="badge badge-warn">CAUTION</span>`;
  return `<span class="badge badge-danger">${esc(verdict.replace(/_/g, " "))}</span>`;
}

async function apiGet(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("cg_theme", theme);
}

function initHeader() {
  const savedTheme = localStorage.getItem("cg_theme") || "light";
  setTheme(savedTheme);

  document.getElementById("theme-btn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    setTheme(cur);
  });

  const caText = document.getElementById("ca-text");
  if (CONFIG.tokenCa) {
    caText.textContent = `$CGUARD: ${shortAddr(CONFIG.tokenCa)}`;
  }

  document.getElementById("copy-ca-btn").addEventListener("click", async (e) => {
    const txt = CONFIG.tokenCa || "npx -y github:CurveGuard-App/curveguard init";
    await navigator.clipboard.writeText(txt).catch(() => {});
    e.currentTarget.textContent = "Copied";
    setTimeout(() => (e.currentTarget.textContent = "Copy"), 1200);
  });

  document.getElementById("copy-cli-btn").addEventListener("click", async (e) => {
    const code = document.getElementById("hero-cli-code").textContent;
    await navigator.clipboard.writeText(code).catch(() => {});
    e.currentTarget.textContent = "Copied";
    setTimeout(() => (e.currentTarget.textContent = "Copy"), 1200);
  });

  document.getElementById("global-scan-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const val = document.getElementById("global-ca-input").value.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(val)) {
      state.selectedToken = val.toLowerCase();
      window.location.hash = `#/xray?token=${state.selectedToken}`;
    }
  });

  document.getElementById("hero-replay-btn").addEventListener("click", () => {
    const val = document.getElementById("global-ca-input").value.trim();
    const target = /^0x[0-9a-fA-F]{40}$/.test(val) ? val.toLowerCase() : CONFIG.defaultReplayToken;
    state.selectedToken = target;
    window.location.hash = `#/replay?token=${target}`;
  });

  document.querySelectorAll(".preset-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const addr = btn.getAttribute("data-preset");
      document.getElementById("global-ca-input").value = addr;
      state.selectedToken = addr;
      if (addr === CONFIG.defaultReplayToken) {
        window.location.hash = `#/replay?token=${addr}`;
      } else {
        window.location.hash = `#/xray?token=${addr}`;
      }
    });
  });
}

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [routePart, queryPart] = raw.split("?");
  const route = ["radar", "xray", "replay", "verify", "cli"].includes(routePart)
    ? routePart
    : "radar";
  const params = new URLSearchParams(queryPart || "");
  if (params.get("token") && /^0x[0-9a-fA-F]{40}$/.test(params.get("token"))) {
    state.selectedToken = params.get("token").toLowerCase();
    document.getElementById("global-ca-input").value = state.selectedToken;
  }
  state.route = route;
  document.querySelectorAll(".nav-tab").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-route") === route);
  });
}

/* ==================== VIEW 1: LIVE RADAR ==================== */
async function renderRadar(root) {
  root.innerHTML = `<div class="panel"><p class="mono">Scanning live Robinhood Chain (4663) bonding curves…</p></div>`;

  const walletParam = state.savedWallet ? `&wallet=${encodeURIComponent(state.savedWallet)}` : "";
  const api = await apiGet(`/v1/radar?limit=20${walletParam}`);

  let items = api?.items || [];
  state.radarTier = api?.tier || null;

  // Fallback if opened as raw static file without Worker: scan benchmark curves directly in browser via RPC!
  if (items.length === 0) {
    const addrs = [
      "0xcd5c01ea857df6253323a1bde87cd1d3a442a8f7",
      "0x872d5f4b6c765a9d6551f2cc1cdce33bab1705d5",
      "0xda4283f14b487034b90d865aac489994f2c680c4",
    ];
    const scans = await Promise.allSettled(
      addrs.map((a) => scanPonsTokenLive(a, { maxBlockSpan: 25_000, checkTopSniperBalances: 4 }))
    );
    items = scans
      .filter((s) => s.status === "fulfilled")
      .map((s) => {
        const v = s.value;
        const m = v.forensics.metrics;
        return {
          token: v.token.address,
          symbol: v.token.symbol,
          name: v.token.name,
          curve: v.token.curve,
          ageSec: v.token.createdAt ? Math.round((Date.now() - Date.parse(v.token.createdAt)) / 1000) : 3600,
          verdict: v.forensics.verdict,
          cleanScore: v.forensics.cleanScore,
          realReserveEth: m.realReserveEth,
          progressPct: m.progressPct,
          mcapUsd: m.mcapUsd,
          creatorTaxBps: m.creatorTaxBps,
          sniperInitialPct: m.sniperInitialPct,
          sniperOverhangPct: m.sniperOverhangPct,
          sellWallMcapUsd: m.sellWallMcapUsd,
          safeExitMcapUsd: m.safeExitMcapUsd,
          organicHumanBuyers: m.organicHumanBuyers,
          swarmClusterCount: m.swarmClusterCount,
        };
      });
  }

  state.radarItems = items;
  const cleanCount = items.filter((i) => i.verdict === "CLEAN_CLIMB").length;
  const wallCount = items.filter((i) => i.sniperOverhangPct >= 5).length;
  const avgOverhang = items.length
    ? (items.reduce((s, i) => s + (i.sniperOverhangPct || 0), 0) / items.length).toFixed(1)
    : "0.0";

  root.innerHTML = `
    <div class="stat-strip">
      <div class="stat-box">
        <div class="stat-label">Audited Curves</div>
        <div class="stat-val">${items.length}</div>
        <div class="stat-note">Live on Robinhood Chain (4663)</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Clean Climbs</div>
        <div class="stat-val">${cleanCount}</div>
        <div class="stat-note">&lt;2.5% sniper overhang &amp; &le;2% tax</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Active Sniper Walls</div>
        <div class="stat-val">${wallCount}</div>
        <div class="stat-note">Avg overhang: ${avgOverhang}% of supply</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Wallet Signatures Needed</div>
        <div class="stat-val">0</div>
        <div class="stat-note">100% read-only RPC &amp; ERC-20 checks</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Live Pons Bonding-Curve Forensics</h2>
          <div style="font-size:12.5px;color:var(--ink-muted);">
            Sniper Overhang % cross-checks first-1.5s buyers against live ERC-20 <code>balanceOf</code> so router sells never hide remaining bags.
          </div>
        </div>
        <button class="btn btn-sm" id="refresh-radar-btn" type="button">Refresh Live RPC</button>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Verdict</th>
              <th>Score</th>
              <th>Curve / 4.20 ETH</th>
              <th>MCAP</th>
              <th>Tax</th>
              <th>1.5s Snipers (Init &rarr; Held)</th>
              <th>Sniper Wall</th>
              <th>Safe Exit</th>
              <th>Humans</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${items
              .map((it) => {
                const taxPct = ((it.creatorTaxBps || 0) / 100).toFixed(2) + "%";
                const taxWarn = (it.creatorTaxBps || 0) >= 300;
                return `
                  <tr>
                    <td>
                      <strong>$${esc(it.symbol)}</strong>
                      <div class="mono" style="font-size:11px;color:var(--ink-muted);">${esc(shortAddr(it.token))} · ${fmtAge(it.ageSec)}</div>
                    </td>
                    <td>${verdictBadge(it.verdict)}</td>
                    <td class="mono"><strong>${it.cleanScore}</strong>/100</td>
                    <td class="mono">${Number(it.realReserveEth).toFixed(3)} ETH (${Number(it.progressPct).toFixed(0)}%)</td>
                    <td class="mono">${fmtUsd(it.mcapUsd)}</td>
                    <td class="mono" style="${taxWarn ? "color:var(--danger);font-weight:700;" : ""}">${taxPct}</td>
                    <td class="mono">${it.sniperInitialPct}% &rarr; <strong>${it.sniperOverhangPct}%</strong></td>
                    <td class="mono">${it.sellWallMcapUsd ? fmtUsd(it.sellWallMcapUsd) : "None"}</td>
                    <td class="mono">${it.safeExitMcapUsd ? fmtUsd(it.safeExitMcapUsd) : "—"}</td>
                    <td class="mono">${it.organicHumanBuyers}</td>
                    <td>
                      ${
                        it.gatedFresh
                          ? `<a class="btn btn-sm" href="#/cli">Unlock &lt;10m</a>`
                          : `<a class="btn btn-sm" href="#/xray?token=${esc(it.token)}">X-Ray</a>
                             <a class="btn btn-sm" href="#/replay?token=${esc(it.token)}">Replay</a>`
                      }
                    </td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById("refresh-radar-btn")?.addEventListener("click", () => renderRadar(root));
}

/* ==================== VIEW 2: TOKEN X-RAY ==================== */
async function renderXray(root) {
  const token = state.selectedToken || CONFIG.defaultToken;
  root.innerHTML = `<div class="panel"><p class="mono">Running live RPC log &amp; sniper balanceOf X-ray on ${esc(token)}…</p></div>`;

  let item = (await apiGet(`/v1/scan/${token}`))?.item || null;
  if (!item) {
    try {
      const scan = await scanPonsTokenLive(token, { maxBlockSpan: 45_000, checkTopSniperBalances: 8 });
      const m = scan.forensics.metrics;
      item = {
        token: scan.token.address,
        name: scan.token.name,
        symbol: scan.token.symbol,
        curve: scan.token.curve,
        deployer: scan.token.deployer,
        creatorTaxBps: scan.token.creatorTaxBps,
        verdict: scan.forensics.verdict,
        cleanScore: scan.forensics.cleanScore,
        flags: scan.forensics.flags,
        ...m,
        snipers: scan.forensics.snipers,
        swarmClusters: scan.forensics.swarmClusters,
      };
    } catch (err) {
      root.innerHTML = `<div class="panel"><p style="color:var(--danger);">Scan error: ${esc(err.message)}</p></div>`;
      return;
    }
  }

  state.currentScan = item;
  const curPct = Math.min(100, (item.realReserveEth / 4.2) * 100);
  const wallPct = item.sellWallReserveEth > 0 ? Math.min(99, (item.sellWallReserveEth / 4.2) * 100) : 0;
  const safePct = item.safeExitReserveEth > 0 ? Math.min(98, (item.safeExitReserveEth / 4.2) * 100) : 0;

  const directBuy01 = quoteCurveBuy({
    realReserveEth: item.realReserveEth,
    grossEthIn: 0.1,
    creatorTaxBps: item.creatorTaxBps,
    routerFeeBps: 0,
  });
  const botBuy01 = quoteCurveBuy({
    realReserveEth: item.realReserveEth,
    grossEthIn: 0.1,
    creatorTaxBps: item.creatorTaxBps,
    routerFeeBps: 100,
  });

  const guardCmd = `npx -y github:CurveGuard-App/curveguard guard ${item.token} --sl 18 --trail 14${item.sellWallReserveEth > 0 ? " --exit-before-wall" : ""}`;

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">${esc(item.name)} ($${esc(item.symbol)}) ${verdictBadge(item.verdict)}</h2>
          <div class="mono" style="font-size:12px;color:var(--ink-muted);margin-top:3px;">
            Token: <a href="https://ponsfamily.com/launchpad/${esc(item.token)}" target="_blank" rel="noopener">${esc(item.token)}</a> ·
            Curve: <a href="https://robinhoodchain.blockscout.com/address/${esc(item.curve)}" target="_blank" rel="noopener">${esc(shortAddr(item.curve))}</a>
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <a class="btn btn-primary btn-sm" href="#/replay?token=${esc(item.token)}">Replay Wall Strategy</a>
          <a class="btn btn-sm" href="https://ponsfamily.com/launchpad/${esc(item.token)}" target="_blank" rel="noopener">Open on Pons &nearr;</a>
        </div>
      </div>

      <div class="stat-strip">
        <div class="stat-box">
          <div class="stat-label">Clean Score</div>
          <div class="stat-val">${item.cleanScore}/100</div>
          <div class="stat-note">Creator tax: ${(item.creatorTaxBps / 100).toFixed(2)}%</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Curve Reserve</div>
          <div class="stat-val">${Number(item.realReserveEth).toFixed(3)} ETH</div>
          <div class="stat-note">${curPct.toFixed(1)}% of 4.20 ETH (${fmtUsd(item.mcapUsd)})</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">1.5s Sniper Overhang</div>
          <div class="stat-val">${item.sniperOverhangPct}%</div>
          <div class="stat-note">Initial grab at launch: ${item.sniperInitialPct}%</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Sniper Dump Wall</div>
          <div class="stat-val">${item.sellWallMcapUsd ? fmtUsd(item.sellWallMcapUsd) : "Clear"}</div>
          <div class="stat-note">${item.safeExitMcapUsd ? `Safe exit: ${fmtUsd(item.safeExitMcapUsd)}` : "No early sniper wall"}</div>
        </div>
      </div>

      <div>
        <div class="mono" style="font-size:12px;display:flex;justify-content:space-between;">
          <span>0.00 ETH ($3.6K floor)</span>
          <span>Current: ${Number(item.realReserveEth).toFixed(3)} ETH</span>
          <span>4.20 ETH Graduation (~$32K)</span>
        </div>
        <div class="gauge-track">
          <div class="gauge-fill" style="width:${curPct.toFixed(1)}%;"></div>
          ${safePct > 0 ? `<div class="gauge-marker safe" style="left:${safePct.toFixed(1)}%;" title="Safe Front-Run Exit (${fmtUsd(item.safeExitMcapUsd)})"></div>` : ""}
          ${wallPct > 0 ? `<div class="gauge-marker wall" style="left:${wallPct.toFixed(1)}%;" title="Sniper Sell-Wall (${fmtUsd(item.sellWallMcapUsd)})"></div>` : ""}
        </div>
        ${
          item.flags?.length
            ? `<ul style="margin:10px 0 0;padding-left:18px;font-size:13px;color:var(--warn);">
                 ${item.flags.map((f) => `<li class="mono">${esc(f)}</li>`).join("")}
               </ul>`
            : `<div class="mono" style="font-size:12px;color:var(--accent);margin-top:6px;">No high-tax, sniper-wall, or curve-extraction flags triggered.</div>`
        }
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3 class="panel-title" style="margin-bottom:8px;">Block +1..+15 Early Snipers (Live ERC-20 Verified)</h3>
        ${
          item.snipers?.length
            ? `<div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>Wallet</th><th>Block</th><th>ETH In</th><th>Bought</th><th>Still Held</th></tr>
                  </thead>
                  <tbody>
                    ${item.snipers
                      .map(
                        (s) => `
                        <tr>
                          <td class="mono"><a href="https://robinhoodchain.blockscout.com/address/${esc(s.address)}" target="_blank" rel="noopener">${esc(shortAddr(s.address))}</a></td>
                          <td class="mono">+${s.dtBlocks}</td>
                          <td class="mono">${s.ethSpent} ETH</td>
                          <td class="mono">${(s.tokensBought / 1e6).toFixed(2)}M</td>
                          <td class="mono"><strong>${s.supplyPct}%</strong> (${s.stillHoldingPct}%)</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>`
            : `<p style="color:var(--ink-muted);font-size:13.5px;">Zero block +1..+15 external snipers (>=0.008 ETH) detected on this launch.</p>`
        }
      </div>

      <div class="panel">
        <h3 class="panel-title" style="margin-bottom:8px;">Direct Curve Execution &amp; Local Guard</h3>
        <div style="font-size:13px;color:var(--ink-muted);margin-bottom:10px;">
          Buying <strong>0.10 ETH</strong> directly on PonsCurve yields <strong class="mono">${Math.round(directBuy01.tokensOut).toLocaleString()} $${esc(item.symbol)}</strong> vs <span class="mono">${Math.round(botBuy01.tokensOut).toLocaleString()}</span> via 1% bot routers (<strong style="color:var(--accent);">+${Math.round(directBuy01.tokensOut - botBuy01.tokensOut).toLocaleString()} extra tokens</strong>).
        </div>
        <div class="cli-card">
          <div class="cli-card-head">
            <span>ZERO-CUSTODY LOCAL GUARD COMMAND</span>
            <button type="button" class="btn btn-sm" id="copy-xray-cmd" style="padding:2px 7px;font-size:11px;">Copy</button>
          </div>
          <code class="cli-cmd" id="xray-cmd-code">${esc(guardCmd)}</code>
        </div>
        <h4 style="margin:14px 0 6px;font-size:13.5px;">Same-Block (100ms) Swarm Clusters (${item.swarmClusters?.length || 0})</h4>
        ${
          item.swarmClusters?.length
            ? `<div class="table-wrap">
                <table>
                  <thead><tr><th>Block</th><th>Offset</th><th>Wallets</th><th>Combined ETH</th></tr></thead>
                  <tbody>
                    ${item.swarmClusters
                      .map(
                        (c) => `<tr>
                          <td class="mono">#${c.blockNumber}</td>
                          <td class="mono">+${c.dtBlocks}</td>
                          <td class="mono">${c.walletCount} EOAs</td>
                          <td class="mono">${c.totalEth} ETH</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>`
            : `<p style="color:var(--ink-muted);font-size:13px;margin:0;">No multi-wallet same-block swarms detected.</p>`
        }
      </div>
    </div>
  `;

  document.getElementById("copy-xray-cmd")?.addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(guardCmd).catch(() => {});
    e.currentTarget.textContent = "Copied";
    setTimeout(() => (e.currentTarget.textContent = "Copy"), 1200);
  });
}

/* ==================== VIEW 3: WALL REPLAY STUDIO ==================== */
function renderReplaySvg(series, exitStep) {
  if (!series || series.length < 2) return "";
  const w = 820;
  const h = 220;
  const padX = 40;
  const padY = 22;
  const vals = series.flatMap((p) => [p.holdValueEth, p.guardedValueEth]);
  const minV = Math.min(...vals) * 0.95;
  const maxV = Math.max(...vals, 0.001) * 1.05;
  const spanV = Math.max(0.0001, maxV - minV);

  const xOf = (idx) => padX + (idx / (series.length - 1)) * (w - padX * 2);
  const yOf = (v) => h - padY - ((v - minV) / spanV) * (h - padY * 2);

  const holdPts = series.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.holdValueEth).toFixed(1)}`).join(" ");
  const guardPts = series.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.guardedValueEth).toFixed(1)}`).join(" ");

  const exitIdx = series.findIndex((p) => p.step === exitStep);
  const marker =
    exitIdx > 0
      ? `<circle cx="${xOf(exitIdx).toFixed(1)}" cy="${yOf(series[exitIdx].guardedValueEth).toFixed(1)}" r="5" fill="#0c5c4c" stroke="#fff" stroke-width="2" />`
      : "";

  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;border:1px solid var(--line);border-radius:4px;background:var(--surface-alt);">
      <polyline fill="none" stroke="#a62626" stroke-width="2" stroke-dasharray="4 3" points="${holdPts}" />
      <polyline fill="none" stroke="#0c5c4c" stroke-width="2.6" points="${guardPts}" />
      ${marker}
      <text x="${padX}" y="15" font-size="11" fill="currentColor" font-family="monospace">Solid Green: CurveGuard Position (ETH) · Dashed Red: Unguarded Hold (ETH)</text>
    </svg>
  `;
}

async function renderReplay(root) {
  const token = state.selectedToken || CONFIG.defaultReplayToken;
  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Wall Replay Studio — Test Guard Rules on Real Blocks</h2>
          <div style="font-size:12.5px;color:var(--ink-muted);">
            Zero lookahead: sniper overhang and safe exit setpoint are computed strictly from blocks before your entry.
          </div>
        </div>
      </div>

      <form id="replay-form" class="form-row">
        <div class="field" style="grid-column: span 2;">
          <label>Token Address (Robinhood Chain)</label>
          <input type="text" id="rep-token" value="${esc(token)}" />
        </div>
        <div class="field">
          <label>Entry Delay (sec)</label>
          <input type="number" id="rep-entry-sec" value="12" min="1" max="3600" />
        </div>
        <div class="field">
          <label>Order Size (ETH)</label>
          <input type="number" id="rep-eth" value="0.10" step="0.01" min="0.01" />
        </div>
        <div class="field">
          <label>Hard Stop-Loss (%)</label>
          <input type="number" id="rep-sl" value="25" min="5" max="80" />
        </div>
        <div class="field">
          <label>Trailing Stop (%)</label>
          <input type="number" id="rep-trail" value="14" min="5" max="60" />
        </div>
        <div class="field">
          <label>Front-Run Sniper Wall</label>
          <select id="rep-wall">
            <option value="1" selected>Enabled (Exit 7% below wall)</option>
            <option value="0">Disabled</option>
          </select>
        </div>
        <div class="field" style="display:flex;align-items:end;">
          <button type="submit" class="btn btn-primary" style="width:100%;">Run Replay</button>
        </div>
      </form>

      <div id="replay-output" class="mono" style="font-size:13px;">Loading historical curve blocks…</div>
    </div>
  `;

  const runSim = async () => {
    const outEl = document.getElementById("replay-output");
    const addr = document.getElementById("rep-token").value.trim().toLowerCase();
    const entrySec = Number(document.getElementById("rep-entry-sec").value || 12);
    const ethIn = Number(document.getElementById("rep-eth").value || 0.1);
    const sl = Number(document.getElementById("rep-sl").value || 25);
    const trail = Number(document.getElementById("rep-trail").value || 14);
    const wallExit = document.getElementById("rep-wall").value === "1";

    outEl.innerHTML = `Replaying real Robinhood Chain curve logs on ${esc(addr)}…`;
    let payload = await apiGet(
      `/v1/replay?token=${encodeURIComponent(addr)}&entrySec=${entrySec}&ethIn=${ethIn}&sl=${sl}&trail=${trail}&wallExit=${wallExit ? "1" : "0"}`
    );

    if (!payload?.replay) {
      try {
        const scan = await scanPonsTokenLive(addr, { maxBlockSpan: 50_000, checkTopSniperBalances: 5 });
        const rep = replayGuardStrategy({
          trades: scan.trades,
          deployer: scan.token.deployer,
          creatorTaxBps: scan.token.creatorTaxBps,
          entryAfterSec: entrySec,
          ethIn,
          stopLossPct: sl,
          trailingStopPct: trail,
          exitBeforeWall: wallExit,
        });
        payload = { token: scan.token, replay: rep };
      } catch (err) {
        outEl.innerHTML = `<span style="color:var(--danger);">Replay error: ${esc(err.message)}</span>`;
        return;
      }
    }

    const r = payload.replay;
    if (!r.ok) {
      outEl.innerHTML = `<span style="color:var(--danger);">${esc(r.reason)}</span>`;
      return;
    }

    const edgePositive = r.edgeVsHoldPct >= 0;
    outEl.innerHTML = `
      <div class="stat-strip" style="margin-top:8px;">
        <div class="stat-box">
          <div class="stat-label">Entry @ T+${r.entry.dtSec}s</div>
          <div class="stat-val">${fmtUsd(r.entry.entryMcapUsd)}</div>
          <div class="stat-note">Snipers seen: ${r.entry.detectedSniperOverhangPct}% (Wall: ${r.entry.detectedSellWallMcapUsd ? fmtUsd(r.entry.detectedSellWallMcapUsd) : "None"})</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">CurveGuard Outcome</div>
          <div class="stat-val" style="color:${r.guardedExit.pnlPct >= 0 ? "var(--accent)" : "var(--danger)"};">
            ${r.guardedExit.pnlPct >= 0 ? "+" : ""}${r.guardedExit.pnlPct}%
          </div>
          <div class="stat-note">${esc(r.guardedExit.reason)} (${r.guardedExit.netEthOut} ETH)</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Unguarded Hold</div>
          <div class="stat-val" style="color:${r.holdOutcome.pnlPct >= 0 ? "var(--accent)" : "var(--danger)"};">
            ${r.holdOutcome.pnlPct >= 0 ? "+" : ""}${r.holdOutcome.pnlPct}%
          </div>
          <div class="stat-note">End value: ${r.holdOutcome.netEthOut} ETH</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">CurveGuard Edge</div>
          <div class="stat-val" style="color:${edgePositive ? "var(--accent)" : "var(--warn)"};">
            ${edgePositive ? "+" : ""}${r.edgeVsHoldPct}%
          </div>
          <div class="stat-note">${edgePositive ? "+" : ""}${r.edgeVsHoldEth} ETH (+${r.routerFeeSavedEth} ETH router tax saved)</div>
        </div>
      </div>
      ${renderReplaySvg(r.series, r.guardedExit.step)}
    `;
  };

  document.getElementById("replay-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runSim();
  });

  await runSim();
}

/* ==================== VIEW 4: VERIFY MERKLE SEALS ==================== */
async function renderVerify(root) {
  root.innerHTML = `<div class="panel"><p class="mono">Loading sealed audit epochs &amp; Merkle proofs…</p></div>`;

  const sealsRes = await apiGet("/v1/seals");
  const proofRes = await apiGet("/v1/seals/proof");

  if (!proofRes?.ok) {
    root.innerHTML = `<div class="panel"><p class="mono">Seal proof service requires Worker runtime (<code>/v1/seals/proof</code>). Run locally or inspect <code>npx curveguard verify</code>.</p></div>`;
    return;
  }

  state.seals = sealsRes?.epochs || [];
  state.currentProof = proofRes;

  const regAddr = proofRes.registryAddress || CONFIG.sealRegistry;

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Verify an Hourly CurveGuard Audit Seal Yourself</h2>
          <div style="font-size:12.5px;color:var(--ink-muted);">
            Your browser recomputes <code>keccak256("curveguard:audit:v1:" + canonicalJson)</code>, walks the sorted-pair Merkle proof, and compares against the sealed root${regAddr ? ` in <code>AuditSealRegistry</code> (${esc(shortAddr(regAddr))})` : ""}. Edit any number below to test tamper detection.
          </div>
        </div>
      </div>

      <div class="grid-2">
        <div>
          <label class="mono" style="font-size:12px;color:var(--ink-muted);display:block;margin-bottom:6px;">
            Audited Record JSON (Edit any value and press Re-Verify)
          </label>
          <textarea id="verify-json-box" class="json-box">${esc(JSON.stringify(proofRes.record, null, 2))}</textarea>
          <div style="margin-top:10px;display:flex;gap:8px;">
            <button type="button" class="btn btn-primary" id="run-verify-btn">Re-Verify Proof in Browser</button>
            <button type="button" class="btn" id="tamper-demo-btn">Simulate Tamper (+10 Score)</button>
          </div>
        </div>

        <div id="verify-result-box" class="panel" style="margin-top:0;background:var(--surface-alt);"></div>
      </div>
    </div>
  `;

  const runCheck = async () => {
    const out = document.getElementById("verify-result-box");
    let parsed;
    try {
      parsed = JSON.parse(document.getElementById("verify-json-box").value);
    } catch (e) {
      out.innerHTML = `<div class="badge badge-danger">INVALID JSON</div><p class="mono">${esc(e.message)}</p>`;
      return;
    }

    const local = verifyMerkleProof({
      record: parsed,
      proof: proofRes.proof,
      expectedRoot: proofRes.merkleRoot,
    });

    let onchainNote = `<span style="color:var(--ink-muted);">Awaiting AuditSealRegistry deployment binding</span>`;
    if (regAddr && /^0x[0-9a-fA-F]{40}$/.test(regAddr)) {
      try {
        const oc = await verifyAuditOnchain({
          registryAddress: regAddr,
          epochHour: proofRes.epochHour,
          record: parsed,
          proof: proofRes.proof,
          rpcUrl: CONFIG.rpcUrl,
        });
        onchainNote = oc.valid
          ? `<span style="color:var(--accent);font-weight:700;">MATCHED ONCHAIN AuditSealRegistry (${esc(shortAddr(regAddr))})</span>`
          : `<span style="color:var(--warn);">${esc(oc.reason || "Root mismatch vs chain")}</span>`;
      } catch (err) {
        onchainNote = `<span style="color:var(--warn);">RPC check: ${esc(err.message)}</span>`;
      }
    }

    out.innerHTML = `
      <div style="margin-bottom:10px;">
        ${
          local.valid
            ? `<span class="badge badge-clean" style="font-size:13px;">VALID MERKLE PROOF · EXACT ROOT MATCH</span>`
            : `<span class="badge badge-danger" style="font-size:13px;">TAMPER DETECTED · ROOT MISMATCH</span>`
        }
      </div>
      <div class="mono" style="font-size:12px;line-height:1.7;word-break:break-all;">
        <div><strong>Epoch Hour:</strong> ${proofRes.epochHour} (${new Date(proofRes.epochHour * 1000).toISOString()})</div>
        <div><strong>Computed Leaf:</strong> ${local.computedLeaf}</div>
        <div><strong>Proof Siblings:</strong> ${proofRes.proof.length} level(s)</div>
        <div><strong>Computed Root:</strong> ${local.computedRoot}</div>
        <div><strong>Expected Root:</strong> ${local.expectedRoot}</div>
        <div><strong>Onchain Check:</strong> ${onchainNote}</div>
      </div>
    `;
  };

  document.getElementById("run-verify-btn").addEventListener("click", runCheck);
  document.getElementById("tamper-demo-btn").addEventListener("click", () => {
    try {
      const obj = JSON.parse(document.getElementById("verify-json-box").value);
      obj.cleanScore = (Number(obj.cleanScore) || 50) + 10;
      document.getElementById("verify-json-box").value = JSON.stringify(obj, null, 2);
      runCheck();
    } catch {}
  });

  await runCheck();
}

/* ==================== VIEW 5: CLI / MCP & HONESTY ==================== */
async function renderCliAndHonesty(root) {
  root.innerHTML = `
    <div class="grid-2">
      <div class="panel">
        <h2 class="panel-title" style="margin-bottom:8px;">Install CLI &amp; MCP in One Command</h2>
        <p style="color:var(--ink-muted);font-size:13.5px;margin-top:0;">
          Requires Node 20+. Zero external dependencies, zero account, zero telemetry. Configures Cursor, Claude Code, Codex, and Claude Desktop idempotently with <code>.curveguard-bak</code> backups.
        </p>
        <div class="cli-card" style="margin-bottom:12px;">
          <code class="cli-cmd"># Auto-detect and wire your coding agents
npx -y github:CurveGuard-App/curveguard init

# Preview changes without touching disk
npx -y github:CurveGuard-App/curveguard init --dry-run

# Health check
npx -y github:CurveGuard-App/curveguard doctor</code>
        </div>
        <h3 style="font-size:14px;margin:14px 0 6px;">8 Exposed MCP Tools (stdio &amp; HTTP <code>/mcp</code>)</h3>
        <div class="mono" style="font-size:12px;color:var(--ink-muted);line-height:1.65;">
          scan_token · live_radar · quote_curve · sniper_wall · replay_guard · verify_seal · check_holder_tier · guard_command
        </div>
      </div>

      <div class="panel">
        <h2 class="panel-title" style="margin-bottom:8px;">Read-Only Holder Check (&lt;10m Fresh Clean Wire)</h2>
        <p style="color:var(--ink-muted);font-size:13.5px;margin-top:0;">
          Never click "Connect Wallet" or sign <code>approve()</code> on a new token site. Paste any address below — CurveGuard reads <code>balanceOf</code> directly via public RPC. Hold <strong>1,000,000 $CGUARD</strong> (or burn <strong>250,000</strong> to <code>0x…dEaD</code>) to unlock &lt;10m Fresh Clean-Launch discovery.
        </p>
        <form id="tier-check-form" class="scan-bar">
          <input type="text" class="input" id="tier-wallet-input" placeholder="Paste 0x… wallet (read-only, no signature)" value="${esc(state.savedWallet)}" />
          <button type="submit" class="btn btn-primary">Check Balance</button>
        </form>
        <div id="tier-check-result" class="mono" style="font-size:12.5px;margin-top:8px;"></div>
      </div>
    </div>

    <div class="panel">
      <h2 class="panel-title" style="margin-bottom:10px;">Engineering Claims &amp; Status (No Hype)</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Capability</th><th>Status</th><th>How to Verify</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Deterministic Pons v2 constant-product curve &amp; sniper sell-wall solver (<code>@curveguard/core</code>)</td>
              <td><span class="badge badge-clean">LIVE</span></td>
              <td class="mono">npm test / packages/core/src/curve.js</td>
            </tr>
            <tr>
              <td>Live block +1..+15 sniper unmasker cross-checked with ERC-20 <code>balanceOf</code></td>
              <td><span class="badge badge-clean">LIVE</span></td>
              <td class="mono">npx curveguard scan 0xcd5c…a8f7</td>
            </tr>
            <tr>
              <td>Zero-lookahead Wall Replay Studio in browser &amp; CLI</td>
              <td><span class="badge badge-clean">LIVE</span></td>
              <td class="mono">/#/replay or npx curveguard replay</td>
            </tr>
            <tr>
              <td>Sorted-pair Keccak-256 Merkle proofs &amp; <code>AuditSealRegistry.sol</code> (zero custody, zero approvals)</td>
              <td><span class="badge badge-clean">LIVE</span></td>
              <td class="mono">/#/verify &amp; contracts/src/AuditSealRegistry.sol</td>
            </tr>
            <tr>
              <td>Local non-custodial curve watcher &amp; stdio MCP server (<code>npx curveguard init</code>)</td>
              <td><span class="badge badge-clean">LIVE</span></td>
              <td class="mono">npx curveguard doctor</td>
            </tr>
            <tr>
              <td>v0.2 Trailing-stop auto-Broadcast + v0.3 Post-Graduation Uniswap v4 TWAP + v0.4 Telegram Webhook Alerts</td>
              <td><span class="badge badge-warn">SCHEDULED (48H)</span></td>
              <td class="mono">Ships across v0.2–v0.4 post-launch releases</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById("tier-check-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const w = document.getElementById("tier-wallet-input").value.trim().toLowerCase();
    state.savedWallet = w;
    localStorage.setItem("cg_read_wallet", w);
    const out = document.getElementById("tier-check-result");
    out.textContent = "Reading Robinhood Chain balanceOf…";
    const res = await apiGet(`/v1/tier?wallet=${encodeURIComponent(w)}`);
    if (!res) {
      out.textContent = "Saved locally. Connect to live Worker API to check $CGUARD tier.";
      return;
    }
    out.textContent = `Tier ${res.tier} · Fresh <10m Wire: ${res.freshWireUnlocked ? "UNLOCKED" : "LOCKED"} (${res.note || `Balance: ${res.balance?.toLocaleString() || 0}`})`;
  });
}

async function renderApp() {
  parseHash();
  const root = document.getElementById("app-view");
  if (state.route === "xray") await renderXray(root);
  else if (state.route === "replay") await renderReplay(root);
  else if (state.route === "verify") await renderVerify(root);
  else if (state.route === "cli") await renderCliAndHonesty(root);
  else await renderRadar(root);
}

initHeader();
window.addEventListener("hashchange", renderApp);
renderApp();
