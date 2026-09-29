// Datenaufbereitung & Analysemodell.
// Alles läuft lokal im Browser. Die Modelle sind bewusst einfach und nachvollziehbar gehalten.

import { pool } from './api.js';
import { clamp, mean } from './util.js';
import { fetchPrevTables, teamRatings, matchModel, playerHistory, blendedAverage, mvTrend } from './sources.js';

export const FORMATIONS = ['3-4-3', '3-5-2', '3-6-1', '4-2-4', '4-3-3', '4-4-2', '4-5-1', '5-2-3', '5-3-2', '5-4-1'];

// Einsatzfaktoren (Annahmen, siehe "So rechnet die App")
const PROB_FACTOR = { 1: 1, 2: 0.85, 3: 0.55, 4: 0.2, 5: 0.03 };
const CRIT_BITS = 1 | 8 | 16 | 32 | 64 | 128 | 256;
const TREND_EPS = 0.002; // ab ±0,2 % pro Tag gilt ein Marktwert als steigend/fallend
const MD_SOON_HOURS = 48; // "Spieltag steht an"
const TRADING_REL = 0.02; // ab +2 % MW pro Tag lohnt sich ein reiner Wert-Kauf
const POINT_EUR = 20000; // Heuristik: Wert eines erwarteten Spieltagspunkts in € (für Budget-Ausgleich)

function statusText(p) {
  if (p.st & 1) return 'verletzt';
  if (p.st & (8 | 16 | 32)) return 'gesperrt';
  if (p.st & (64 | 128 | 256)) return 'nicht verfügbar';
  if (p.prob >= 5) return 'kein Einsatz erwartet';
  return 'eingeschränkt';
}

function nextMatchFactor(st) {
  if (!st) return 1;
  if (st & CRIT_BITS) return 0;
  if (st & 4) return 0.3; // Aufbautraining
  if (st & 2) return 0.75; // angeschlagen
  return 1;
}

function seasonFactor(st) {
  if (!st) return 1;
  if (st & (64 | 128)) return 0; // nicht im Kader / weg
  if (st & 1) return 0.55;
  if (st & 4) return 0.7;
  if (st & (8 | 16 | 32)) return 0.9;
  if (st & 2) return 0.9;
  return 1;
}

// ---------------------------------------------------------------- Laden

/**
 * Lädt alle Rohdaten einer Liga. onProgress(text, fraction)
 */
export async function loadLeague(kb, onProgress = () => {}) {
  onProgress('Liga & Kader laden …', 0.02);
  const [me, overview, squad, market, ranking, table, matchdays, eleven] = await Promise.all([
    kb.me(), kb.overview(), kb.squad(), kb.market(), kb.ranking(), kb.table(), kb.matchdays(),
    kb.myEleven().catch(() => null),
  ]);

  // Externe Quelle (OpenLigaDB) parallel laden – optional
  const firstMatch = matchdays.it.flatMap((d) => d.it).map((m) => m.dt).sort()[0];
  const seasonStart = firstMatch ? new Date(firstMatch).getFullYear() : new Date().getFullYear();
  const prevTablesP = fetchPrevTables(seasonStart);

  onProgress('Alle Bundesliga-Kader laden …', 0.12);
  const tids = table.it.map((t) => t.tid);
  const profiles = await pool(tids, 6, (tid) => kb.teamProfile(tid), (d, n) => onProgress(`Vereine ${d}/${n} …`, 0.12 + 0.28 * (d / n)));

  // Detaildaten, Leistungshistorie & MW-Verlauf für eigene Spieler + Transfermarkt
  const detailIds = [...new Set([...squad.it.map((p) => p.i), ...market.it.map((p) => p.i)])];
  const raw = {
    me, overview, squad, market, ranking, table, matchdays, eleven, profiles: profiles.filter(Boolean),
    detailMap: new Map(), perfMap: new Map(), mvMap: new Map(), loadedAt: Date.now(),
  };
  await loadPlayerData(kb, raw, detailIds, { mv: true }, (d, n) => onProgress(`Spielerdaten ${d}/${n} …`, 0.4 + 0.58 * (d / n)));
  raw.prevTables = await prevTablesP;
  return raw;
}

/** Lädt Detail, Leistungshistorie (und optional MW-Verlauf) für die angegebenen Spieler. */
async function loadPlayerData(kb, raw, ids, { mv = false } = {}, onProgress) {
  await pool(ids, 6, async (pid) => {
    const [d, perf, hist] = await Promise.all([
      raw.detailMap.has(pid) ? null : kb.player(pid).catch(() => null),
      raw.perfMap.has(pid) ? null : kb.performance(pid).catch(() => null),
      mv && !raw.mvMap.has(pid) ? kb.marketValue(pid, 92).catch(() => null) : null,
    ]);
    if (d) raw.detailMap.set(pid, d);
    if (perf) raw.perfMap.set(pid, perf);
    if (hist) raw.mvMap.set(pid, hist);
  }, onProgress);
}

/** Optional: Detaildaten & Historie für alle Spieler nachladen (Tiefenanalyse, ca. 25 MB). */
export async function loadAllDetails(kb, raw, onProgress) {
  const ids = [];
  for (const tp of raw.profiles) for (const p of tp.it) if (!raw.detailMap.has(p.i) || !raw.perfMap.has(p.i)) ids.push(p.i);
  await loadPlayerData(kb, raw, ids, {}, (d, n) => onProgress?.(`Spieler ${d}/${n} …`, d / n));
}

// ---------------------------------------------------------------- Spielplan / Gegnerstärke

function buildFixtures(matchdays, tr) {
  const days = matchdays.it.slice().sort((a, b) => a.day - b.day);
  const upcoming = days.filter((d) => d.it.some((m) => m.st !== 2));
  const nextDay = upcoming[0]?.day ?? null;
  const fixtures = new Map(); // tid -> [{day, opp, home, dt, win, draw, loss, odds}]
  const symbols = new Map();

  for (const d of days) for (const m of d.it) {
    symbols.set(m.t1, m.t1sy);
    symbols.set(m.t2, m.t2sy);
  }

  for (const d of upcoming.slice(0, 5)) {
    for (const m of d.it) {
      if (m.st === 2) continue;
      // Tor-Modell (Kickbase-Ergebnisse + OpenLigaDB-Vorsaison); Wettquoten haben Vorrang (70 %)
      const mm = matchModel(tr, m.t1, m.t2) || { lh: tr.base, la: tr.base, pH: 0.45, pD: 0.25, pA: 0.3 };
      let pH = mm.pH, pD = mm.pD, pA = mm.pA, odds = false;
      if (m.bo && m.bo.o1 && m.bo.ox && m.bo.o2) {
        const a = 1 / m.bo.o1, b = 1 / m.bo.ox, c = 1 / m.bo.o2, s = a + b + c;
        pH = 0.7 * (a / s) + 0.3 * mm.pH; pD = 0.7 * (b / s) + 0.3 * mm.pD; pA = 0.7 * (c / s) + 0.3 * mm.pA;
        odds = true;
      }
      const push = (tid, opp, home, win, draw, loss, xgFor, xgAgainst) => {
        if (!fixtures.has(tid)) fixtures.set(tid, []);
        fixtures.get(tid).push({ day: d.day, opp, home, dt: m.dt, win, draw, loss, odds, xgFor, xgAgainst, cs: Math.exp(-xgAgainst) });
      };
      push(m.t1, m.t2, true, pH, pD, pA, mm.lh, mm.la);
      push(m.t2, m.t1, false, pA, pD, pH, mm.la, mm.lh);
    }
  }
  const finished = days.filter((d) => d.it.every((m) => m.st === 2));
  const lastDate = finished.length ? finished[finished.length - 1].it.map((m) => m.dt).sort().pop() : null;
  return { fixtures, nextDay, symbols, lastDate, nextDate: upcoming[0]?.it.map((m) => m.dt).sort()[0] ?? null };
}

/**
 * Punkte-Multiplikator aus erwartetem Spielausgang (≈0,85 … 1,18) und positionsabhängig
 * aus dem Tor-Modell: TW/ABW profitieren von "zu Null", MF/ST von vielen eigenen Toren.
 */
function fixtureMult(f, pos, base) {
  if (!f) return 1;
  const result = 0.75 + 0.5 * (f.win + 0.5 * f.draw);
  const csAvg = Math.exp(-base);
  const posAdj = pos <= 2
    ? clamp(0.9 + 0.1 * (f.cs / csAvg), 0.9, 1.15)
    : clamp(0.9 + 0.1 * (f.xgFor / base), 0.9, 1.15);
  return result * posAdj;
}

// ---------------------------------------------------------------- Regression (fairer Marktwert)

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

function ols(X, y, ridge = 1e-3) {
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < k; a++) XtX[a][a] += ridge;
  return solve(XtX, Xty);
}

function features(p, useAdjusted = false) {
  const ap = Math.max((useAdjusted ? p.apAdj ?? p.ap : p.ap) ?? 0, 0);
  return [p.pos === 1 ? 1 : 0, p.pos === 2 ? 1 : 0, p.pos === 3 ? 1 : 0, p.pos === 4 ? 1 : 0,
    Math.sqrt(ap), p.availSeason, Math.sqrt(ap) * p.availSeason];
}

/**
 * "Echter" Marktwert: Was kostet ein Spieler mit dieser Leistung (Ø-Punkte, Position,
 * Einsatzchance) typischerweise auf dem Kickbase-Markt? log(MW) ~ Position + √Ø-Punkte + Einsatz.
 */
function fitFairValue(players) {
  const train = players.filter((p) => p.mv > 0 && p.ap != null && !(p.st & (64 | 128)));
  if (train.length < 30) return { predict: () => null, r2: null, n: train.length };
  const X = train.map(features);
  const y = train.map((p) => Math.log(p.mv));
  const beta = ols(X, y);
  if (!beta) return { predict: () => null, r2: null, n: train.length };
  const pred = (p, adj = false) => features(p, adj).reduce((s, x, i) => s + x * beta[i], 0);
  const res = train.map((p, i) => y[i] - pred(p));
  const smear = mean(res.map(Math.exp)); // Duan-Smearing für Rücktransformation
  const my = mean(y);
  const ssTot = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const ssRes = res.reduce((s, v) => s + v * v, 0);
  return {
    // Vorhersage mit dem geglätteten Ø (inkl. Vorsaison), sofern vorhanden
    predict: (p) => ((p.apAdj ?? p.ap) == null ? null : Math.max(500000, Math.exp(pred(p, true)) * smear)),
    r2: 1 - ssRes / ssTot,
    n: train.length,
  };
}

// ---------------------------------------------------------------- Perzentile

function percentiler(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return (v) => {
    if (!Number.isFinite(v) || !sorted.length) return 0.5;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
    return lo / sorted.length;
  };
}

// ---------------------------------------------------------------- Aufstellung

export function optimalLineup(players, key = 'xp') {
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of players) byPos[p.pos]?.push(p);
  for (const k in byPos) byPos[k].sort((a, b) => b[key] - a[key]);
  let best = null;
  for (const f of FORMATIONS) {
    const [d, m, s] = f.split('-').map(Number);
    if (byPos[1].length < 1 || byPos[2].length < d || byPos[3].length < m || byPos[4].length < s) continue;
    const xi = [byPos[1][0], ...byPos[2].slice(0, d), ...byPos[3].slice(0, m), ...byPos[4].slice(0, s)];
    const total = xi.reduce((sum, p) => sum + p[key], 0);
    if (!best || total > best.total) best = { formation: f, xi, total };
  }
  if (!best) return null;
  const ids = new Set(best.xi.map((p) => p.id));
  best.bench = players.filter((p) => !ids.has(p.id)).sort((a, b) => b[key] - a[key]);
  return best;
}

// ---------------------------------------------------------------- Hauptanalyse

export function analyze(raw, myUserId) {
  const tr = teamRatings(raw.matchdays, raw.table, raw.prevTables);
  const { fixtures, nextDay, symbols, nextDate, lastDate } = buildFixtures(raw.matchdays, tr);
  // Tage seit dem letzten Spieltag (Kickbase liefert die MW-Änderung seit dem Spieltag)
  const daysSinceMd = lastDate ? clamp((Date.now() - new Date(lastDate).getTime()) / 864e5, 1, 60) : 7;
  const teamMap = new Map(raw.table.it.map((t) => [t.tid, { ...t, sy: symbols.get(t.tid) || t.tn.slice(0, 3).toUpperCase() }]));

  const managers = new Map(raw.ranking.us.map((u) => [u.i, u]));
  const marketMap = new Map(raw.market.it.map((m) => [m.i, m]));
  const squadMap = new Map(raw.squad.it.map((s) => [s.i, s]));

  // Alle Spieler der Bundesliga (aus Vereinsprofilen) zusammenführen
  const players = new Map();
  for (const tp of raw.profiles) {
    for (const p of tp.it) {
      players.set(p.i, {
        id: p.i, name: p.n, tid: p.tid, pos: p.pos, mv: p.mv, ap: p.ap ?? null, st: p.st || 0, prob: p.prob,
        mvMd: p.sdmvt ?? null, mv24: null, mvt: p.mvt, pim: p.pim,
        ownerId: p.oui != null ? String(p.oui) : null, ownerName: p.onm || null,
      });
    }
  }
  // Transfermarkt & eigener Kader können Spieler enthalten, die (noch) nicht im Profil sind
  for (const src of [raw.market.it, raw.squad.it]) {
    for (const p of src) {
      if (!players.has(p.i)) {
        players.set(p.i, { id: p.i, name: p.n, tid: p.tid, pos: p.pos, mv: p.mv, ap: p.ap ?? null, st: p.st || 0, prob: p.prob, mvMd: p.sdmvt ?? null, mv24: null, mvt: p.mvt, pim: p.pim, ownerId: null, ownerName: null });
      }
    }
  }

  const myId = String(myUserId);
  for (const p of players.values()) {
    const s = squadMap.get(p.id);
    const m = marketMap.get(p.id);
    const d = raw.detailMap.get(p.id);
    const team = teamMap.get(p.tid);
    p.teamName = team?.tn ?? '';
    p.teamSy = team?.sy ?? '';
    p.tim = team?.tim ?? d?.tim ?? null;
    p.fn = m?.fn || d?.fn || '';
    if (d) {
      p.name = d.ln || p.name;
      p.fn = d.fn || p.fn;
      p.totalPts = d.tp ?? null;
      p.goals = d.g; p.assists = d.a;
      p.minutes = d.sec != null ? Math.round(d.sec / 60) : null;
      p.mv24 = d.tfhmvt ?? null;
      const played = (d.ph || []).filter((x) => x.hp);
      p.last = (d.ph || []).map((x) => (x.hp ? x.p : null));
      if (played.length) {
        const w = played.map((_, i) => 1 + i * 0.5); // jüngere Spiele stärker gewichten
        p.form = played.reduce((s2, x, i) => s2 + x.p * w[i], 0) / w.reduce((a, b) => a + b, 0);
      }
      p.lp = d.plpt || null; // Quelle der Startelfprognose (z. B. Ligainsider)
    }
    if (s) {
      p.mine = true;
      p.ownerId = myId;
      p.buyGain = s.mvgl ?? null; // Wertänderung seit Kauf
      p.mv24 = s.tfhmvt ?? p.mv24;
      p.totalPts = p.totalPts ?? s.p ?? null;
      p.lineupSlot = s.lo ?? null;
    }
    if (m) {
      p.market = { price: m.prc, exs: m.exs, offers: m.ofc, seller: m.u ? { id: m.u.i, name: m.u.n } : null, isNew: m.isn, since: m.dt, myBid: m.uop ?? null, myBidId: m.uoid ?? null,
        // Angebote auf eigene, gelistete Spieler (Feldnamen defensiv, da unterschiedlich benannt)
        offerList: (Array.isArray(m.ofs) ? m.ofs : []).map((o) => ({
          id: o.i ?? o.id ?? o.uoid, price: o.uop ?? o.prc ?? o.price ?? o.p, from: o.unm ?? o.u?.n ?? o.n ?? 'Kickbase', dt: o.dt ?? null,
        })).filter((o) => o.id != null) };
      p.listedByMe = m.u?.i === String(myUserId);
      p.totalPts = p.totalPts ?? m.p ?? null;
    }
    if (p.ownerId && !p.ownerName) p.ownerName = managers.get(p.ownerId)?.n ?? null;
    p.games = p.totalPts != null && p.ap ? Math.round(p.totalPts / p.ap) : null;

    // Leistungshistorie: Vorsaison als Prior für den (früh in der Saison wackeligen) Ø
    p.hist = playerHistory(raw.perfMap.get(p.id));
    const blended = blendedAverage(p.ap, p.hist?.cur?.games ?? p.games, p.hist);
    p.apAdj = blended.value;
    p.priorWeight = blended.weight;

    // Einsatzwahrscheinlichkeiten: Kickbase-Prognose, ergänzt um die tatsächliche Startelf-Quote
    const probF = PROB_FACTOR[p.prob];
    const cur = p.hist?.cur;
    p.startShare = cur && cur.recentGames >= 2 ? cur.recentStarts / cur.recentGames : null;
    let avail = probF ?? 0.6;
    if (p.startShare != null) avail = probF != null ? 0.75 * probF + 0.25 * p.startShare : 0.4 + 0.5 * p.startShare;
    p.availNext = avail * nextMatchFactor(p.st);
    p.availSeason = clamp(avail * 0.6 + 0.4, 0, 1) * seasonFactor(p.st);

    // Spielplan
    p.fixtures = fixtures.get(p.tid) || [];
    const nextFix = p.fixtures.find((f) => f.day === nextDay);
    p.nextFix = nextFix || null;
    p.fixEase = p.fixtures.length ? mean(p.fixtures.slice(0, 3).map((f) => f.win + 0.5 * f.draw)) : 0.5;

    // Erwartete Punkte
    const avgPts = p.apAdj ?? p.ap;
    const base = p.form != null && avgPts != null ? 0.55 * p.form + 0.45 * avgPts : (p.form ?? avgPts ?? 0);
    p.base = base;
    p.xp = nextFix ? (base > 0 ? base * fixtureMult(nextFix, p.pos, tr.base) : base) * p.availNext : 0;
    const seasonBase = avgPts ?? p.form ?? 0;
    p.xs = (seasonBase > 0 ? seasonBase * (0.75 + 0.5 * p.fixEase) : seasonBase) * p.availSeason;

    // Marktwert-Trend (€/Tag): letzter Tag, ergänzt um 3- und 14-Tage-Steigung aus dem Verlauf
    p.daily = p.mv24 ?? (p.mvMd != null ? p.mvMd / daysSinceMd : 0);
    p.mvTrend = mvTrend(raw.mvMap.get(p.id));
    if (p.mvTrend) p.daily = 0.5 * p.daily + 0.3 * p.mvTrend.s3 + 0.2 * p.mvTrend.s14;
    // Momentum: relative Änderung seit Spieltag, auf 7 Tage normiert
    p.mom = p.mv ? clamp(((p.mvMd ?? p.daily * daysSinceMd) / daysSinceMd) * 7 / p.mv, -0.5, 0.5) : 0;
    p.mvIn7 = p.mv + p.daily * 7 * 0.7; // gedämpfte Fortschreibung
  }

  const all = [...players.values()];
  const fair = fitFairValue(all);
  for (const p of all) {
    p.fair = fair.predict(p);
    p.gap = p.fair ? p.fair / p.mv - 1 : null;
    p.eff = p.mv ? p.xs / (p.mv / 1e6) : 0; // erwartete Punkte pro Spiel je Mio.
  }

  // Perzentile ligaweit (nur Spieler mit Einsatz-Chance)
  const pool2 = all.filter((p) => p.ap != null);
  const qXs = percentiler(pool2.map((p) => p.xs));
  const qEff = percentiler(pool2.map((p) => p.eff));
  const qGap = percentiler(pool2.map((p) => p.gap ?? 0));
  const qMom = percentiler(pool2.map((p) => p.mom));
  const qFix = percentiler(all.map((p) => p.fixEase));

  for (const p of all) {
    p.q = { xs: qXs(p.xs), eff: qEff(p.eff), gap: qGap(p.gap ?? 0), mom: qMom(p.mom), fix: qFix(p.fixEase) };
  }

  // Eigener Kader & Aufstellung
  const mine = all.filter((p) => p.mine);
  const lineup = optimalLineup(mine, 'xp');
  const xiIds = new Set(lineup?.xi.map((p) => p.id) || []);
  const current = new Set((raw.eleven?.lp || []).map((p) => p.i));

  const budget = raw.me.b;
  const hoursToMd = nextDate ? (new Date(nextDate) - Date.now()) / 36e5 : null;
  const mdSoon = hoursToMd != null && hoursToMd <= MD_SOON_HOURS; // "Spieltag steht an"
  const daysToMd = hoursToMd != null ? Math.max(0.5, hoursToMd / 24) : 7;

  // ---- Verkaufs-Empfehlung eigener Spieler
  // Grundsatz: Steigt der Marktwert, ist ein Verkauf sinnlos – außer das Budget ist negativ und der Spieltag
  // steht an. Fällt er, sollte vor dem nächsten MW-Update verkauft werden (sofern der Spieler entbehrlich ist).
  for (const p of mine) {
    p.inBestXI = xiIds.has(p.id);
    p.inCurrentXI = current.has(p.id);
    const rel = p.mv ? p.daily / p.mv : 0; // relative MW-Änderung pro Tag
    p.mvRel = rel;
    const rising = rel > TREND_EPS;
    const falling = rel < -TREND_EPS;
    const peak = p.mvTrend?.signal === 'Hoch überschritten';
    const injured = (p.st & CRIT_BITS) || p.prob >= 5;
    const reasons = [];
    let sell = 0;
    if (falling) { sell += clamp(-rel * 100 * 12, 5, 40); reasons.push(['neg', `MW fällt (${(rel * 100).toFixed(1).replace('.', ',')} %/Tag)`]); }
    if (peak) { sell += 15; reasons.push(['neg', 'Marktwert-Hoch überschritten']); }
    if (!p.inBestXI) { sell += 15; reasons.push(['neg', 'nicht in deiner besten Elf']); }
    if (p.q.xs < 0.35) { sell += 10; reasons.push(['neg', 'schwache Punkteerwartung']); }
    if (injured) { sell += 10; reasons.push(['neg', statusText(p)]); }
    if (p.gap != null && p.gap < -0.25) { sell += 10; reasons.push(['neg', 'deutlich überbewertet']); }
    if (p.inBestXI) { sell -= 15; reasons.push(['pos', `Stammspieler deiner Elf (${Math.round(p.xp)} Pkt erw.)`]); }
    if (rising) {
      sell = Math.min(sell, 20);
      reasons.unshift(['pos', `MW steigt (+${(rel * 100).toFixed(1).replace('.', ',')} %/Tag) – Wertzuwachs mitnehmen`]);
    }
    p.sellScore = Math.round(clamp(sell, 0, 100));
    p.sellLabel = rising ? 'Halten – steigt' : p.sellScore >= 50 ? 'Verkaufen' : p.sellScore >= 30 ? 'Verkauf prüfen' : 'Halten';
    p.sellReasons = reasons;
    p.sellTiming = rising ? 'Wenn überhaupt: erst nach dem nächsten MW-Update verkaufen.'
      : falling && p.sellScore >= 30 ? 'Vor dem nächsten MW-Update verkaufen – danach ist er weniger wert.' : null;
  }

  // ---- Budget-Ausgleich: nur nötig, wenn der Kontostand negativ ist
  let rescue = null;
  if (budget < 0) {
    // "Schmerz" eines Verkaufs in €: entgangene Punkte (nur Stammelf) + entgangener Wertzuwachs bis zum Spieltag;
    // fallende Spieler abzugeben spart sogar Verlust (negativer Beitrag). Bewertet je freigesetztem Euro.
    const pain = (p) => (p.inBestXI ? p.xp * POINT_EUR : 0) + p.daily * daysToMd;
    const cands = mine.slice().sort((x, y) => pain(x) / x.mv - pain(y) / y.mv);
    const need = -budget;
    let covered = 0;
    const pick = [];
    for (const p of cands) { if (covered >= need) break; pick.push(p); covered += p.mv; }
    // Überflüssige Verkäufe wieder streichen (teuerste zuerst prüfen)
    for (const p of pick.slice().sort((x, y) => pain(y) - pain(x))) {
      if (covered - p.mv >= need) { pick.splice(pick.indexOf(p), 1); covered -= p.mv; }
    }
    for (const p of pick) {
      p.sellLabel = mdSoon ? 'Verkaufen (Budget)' : 'Bis Spieltag verkaufen';
      p.sellReasons = [['neg', `Budget ausgleichen (${(-budget / 1e6).toFixed(2).replace('.', ',')} Mio. fehlen)`], ...p.sellReasons];
      p.sellTiming = p.daily > 0
        ? 'Steigt noch: möglichst spät verkaufen, aber vor Anpfiff.'
        : 'Fällt: vor dem nächsten MW-Update verkaufen.';
    }
    rescue = { need, covered, pick, urgent: mdSoon, hoursToMd };
  }

  // ---- Kauf-Empfehlungen (alle Spieler, damit Markt und Spieler-Datenbank gleich bewerten)
  const baseTotal = lineup?.total ?? 0;
  for (const p of all) {
    // Wie sehr würde der Spieler deine beste Elf verbessern?
    p.xiGain = p.mine ? 0 : Math.max(0, (optimalLineup([...mine, p], 'xp')?.total ?? baseTotal) - baseTotal);
    const rel = p.mv ? p.daily / p.mv : 0;
    p.mvRel = rel;
    let buy = 100 * (0.3 * p.q.xs + 0.15 * p.q.eff + 0.15 * p.q.gap + 0.2 * p.q.mom + 0.1 * p.q.fix + 0.1 * clamp(p.xiGain / 40, 0, 1));
    if (p.st & CRIT_BITS) buy *= 0.6;
    if (p.prob >= 4) buy *= 0.7;
    if (p.ap == null) buy *= 0.5;
    p.buyScore = Math.round(buy);
    const reasons = [];
    if (p.xiGain >= 5) reasons.push(['pos', `stärkt deine Elf um +${Math.round(p.xiGain)} Pkt`]);
    if (rel > TREND_EPS) reasons.push(['pos', `MW steigt (+${(rel * 100).toFixed(1).replace('.', ',')} %/Tag)`]);
    if (rel < -TREND_EPS) reasons.push(['neg', `MW fällt (${(rel * 100).toFixed(1).replace('.', ',')} %/Tag)`]);
    if (p.gap != null && p.gap > 0.15) reasons.push(['pos', p.gap > 1 ? 'stark unterbewertet' : `unterbewertet (${Math.round(p.gap * 100)} %)`]);
    if (p.gap != null && p.gap < -0.2) reasons.push(['neg', 'überbewertet']);
    if (p.q.fix > 0.7) reasons.push(['pos', 'leichtes Restprogramm']);
    if (p.st & CRIT_BITS) reasons.push(['neg', statusText(p)]);
    p.buyReasons = reasons;
    let label = p.buyScore >= 70 ? 'Top-Kauf' : p.buyScore >= 56 ? 'Kaufen' : p.buyScore >= 42 ? 'Beobachten' : 'Meiden';
    // Fällt der Marktwert deutlich, wird er morgen billiger: abwarten statt kaufen
    if (rel < -0.01 && /Kauf/.test(label)) label = 'Abwarten (MW fällt)';
    // Reines Wertgeschäft: kaum Punkte, aber stark steigender Marktwert → kaufen, halten, teurer verkaufen
    p.trading = !/Kauf/.test(label) && rel >= TRADING_REL && !(p.st & CRIT_BITS);
    if (p.trading) {
      label = 'Trading-Kauf';
      reasons.unshift(['pos', `ca. +${(p.daily * 3 / 1e6).toFixed(2).replace('.', ',')} Mio. Wertzuwachs in 3 Tagen erwartet`]);
    }
    p.buyLabel = label;
  }

  // ---- Gebotsvorschläge (Transfermarkt)
  const market = all.filter((p) => p.market);
  for (const p of market) {
    const days = (p.market.exs || 0) / 86400;
    const projected = p.mv + Math.max(0, p.daily) * days;
    // Konkurrenz: jedes vorliegende Gebot anderer Manager erhöht den nötigen Aufschlag
    const premium = (p.buyScore >= 70 ? 0.06 : p.buyScore >= 56 ? 0.03 : 0.01) + Math.min(0.08, 0.02 * (p.market.offers || 0));
    const floor = Math.max(p.market.price, projected);
    const cap = Math.max(p.market.price, Math.min(p.fair ?? p.mv, p.mv * 1.2));
    let bid = floor * (1 + premium);
    if (bid > cap && p.buyScore < 70) bid = Math.max(floor, cap);
    if (p.trading) {
      // Beim Trading höchstens die Hälfte des erwarteten 3-Tage-Zuwachses als Aufschlag zahlen
      const tradeCap = Math.max(p.market.price, p.mv + 0.5 * p.daily * 3);
      bid = Math.min(Math.max(p.market.price, projected) * (1 + Math.min(0.08, 0.02 * (p.market.offers || 0))), tradeCap);
      p.bidMaxOverride = tradeCap;
    }
    p.bid = Math.ceil(bid / 10000) * 10000;
    p.bidMax = Math.ceil(Math.max(p.bidMaxOverride ?? cap, p.bid) / 10000) * 10000;
    p.affordable = p.bid <= budget;
    if (p.market.myBid) p.bidStatus = p.market.myBid < p.market.price ? 'zu niedrig' : p.market.myBid < p.bid ? 'unter Vorschlag' : p.market.myBid > p.bidMax ? 'über Maximum' : 'passt';
  }

  // Tauschvorschläge: Verkaufe X, kaufe Y (gleiche Position, bessere Erwartung)
  const swaps = [];
  for (const buy of market.filter((p) => !p.mine && p.buyScore >= 50 && !/Abwarten/.test(p.buyLabel))) {
    // Steigende Spieler nicht zum Tausch vorschlagen (Wertzuwachs mitnehmen)
    for (const sell of mine.filter((p) => p.pos === buy.pos && !/steigt/.test(p.sellLabel))) {
      const gain = buy.xs - sell.xs;
      if (gain <= 5) continue;
      const net = buy.bid - sell.mv;
      if (budget - net < 0) continue;
      swaps.push({ buy, sell, gain, net, value: gain / Math.max(1, net / 1e6 + 5) });
    }
  }
  swaps.sort((a, b) => b.value - a.value);
  const usedB = new Set(), usedS = new Set(), topSwaps = [];
  for (const s of swaps) {
    if (usedB.has(s.buy.id) || usedS.has(s.sell.id)) continue;
    usedB.add(s.buy.id); usedS.add(s.sell.id); topSwaps.push(s);
    if (topSwaps.length >= 6) break;
  }

  return {
    mdSoon, hoursToMd,
    players, all, mine, market, lineup, fixtures, mvUpdate: raw.market.mvud || null, teamRatings: tr,
    sources: {
      openLigaDb: raw.prevTables ? raw.prevTables.season : null,
      history: raw.perfMap.size,
      mvHistory: raw.mvMap.size,
      details: raw.detailMap.size,
    },
    myBids: market.filter((p) => p.market.myBid), currentXI: current, swaps: topSwaps, rescue,
    budget, teamValue: mine.reduce((s, p) => s + p.mv, 0),
    nextDay, nextDate, lastDate, daysSinceMd, teams: teamMap, managers, fair,
    ranking: raw.ranking, me: raw.me, overview: raw.overview, myId,
  };
}
