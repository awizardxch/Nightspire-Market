'use strict';
/* Nightspire Market — read-only venue board.
 *
 * READ-ONLY GUARANTEE: this file only ever issues HTTP GET requests
 * (see api()). It never POSTs, never touches a wallet, never signs.
 * To fill an offer, copy the terms and sign in your own wallet —
 * see the "How fills work" view (#/about).
 */

const DEFAULT_RELAY =
  (typeof window !== 'undefined' && window.NIGHTSPIRE_RELAY_URL) || '';
const app = document.getElementById('app');

let relayBase = DEFAULT_RELAY;
try {
  const q = new URLSearchParams(location.search).get('relay');
  relayBase = (q || DEFAULT_RELAY).replace(/\/+$/, '');
  // The relay switcher UI is gone: one deployment, one relay.
  // Drop any stale saved choice from when the box existed.
  localStorage.removeItem('nightspire.relay');
} catch (e) { /* storage unavailable — use default */ }

/* ---------- HTTP (GET only) ---------- */
async function api(path) {
  if (!relayBase) {
    throw new Error('relay URL is not configured in this build ' +
      '(NIGHTSPIRE_RELAY_URL was empty at build time)');
  }
  const r = await fetch(relayBase + path);
  if (!r.ok) {
    let body = {};
    try { body = await r.json(); } catch (e) { /* non-JSON error */ }
    const err = new Error(body.message || body.error || `HTTP ${r.status}`);
    err.code = body.code || null;
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/* ---------- formatting ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmtInt(s) {
  try { return BigInt(s).toLocaleString('en-US'); } catch (e) { return String(s); }
}

/* Human-readable token amounts: relay amounts are base-unit strings.
 * Native-asset decimals per chain (EVM 18, Solana 9, Chia 12). Unknown
 * chain/asset pairs fall back to raw fmtInt — never guess decimals. */
const NATIVE_DECIMALS = {
  'robinhood': 18, 'robinhood-testnet': 18,
  'base': 18, 'base-sepolia': 18,
  'ethereum': 18, 'ethereum-sepolia': 18,
  'solana': 9, 'solana-devnet': 9, 'solana-testnet': 9,
  'chia': 12, 'chia-testnet': 12,
};
function fmtAmount(s, asset, chain) {
  const dec = asset === 'native' ? NATIVE_DECIMALS[chain] : undefined;
  if (dec === undefined) return fmtInt(s);
  try {
    const v = BigInt(s);
    const base = 10n ** BigInt(dec);
    const ip = v / base;
    const fp = v % base;
    if (fp === 0n) return ip.toLocaleString('en-US');
    const frac = fp.toString().padStart(dec, '0').replace(/0+$/, '');
    return ip.toLocaleString('en-US') + '.' + frac;
  } catch (e) { return String(s); }
}
function shortHash(s, n = 12) {
  s = String(s);
  return s.length > n + 8 ? `${s.slice(0, n)}…${s.slice(-6)}` : s;
}
function fmtPrice(s) {
  // BaseUnits integer string, ask rate scaled by 1e6 -> decimal.
  try {
    const v = BigInt(s);
    const whole = v / 1000000n;
    const frac = (v % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
    return frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US');
  } catch (e) { return String(s); }
}
function fmtTs(sec) {
  if (sec == null) return '—';
  const d = new Date(Number(sec) * 1000);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
function fmtIso(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : d.toLocaleString();
}
function chainName(c) { return esc(c || '—'); }

/* ---------- badges ---------- */
const STATUS_CLASS = { open: 'b-open', filling: 'b-filling', filled: 'b-filled', expired: 'b-expired', cancelled: 'b-filled' };
function statusBadge(s) {
  return `<span class="badge ${STATUS_CLASS[s] || ''}">${esc(s || 'unknown')}</span>`;
}
function sigBadge(status) {
  const cls = status === 'VERIFIED' ? 'b-verified' : status === 'UNVERIFIED' ? 'b-unverified' : 'b-absent';
  return `<span class="badge ${cls}" title="offer signature status">${esc(status || 'absent')}</span>`;
}
function offerBadges(o) {
  const b = o.badges || {};
  let h = '';
  if (b.isMediated) h += `<span class="badge b-mediated" title="An arbiter can redirect escrowed funds before timelock expiry">⚖ mediated</span>`;
  if (b.hasFiatLeg) h += `<span class="badge b-fiat" title="Fiat legs never settle atomically">fiat leg</span>`;
  if (o.takerCredential) h += `<span class="badge b-kyc" title="Taker credential required">KYC-gated</span>`;
  if (o.takerAddr) h += `<span class="badge b-directed" title="Directed at a specific taker">directed</span>`;
  return h;
}
const PHASE_CLASS = { committed: 'b-phase', makerLocked: 'b-filling', takerLocked: 'b-filling', claimed: 'b-verified', refunded: 'b-expired' };
function phaseBadge(p) {
  return `<span class="badge ${PHASE_CLASS[p] || ''}">${esc(p)}</span>`;
}

/* ---------- relay connection ---------- */
async function checkRelay() {
  const pill = document.getElementById('relayStatus');
  try {
    const h = await api('/v1/health');
    pill.textContent = `connected · ${h.offers || 0} offers`;
    pill.className = 'status-pill ok';
  } catch (e) {
    pill.textContent = 'unreachable';
    pill.className = 'status-pill bad';
  }
}

/* ---------- router ---------- */
const routes = [
  [/^#\/$/, renderBoard],
  [/^#\/offer\/([^/]+)$/, renderOfferDetail],
  [/^#\/auction\/([^/]+)$/, renderAuction],
  [/^#\/about$/, renderAbout],
];
function currentRoute() {
  const h = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) return { fn, params: m.slice(1) };
  }
  return { fn: renderBoard, params: [] };
}
async function render() {
  const { fn, params } = currentRoute();
  app.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    await fn(...params);
  } catch (e) {
    app.innerHTML = `<div class="glow-card"><h2 class="error">Couldn't reach the relay</h2>
      <p>${esc(e.message)}</p>
      <p class="muted">This board is built with its relay address baked in. If the relay
      was just deployed or redeployed, wait a moment and refresh.</p></div>`;
  }
  const extra = document.getElementById('crumbExtra');
  extra.innerHTML = '';
}
window.addEventListener('hashchange', render);

/* ---------- board ---------- */
const boardState = { page: 1, limit: 12, giveChain: '', wantChain: '', fillMode: '', mediated: '', fiatOnly: false, q: '' };

function filterForm() {
  const s = boardState;
  // simpler: build want-chain options with its own selected value
  const mkOpts = (sel) => ['', 'robinhood', 'base', 'ethereum', 'solana', 'chia',
    'robinhood-testnet', 'base-sepolia', 'ethereum-sepolia', 'solana-devnet', 'chia-testnet11']
    .map((c) => `<option value="${c}"${sel === c ? ' selected' : ''}>${c || 'any'}</option>`).join('');
  const modeOpts = ['', 'direct', 'solver', 'any']
    .map((m) => `<option value="${m}"${s.fillMode === m ? ' selected' : ''}>${m || 'any'}</option>`).join('');
  return `<div class="glow-card"><div class="filters">
    <label>Give chain<select id="fGive">${mkOpts(s.giveChain)}</select></label>
    <label>Want chain<select id="fWant">${mkOpts(s.wantChain)}</select></label>
    <label>Fill mode<select id="fMode">${modeOpts}</select></label>
    <label>Mediated<select id="fMed">
      <option value=""${s.mediated === '' ? ' selected' : ''}>any</option>
      <option value="true"${s.mediated === 'true' ? ' selected' : ''}>yes</option>
      <option value="false"${s.mediated === 'false' ? ' selected' : ''}>no</option>
    </select></label>
    <label style="flex-direction:row;align-items:center;gap:6px">Fiat only
      <input type="checkbox" id="fFiat"${s.fiatOnly ? ' checked' : ''}></label>
    <label>Offer id<input id="fQ" type="text" placeholder="uuid…" value="${esc(s.q)}" style="width:200px"></label>
    <button class="glow-btn" id="fApply">Apply</button>
  </div></div>`;
}

function offerCard(o) {
  const a = o.advisory || {};
  const give = BigInt(o.giveAmount || '0');
  const filled = BigInt(a.filledAmount || '0');
  const pct = give > 0n ? Number((filled * 100n) / give) : 0;
  return `<div class="glow-card offer-card" data-offer="${esc(o.offerId)}">
    <h3><span class="mono">${esc(shortHash(o.offerId, 8))}</span></h3>
    <div class="pair">${fmtAmount(o.giveAmount, o.giveAsset, o.giveChain)} ${esc(o.giveAsset)} <span class="muted">@ ${chainName(o.giveChain)}</span>
      <span class="arrow">→</span> ${fmtAmount(o.wantAmount, o.wantAsset, o.wantChain)} ${esc(o.wantAsset)} <span class="muted">@ ${chainName(o.wantChain)}</span></div>
    <div>${statusBadge(a.status)}${offerBadges(o)}</div>
    <div class="progress"><div style="width:${Math.min(100, pct)}%"></div></div>
    <div class="muted">filled ${fmtAmount(a.filledAmount || '0', o.giveAsset, o.giveChain)} · remaining ${fmtAmount(a.remainingAmount || '0', o.giveAsset, o.giveChain)}
      · min fill ${fmtAmount(o.minFillAmount, o.giveAsset, o.giveChain)}</div>
  </div>`;
}

async function renderBoard() {
  const s = boardState;
  const params = new URLSearchParams({ page: s.page, limit: s.limit });
  if (s.giveChain) params.set('giveChain', s.giveChain);
  if (s.wantChain) params.set('wantChain', s.wantChain);
  if (s.fillMode) params.set('fillMode', s.fillMode);
  if (s.mediated) params.set('mediated', s.mediated);
  if (s.fiatOnly) params.set('fiatOnly', 'true');
  const list = await api('/v1/offers?' + params.toString());
  let offers = list.offers || [];
  if (s.q) offers = offers.filter((o) => o.offerId.toLowerCase().includes(s.q.toLowerCase()));

  const totalPages = Math.max(1, Math.ceil((list.total || 0) / (list.limit || s.limit)));
  app.innerHTML = `<h2>Offer board <span class="muted">(${list.total || 0} offers)</span></h2>
    ${filterForm()}
    <div class="offer-grid">${offers.map(offerCard).join('') || '<p class="muted">No offers match.</p>'}</div>
    <div class="pager">
      <button class="glow-btn" id="pgPrev"${s.page <= 1 ? ' disabled' : ''}>← Prev</button>
      <span class="muted">page ${list.page} of ${totalPages}</span>
      <button class="glow-btn" id="pgNext"${s.page >= totalPages ? ' disabled' : ''}>Next →</button>
      <button class="glow-btn" id="bRefresh">Refresh</button>
    </div>
    <div class="note blue">Advisory data only — the relay mirrors reservations and lock
    proofs; <strong>chain state is truth</strong>. Verify every signature locally before
    locking funds.</div>`;

  document.getElementById('fApply').onclick = () => {
    s.giveChain = document.getElementById('fGive').value;
    s.wantChain = document.getElementById('fWant').value;
    s.fillMode = document.getElementById('fMode').value;
    s.mediated = document.getElementById('fMed').value;
    s.fiatOnly = document.getElementById('fFiat').checked;
    s.q = document.getElementById('fQ').value.trim();
    s.page = 1;
    render();
  };
  document.getElementById('pgPrev').onclick = () => { s.page--; render(); };
  document.getElementById('pgNext').onclick = () => { s.page++; render(); };
  document.getElementById('bRefresh').onclick = () => render();
  app.querySelectorAll('.offer-card').forEach((el) => {
    el.onclick = () => { location.hash = '#/offer/' + encodeURIComponent(el.dataset.offer); };
  });
}

/* ---------- offer detail ---------- */
async function renderOfferDetail(offerId) {
  const { offer: o, fills } = await api('/v1/offers/' + encodeURIComponent(offerId));
  const a = o.advisory || {};
  const sigs = o.signatureStatuses || {};
  document.getElementById('crumbExtra').innerHTML = ` › <span class="mono">${esc(shortHash(o.offerId, 8))}</span>`;

  const sigRow = ['ed25519', 'solana', 'evm', 'chia']
    .map((k) => `<span class="muted">${k}</span> ${sigBadge(sigs[k])}`).join(' · ');
  const fillRows = (fills || []).map((f) => `<tr>
      <td class="mono">${esc(shortHash(f.fillId))}</td>
      <td>${fmtAmount(f.f, o.giveAsset, o.giveChain)}</td>
      <td>${phaseBadge(f.phase)}</td>
      <td class="mono">${f.hashlock ? esc(shortHash(f.hashlock)) : '—'}</td>
      <td>${f.lockProofs && f.lockProofs.makerLock ? `<span class="ok-text">✓</span> <span class="mono">${esc(shortHash(f.lockProofs.makerLock.txid))}</span>${f.lockProofs.makerLock.blockHeight != null ? ` @${f.lockProofs.makerLock.blockHeight}` : ''}` : '<span class="muted">—</span>'}</td>
      <td>${f.lockProofs && f.lockProofs.takerLock ? `<span class="ok-text">✓</span> <span class="mono">${esc(shortHash(f.lockProofs.takerLock.txid))}</span>${f.lockProofs.takerLock.blockHeight != null ? ` @${f.lockProofs.takerLock.blockHeight}` : ''}` : '<span class="muted">—</span>'}</td>
    </tr>`).join('');

  app.innerHTML = `
  <h2>Offer <span class="mono">${esc(o.offerId)}</span></h2>
  <div class="glow-card">
    <div class="pair">${fmtAmount(o.giveAmount, o.giveAsset, o.giveChain)} ${esc(o.giveAsset)} <span class="muted">@ ${chainName(o.giveChain)}</span>
      <span class="arrow">→</span> ${fmtAmount(o.wantAmount, o.wantAsset, o.wantChain)} ${esc(o.wantAsset)} <span class="muted">@ ${chainName(o.wantChain)}</span></div>
    <div>${statusBadge(a.status)}${offerBadges(o)}</div>
    <div class="progress"><div style="width:${o.giveAmount && BigInt(o.giveAmount) > 0n ? Math.min(100, Number((BigInt(a.filledAmount || '0') * 100n) / BigInt(o.giveAmount))) : 0}%"></div></div>
    <dl class="kv">
      <dt>Filled / reserved / remaining</dt><dd class="mono">${fmtAmount(a.filledAmount || '0', o.giveAsset, o.giveChain)} / ${fmtAmount(a.reservedAmount || '0', o.giveAsset, o.giveChain)} / ${fmtAmount(a.remainingAmount || '0', o.giveAsset, o.giveChain)} ${esc(o.giveAsset)}</dd>
      <dt>Min fill</dt><dd class="mono">${fmtAmount(o.minFillAmount, o.giveAsset, o.giveChain)} ${esc(o.giveAsset)}</dd>
      <dt>Fill mode</dt><dd>${esc(o.fillMode)}</dd>
      <dt>Maker (give chain)</dt><dd class="mono">${esc(o.makerAddr)}</dd>
      <dt>Maker receives (want chain)</dt><dd class="mono">${esc(o.makerRecvAddr)}</dd>
      ${o.takerAddr ? `<dt>Directed taker</dt><dd class="mono">${esc(o.takerAddr)}</dd>` : ''}
      <dt>Timelocks T1 / T2</dt><dd>${esc(o.makerTimelockSec)}s / ${esc(o.takerTimelockSec)}s</dd>
      <dt>Commit window</dt><dd>${esc(o.commitWindowSec)}s</dd>
      <dt>Expiry</dt><dd>${fmtTs(o.expiry)} <span class="muted">(unix ${esc(o.expiry)})</span></dd>
      <dt>Advisory updated</dt><dd>${fmtIso(a.updatedAt)}</dd>
    </dl>
    <div><span class="muted">Offer signatures:</span> ${sigRow}</div>
    ${o.badges && o.badges.validationStatus ? `<div class="muted" style="margin-top:6px">Token registry: give <strong>${esc(o.badges.validationStatus.give)}</strong> · want <strong>${esc(o.badges.validationStatus.want)}</strong>${o.badges.validationStatus.give !== 'validated' || o.badges.validationStatus.want !== 'validated' ? ' — <span class="warn">not validated: do not assume 1:1 backing</span>' : ''}</div>` : ''}
  </div>

  ${o.arbiter ? `<div class="note"><strong>⚖ Mediated offer.</strong> Arbiter <code class="mono">${esc(o.arbiter)}</code> can unilaterally redirect escrowed funds before timelock expiry. Only fill if you trust this arbiter.</div>` : ''}
  ${o.fiatLeg ? `<div class="note"><strong>Fiat leg:</strong> ${esc(o.fiatLeg.currency)} via ${esc(o.fiatLeg.rails)} (${esc(o.fiatLeg.providerId)}). <strong>Fiat legs never settle atomically</strong> — the crypto leg's HTLC does not cover the fiat transfer.</div>` : ''}

  <div class="glow-card">
    <h2>Fills (${(fills || []).length})</h2>
    ${(fills || []).length ? `<table class="data"><thead><tr>
      <th>Fill id</th><th>Amount</th><th>Phase</th><th>Hashlock</th><th>Maker lock</th><th>Taker lock</th>
    </tr></thead><tbody>${fillRows}</tbody></table>` : '<p class="muted">No fills yet.</p>'}
    <p class="muted">Phases: committed → makerLocked → takerLocked → claimed. Lock proofs are
    advisory mirrors until a watcher confirms them against its own RPC.</p>
  </div>

  <div class="glow-card">
    <h2>Fill this offer — from your own wallet</h2>
    <div class="note">Nightspire Market never signs. Copy the terms below, build and sign the
    fill in <strong>your own wallet or agent</strong>, then submit through your own tooling.
    Verify every signature locally before locking funds (spec §12).</div>
    <div class="actions">
      <button class="glow-btn" id="copyOffer">Copy offer JSON</button>
      <button class="glow-btn" id="copyTemplate">Copy fill-commitment template</button>
      ${o.fillMode === 'solver' || o.fillMode === 'any' ? `<button class="glow-btn" id="goAuction">View auction</button>` : ''}
    </div>
    <p class="muted" style="margin-top:10px">Deep link to this offer:
      <code class="mono" id="deeplink"></code></p>
  </div>`;

  document.getElementById('deeplink').textContent = location.origin + location.pathname + '#/offer/' + o.offerId;
  document.getElementById('copyOffer').onclick = async () => {
    await navigator.clipboard.writeText(JSON.stringify(o, null, 2));
    document.getElementById('copyOffer').textContent = 'Copied ✓';
  };
  document.getElementById('copyTemplate').onclick = async () => {
    const tpl = {
      _note: 'Taker fill commitment template — sign f+fillNonce+takerAddrs with your taker key, then POST to /v1/offers/{offerId}/commitments from your own tooling. The maker\'s signed ack is authoritative.',
      offerId: o.offerId,
      f: '<base-unit integer ≤ remaining ' + (a.remainingAmount || '?') + '>',
      fillNonce: '<unique random string>',
      takerAddrs: { giveChain: '<your address on ' + o.giveChain + '>', wantChain: '<your address on ' + o.wantChain + '>' },
      takerSig: '<your signature>',
    };
    await navigator.clipboard.writeText(JSON.stringify(tpl, null, 2));
    document.getElementById('copyTemplate').textContent = 'Copied ✓';
  };
  const goA = document.getElementById('goAuction');
  if (goA) goA.onclick = async () => {
    // find auctions for this offer by scanning the board's auctions is not
    // exposed; the auction id is returned at auction-open time. Ask the user.
    const id = prompt('Auction id for this offer (returned by POST /v1/auctions):');
    if (id) location.hash = '#/auction/' + encodeURIComponent(id.trim());
  };
}

/* ---------- auction ---------- */
async function sha256hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function canon(o) {
  if (o === null || o === undefined) return 'null';
  if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
  if (typeof o === 'object') {
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  }
  return JSON.stringify(o);
}
function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

async function verifyTickChain(view, pubkeyDerHex) {
  // Recomputes the full tick chain client-side: tickHash, prevTickHash
  // linkage from GENESIS, and every relaySig (ed25519, pinned relay key).
  const pub = await crypto.subtle.importKey(
    'spki', hexToBytes(pubkeyDerHex).buffer, { name: 'Ed25519' }, false, ['verify']);
  let prev = 'GENESIS';
  const ticks = [...view.ticks].sort((x, y) => x.tick - y.tick);
  for (const t of ticks) {
    const core = { auctionId: t.auctionId, tick: t.tick, price: t.price, prevTickHash: t.prevTickHash, ts: t.ts };
    const hash = await sha256hex(new TextEncoder().encode(canon(core)));
    if (hash !== t.tickHash.toLowerCase()) return { ok: false, at: t.tick, why: 'tickHash mismatch' };
    if (t.prevTickHash !== prev) return { ok: false, at: t.tick, why: 'prevTickHash linkage broken' };
    const signed = { ...core, tickHash: t.tickHash };
    const sigOk = await crypto.subtle.verify('Ed25519', pub, hexToBytes(t.relaySig), new TextEncoder().encode(canon(signed)));
    if (!sigOk) return { ok: false, at: t.tick, why: 'relaySig invalid' };
    prev = t.tickHash;
  }
  return { ok: true, ticks: ticks.length, tip: prev };
}

async function renderAuction(auctionId) {
  const view = await api('/v1/auctions/' + encodeURIComponent(auctionId));
  document.getElementById('crumbExtra').innerHTML = ` › auction <span class="mono">${esc(shortHash(view.auctionId, 8))}</span>`;

  // winner order, recomputed client-side per the published rule
  const acc = [...(view.acceptances || [])];
  const keyed = await Promise.all(acc.map(async (x) => ({
    x, h: await sha256hex(new TextEncoder().encode(x.fillerAddr)),
  })));
  keyed.sort((p, q) => (p.x.tick - q.x.tick) || (p.h < q.h ? -1 : p.h > q.h ? 1 : 0));
  const winnerAddr = view.outcome ? view.outcome.winner : (keyed[0] ? keyed[0].x.fillerAddr : null);

  const tickRows = [...(view.ticks || [])].sort((a, b) => a.tick - b.tick).map((t) => `<tr>
      <td class="mono">${t.tick}</td>
      <td class="mono">${fmtPrice(t.price)}</td>
      <td class="mono" title="${esc(t.prevTickHash)}">${esc(shortHash(t.prevTickHash))}</td>
      <td class="mono" title="${esc(t.tickHash || '')}">${t.tickHash ? esc(shortHash(t.tickHash)) : '—'}</td>
      <td class="mono" title="${esc(t.relaySig)}">${esc(shortHash(t.relaySig, 10))}</td>
      <td class="muted">${fmtTs(t.ts)}</td>
    </tr>`).join('');

  const accRows = keyed.map(({ x }, i) => `<tr${x.fillerAddr === winnerAddr ? ' class="winner-row"' : ''}>
      <td class="mono">${i === 0 ? '👑 ' : ''}${esc(shortHash(x.fillerAddr))}</td>
      <td class="mono">${x.tick}</td>
      <td class="mono">${fmtPrice(x.price)}</td>
      <td class="mono">${fmtInt(x.f)}</td>
      <td>${x.sigStatus === 'VERIFIED' ? '<span class="badge b-verified">VERIFIED</span>' : `<span class="badge b-unverified">${esc(x.sigStatus || '?')}</span>`}</td>
      <td class="mono" title="${esc(x.sig)}">${esc(shortHash(x.sig, 10))}</td>
    </tr>`).join('');

  const oc = view.outcome;
  const nowS = Math.floor(Date.now() / 1000);
  const ewLeft = oc ? Math.max(0, oc.exclusiveWindow.end - nowS) : 0;

  app.innerHTML = `
  <h2>Auction <span class="mono">${esc(view.auctionId)}</span></h2>
  <div class="glow-card">
    <dl class="kv">
      <dt>Offer</dt><dd><a href="#/offer/${esc(view.offerId)}" class="mono">${esc(shortHash(view.offerId, 12))}</a></dd>
      <dt>Status</dt><dd><span class="badge ${view.status === 'open' ? 'b-open' : 'b-verified'}">${esc(view.status)}</span></dd>
      <dt>Winner rule</dt><dd class="mono">${esc(view.winnerRule)}</dd>
      <dt>Ticks</dt><dd>${(view.ticks || []).length} · acceptances ${(view.acceptances || []).length}</dd>
    </dl>
    <div class="actions">
      <button class="glow-btn" id="verifyChain">Verify tick chain in browser</button>
    </div>
    <p id="verifyOut" class="muted"></p>
  </div>

  ${oc ? `<div class="glow-card">
    <h2>Outcome</h2>
    <dl class="kv">
      <dt>Winner</dt><dd class="mono">${esc(oc.winner)}</dd>
      <td><dt>Winning tick / fill</dt><dd class="mono">${oc.winningTick} / ${fmtInt(oc.f)} base units</dd>
      <dt>Exclusive window</dt><dd>${fmtTs(oc.exclusiveWindow.start)} → ${fmtTs(oc.exclusiveWindow.end)}
        ${ewLeft > 0 ? `<span class="badge b-filling">${ewLeft}s left</span>` : '<span class="badge b-expired">elapsed</span>'}</dd>
      <dt>Relay signature</dt><dd class="mono" title="${esc(oc.relaySig)}">${esc(shortHash(oc.relaySig, 16))}</dd>
    </dl>
    <div class="note">The winner must lock within its exclusive window or face slashing
    (spec §8). The signed outcome record above is the slash evidence base.</div>
  </div>` : `<div class="note blue">No outcome yet — the auction is still ${esc(view.status)}.</div>`}

  <div class="glow-card">
    <h2>Ticks (${(view.ticks || []).length})</h2>
    <table class="data"><thead><tr><th>#</th><th>Price (want/give)</th><th>prevTickHash</th><th>tickHash</th><th>relaySig</th><th>Time</th></tr></thead>
    <tbody>${tickRows || '<tr><td colspan="6" class="muted">No ticks yet.</td></tr>'}</tbody></table>
  </div>

  <div class="glow-card">
    <h2>Acceptances (${(view.acceptances || []).length})</h2>
    <table class="data"><thead><tr><th>Filler</th><th>Tick</th><th>Price</th><th>f</th><th>Sig</th><th>sig</th></tr></thead>
    <tbody>${accRows || '<tr><td colspan="6" class="muted">No acceptances yet.</td></tr>'}</tbody></table>
    <p class="muted">Sorted by the deterministic winner rule — recomputed here in your
    browser from the served ticks + acceptances. 👑 marks the winner.</p>
  </div>`;

  document.getElementById('verifyChain').onclick = async () => {
    const out = document.getElementById('verifyChain');
    const res = document.getElementById('verifyOut');
    out.disabled = true;
    res.textContent = 'Verifying…';
    try {
      if (!crypto.subtle) throw new Error('WebCrypto unavailable in this browser');
      const health = await api('/v1/health');
      const r = await verifyTickChain(view, health.relay.publicKeyDerHex);
      res.innerHTML = r.ok
        ? `<span class="ok-text">✓ Chain valid:</span> ${r.ticks} ticks, hashes + linkage + relay signatures recomputed locally. Tip <code class="mono">${esc(shortHash(r.tip))}</code>.`
        : `<span class="error">✗ Chain broken at tick ${r.at}:</span> ${esc(r.why)}`;
    } catch (e) {
      res.innerHTML = `<span class="warn">Could not verify in-browser (${esc(e.message)}).</span>
        The chain remains verifiable offline via <code class="mono">relay/scripts/verify-chain.js</code>.`;
    }
    out.disabled = false;
  };
}

/* ---------- about ---------- */
async function renderAbout() {
  app.innerHTML = `<div class="glow-card">
    <h2>How fills work — read-only venue</h2>
    <p>Nightspire Market is an <strong>off-chain order book</strong>. The relay mirrors
    offers, reservations, lock proofs and auction ticks, but it is <strong>never a
    custodian</strong> and this page <strong>never signs or submits anything</strong>.</p>
    <ol>
      <li><strong>Browse</strong> the offer board. Check the advisory status, badges
        (⚖ mediated, fiat leg), and each offer's signature statuses.</li>
      <li><strong>Copy</strong> the offer JSON from the offer page.</li>
      <li><strong>Sign in your own wallet</strong>: build a fill commitment
        (<code class="mono">fillNonce</code>, <code class="mono">f</code>, your addresses),
        sign it with your taker key, and submit it to
        <code class="mono">POST /v1/offers/{offerId}/commitments</code> from your own tooling.</li>
      <li><strong>Lock on-chain</strong>: both legs lock into HTLCs (maker first, T1 &gt; T2).
        Mirror the lock proofs so the board can track them.</li>
      <li><strong>Claim / refund</strong> via the HTLC timelocks. Verify every signature
        and every chain state <strong>locally</strong> — relay data is advisory (spec §12).</li>
    </ol>
    <div class="note"><strong>Security rules that always apply:</strong>
      verify signatures locally; fiat legs never settle atomically; mediated offers
      trust the arbiter; unvalidated token legs carry no 1:1 backing assumption.</div>
    <p class="muted">Endpoints this page reads (all GET):
      <code class="mono">/v1/offers</code>, <code class="mono">/v1/offers/{offerId}</code>,
      <code class="mono">/v1/auctions/{auctionId}</code>, <code class="mono">/v1/health</code>
      (relay identity key for in-browser tick-chain verification).</p>
  </div>`;
}

/* ---------- boot ---------- */
checkRelay();
render();
