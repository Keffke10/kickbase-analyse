import { login, Kickbase, ApiError } from './api.js';
import { loadLeague, loadAllDetails, analyze, FORMATIONS } from './model.js';
import { lineChart, barChart, wireCharts } from './charts.js';
import {
  esc, img, num, num1, eur, signedEur, pct, deltaClass, POS, POS_LONG, statusInfo, PROB, countdown, dateTime, ago, mean,
} from './util.js';

const APP_VERSION = '0.2';

// ------------------------------------------------------------ Sitzung (nur Token, niemals Passwort)

const KEY = 'kba.session';
const session = {
  get() {
    for (const st of [sessionStorage, localStorage]) {
      try {
        const v = JSON.parse(st.getItem(KEY) || 'null');
        if (v && new Date(v.expires) > new Date()) return v;
        if (v) st.removeItem(KEY);
      } catch { /* Speicher blockiert */ }
    }
    return null;
  },
  set(v, remember) {
    try {
      (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(v));
      (remember ? sessionStorage : localStorage).removeItem(KEY);
    } catch { /* ignorieren */ }
  },
  update(patch) {
    const cur = this.get();
    if (!cur) return;
    const remember = (() => { try { return !!localStorage.getItem(KEY); } catch { return false; } })();
    this.set({ ...cur, ...patch }, remember);
  },
  clear() {
    try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch { /* ignorieren */ }
  },
};

// ------------------------------------------------------------ Zustand

const state = {
  s: null, kb: null, raw: null, a: null,
  tab: 'home',
  marketSort: 'score', marketPos: 0,
  playerQuery: '', playerPos: 0, playerFree: true, playerSort: 'gap',
  squadView: 'sell',
  leagueView: 'table',
};

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');

// ------------------------------------------------------------ Kleine Render-Helfer

const face = (p, size = 44) => {
  const src = img(p.pim);
  return src ? `<img class="face" src="${esc(src)}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="face face-empty" style="width:${size}px;height:${size}px"></span>`;
};
const crest = (tim, size = 16) => (img(tim) ? `<img class="crest" src="${esc(img(tim))}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer">` : '');

function chips(p) {
  const out = [];
  const st = statusInfo(p.st);
  if (st) out.push(`<span class="chip ${st.level}">${st.level === 'crit' ? '✚' : '!'} ${esc(st.label)}</span>`);
  const pr = PROB[p.prob];
  if (pr && pr.level !== 'good') out.push(`<span class="chip ${pr.level}">${pr.level === 'crit' ? '▼' : '◆'} ${esc(pr.short)}</span>`);
  return out.join('');
}

function fixtureText(f, teams) {
  if (!f) return '<span class="muted">kein Spiel</span>';
  const opp = teams.get(f.opp);
  return `${f.home ? 'vs' : '@'} ${crest(opp?.tim, 14)} ${esc(opp?.sy || '?')} <span class="muted">(${Math.round(f.win * 100)} % Sieg)</span>`;
}

/** Transparente Aufschlüsselung, woraus sich die Prognose eines Spielers zusammensetzt. */
function basisTable(p) {
  const h = p.hist;
  const rows = [
    ['Saison-Ø (Kickbase)', `${num(p.ap)}${h?.cur ? ` <small class="muted">aus ${h.cur.games} Spielen</small>` : ''}`],
    ['Vorsaison-Ø', h?.prev?.avg != null ? `${num(h.prev.avg)} <small class="muted">aus ${h.prev.games} Spielen</small>` : '–'],
    ['Geglätteter Ø', p.apAdj != null ? `<b>${num(p.apAdj)}</b>${p.priorWeight ? ` <small class="muted">(${Math.round(p.priorWeight * 100)} % Vorsaison)</small>` : ''}` : '–'],
    ['Form (letzte Spiele)', num(p.form)],
    ['Startelf letzte Spiele', p.startShare != null ? `${Math.round(p.startShare * 100)} %` : '–'],
    ['Kickbase-Prognose', PROB[p.prob]?.label ?? '–'],
    ['Einsatzchance gesamt', `${Math.round(p.availNext * 100)} %`],
    ['MW-Signal (92 Tage)', p.mvTrend?.signal ? `${esc(p.mvTrend.signal)} <small class="muted">(3 T: ${signedEur(p.mvTrend.s3)}/Tag, 14 T: ${signedEur(p.mvTrend.s14)}/Tag)</small>` : '–'],
  ];
  return `<div class="table-wrap"><table class="rank basis">${rows.map(([l, v]) => `<tr><td>${l}</td><td class="r">${v}</td></tr>`).join('')}</table></div>`;
}

function trend(p) {
  const v = p.daily;
  if (!v) return '<span class="muted">±0</span>';
  return `<span class="${deltaClass(v)}">${v > 0 ? '▲' : '▼'} ${eur(Math.abs(v))}/Tag</span>`;
}

function gapBadge(p) {
  if (p.gap == null) return '<span class="muted">–</span>';
  const cls = p.gap > 0.15 ? 'pos' : p.gap < -0.15 ? 'neg' : '';
  const word = p.gap > 0.15 ? 'unterbewertet' : p.gap < -0.15 ? 'überbewertet' : 'fair';
  return `<span class="${cls}">${pct(p.gap, 0)} <small>${word}</small></span>`;
}

function scoreBadge(score, label) {
  const lvl = /Top|Kaufen$/.test(label) ? 'good' : /Beobachten|prüfen/.test(label) ? 'warn' : /Verkaufen|Meiden/.test(label) ? 'crit' : 'neutral';
  const icon = lvl === 'good' ? '✓' : lvl === 'warn' ? '◆' : lvl === 'crit' ? '✕' : '·';
  return `<span class="badge ${lvl}"><b>${score}</b> ${icon} ${esc(label)}</span>`;
}

function playerRow(p, right = '', sub = '') {
  return `<button class="prow" data-action="player" data-id="${esc(p.id)}">
    ${face(p)}
    <span class="pmain">
      <span class="pname">${esc(p.name)} <span class="pos pos${p.pos}">${POS[p.pos] || ''}</span></span>
      <span class="psub">${crest(p.tim)} ${esc(p.teamSy)} ${sub}</span>
      <span class="chips">${chips(p)}</span>
    </span>
    <span class="pright">${right}</span>
  </button>`;
}

function stat(label, value, cls = '') {
  return `<div class="stat"><span class="stat-l">${label}</span><span class="stat-v ${cls}">${value}</span></div>`;
}

// ------------------------------------------------------------ Ansichten

function viewLogin(error = '') {
  document.body.dataset.view = 'login';
  $app.innerHTML = `
  <main class="login">
    <div class="brand"><img src="icons/icon.svg" alt="" width="64" height="64"><h1>Kickbase Analyse</h1>
    <p class="muted">Empfehlungen für Aufstellung, Transfers &amp; faire Marktwerte deiner Liga.</p></div>
    <form id="loginForm" class="card" autocomplete="on">
      <label>Kickbase E-Mail<input type="email" name="email" required autocomplete="username" inputmode="email"></label>
      <label>Passwort<input type="password" name="password" required autocomplete="current-password"></label>
      <label class="check"><input type="checkbox" name="remember"> Angemeldet bleiben (nur Sitzungs-Token auf diesem Gerät, max. 7 Tage)</label>
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
      <button class="btn primary" type="submit">Anmelden</button>
    </form>
    <section class="card privacy">
      <h2>Datenschutz in Kürze</h2>
      <ul>
        <li>Die App läuft vollständig in deinem Browser. Es gibt <b>keinen eigenen Server</b>.</li>
        <li>E-Mail &amp; Passwort gehen <b>direkt und verschlüsselt an Kickbase</b> und werden nicht gespeichert.</li>
        <li>Nur das Sitzungs-Token von Kickbase wird lokal gehalten – Abmelden löscht es.</li>
        <li>Kein Tracking, keine Cookies, keine Analyse-Dienste, keine externen Schriftarten.</li>
      </ul>
      <p class="small muted">Inoffizielles Fan-Projekt, nicht mit Kickbase verbunden. <a href="datenschutz.html">Datenschutzerklärung</a></p>
    </section>
  </main>`;
  document.getElementById('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const btn = ev.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Anmelden …';
    try {
      const s = await login(String(f.get('email')).trim(), String(f.get('password')));
      ev.target.reset(); // Passwort sofort aus dem Formular entfernen
      session.set(s, f.get('remember') === 'on');
      state.s = s;
      chooseLeague();
    } catch (e) {
      viewLogin(e instanceof ApiError ? e.message : 'Keine Verbindung zu Kickbase.');
    }
  });
}

function chooseLeague() {
  const s = state.s;
  const leagues = s.leagues;
  if (s.leagueId && leagues.some((l) => l.id === s.leagueId)) return openLeague(s.leagueId);
  if (leagues.length === 1) return openLeague(leagues[0].id);
  document.body.dataset.view = 'select';
  $app.innerHTML = `<main class="login"><h1>Liga wählen</h1>
    <div class="list">${leagues.map((l) => `<button class="card league-btn" data-action="league" data-id="${esc(l.id)}">
      ${img(l.uim) ? `<img src="${esc(img(l.uim))}" alt="" width="40" height="40" referrerpolicy="no-referrer">` : ''}<span>${esc(l.name)}</span></button>`).join('')}
    </div>${leagues.length ? '' : '<p>Du bist in keiner Liga.</p>'}
    <button class="btn" data-action="logout">Abmelden</button></main>`;
}

async function openLeague(id, { fresh = false } = {}) {
  const league = state.s.leagues.find((l) => l.id === id);
  session.update({ leagueId: id });
  state.s.leagueId = id;
  if (!state.kb || state.kb.lid !== id || fresh) state.kb = new Kickbase(state.s.token, id, league?.cpi || '1');
  document.body.dataset.view = 'loading';
  $app.innerHTML = `<main class="loading"><div class="spinner" aria-hidden="true"></div><p id="progress">Lade Daten …</p><div class="bar"><span id="progressBar"></span></div></main>`;
  try {
    state.raw = await loadLeague(state.kb, (text, f) => {
      const p = document.getElementById('progress'); const b = document.getElementById('progressBar');
      if (p) p.textContent = text;
      if (b) b.style.width = `${Math.round(f * 100)}%`;
    });
    state.a = analyze(state.raw, state.s.user.id);
    state.league = league;
    render();
  } catch (e) {
    handleError(e);
  }
}

function handleError(e) {
  console.error(e);
  if (e instanceof ApiError && e.status === 401) {
    session.clear();
    return viewLogin(e.message);
  }
  $app.innerHTML = `<main class="login"><div class="card"><h2>Fehler</h2><p>${esc(e.message || 'Unbekannter Fehler')}</p>
    <button class="btn primary" data-action="reload">Erneut versuchen</button> <button class="btn" data-action="logout">Abmelden</button></div></main>`;
}

const TABS = [
  ['home', 'Übersicht', '<path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z"/>'],
  ['lineup', 'Aufstellung', '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18"/>'],
  ['market', 'Markt', '<path d="M4 7h16l-2 12H6zM9 7a3 3 0 016 0"/>'],
  ['squad', 'Kader', '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 7M18 14a6 6 0 013.5 6"/>'],
  ['players', 'Spieler', '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'],
  ['league', 'Liga', '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM7 6H4a3 3 0 003 4M17 6h3a3 3 0 01-3 4"/>'],
];

function render() {
  const a = state.a;
  document.body.dataset.view = 'app';
  const views = { home: viewHome, lineup: viewLineup, market: viewMarket, squad: viewSquad, players: viewPlayers, league: viewLeague, info: viewInfo };
  $app.innerHTML = `
  <header class="top">
    <div class="top-title"><strong>${esc(state.league?.name || a.overview.lnm)}</strong>
      <span class="muted small">Stand ${new Date(state.raw.loadedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span></div>
    <button class="icon-btn" data-action="refresh" aria-label="Aktualisieren" title="Aktualisieren"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.3-5.7M20 4v5h-5"/></svg></button>
    <button class="icon-btn" data-action="tab" data-tab="info" aria-label="Info &amp; Einstellungen" title="Info"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg></button>
  </header>
  <main class="content" id="content">${views[state.tab]()}</main>
  <nav class="tabs" aria-label="Navigation">${TABS.map(([k, l, icon]) => `<button data-action="tab" data-tab="${k}" class="${state.tab === k ? 'active' : ''}" aria-current="${state.tab === k ? 'page' : 'false'}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${l}</span></button>`).join('')}</nav>`;
  wireCharts($app);
  if (state.tab === 'league' && state.leagueView === 'history') loadHistory();
  if (state.tab === 'league' && state.leagueView === 'transfers') loadFeed();
  const q = document.getElementById('playerSearch');
  if (q) q.addEventListener('input', (e) => { state.playerQuery = e.target.value; updatePlayerList(); });
}

// ---- Übersicht

function viewHome() {
  const a = state.a;
  const meRank = a.ranking.us.find((u) => u.i === a.myId);
  const secondsToMd = a.nextDate ? (new Date(a.nextDate) - Date.now()) / 1000 : null;
  const currentXI = a.mine.filter((p) => a.currentXI.has(p.id));
  const curTotal = currentXI.reduce((s, p) => s + p.xp, 0);
  const alerts = [];
  if (a.budget < 0) alerts.push(['crit', `Budget negativ (${eur(a.budget)}): Bis zum Spieltag ausgleichen, sonst gibt es 0 Punkte.`]);
  for (const p of currentXI) {
    const st = statusInfo(p.st);
    if (st?.level === 'crit') alerts.push(['crit', `${p.name} steht in deiner Startelf, ist aber ${st.label}.`]);
    else if (!p.nextFix) alerts.push(['warn', `${p.name} hat am nächsten Spieltag kein Spiel.`]);
    else if (p.prob >= 4) alerts.push(['warn', `${p.name}: ${PROB[p.prob].label}.`]);
  }
  if (currentXI.length && currentXI.length < 11) alerts.push(['warn', `Nur ${currentXI.length} Spieler aufgestellt.`]);
  if (a.lineup && a.lineup.total - curTotal > 15) alerts.push(['warn', `Optimierte Aufstellung bringt ca. +${num(a.lineup.total - curTotal)} erwartete Punkte.`]);

  const buys = a.market.filter((p) => !p.mine && p.buyScore >= 56).sort((x, y) => y.buyScore - x.buyScore).slice(0, 3);
  const sells = a.mine.filter((p) => p.sellLabel === 'Verkaufen').sort((x, y) => y.sellScore - x.sellScore).slice(0, 3);
  const movers = a.mine.filter((p) => p.mv24).sort((x, y) => Math.abs(y.mv24) - Math.abs(x.mv24)).slice(0, 5);
  const secondsToMv = a.mvUpdate ? (new Date(a.mvUpdate) - Date.now()) / 1000 : null;
  // MW-Trading: steigende Marktspieler früh kaufen, fallende eigene Spieler vor dem Update abgeben
  const risers = a.market.filter((p) => !p.mine && p.daily > 0 && !(p.st & 1) && p.prob < 5).sort((x, y) => y.daily / y.mv - x.daily / x.mv).slice(0, 4);
  const fallers = a.mine.filter((p) => p.daily < 0).sort((x, y) => x.daily / x.mv - y.daily / y.mv).slice(0, 4);
  const bidSum = a.myBids.reduce((s, p) => s + p.market.myBid, 0);

  return `
  <section class="kpis">
    ${stat('Platz', meRank ? `${meRank.spl}.` : '–')}
    ${stat('Punkte', num(meRank?.sp))}
    ${stat('Budget', eur(a.budget), a.budget < 0 ? 'neg' : '')}
    ${stat('Teamwert', eur(a.teamValue))}
  </section>
  <section class="card">
    <div class="row-between"><h2>Spieltag ${a.nextDay ?? '–'}</h2><span class="muted">${a.nextDate ? `in ${countdown(secondsToMd)}` : ''}</span></div>
    <p class="muted small">${a.nextDate ? `Anpfiff ${dateTime(a.nextDate)}` : ''}</p>
    ${alerts.length ? `<ul class="alerts">${alerts.map(([l, t]) => `<li class="${l}"><span aria-hidden="true">${l === 'crit' ? '✕' : '!'}</span> ${esc(t)}</li>`).join('')}</ul>` : '<p class="ok">✓ Keine Probleme mit deiner Aufstellung erkannt.</p>'}
    <button class="btn" data-action="tab" data-tab="lineup">Aufstellung ansehen</button>
  </section>
  ${a.myBids.length ? `<section class="card"><div class="row-between"><h2>Deine Gebote</h2><span class="small">gesamt <b>${eur(bidSum)}</b></span></div>
    ${a.myBids.map((p) => playerRow(p, `<b>${eur(p.market.myBid)}</b><small class="${p.bidStatus === 'passt' ? 'pos' : 'neg'}">${esc(p.bidStatus)}</small>`, `· Vorschlag ${eur(p.bid)} · ${countdown(p.market.exs)}`)).join('')}
    ${bidSum > a.budget ? '<p class="small neg">! Die Summe deiner Gebote übersteigt dein Budget.</p>' : ''}</section>` : ''}
  <section class="card">
    <div class="row-between"><h2>Marktwert-Trading</h2><span class="muted small">${secondsToMv > 0 ? `MW-Update in ${countdown(secondsToMv)}` : ''}</span></div>
    <p class="small muted">Kickbase passt die Marktwerte einmal täglich an. Steigende Spieler früh kaufen, fallende vor dem Update verkaufen.</p>
    <h3 class="pos">▲ Steigen (Transfermarkt)</h3>
    ${risers.map((p) => playerRow(p, `<span class="pos">+${eur(p.daily)}</span><small>${pct(p.daily / p.mv)} / Tag</small>`, `· ${eur(p.mv)}${p.mvTrend?.signal ? ` · ${esc(p.mvTrend.signal)}` : ''}`)).join('') || '<p class="muted">–</p>'}
    <h3 class="neg">▼ Fallen (dein Kader)</h3>
    ${fallers.map((p) => playerRow(p, `<span class="neg">−${eur(-p.daily)}</span><small>${pct(p.daily / p.mv)} / Tag</small>`, `· ${eur(p.mv)}${p.mvTrend?.signal ? ` · ${esc(p.mvTrend.signal)}` : ''}`)).join('') || '<p class="muted">Keiner deiner Spieler fällt.</p>'}
  </section>
  <section class="card">
    <div class="row-between"><h2>Kaufempfehlungen</h2><button class="link" data-action="tab" data-tab="market">Markt →</button></div>
    ${buys.length ? buys.map((p) => playerRow(p, `${scoreBadge(p.buyScore, p.buyLabel)}<small>Gebot ~${eur(p.bid)}</small>`, `· ${eur(p.mv)}`)).join('') : '<p class="muted">Aktuell nichts Überzeugendes auf dem Markt.</p>'}
  </section>
  ${a.swaps.length ? `<section class="card"><h2>Tausch-Ideen</h2>${a.swaps.slice(0, 3).map(swapRow).join('')}</section>` : ''}
  <section class="card">
    <div class="row-between"><h2>Verkaufskandidaten</h2><button class="link" data-action="tab" data-tab="squad">Kader →</button></div>
    ${sells.length ? sells.map((p) => playerRow(p, `${scoreBadge(p.sellScore, p.sellLabel)}<small>${eur(p.mv)}</small>`)).join('') : '<p class="muted">Kein klarer Verkaufskandidat.</p>'}
  </section>
  ${movers.length ? `<section class="card"><h2>Marktwert-Bewegung (24 h)</h2>${movers.map((p) => playerRow(p, `<span class="${deltaClass(p.mv24)}">${signedEur(p.mv24)}</span><small>${eur(p.mv)}</small>`)).join('')}</section>` : ''}`;
}

function swapRow(s) {
  return `<div class="swap">
    <button class="swap-side" data-action="player" data-id="${esc(s.sell.id)}"><span class="neg">▼ raus</span>${face(s.sell, 36)}<b>${esc(s.sell.name)}</b><small>${eur(s.sell.mv)}</small></button>
    <span class="swap-arrow" aria-hidden="true">→</span>
    <button class="swap-side" data-action="player" data-id="${esc(s.buy.id)}"><span class="pos">▲ rein</span>${face(s.buy, 36)}<b>${esc(s.buy.name)}</b><small>Gebot ${eur(s.buy.bid)}</small></button>
    <div class="swap-meta">+${num(s.gain)} Pkt/Spiel erwartet · Kosten netto ${signedEur(s.net)}</div>
  </div>`;
}

// ---- Aufstellung

function viewLineup() {
  const a = state.a;
  const L = a.lineup;
  if (!L) return '<section class="card"><p>Zu wenige Spieler für eine gültige Formation.</p></section>';
  const rows = { 4: [], 3: [], 2: [], 1: [] };
  L.xi.forEach((p) => rows[p.pos].push(p));
  const cur = a.mine.filter((p) => a.currentXI.has(p.id));
  const curTotal = cur.reduce((s, p) => s + p.xp, 0);
  const inn = L.xi.filter((p) => !a.currentXI.has(p.id));
  const out = cur.filter((p) => !p.inBestXI);
  const tile = (p) => `<button class="tile" data-action="player" data-id="${esc(p.id)}">${face(p, 40)}<span class="tile-n">${esc(p.name)}</span><span class="tile-x">${num(p.xp)}</span>${a.currentXI.has(p.id) ? '' : '<span class="tile-new">neu</span>'}</button>`;
  return `
  <section class="card">
    <div class="row-between"><h2>Optimale Elf · ${esc(L.formation)}</h2><span class="badge good"><b>${num(L.total)}</b> Pkt erw.</span></div>
    <p class="small muted">Erwartete Punkte für Spieltag ${a.nextDay}: Form × Ø-Punkte × Gegner (Wettquoten) × Einsatzchance. Aktuelle Elf: ${num(curTotal)} Pkt erw.</p>
    <div class="pitch">${[4, 3, 2, 1].map((k) => `<div class="line">${rows[k].map(tile).join('')}</div>`).join('')}</div>
    ${inn.length || out.length ? `<div class="changes"><div><h3 class="pos">Einwechseln</h3>${inn.map((p) => `<p>▲ ${esc(p.name)} <small>(${num(p.xp)})</small></p>`).join('') || '<p class="muted">–</p>'}</div>
      <div><h3 class="neg">Auswechseln</h3>${out.map((p) => `<p>▼ ${esc(p.name)} <small>(${num(p.xp)})</small></p>`).join('') || '<p class="muted">–</p>'}</div></div>` : '<p class="ok">✓ Deine aktuelle Aufstellung ist bereits optimal.</p>'}
    ${inn.length || out.length
      ? `<button class="btn primary" data-action="applyLineup" data-f="${esc(L.formation)}">Diese Elf in Kickbase übernehmen</button>`
      : `<button class="btn" data-action="applyLineup" data-f="${esc(L.formation)}">Erneut an Kickbase senden</button>`}
    <p class="small muted">Du bestätigst jede Änderung, bevor sie an Kickbase geht. Oder tippe unten auf eine andere Formation.</p>
  </section>
  <section class="card"><h2>Alle Formationen</h2>
    <div class="formations">${FORMATIONS.map((f) => {
      const t = formationTotal(a.mine, f);
      return t == null ? `<div class="off"><b>${f}</b><span>–</span></div>`
        : `<button class="${f === L.formation ? 'best' : ''}" data-action="applyLineup" data-f="${f}" aria-label="Formation ${f} übernehmen"><b>${f}</b><span>${num(t)}</span></button>`;
    }).join('')}</div>
    <p class="small muted">Tippe auf eine Formation, um ihre beste Elf zu übernehmen.</p>
  </section>
  <section class="card"><h2>Bank</h2>
    ${L.bench.map((p) => playerRow(p, `<b>${num(p.xp)}</b><small>Pkt erw.</small>`, `· ${fixtureText(p.nextFix, a.teams)}`)).join('')}
  </section>`;
}

/** Beste Elf für eine Formation, sortiert TW → ABW → MF → ST (so erwartet es Kickbase). */
function formationXI(players, f) {
  const [d, m, s] = f.split('-').map(Number);
  const need = { 1: 1, 2: d, 3: m, 4: s };
  const xi = [];
  for (const pos of [1, 2, 3, 4]) {
    const list = players.filter((p) => p.pos === pos).sort((x, y) => y.xp - x.xp);
    if (list.length < need[pos]) return null;
    xi.push(...list.slice(0, need[pos]));
  }
  return xi;
}

function formationTotal(players, f) {
  const xi = formationXI(players, f);
  return xi ? xi.reduce((sum, p) => sum + p.xp, 0) : null;
}

// ---- Transfermarkt

function posFilter(active, action) {
  return `<div class="seg" role="group" aria-label="Position">${[[0, 'Alle'], [1, 'TW'], [2, 'ABW'], [3, 'MF'], [4, 'ST']].map(([v, l]) => `<button data-action="${action}" data-v="${v}" class="${active === v ? 'on' : ''}" aria-pressed="${active === v}">${l}</button>`).join('')}</div>`;
}

function viewMarket() {
  const a = state.a;
  const sorters = {
    score: (x, y) => y.buyScore - x.buyScore,
    expiry: (x, y) => x.market.exs - y.market.exs,
    price: (x, y) => x.market.price - y.market.price,
    xp: (x, y) => y.xs - x.xs,
    gap: (x, y) => (y.gap ?? -9) - (x.gap ?? -9),
  };
  const list = a.market.filter((p) => !state.marketPos || p.pos === state.marketPos).sort(sorters[state.marketSort]);
  return `
  <section class="card toolbar">
    <div class="row-between"><h2>Transfermarkt <span class="muted">(${a.market.length})</span></h2><span class="small">Budget <b class="${a.budget < 0 ? 'neg' : ''}">${eur(a.budget)}</b></span></div>
    ${posFilter(state.marketPos, 'marketPos')}
    <label class="select">Sortierung <select data-action="marketSort">
      ${[['score', 'Empfehlung'], ['expiry', 'Ablauf'], ['price', 'Preis'], ['xp', 'Erw. Punkte'], ['gap', 'Unterbewertung']].map(([v, l]) => `<option value="${v}" ${state.marketSort === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
  </section>
  ${list.map((p) => marketCard(p)).join('') || '<p class="muted center">Keine Spieler.</p>'}`;
}

function marketCard(p) {
  const a = state.a;
  if (p.listedByMe) {
    return `<article class="card mcard own">
      ${playerRow(p, '<span class="badge neutral">Dein Angebot</span>', '· von dir angeboten')}
      <div class="grid4">
        ${stat('Dein Preis', eur(p.market.price))}
        ${stat('Marktwert', eur(p.mv))}
        ${stat('Fairer MW', eur(p.fair))}
        ${stat('MW-Trend', trend(p))}
      </div>
      ${marketActions(p)}
    </article>`;
  }
  return `<article class="card mcard">
    ${playerRow(p, scoreBadge(p.buyScore, p.buyLabel), `· ${p.market.seller ? `von <b>${esc(p.market.seller.name)}</b>` : 'Kickbase'}`)}
    <div class="grid4">
      ${stat('Preis', eur(p.market.price))}
      ${stat('Fairer MW', eur(p.fair))}
      ${stat('Bewertung', gapBadge(p))}
      ${stat('Läuft ab', countdown(p.market.exs))}
      ${stat('Ø Punkte', num(p.ap))}
      ${stat('Erw. nächstes Spiel', num(p.xp))}
      ${stat('MW-Trend', trend(p))}
      ${stat('Nächster Gegner', fixtureText(p.nextFix, a.teams))}
    </div>
    <div class="bid ${p.affordable ? '' : 'warn'}">
      <span>Gebotsvorschlag <b>${eur(p.bid)}</b> · max. sinnvoll ${eur(p.bidMax)}</span>
      ${p.affordable ? '' : '<small>! übersteigt dein Budget</small>'}
      ${p.market.offers ? `<small>${p.market.offers} Gebot(e) liegen vor</small>` : ''}
      ${p.market.myBid ? `<small>Dein Gebot: <b>${eur(p.market.myBid)}</b> – <span class="${p.bidStatus === 'passt' ? 'pos' : 'neg'}">${esc(p.bidStatus)}</span></small>` : ''}
    </div>
    ${marketActions(p)}
  </article>`;
}

/** Aktionsknöpfe je nach Situation: bieten / Gebot ändern / eigenes Angebot verwalten. */
function marketActions(p) {
  if (p.listedByMe) {
    return `<div class="actions">
      ${p.market.offerList.length ? `<p class="small"><b>${p.market.offerList.length} Angebot(e)</b> – im Spieler-Detail annehmen oder ablehnen.</p>` : '<p class="small muted">Dein Angebot – noch keine Gebote.</p>'}
      <button class="btn small" data-action="player" data-id="${esc(p.id)}">Angebote ansehen</button>
      <button class="btn small" data-action="unlist" data-id="${esc(p.id)}">Vom Markt nehmen</button></div>`;
  }
  if (p.mine) return '';
  if (p.market.myBid) {
    return `<div class="actions">
      <button class="btn small primary-soft" data-action="bid" data-id="${esc(p.id)}">Gebot ändern</button>
      <button class="btn small" data-action="withdraw" data-id="${esc(p.id)}">Gebot zurückziehen</button></div>`;
  }
  return `<div class="actions"><button class="btn small primary-soft" data-action="bid" data-id="${esc(p.id)}">Bieten …</button></div>`;
}

// ---- Kader

function viewSquad() {
  const a = state.a;
  const mine = a.mine.slice();
  const list = state.squadView === 'sell' ? mine.sort((x, y) => y.sellScore - x.sellScore)
    : state.squadView === 'pos' ? mine.sort((x, y) => x.pos - y.pos || y.xs - x.xs)
    : mine.sort((x, y) => (y.buyGain ?? 0) - (x.buyGain ?? 0));
  const profit = mine.reduce((s, p) => s + (p.buyGain ?? 0), 0);
  return `
  <section class="kpis">
    ${stat('Spieler', mine.length)}
    ${stat('Teamwert', eur(a.teamValue))}
    ${stat('Budget', eur(a.budget), a.budget < 0 ? 'neg' : '')}
    ${stat('Gewinn seit Kauf', signedEur(profit), deltaClass(profit))}
  </section>
  ${a.rescue ? `<section class="card alert-card"><h2>Budget ausgleichen</h2><p>Dir fehlen <b>${eur(a.rescue.need)}</b>. Verkaufe mit geringstem Punkteverlust:</p>
    ${a.rescue.pick.map((p) => playerRow(p, `<b>${eur(p.mv)}</b>`)).join('')}</section>` : ''}
  ${a.swaps.length ? `<section class="card"><h2>Tausch-Ideen</h2><p class="small muted">Verkauf + Kauf auf gleicher Position, Budget bleibt ≥ 0.</p>${a.swaps.map(swapRow).join('')}</section>` : ''}
  <section class="card">
    <div class="seg" role="group" aria-label="Sortierung">${[['sell', 'Verkaufsranking'], ['pos', 'Nach Position'], ['gain', 'Gewinn']].map(([v, l]) => `<button data-action="squadView" data-v="${v}" class="${state.squadView === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${list.map((p) => playerRow(p,
      state.squadView === 'sell' ? `${scoreBadge(p.sellScore, p.sellLabel)}<small>${eur(p.mv)}</small>`
        : `<b>${eur(p.mv)}</b><small class="${deltaClass(p.buyGain)}">${signedEur(p.buyGain)} seit Kauf</small>`,
      `· Ø ${num(p.ap)} · ${p.inBestXI ? 'Startelf' : 'Bank'}`)).join('')}
  </section>`;
}

// ---- Spielerdatenbank

function filteredPlayers() {
  const a = state.a;
  const q = state.playerQuery.trim().toLowerCase();
  const sorters = {
    gap: (x, y) => (y.gap ?? -9) - (x.gap ?? -9),
    ap: (x, y) => (y.ap ?? -999) - (x.ap ?? -999),
    xp: (x, y) => y.xp - x.xp,
    mv: (x, y) => y.mv - x.mv,
    trend: (x, y) => y.daily - x.daily,
    eff: (x, y) => y.eff - x.eff,
    score: (x, y) => y.buyScore - x.buyScore,
  };
  return a.all
    .filter((p) => (!state.playerPos || p.pos === state.playerPos)
      && (!state.playerFree || !p.ownerId)
      && (!q || `${p.fn} ${p.name} ${p.teamName}`.toLowerCase().includes(q))
      && (state.playerSort !== 'gap' || (p.ap ?? 0) > 20))
    .sort(sorters[state.playerSort]);
}

function playerListHtml() {
  const list = filteredPlayers();
  const metric = (p) => ({
    gap: gapBadge(p), ap: `<b>${num(p.ap)}</b><small>Ø Pkt</small>`, xp: `<b>${num(p.xp)}</b><small>erw.</small>`,
    mv: `<b>${eur(p.mv)}</b>`, trend: trend(p), eff: `<b>${num1(p.eff)}</b><small>Pkt/Mio</small>`,
    score: scoreBadge(p.buyScore, p.buyScore >= 70 ? 'Top' : p.buyScore >= 56 ? 'gut' : p.buyScore >= 42 ? 'ok' : 'schwach'),
  }[state.playerSort]);
  return `<p class="small muted">${list.length} Spieler${list.length > 80 ? ' · die ersten 80' : ''}</p>` + list.slice(0, 80).map((p) => playerRow(p, metric(p),
    `· ${eur(p.mv)}${p.ownerName ? ` · <i>${esc(p.ownerName)}</i>` : p.market ? ' · <b>auf dem Markt</b>' : ''}`)).join('');
}

function updatePlayerList() {
  const el = document.getElementById('playerList');
  if (el) el.innerHTML = playerListHtml();
}

function viewPlayers() {
  const a = state.a;
  const detailCount = state.raw.detailMap.size;
  return `
  <section class="card toolbar">
    <h2>Alle Bundesliga-Spieler</h2>
    <input id="playerSearch" type="search" placeholder="Name oder Verein suchen …" value="${esc(state.playerQuery)}" aria-label="Suche">
    ${posFilter(state.playerPos, 'playerPos')}
    <div class="row-between">
      <label class="check"><input type="checkbox" data-action="playerFree" ${state.playerFree ? 'checked' : ''}> nur ohne Besitzer</label>
      <label class="select">Sortierung <select data-action="playerSort">
        ${[['gap', 'Unterbewertet'], ['score', 'Kauf-Score'], ['eff', 'Preis-Leistung'], ['ap', 'Ø Punkte'], ['xp', 'Erw. nächstes Spiel'], ['trend', 'MW-Trend'], ['mv', 'Marktwert']].map(([v, l]) => `<option value="${v}" ${state.playerSort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    </div>
    ${detailCount < a.all.length * 0.9 ? `<button class="btn small" data-action="deep">Tiefenanalyse: Form &amp; Vorsaison aller ${a.all.length} Spieler laden (ca. 25 MB)</button>` : '<p class="small ok">✓ Formdaten aller Spieler geladen.</p>'}
  </section>
  <section class="card" id="playerList">${playerListHtml()}</section>`;
}

// ---- Liga

function viewLeague() {
  const a = state.a;
  const us = a.ranking.us.slice().sort((x, y) => x.spl - y.spl);
  const maxTv = Math.max(...us.map((u) => u.tv));
  const seg = `<div class="seg" role="group" aria-label="Ansicht">${[['table', 'Tabelle'], ['history', 'Verlauf'], ['fixtures', 'Restprogramm'], ['transfers', 'Transfers']].map(([v, l]) => `<button data-action="leagueView" data-v="${v}" class="${state.leagueView === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  if (state.leagueView === 'history') return `${seg}<section class="card"><h2>Saisonverlauf</h2><div id="history"><p class="muted">Lade …</p></div></section>`;
  if (state.leagueView === 'fixtures') return seg + viewFixtureMatrix();
  if (state.leagueView === 'transfers') return `${seg}<section class="card"><h2>Transfer-Aktivität</h2><div id="feed"><p class="muted">Lade …</p></div></section>`;
  return `${seg}
  <section class="card"><h2>Tabelle · Spieltag ${a.ranking.day}</h2>
    <div class="table-wrap"><table class="rank">
      <thead><tr><th>#</th><th>Manager</th><th class="r">Punkte</th><th class="r">Spieltag</th><th class="r">Teamwert</th></tr></thead>
      <tbody>${us.map((u) => `<tr class="${u.i === a.myId ? 'me' : ''}" data-action="manager" data-id="${esc(u.i)}" tabindex="0">
        <td>${u.spl}</td><td>${esc(u.n)}</td><td class="r">${num(u.sp)}</td><td class="r">${num(u.mdp)}</td><td class="r">${eur(u.tv)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="small muted">Tippe auf einen Manager für Kader &amp; Stärken.</p>
  </section>
  <section class="card"><h2>Teamwerte</h2>
    <div class="hbars">${us.slice().sort((x, y) => y.tv - x.tv).map((u) => `<div class="hbar ${u.i === a.myId ? 'me' : ''}"><span class="hbar-l">${esc(u.n)}</span><span class="hbar-t"><span style="width:${(u.tv / maxTv * 100).toFixed(1)}%"></span></span><span class="hbar-v">${eur(u.tv)}</span></div>`).join('')}</div>
  </section>`;
}

function viewFixtureMatrix() {
  const a = state.a;
  const myTeams = new Map();
  for (const p of a.mine) myTeams.set(p.tid, (myTeams.get(p.tid) || 0) + 1);
  const days = [...new Set([...a.fixtures.values()].flat().map((f) => f.day))].sort((x, y) => x - y).slice(0, 5);
  const rows = [...a.teams.values()].map((t) => {
    const fx = a.fixtures.get(t.tid) || [];
    const ease = mean(fx.filter((f) => days.slice(0, 3).includes(f.day)).map((f) => f.win + 0.5 * f.draw)) ?? 0;
    return { t, fx, ease };
  }).sort((x, y) => y.ease - x.ease);
  const lvl = (w) => (w >= 0.55 ? 'e5' : w >= 0.42 ? 'e4' : w >= 0.3 ? 'e3' : w >= 0.2 ? 'e2' : 'e1');
  const cell = (f) => {
    if (!f) return '<td class="cell">–</td>';
    const o = a.teams.get(f.opp);
    const title = `${f.home ? 'Heim' : 'Auswärts'} gegen ${o?.tn || ''}: ${Math.round(f.win * 100)} % Siegchance, erw. Tore ${f.xgFor.toFixed(1)}:${f.xgAgainst.toFixed(1)}, zu Null ${Math.round(f.cs * 100)} %`;
    return `<td class="cell ${lvl(f.win)}" title="${esc(title)}"><b>${esc(o?.sy || '?')}</b> ${f.home ? 'H' : 'A'}<small>${Math.round(f.win * 100)} %</small></td>`;
  };
  return `<section class="card"><h2>Restprogramm</h2>
    <p class="small muted">Siegchance je Spiel (Wettquoten, sonst Tabellenstärke). Oben die leichtesten Programme der nächsten 3 Spieltage. H = Heim, A = Auswärts, „Du“ = deine Spieler im Verein.</p>
    <div class="legend small"><span class="cell e5">leicht</span><span class="cell e3">mittel</span><span class="cell e1">schwer</span></div>
    <div class="table-wrap"><table class="fixm"><thead><tr><th>Verein</th><th class="du">Du</th>${days.map((d) => `<th>ST ${d}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(({ t, fx }) => `<tr><td>${crest(t.tim)} ${esc(t.sy)} <small class="muted">(${t.cpl}.)</small></td><td class="du">${myTeams.get(t.tid) || ''}</td>${days.map((d) => cell(fx.find((x) => x.day === d))).join('')}</tr>`).join('')}
    </tbody></table></div></section>`;
}

async function loadHistory() {
  const el = document.getElementById('history');
  if (!el) return;
  const a = state.a;
  try {
    const days = Array.from({ length: a.ranking.day }, (_, i) => i + 1);
    const res = await Promise.all(days.map((d) => (d === a.ranking.day ? a.ranking : state.kb.ranking(d))));
    const byDay = res.map((r) => new Map(r.us.map((u) => [u.i, u])));
    const best = byDay.map((m) => Math.max(...[...m.values()].map((u) => u.mdp)));
    const users = a.ranking.us.slice().sort((x, y) => x.spl - y.spl);
    el.innerHTML = `<div class="table-wrap"><table class="rank hist"><thead><tr><th>Manager</th>${days.map((d) => `<th class="r">ST ${d}</th>`).join('')}<th class="r">Ø</th><th class="r">Siege</th><th>Platz je Spieltag</th></tr></thead><tbody>
      ${users.map((u) => {
        const pts = byDay.map((m) => m.get(u.i)?.mdp ?? null);
        const isWin = (v, i) => v != null && v > 0 && v === best[i];
        return `<tr class="${u.i === a.myId ? 'me' : ''}"><td>${esc(u.n)}</td>
          ${pts.map((v, i) => `<td class="r ${isWin(v, i) ? 'win' : ''}">${isWin(v, i) ? '★ ' : ''}${num(v)}</td>`).join('')}
          <td class="r">${num(mean(pts.filter((v) => v != null)))}</td><td class="r">${pts.filter(isWin).length}</td>
          <td class="muted">${byDay.map((m) => m.get(u.i)?.spl ?? '–').join(' → ')}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="small muted">★ = Spieltagssieger.</p>`;
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function loadFeed() {
  const el = document.getElementById('feed');
  el.innerHTML = '<p class="muted">Lade …</p>';
  try {
    const f = await state.kb.feed(100);
    const tx = (f.af || []).filter((x) => x.t === 15);
    const byMgr = new Map();
    for (const x of tx) {
      const who = x.data.byr || x.data.slr;
      const m = byMgr.get(who) || { buy: 0, sell: 0, nb: 0, ns: 0 };
      if (x.data.byr) { m.buy += x.data.trp; m.nb++; } else { m.sell += x.data.trp; m.ns++; }
      byMgr.set(who, m);
    }
    el.innerHTML = `
      <div class="table-wrap"><table class="rank"><thead><tr><th>Manager</th><th class="r">Käufe</th><th class="r">Verkäufe</th><th class="r">Saldo</th></tr></thead>
      <tbody>${[...byMgr].map(([n, m]) => `<tr><td>${esc(n)}</td><td class="r">${m.nb} · ${eur(m.buy)}</td><td class="r">${m.ns} · ${eur(m.sell)}</td><td class="r ${deltaClass(m.sell - m.buy)}">${signedEur(m.sell - m.buy)}</td></tr>`).join('')}</tbody></table></div>
      <ul class="feed">${tx.slice(0, 40).map((x) => `<li><span class="${x.data.byr ? 'pos' : 'neg'}">${x.data.byr ? '▲' : '▼'}</span>
        <span><b>${esc(x.data.byr || x.data.slr)}</b> ${x.data.byr ? 'kauft' : 'verkauft'} <b>${esc(x.data.pn)}</b> für ${eur(x.data.trp)}</span><small class="muted">${ago(x.dt)}</small></li>`).join('')}</ul>
      <p class="small muted">Basis: die letzten ${f.af?.length || 0} Liga-Ereignisse.</p>`;
  } catch (e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ---- Info

function viewInfo() {
  const a = state.a;
  return `
  <section class="card"><h2>Konto</h2>
    <p>Angemeldet als <b>${esc(state.s.user.name)}</b></p>
    ${state.s.leagues.length > 1 ? '<button class="btn" data-action="switch">Liga wechseln</button>' : ''}
    <button class="btn danger" data-action="logout">Abmelden &amp; lokale Daten löschen</button>
  </section>
  <section class="card"><h2>Datenquellen</h2>
    <ul class="sources">
      <li><span class="ok">✓</span><div><b>Kickbase – Liga, Markt, Kader, Spielplan</b><small>Budget, Gebote, Startelf-Prognose, Verletzungen, Wettquoten, Ergebnisse</small></div></li>
      <li><span class="${a.sources.history ? 'ok' : 'muted'}">${a.sources.history ? '✓' : '–'}</span><div><b>Kickbase – Leistungshistorie</b><small>${a.sources.history} Spieler: Vorsaison-Ø als Prior, Startelf-Quote → erwartete Punkte, fairer Marktwert, Einsatzchance</small></div></li>
      <li><span class="${a.sources.mvHistory ? 'ok' : 'muted'}">${a.sources.mvHistory ? '✓' : '–'}</span><div><b>Kickbase – Marktwertverlauf 92 Tage</b><small>${a.sources.mvHistory} Spieler: 3-/14-Tage-Trend &amp; Trendwende → MW-Prognose, Momentum, Gebote</small></div></li>
      <li><span class="${a.sources.openLigaDb ? 'ok' : 'neg'}">${a.sources.openLigaDb ? '✓' : '✕'}</span><div><b>OpenLigaDB – Abschlusstabellen ${esc(a.sources.openLigaDb || 'Vorsaison')}</b><small>${a.sources.openLigaDb ? '1. &amp; 2. Liga: Tore als Stärke-Prior (inkl. Aufsteiger) → Tor-Modell' : 'nicht erreichbar – Tor-Modell nutzt nur die laufende Saison'}</small></div></li>
      <li><span class="ok">✓</span><div><b>Liga-Gebote anderer Manager</b><small>Anzahl Konkurrenzgebote → Aufschlag im Gebotsvorschlag</small></div></li>
    </ul>
  </section>
  <section class="card"><h2>So rechnet die App</h2>
    <dl class="explain">
      <dt>Geglätteter Ø (Vorsaison-Prior)</dt>
      <dd>Früh in der Saison sagt ein Ø aus 2–4 Spielen wenig. Die Vorsaison geht deshalb mit bis zu 6 „virtuellen Spielen“ ein; je mehr aktuelle Spiele, desto geringer ihr Einfluss.</dd>
      <dt>Tor-Modell</dt>
      <dd>Angriffs- und Abwehrstärke je Verein aus den Toren der laufenden Saison, geglättet mit der Vorsaison (Aufsteiger: 2.-Liga-Werte abgeschwächt). Daraus per Poisson-Verteilung: erwartete Tore, Sieg-/Remis-Chance und die Chance auf „zu Null“. Liegen Wettquoten vor, zählen sie zu 70 %.</dd>
      <dt>Erwartete Punkte (nächster Spieltag)</dt>
      <dd>Basis = 55 % gewichtete Form + 45 % geglätteter Ø. Multipliziert mit dem Spielausgangs-Faktor (0,85–1,18), einem Positionsfaktor (TW/ABW: Zu-Null-Chance, MF/ST: erwartete eigene Tore) und der Einsatzchance (75 % Kickbase-Prognose + 25 % tatsächliche Startelf-Quote, Verletzungsstatus).</dd>
      <dt>Fairer („echter“) Marktwert</dt>
      <dd>Regressionsmodell über alle ${a.fair.n} Bundesliga-Spieler: log(Marktwert) ~ Position + √Ø-Punkte + Einsatzchance. Bewertet wird mit dem geglätteten Ø. Es zeigt, was ein Spieler mit dieser Leistung typischerweise kostet. Erklärte Varianz R² = ${a.fair.r2 != null ? a.fair.r2.toFixed(2).replace('.', ',') : '–'}. „Unterbewertet“ = Marktwert liegt deutlich unter dem Modellwert.</dd>
      <dt>Marktwert-Trend</dt>
      <dd>50 % letzte Tagesänderung + 30 % Ø der letzten 3 Tage + 20 % Ø der letzten 14 Tage. Signale: „Hoch überschritten“ (fällt nach Anstieg nahe am 92-Tage-Hoch), „Trendwende nach oben“ usw.</dd>
      <dt>Kauf-Score (0–100)</dt>
      <dd>35 % Saison-Erwartung, 20 % Punkte je Mio., 20 % Unterbewertung, 15 % Marktwert-Momentum, 10 % Restprogramm (nächste 3 Gegner). Abzüge bei Verletzung/geringer Einsatzchance. Alles als Perzentil gegen die ganze Liga.</dd>
      <dt>Gebotsvorschlag</dt>
      <dd>Preis bzw. hochgerechneter Marktwert bei Ablauf + 1–6 % Aufschlag je nach Score + 2 % je Konkurrenzgebot (max. +8 %), gedeckelt beim fairen Marktwert (max. +20 %).</dd>
      <dt>Verkaufs-Score</dt>
      <dd>Schwache Saison-Erwartung, fallender Marktwert, Überbewertung, schweres Programm, Bankplatz, Verletzung.</dd>
    </dl>
    <p class="small muted">Alle Angaben sind Schätzungen ohne Gewähr – keine Garantie für Punkte oder Gewinne.</p>
  </section>
  <section class="card"><h2>Datenschutz</h2>
    <p class="small">Keine eigenen Server, kein Tracking. Deine Kickbase-Daten werden nur im Arbeitsspeicher dieses Tabs verarbeitet. <a href="datenschutz.html">Datenschutzerklärung</a></p>
    <p class="small muted">Inoffizielles Fan-Projekt. Nicht mit Kickbase verbunden oder von Kickbase unterstützt. „Kickbase“ ist eine Marke der jeweiligen Inhaber.</p>
    <p class="small muted">Version ${APP_VERSION}</p>
  </section>`;
}

// ------------------------------------------------------------ Spieler-Detail (Bottom-Sheet)

async function openPlayer(id) {
  const a = state.a;
  const p = a.players.get(id);
  if (!p) return;
  const st = statusInfo(p.st);
  const pr = PROB[p.prob];
  $sheet.innerHTML = `
  <div class="sheet-back" data-action="close"></div>
  <div class="sheet-body" role="dialog" aria-modal="true" aria-label="${esc(p.name)}">
    <button class="sheet-close icon-btn" data-action="close" aria-label="Schließen"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <div class="phead">${face(p, 72)}<div>
      <h2>${esc(p.fn)} ${esc(p.name)}</h2>
      <p>${crest(p.tim)} ${esc(p.teamName)} · ${POS_LONG[p.pos] || ''}</p>
      <p class="small">${p.ownerName ? `Besitzer: <b>${esc(p.ownerName)}</b>` : 'Ohne Besitzer'}${p.market ? ' · <b>auf dem Transfermarkt</b>' : ''}</p>
      <div class="chips">${st ? `<span class="chip ${st.level}">${esc(st.label)}</span>` : '<span class="chip good">✓ fit</span>'}${pr ? `<span class="chip ${pr.level}">${esc(pr.label)}</span>` : ''}</div>
    </div></div>
    <div class="grid4">
      ${stat('Marktwert', eur(p.mv))}
      ${stat('Fairer MW', eur(p.fair))}
      ${stat('Bewertung', gapBadge(p))}
      ${stat('MW-Trend', trend(p))}
      ${stat('Ø Punkte', num(p.ap))}
      ${stat('Gesamtpunkte', num(p.totalPts))}
      ${stat('Erw. nächstes Spiel', num(p.xp))}
      ${stat('Pkt/Mio', num1(p.eff))}
      ${p.goals != null ? stat('Tore / Vorlagen', `${p.goals} / ${p.assists}`) : ''}
      ${p.minutes != null ? stat('Minuten', num(p.minutes)) : ''}
      ${stat('Kauf-Score', p.buyScore)}
      ${p.mine ? stat('Verkaufs-Score', p.sellScore) : ''}
    </div>
    ${p.market ? `<div class="bid ${p.affordable ? '' : 'warn'}"><span>Gebotsvorschlag <b>${eur(p.bid)}</b> · max. ${eur(p.bidMax)} · läuft ab in ${countdown(p.market.exs)}</span>${p.market.offers ? `<small>${p.market.offers} Konkurrenzgebot(e) → Aufschlag +${Math.min(8, 2 * p.market.offers)} %</small>` : ''}</div>` : ''}
    ${playerActions(p)}
    <h3>Prognose-Grundlage</h3>
    ${basisTable(p)}
    <h3>Nächste Spiele</h3>
    <ul class="fixtures">${p.fixtures.slice(0, 4).map((f) => `<li><span>ST ${f.day}</span><span>${fixtureText(f, a.teams)}<br><small class="muted">erw. Tore ${num1(f.xgFor)} : ${num1(f.xgAgainst)} · zu Null ${Math.round(f.cs * 100)} %</small></span><span class="muted small">${f.odds ? 'Quote + Modell' : 'Modell'}</span></li>`).join('') || '<li class="muted">–</li>'}</ul>
    <div class="row-between"><h3>Marktwert</h3><div class="seg small" role="group"><button data-action="mvRange" data-v="92" class="on">3 Monate</button><button data-action="mvRange" data-v="365">1 Jahr</button></div></div>
    <div id="mvChart"><p class="muted">Lade …</p></div>
    <h3>Punkte je Spieltag</h3>
    <div id="ptsChart"><p class="muted">Lade …</p></div>
    <h3>Einsatz &amp; Konstanz</h3>
    <div id="usage"><p class="muted">Lade …</p></div>
    <h3>Transferhistorie (Liga)</h3>
    <div id="transfers"><p class="muted">Lade …</p></div>
  </div>`;
  $sheet.hidden = false;
  document.body.classList.add('noscroll');
  $sheet.dataset.pid = id;
  loadMv(id, 92);
  loadPts(id);
  loadTransfers(id);
}

async function loadMv(id, days) {
  const el = document.getElementById('mvChart');
  if (!el) return;
  try {
    const d = await state.kb.marketValue(id, days);
    const p = state.a.players.get(id);
    const pts = (d.it || []).map((x) => ({ x: new Date(x.dt * 864e5), y: x.mv }));
    if ($sheet.dataset.pid !== id) return;
    const extra = [];
    if (d.hmv) extra.push(`Hoch ${eur(d.hmv)}`);
    if (d.lmv) extra.push(`Tief ${eur(d.lmv)}`);
    if (d.trp) extra.push(`Kaufpreis ${eur(d.trp)}`);
    el.innerHTML = lineChart(pts, { hLine: p.fair ? { y: p.fair, label: 'fairer MW' } : null }) + `<p class="small muted">${extra.join(' · ')}</p>`;
    wireCharts(el);
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function loadPts(id) {
  const el = document.getElementById('ptsChart');
  try {
    const d = await state.kb.performance(id);
    const seasons = d.it || [];
    const cur = seasons[seasons.length - 1];
    const prev = seasons[seasons.length - 2];
    if ($sheet.dataset.pid !== id) return;
    const bars = (cur?.ph || []).filter((x) => x.mdst === 2 || x.p != null).map((x) => ({ label: String(x.day), value: x.p ?? null, sub: x.mp ? `${x.mp} gespielt` : 'nicht gespielt' }));
    const prevPts = prev?.ph?.filter((x) => x.p != null).map((x) => x.p) || [];
    el.innerHTML = (bars.length ? barChart(bars) : '<p class="muted">Noch keine Spiele in dieser Saison.</p>')
      + (prev ? `<p class="small muted">Vorsaison ${esc(prev.ti)}: ${prevPts.length} Spiele, Ø ${num(mean(prevPts))} Pkt, gesamt ${num(prevPts.reduce((s, v) => s + v, 0))}</p>` : '');
    wireCharts(el);
    const u = document.getElementById('usage');
    const cols = [cur, prev].filter(Boolean).map(seasonStats);
    const rows = [['Spiele (Team)', 'teamGames'], ['Einsätze', 'apps'], ['Startelf-Quote', 'startRate'], ['Joker-Einsätze', 'subs'],
      ['Minuten / Einsatz', 'mins'], ['Ø Punkte Heim', 'home'], ['Ø Punkte Auswärts', 'away'], ['Punkte / 90 Min', 'p90'],
      ['Bestwert', 'max'], ['Schwächster Wert', 'min'], ['Streuung', 'sd']];
    u.innerHTML = cols.length ? `<div class="table-wrap"><table class="rank"><thead><tr><th></th>${cols.map((c) => `<th class="r">${esc(c.name)}</th>`).join('')}</tr></thead><tbody>
      ${rows.map(([l, k]) => `<tr><td>${l}</td>${cols.map((c) => `<td class="r">${c[k]}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div><p class="small muted">Streuung = Standardabweichung der Punkte: je kleiner, desto verlässlicher.</p>` : '<p class="muted">–</p>';
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

function seasonStats(season) {
  const done = (season.ph || []).filter((x) => x.mdst === 2 || x.p != null);
  const played = done.filter((x) => x.p != null);
  const pts = played.map((x) => x.p);
  const totalMin = played.reduce((s, x) => s + (parseInt(x.mp, 10) || 0), 0);
  const avg = mean(pts);
  const sd = pts.length > 1 ? Math.sqrt(mean(pts.map((v) => (v - avg) ** 2))) : null;
  const starts = played.filter((x) => x.st === 5).length;
  return {
    name: season.ti,
    teamGames: num(done.length),
    apps: num(played.length),
    startRate: done.length ? `${Math.round((starts / done.length) * 100)} %` : '–',
    subs: num(played.length - starts),
    mins: played.length ? num(totalMin / played.length) : '–',
    home: num(mean(played.filter((x) => x.pt === x.t1).map((x) => x.p))),
    away: num(mean(played.filter((x) => x.pt === x.t2).map((x) => x.p))),
    p90: totalMin ? num((pts.reduce((s, v) => s + v, 0) / totalMin) * 90) : '–',
    max: pts.length ? num(Math.max(...pts)) : '–',
    min: pts.length ? num(Math.min(...pts)) : '–',
    sd: sd == null ? '–' : `± ${num(sd)}`,
  };
}

async function loadTransfers(id) {
  const el = document.getElementById('transfers');
  try {
    const d = await state.kb.transferHistory(id);
    if ($sheet.dataset.pid !== id) return;
    const it = (d.it || []).slice().reverse();
    el.innerHTML = it.length ? `<ul class="feed">${it.slice(0, 10).map((x) => `<li><span aria-hidden="true">⇄</span><span>${esc(x.unm || 'Kickbase')} · ${eur(x.trp)}</span><small class="muted">${new Date(x.dt).toLocaleDateString('de-DE')}</small></li>`).join('')}</ul>` : '<p class="muted">Keine Transfers in dieser Liga.</p>';
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function openManager(uid) {
  const a = state.a;
  const u = a.managers.get(uid);
  $sheet.innerHTML = `<div class="sheet-back" data-action="close"></div><div class="sheet-body" role="dialog" aria-modal="true">
    <button class="sheet-close icon-btn" data-action="close" aria-label="Schließen"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <h2>${esc(u?.n)}</h2><div id="mgr"><p class="muted">Lade …</p></div></div>`;
  $sheet.hidden = false;
  document.body.classList.add('noscroll');
  $sheet.dataset.pid = '';
  try {
    const [sq, dash] = await Promise.all([state.kb.managerSquad(uid), state.kb.managerDashboard(uid).catch(() => null)]);
    const ps = (sq.it || []).map((x) => a.players.get(x.pi)).filter(Boolean);
    const lu = optimalFor(ps);
    const byPos = [1, 2, 3, 4].map((pos) => ps.filter((p) => p.pos === pos));
    const el = document.getElementById('mgr');
    el.innerHTML = `
      <div class="grid4">
        ${stat('Platz', u?.spl ?? '–')}${stat('Punkte', num(u?.sp))}${stat('Teamwert', eur(u?.tv))}
        ${stat('Spieler', ps.length)}
        ${dash?.prft != null ? stat('Transfer-Gewinn', signedEur(dash.prft), deltaClass(dash.prft)) : ''}
        ${stat('Ø Pkt/Spieltag', num(u?.sp && a.ranking.day ? u.sp / a.ranking.day : null))}
        ${stat('Stärkste Elf (erw.)', num(lu))}
      </div>
      ${byPos.map((list, i) => list.length ? `<h3>${POS_LONG[i + 1]}</h3>${list.sort((x, y) => y.xs - x.xs).map((p) => playerRow(p, `<b>${eur(p.mv)}</b><small>Ø ${num(p.ap)}</small>`)).join('')}` : '').join('')}`;
  } catch (e) {
    document.getElementById('mgr').innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function optimalFor(ps) {
  let best = null;
  for (const f of FORMATIONS) { const t = formationTotal(ps, f); if (t != null && (best == null || t > best)) best = t; }
  return best;
}

function closeSheet() {
  $sheet.hidden = true;
  $sheet.innerHTML = '';
  document.body.classList.remove('noscroll');
  pending = null;
}

// ------------------------------------------------------------ Aktionen (schreibend – immer mit Bestätigung)

let pending = null; // { run: async () => {}, done: 'Erfolgsmeldung' }
const plain = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const parseEuro = (s) => { const v = parseInt(String(s).replace(/\D/g, ''), 10); return Number.isFinite(v) ? v : null; };
const round10k = (v) => Math.ceil(v / 10000) * 10000;

function toast(msg, level = 'good') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.className = `toast ${level}`;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 4000);
}

function openSheet(title, body) {
  $sheet.innerHTML = `<div class="sheet-back" data-action="close"></div><div class="sheet-body" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <button class="sheet-close icon-btn" data-action="close" aria-label="Schließen"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <h2>${esc(title)}</h2>${body}</div>`;
  $sheet.hidden = false;
  $sheet.dataset.pid = '';
  document.body.classList.add('noscroll');
}

function confirmAction({ title, body, confirmLabel, danger = false, run, done }) {
  openSheet(title, `${body}
    <div class="confirm-row"><button class="btn" data-action="close">Abbrechen</button>
    <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-action="runPending">${esc(confirmLabel)}</button></div>
    <p class="small muted">Wird sofort in deinem Kickbase-Konto ausgeführt.</p>`);
  pending = { run, done };
}

async function runPending(btn) {
  if (!pending) return;
  const { run, done } = pending;
  pending = null;
  btn.disabled = true;
  btn.textContent = 'Wird gesendet …';
  try {
    await run();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { closeSheet(); handleError(e); return; }
    btn.textContent = 'Fehlgeschlagen';
    const p = document.createElement('p');
    p.className = 'error';
    p.setAttribute('role', 'alert');
    p.textContent = e.message || 'Unbekannter Fehler';
    btn.closest('.sheet-body')?.append(p);
    return;
  }
  closeSheet();
  toast(`${done} Daten werden aktualisiert …`);
  await refreshLive();
  toast(done);
}

/** Nach einer Aktion nur veränderliche Daten neu laden; bereits geladene Spielerdaten bleiben erhalten. */
async function refreshLive() {
  const old = state.raw;
  try {
    state.kb.invalidateLive();
    const raw = await loadLeague(state.kb, () => {});
    for (const key of ['detailMap', 'perfMap', 'mvMap']) for (const [k, v] of old[key]) if (!raw[key].has(k)) raw[key].set(k, v);
    state.raw = raw;
    state.a = analyze(raw, state.s.user.id);
    render();
  } catch (e) { handleError(e); }
}

// ---- Aufstellung übernehmen

function applyLineup(f) {
  const a = state.a;
  const xi = formationXI(a.mine, f);
  if (!xi) { toast(`Für ${f} fehlen dir Spieler auf einer Position.`, 'crit'); return; }
  const total = xi.reduce((s, p) => s + p.xp, 0);
  const inn = xi.filter((p) => !a.currentXI.has(p.id));
  const outIds = new Set(xi.map((p) => p.id));
  const out = a.mine.filter((p) => a.currentXI.has(p.id) && !outIds.has(p.id));
  const risky = xi.filter((p) => !p.nextFix || statusInfo(p.st)?.level === 'crit' || p.prob >= 4);
  const lines = [1, 2, 3, 4].map((pos) => `<p><b>${POS[pos]}</b> ${xi.filter((p) => p.pos === pos).map((p) => `${esc(p.name)} <small class="muted">(${num(p.xp)})</small>`).join(', ')}</p>`).join('');
  confirmAction({
    title: `Aufstellung ${f} übernehmen`,
    body: `<p>Erwartet: <b>${num(total)} Punkte</b></p>${lines}
      ${inn.length ? `<p class="pos">▲ rein: ${inn.map((p) => esc(p.name)).join(', ')}</p>` : ''}
      ${out.length ? `<p class="neg">▼ raus: ${out.map((p) => esc(p.name)).join(', ')}</p>` : ''}
      ${risky.length ? `<p class="warn-text">! Achtung: ${risky.map((p) => esc(p.name)).join(', ')} (Verletzung, geringe Einsatzchance oder kein Spiel)</p>` : ''}`,
    confirmLabel: 'In Kickbase übernehmen',
    run: () => state.kb.setLineup(f, xi.map((p) => p.id)),
    done: `Aufstellung ${f} gespeichert.`,
  });
}

// ---- Bieten

function openBid(id) {
  const a = state.a;
  const p = a.players.get(id);
  if (!p?.market) return;
  const start = p.market.myBid || Math.max(p.bid, p.market.price);
  const presets = [['Preis', p.market.price], ['Vorschlag', p.bid], ['Max. sinnvoll', p.bidMax]]
    .filter(([, v], i, arr) => v && arr.findIndex((x) => x[1] === v) === i);
  openSheet(`${p.market.myBid ? 'Gebot ändern' : 'Gebot'}: ${p.fn} ${p.name}`, `
    <p class="small">Preis <b>${eur(p.market.price)}</b> · Marktwert ${eur(p.mv)} · fair ${eur(p.fair)} · läuft ab in ${countdown(p.market.exs)}${p.market.offers ? ` · ${p.market.offers} Konkurrenzgebot(e)` : ''}</p>
    <label class="field">Dein Gebot in €<input id="amount" inputmode="numeric" autocomplete="off" value="${plain.format(start)}"></label>
    <div class="presets">${presets.map(([l, v]) => `<button class="preset" data-action="preset" data-v="${v}">${l}<b>${eur(v)}</b></button>`).join('')}</div>
    <div id="amountInfo" class="amount-info"></div>
    <button class="btn primary" data-action="bidSubmit" data-id="${esc(id)}">Gebot abgeben</button>
    ${p.market.myBid ? `<p class="small muted">Dein bisheriges Gebot (${eur(p.market.myBid)}) wird dabei ersetzt.</p>` : ''}`);
  wireAmount(() => bidInfo(p));
}

function bidInfo(p) {
  const a = state.a;
  const v = parseEuro(document.getElementById('amount').value) || 0;
  const others = a.myBids.filter((x) => x.id !== p.id).reduce((s, x) => s + x.market.myBid, 0);
  const msgs = [];
  if (v < p.market.price) msgs.push(['crit', `Unter dem Preis von ${eur(p.market.price)} – Kickbase lehnt das ab.`]);
  if (v > p.bidMax) msgs.push(['warn', `Über dem sinnvollen Maximum (${eur(p.bidMax)}).`]);
  if (v + others > a.budget) msgs.push(['warn', `Alle deine Gebote zusammen (${eur(v + others)}) übersteigen dein Budget (${eur(a.budget)}).`]);
  return { ok: v >= p.market.price, label: `Gebot über ${eur(v)} abgeben`, html: `<p>Budget nach Zuschlag: <b class="${a.budget - v < 0 ? 'neg' : ''}">${eur(a.budget - v)}</b></p>${msgs.map(([l, t]) => `<p class="${l === 'crit' ? 'neg' : 'warn-text'}">${l === 'crit' ? '✕' : '!'} ${esc(t)}</p>`).join('')}` };
}

function wireAmount(info) {
  const input = document.getElementById('amount');
  const out = document.getElementById('amountInfo');
  const submit = $sheet.querySelector('[data-action=bidSubmit],[data-action=listSubmit]');
  const update = () => {
    const r = info();
    out.innerHTML = r.html;
    submit.disabled = !r.ok;
    submit.textContent = r.label;
  };
  input.addEventListener('input', update);
  input.addEventListener('blur', () => { const v = parseEuro(input.value); if (v) input.value = plain.format(v); });
  $sheet.querySelectorAll('[data-action=preset]').forEach((b) => b.addEventListener('click', () => { input.value = plain.format(Number(b.dataset.v)); update(); }));
  update();
}

function submitBid(id, btn) {
  const p = state.a.players.get(id);
  const v = parseEuro(document.getElementById('amount').value);
  if (!p || !v) return;
  const old = p.market.myBid ? { id: p.market.myBidId, price: p.market.myBid } : null;
  pending = {
    async run() {
      if (old?.id != null) {
        await state.kb.withdrawBid(id, old.id);
        try { await state.kb.placeBid(id, v); } catch (e) { await state.kb.placeBid(id, old.price).catch(() => {}); throw e; }
      } else {
        await state.kb.placeBid(id, v);
      }
    },
    done: `Gebot über ${eur(v)} für ${p.name} abgegeben.`,
  };
  runPending(btn);
}

function withdrawBid(id) {
  const p = state.a.players.get(id);
  confirmAction({
    title: 'Gebot zurückziehen',
    body: `<p>Dein Gebot über <b>${eur(p.market.myBid)}</b> für <b>${esc(p.name)}</b> zurückziehen?</p>`,
    confirmLabel: 'Zurückziehen',
    run: () => state.kb.withdrawBid(id, p.market.myBidId),
    done: `Gebot für ${p.name} zurückgezogen.`,
  });
}

// ---- Verkaufen

function openList(id) {
  const p = state.a.players.get(id);
  const presets = [['Marktwert', p.mv], ['MW +5 %', round10k(p.mv * 1.05)], ['MW +10 %', round10k(p.mv * 1.1)], ['Fairer MW', p.fair ? round10k(p.fair) : null]]
    .filter(([, v], i, arr) => v && v >= p.mv && arr.findIndex((x) => x[1] === v) === i);
  openSheet(`Verkaufen: ${p.fn} ${p.name}`, `
    <p class="small">Marktwert <b>${eur(p.mv)}</b> · fair ${eur(p.fair)} · ${p.buyGain != null ? `seit Kauf ${signedEur(p.buyGain)} · ` : ''}Verkaufs-Score ${p.sellScore} (${esc(p.sellLabel)})</p>
    <label class="field">Angebotspreis in €<input id="amount" inputmode="numeric" autocomplete="off" value="${plain.format(round10k(Math.min(Math.max(p.mv, p.fair ?? 0), p.mv * 1.1)))}"></label>
    <div class="presets">${presets.map(([l, v]) => `<button class="preset" data-action="preset" data-v="${v}">${l}<b>${eur(v)}</b></button>`).join('')}</div>
    <div id="amountInfo" class="amount-info"></div>
    <button class="btn primary" data-action="listSubmit" data-id="${esc(id)}">Auf den Transfermarkt setzen</button>
    <p class="small muted">Der Spieler bleibt in deinem Kader, bis du ein Angebot annimmst. Du kannst ihn jederzeit wieder vom Markt nehmen.</p>`);
  wireAmount(() => {
    const v = parseEuro(document.getElementById('amount').value) || 0;
    const warn = v > p.mv * 1.25 ? `<p class="warn-text">! Deutlich über Marktwert – Mitspieler bieten dann eher nicht.</p>` : '';
    return { ok: v > 0, label: `Für ${eur(v)} anbieten`, html: `<p>Im Vergleich zum Marktwert: <b class="${deltaClass(v - p.mv)}">${signedEur(v - p.mv)}</b></p>${warn}` };
  });
}

function submitList(id, btn) {
  const p = state.a.players.get(id);
  const v = parseEuro(document.getElementById('amount').value);
  if (!p || !v) return;
  pending = { run: () => state.kb.listPlayer(id, v), done: `${p.name} für ${eur(v)} auf den Transfermarkt gesetzt.` };
  runPending(btn);
}

function unlist(id) {
  const p = state.a.players.get(id);
  confirmAction({
    title: 'Vom Markt nehmen',
    body: `<p><b>${esc(p.name)}</b> vom Transfermarkt nehmen? Offene Angebote verfallen.</p>`,
    confirmLabel: 'Vom Markt nehmen',
    run: () => state.kb.unlistPlayer(id),
    done: `${p.name} ist nicht mehr auf dem Markt.`,
  });
}

function acceptOffer(id, oid) {
  const p = state.a.players.get(id);
  const o = p.market.offerList.find((x) => String(x.id) === oid);
  confirmAction({
    title: 'Angebot annehmen',
    body: `<p><b>${esc(p.name)}</b> für <b>${eur(o?.price)}</b> an <b>${esc(o?.from)}</b> verkaufen?</p>
      <p class="small">Marktwert ${eur(p.mv)} · Differenz <span class="${deltaClass((o?.price ?? 0) - p.mv)}">${signedEur((o?.price ?? 0) - p.mv)}</span></p>
      <p class="warn-text">! Der Verkauf kann nicht rückgängig gemacht werden.</p>`,
    confirmLabel: 'Verkaufen',
    danger: true,
    run: () => state.kb.acceptOffer(id, oid),
    done: `${p.name} verkauft.`,
  });
}

function declineOffer(id, oid) {
  const p = state.a.players.get(id);
  confirmAction({
    title: 'Angebot ablehnen',
    body: `<p>Angebot für <b>${esc(p.name)}</b> ablehnen?</p>`,
    confirmLabel: 'Ablehnen',
    run: () => state.kb.declineOffer(id, oid),
    done: 'Angebot abgelehnt.',
  });
}

/** Aktionsbereich im Spieler-Detail. */
function playerActions(p) {
  if (p.listedByMe) {
    const offers = p.market.offerList;
    return `<div class="actions-box"><h3>Dein Angebot · ${eur(p.market.price)}</h3>
      ${offers.length ? offers.map((o) => `<div class="offer"><span><b>${eur(o.price)}</b> von ${esc(o.from)} <small class="${deltaClass(o.price - p.mv)}">(${signedEur(o.price - p.mv)} zum MW)</small></span>
        <span><button class="btn small danger-solid" data-action="accept" data-id="${esc(p.id)}" data-oid="${esc(o.id)}">Annehmen</button>
        <button class="btn small" data-action="decline" data-id="${esc(p.id)}" data-oid="${esc(o.id)}">Ablehnen</button></span></div>`).join('')
        : '<p class="small muted">Noch keine Angebote.</p>'}
      <button class="btn small" data-action="unlist" data-id="${esc(p.id)}">Vom Markt nehmen</button></div>`;
  }
  if (p.mine) {
    return `<div class="actions-box"><button class="btn ${p.sellLabel === 'Verkaufen' ? 'primary' : ''}" data-action="list" data-id="${esc(p.id)}">Auf den Transfermarkt setzen …</button>
      <p class="small muted">Empfehlung: ${esc(p.sellLabel)} (Score ${p.sellScore})</p></div>`;
  }
  if (p.market) {
    return `<div class="actions-box">
      <button class="btn primary" data-action="bid" data-id="${esc(p.id)}">${p.market.myBid ? 'Gebot ändern …' : 'Bieten …'}</button>
      ${p.market.myBid ? `<button class="btn" data-action="withdraw" data-id="${esc(p.id)}">Gebot zurückziehen</button>` : ''}</div>`;
  }
  return '';
}

// ------------------------------------------------------------ Ereignisse

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-action]');
  if (!t || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'checkbox')) return;
  const act = t.dataset.action;
  switch (act) {
    case 'tab': state.tab = t.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'player': openPlayer(t.dataset.id); break;
    case 'manager': openManager(t.dataset.id); break;
    case 'close': closeSheet(); break;
    case 'league': openLeague(t.dataset.id); break;
    case 'switch': state.s.leagueId = null; session.update({ leagueId: null }); chooseLeague(); break;
    case 'marketPos': state.marketPos = Number(t.dataset.v); render(); break;
    case 'playerPos': state.playerPos = Number(t.dataset.v); render(); break;
    case 'playerFree': state.playerFree = t.checked; updatePlayerList(); break;
    case 'squadView': state.squadView = t.dataset.v; render(); break;
    case 'leagueView': state.leagueView = t.dataset.v; render(); break;
    // schreibende Aktionen
    case 'applyLineup': applyLineup(t.dataset.f); break;
    case 'bid': openBid(t.dataset.id); break;
    case 'bidSubmit': submitBid(t.dataset.id, t); break;
    case 'withdraw': withdrawBid(t.dataset.id); break;
    case 'list': openList(t.dataset.id); break;
    case 'listSubmit': submitList(t.dataset.id, t); break;
    case 'unlist': unlist(t.dataset.id); break;
    case 'accept': acceptOffer(t.dataset.id, t.dataset.oid); break;
    case 'decline': declineOffer(t.dataset.id, t.dataset.oid); break;
    case 'runPending': runPending(t); break;
    case 'mvRange':
      t.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === t));
      loadMv($sheet.dataset.pid, Number(t.dataset.v));
      break;
    case 'refresh': state.kb.clearCache(); openLeague(state.s.leagueId, { fresh: true }); break;
    case 'reload': location.reload(); break;
    case 'deep': {
      t.disabled = true;
      try {
        await loadAllDetails(state.kb, state.raw, (txt) => { t.textContent = txt; });
        state.a = analyze(state.raw, state.s.user.id);
        render();
      } catch (e) { handleError(e); }
      break;
    }
    case 'logout':
      session.clear();
      state.s = state.kb = state.raw = state.a = null;
      closeSheet();
      viewLogin();
      break;
    default: break;
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset.action === 'marketSort') { state.marketSort = t.value; render(); }
  if (t.dataset.action === 'playerSort') { state.playerSort = t.value; updatePlayerList(); }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$sheet.hidden) closeSheet();
  if (ev.key === 'Enter' && ev.target.matches('tr[data-action]')) ev.target.click();
});

// ------------------------------------------------------------ Start

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

state.s = session.get();
if (state.s) chooseLeague(); else viewLogin();
