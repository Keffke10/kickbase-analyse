// Datenaufbereitung & Analysemodell.
// Alles läuft lokal im Browser. Die Modelle sind bewusst einfach und nachvollziehbar gehalten.

import { pool } from './api.js';
import { clamp, mean } from './util.js';

export const FORMATIONS = ['3-4-3', '3-5-2', '3-6-1', '4-2-4', '4-3-3', '4-4-2', '4-5-1', '5-2-3', '5-3-2', '5-4-1'];

// Einsatzfaktoren (Annahmen, siehe "So rechnet die App")
const PROB_FACTOR = { 1: 1, 2: 0.85, 3: 0.55, 4: 0.2, 5: 0.03 };
const CRIT_BITS = 1 | 8 | 16 | 32 | 64 | 128 | 256;

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

  onProgress('Alle Bundesliga-Kader laden …', 0.15);
  const tids = table.it.map((t) => t.tid);
  const profiles = await pool(tids, 6, (tid) => kb.teamProfile(tid), (d, n) => onProgress(`Vereine ${d}/${n} …`, 0.15 + 0.35 * (d / n)));

  // Detaildaten (Form der letzten Spiele) für eigene Spieler + Transfermarkt
  const detailIds = [...new Set([...squad.it.map((p) => p.i), ...market.it.map((p) => p.i)])];
  const details = await pool(detailIds, 6, (pid) => kb.player(pid), (d, n) => onProgress(`Spielerform ${d}/${n} …`, 0.5 + 0.5 * (d / n)));
  const detailMap = new Map();
  detailIds.forEach((id, i) => details[i] && detailMap.set(id, details[i]));

  return { me, overview, squad, market, ranking, table, matchdays, eleven, profiles: profiles.filter(Boolean), detailMap, loadedAt: Date.now() };
}

/** Optional: Detaildaten für alle Spieler nachladen (Tiefenanalyse). */
export async function loadAllDetails(kb, raw, onProgress) {
  const ids = [];
  for (const tp of raw.profiles) for (const p of tp.it) if (!raw.detailMap.has(p.i)) ids.push(p.i);
  const res = await pool(ids, 6, (pid) => kb.player(pid), (d, n) => onProgress?.(`Spieler ${d}/${n} …`, d / n));
  ids.forEach((id, i) => res[i] && raw.detailMap.set(id, res[i]));
}

// ---------------------------------------------------------------- Spielplan / Gegnerstärke

function logistic(x) { return 1 / (1 + Math.exp(-x)); }

function buildFixtures(matchdays, table) {
  const teams = new Map(table.it.map((t) => [t.tid, t]));
  const rating = (tid) => {
    const t = teams.get(tid);
    if (!t || !t.mc) return 0;
    return (t.cp + 0.5 * t.gd) / t.mc;
  };

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
      let pH, pD, pA, odds = false;
      if (m.bo && m.bo.o1 && m.bo.ox && m.bo.o2) {
        const a = 1 / m.bo.o1, b = 1 / m.bo.ox, c = 1 / m.bo.o2, s = a + b + c;
        pH = a / s; pD = b / s; pA = c / s; odds = true;
      } else {
        const diff = rating(m.t1) - rating(m.t2) + 0.3; // Heimvorteil
        const nonDraw = 0.74;
        pH = logistic(1.3 * diff) * nonDraw;
        pA = nonDraw - pH;
        pD = 1 - nonDraw;
      }
      const push = (tid, opp, home, win, draw, loss) => {
        if (!fixtures.has(tid)) fixtures.set(tid, []);
        fixtures.get(tid).push({ day: d.day, opp, home, dt: m.dt, win, draw, loss, odds });
      };
      push(m.t1, m.t2, true, pH, pD, pA);
      push(m.t2, m.t1, false, pA, pD, pH);
    }
  }
  const finished = days.filter((d) => d.it.every((m) => m.st === 2));
  const lastDate = finished.length ? finished[finished.length - 1].it.map((m) => m.dt).sort().pop() : null;
  return { fixtures, nextDay, symbols, lastDate, nextDate: upcoming[0]?.it.map((m) => m.dt).sort()[0] ?? null };
}

/** Punkte-Multiplikator aus erwartetem Spielausgang (≈0,85 … 1,18). */
function fixtureMult(f) {
  if (!f) return 1;
  return 0.75 + 0.5 * (f.win + 0.5 * f.draw);
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

function features(p) {
  const ap = Math.max(p.ap ?? 0, 0);
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
  const pred = (p) => features(p).reduce((s, x, i) => s + x * beta[i], 0);
  const res = train.map((p, i) => y[i] - pred(p));
  const smear = mean(res.map(Math.exp)); // Duan-Smearing für Rücktransformation
  const my = mean(y);
  const ssTot = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const ssRes = res.reduce((s, v) => s + v * v, 0);
  return {
    predict: (p) => (p.ap == null ? null : Math.max(500000, Math.exp(pred(p)) * smear)),
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
  const { fixtures, nextDay, symbols, nextDate, lastDate } = buildFixtures(raw.matchdays, raw.table);
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
      p.market = { price: m.prc, exs: m.exs, offers: m.ofc, seller: m.u ? { id: m.u.i, name: m.u.n } : null, isNew: m.isn, since: m.dt, myBid: m.uop ?? null };
      p.totalPts = p.totalPts ?? m.p ?? null;
    }
    if (p.ownerId && !p.ownerName) p.ownerName = managers.get(p.ownerId)?.n ?? null;
    p.games = p.totalPts != null && p.ap ? Math.round(p.totalPts / p.ap) : null;

    // Einsatzwahrscheinlichkeiten
    p.availNext = (PROB_FACTOR[p.prob] ?? 0.6) * nextMatchFactor(p.st);
    p.availSeason = clamp((PROB_FACTOR[p.prob] ?? 0.6) * 0.6 + 0.4, 0, 1) * seasonFactor(p.st);

    // Spielplan
    p.fixtures = fixtures.get(p.tid) || [];
    const nextFix = p.fixtures.find((f) => f.day === nextDay);
    p.nextFix = nextFix || null;
    p.fixEase = p.fixtures.length ? mean(p.fixtures.slice(0, 3).map((f) => f.win + 0.5 * f.draw)) : 0.5;

    // Erwartete Punkte
    const base = p.form != null && p.ap != null ? 0.55 * p.form + 0.45 * p.ap : (p.form ?? p.ap ?? 0);
    p.base = base;
    p.xp = nextFix ? (base > 0 ? base * fixtureMult(nextFix) : base) * p.availNext : 0;
    const seasonBase = p.ap ?? p.form ?? 0;
    p.xs = (seasonBase > 0 ? seasonBase * (0.75 + 0.5 * p.fixEase) : seasonBase) * p.availSeason;

    // Marktwert-Trend (€/Tag)
    p.daily = p.mv24 ?? (p.mvMd != null ? p.mvMd / daysSinceMd : 0);
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
    let buy = 100 * (0.35 * p.q.xs + 0.2 * p.q.eff + 0.2 * p.q.gap + 0.15 * p.q.mom + 0.1 * p.q.fix);
    if (p.st & CRIT_BITS) buy *= 0.6;
    if (p.prob >= 4) buy *= 0.7;
    if (p.ap == null) buy *= 0.5;
    p.buyScore = Math.round(buy);
  }

  // Eigener Kader & Aufstellung
  const mine = all.filter((p) => p.mine);
  const lineup = optimalLineup(mine, 'xp');
  const xiIds = new Set(lineup?.xi.map((p) => p.id) || []);
  const current = new Set((raw.eleven?.lp || []).map((p) => p.i));

  for (const p of mine) {
    p.inBestXI = xiIds.has(p.id);
    p.inCurrentXI = current.has(p.id);
    let sell = 100 * (0.3 * (1 - p.q.xs) + 0.25 * (1 - p.q.mom) + 0.2 * (1 - p.q.gap) + 0.1 * (1 - p.q.fix));
    if (!p.inBestXI) sell += 10;
    if (p.st & CRIT_BITS) sell += 10;
    if (p.prob >= 4) sell += 8;
    p.sellScore = Math.round(clamp(sell, 0, 100));
    p.sellLabel = p.sellScore >= 62 ? 'Verkaufen' : p.sellScore >= 48 ? 'Verkauf prüfen' : 'Halten';
  }

  const budget = raw.me.b;

  // Transfermarkt-Empfehlungen
  const market = all.filter((p) => p.market);
  for (const p of market) {
    p.buyLabel = p.buyScore >= 70 ? 'Top-Kauf' : p.buyScore >= 56 ? 'Kaufen' : p.buyScore >= 42 ? 'Beobachten' : 'Meiden';
    const days = (p.market.exs || 0) / 86400;
    const projected = p.mv + Math.max(0, p.daily) * days;
    const premium = p.buyScore >= 70 ? 0.06 : p.buyScore >= 56 ? 0.03 : 0.01;
    const floor = Math.max(p.market.price, projected);
    const cap = Math.max(p.market.price, Math.min(p.fair ?? p.mv, p.mv * 1.2));
    let bid = floor * (1 + premium);
    if (bid > cap && p.buyScore < 70) bid = Math.max(floor, cap);
    p.bid = Math.ceil(bid / 10000) * 10000;
    p.bidMax = Math.ceil(Math.max(cap, p.bid) / 10000) * 10000;
    p.affordable = p.bid <= budget;
    if (p.market.myBid) p.bidStatus = p.market.myBid < p.market.price ? 'zu niedrig' : p.market.myBid < p.bid ? 'unter Vorschlag' : p.market.myBid > p.bidMax ? 'über Maximum' : 'passt';
  }

  // Tauschvorschläge: Verkaufe X, kaufe Y (gleiche Position, bessere Erwartung)
  const swaps = [];
  for (const buy of market.filter((p) => !p.mine && p.buyScore >= 50)) {
    for (const sell of mine.filter((p) => p.pos === buy.pos)) {
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

  // Budget-Rettung: falls Kontostand negativ, günstigste Verkäufe mit geringstem Punkteverlust
  let rescue = null;
  if (budget < 0) {
    const cands = mine.slice().sort((a, b) => (a.xs / (a.mv || 1)) - (b.xs / (b.mv || 1)));
    let need = -budget; const pick = [];
    for (const p of cands) { if (need <= 0) break; pick.push(p); need -= p.mv; }
    rescue = { need: -budget, pick };
  }

  return {
    players, all, mine, market, lineup, fixtures, mvUpdate: raw.market.mvud || null,
    myBids: market.filter((p) => p.market.myBid), currentXI: current, swaps: topSwaps, rescue,
    budget, teamValue: mine.reduce((s, p) => s + p.mv, 0),
    nextDay, nextDate, lastDate, daysSinceMd, teams: teamMap, managers, fair,
    ranking: raw.ranking, me: raw.me, overview: raw.overview, myId,
  };
}
