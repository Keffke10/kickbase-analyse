// Zusätzliche Datenquellen & daraus abgeleitete Kennzahlen.
//  1. OpenLigaDB (offene Fußball-Datenbank): Abschlusstabellen der Vorsaison (1. + 2. Liga) als Stärke-Prior
//  2. Kickbase-Ergebnisse der laufenden Saison: Angriffs-/Abwehrstärke je Verein (Poisson-Modell)
//  3. Kickbase-Leistungshistorie je Spieler: Vorsaison als Prior für den noch kleinen Saison-Ø
//  4. Kickbase-Marktwertverlauf (92 Tage): kurz- vs. mittelfristiger Trend, Trendwende-Signale

import { clamp, mean } from './util.js';

const OLDB = 'https://api.openligadb.de';

/** Abschlusstabellen der Vorsaison von OpenLigaDB. Fehler sind unkritisch (Fallback: nur Kickbase-Daten). */
export async function fetchPrevTables(seasonStartYear) {
  const get = async (league) => {
    const res = await fetch(`${OLDB}/getbltable/${league}/${seasonStartYear - 1}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`OpenLigaDB ${res.status}`);
    return res.json();
  };
  try {
    const [bl1, bl2] = await Promise.all([get('bl1'), get('bl2')]);
    return { bl1, bl2, season: `${seasonStartYear - 1}/${String(seasonStartYear).slice(2)}` };
  } catch {
    return null;
  }
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();
const ALIAS = { "m'gladbach": 'monchengladbach', hamburg: 'hamburger' };

function findPrev(prev, kbName) {
  if (!prev) return null;
  const key = ALIAS[kbName.toLowerCase()] || norm(kbName);
  for (const [league, rows] of [['bl1', prev.bl1], ['bl2', prev.bl2]]) {
    const hit = rows.find((r) => norm(r.teamName).includes(key) || norm(r.shortName) === key);
    if (hit) return { ...hit, league };
  }
  return null;
}

// ---------------------------------------------------------------- Teamstärke (Poisson)

const PRIOR_GAMES = 6; // Gewicht der Vorsaison in "Spielen"

/**
 * Angriffs- & Abwehrstärke je Verein: Tore der laufenden Saison (Kickbase), geglättet mit der
 * Vorsaison (OpenLigaDB). Aufsteiger: 2.-Liga-Werte abgeschwächt.
 */
export function teamRatings(matchdays, table, prev) {
  const stats = new Map(table.it.map((t) => [t.tid, { gf: 0, ga: 0, n: 0 }]));
  for (const d of matchdays.it) {
    for (const m of d.it) {
      if (m.st !== 2 || m.t1g == null) continue;
      const a = stats.get(m.t1), b = stats.get(m.t2);
      if (a) { a.gf += m.t1g; a.ga += m.t2g; a.n++; }
      if (b) { b.gf += m.t2g; b.ga += m.t1g; b.n++; }
    }
  }
  const all = [...stats.values()];
  const games = all.reduce((s, x) => s + x.n, 0);
  const avg = games ? all.reduce((s, x) => s + x.gf, 0) / games : 1.55; // Tore je Team & Spiel
  const base = clamp(avg, 1.2, 2.0);

  const ratings = new Map();
  for (const t of table.it) {
    const s = stats.get(t.tid);
    const p = findPrev(prev, t.tn);
    let gfp = base, gap = base, src = 'keine Vorsaison';
    if (p && p.matches) {
      gfp = p.goals / p.matches;
      gap = p.opponentGoals / p.matches;
      if (p.league === 'bl2') { gfp *= 0.72; gap *= 1.3; src = `Aufsteiger (2. Liga ${p.goals}:${p.opponentGoals})`; }
      else src = `Vorsaison ${p.goals}:${p.opponentGoals}`;
    }
    const gf = (s.gf + PRIOR_GAMES * gfp) / (s.n + PRIOR_GAMES);
    const ga = (s.ga + PRIOR_GAMES * gap) / (s.n + PRIOR_GAMES);
    ratings.set(t.tid, { att: gf / base, def: ga / base, gf, ga, prevSrc: src });
  }
  return { ratings, base };
}

function poissonProbs(l1, l2, max = 10) {
  const pmf = (l) => { const out = [Math.exp(-l)]; for (let k = 1; k <= max; k++) out.push(out[k - 1] * l / k); return out; };
  const a = pmf(l1), b = pmf(l2);
  let w = 0, d = 0, lo = 0;
  for (let i = 0; i <= max; i++) for (let j = 0; j <= max; j++) {
    const p = a[i] * b[j];
    if (i > j) w += p; else if (i === j) d += p; else lo += p;
  }
  const s = w + d + lo;
  return [w / s, d / s, lo / s];
}

/** Erwartete Tore & Wahrscheinlichkeiten für ein Spiel (Heimteam h, Gast a). */
export function matchModel(tr, h, a) {
  const H = tr.ratings.get(h), A = tr.ratings.get(a);
  if (!H || !A) return null;
  const lh = tr.base * H.att * A.def * 1.12; // Heimvorteil
  const la = tr.base * A.att * H.def * 0.9;
  const [pH, pD, pA] = poissonProbs(lh, la);
  return { lh, la, pH, pD, pA };
}

// ---------------------------------------------------------------- Spieler-Historie

/** Vorsaison-Werte & Einsatzquoten aus der Kickbase-Leistungshistorie. */
export function playerHistory(perf) {
  const seasons = perf?.it || [];
  if (!seasons.length) return null;
  const summarize = (s) => {
    if (!s) return null;
    const done = (s.ph || []).filter((x) => x.mdst === 2 || x.p != null);
    const played = done.filter((x) => x.p != null);
    const pts = played.map((x) => x.p);
    const avg = mean(pts);
    return {
      name: s.ti,
      teamGames: done.length,
      games: played.length,
      avg,
      sd: pts.length > 1 ? Math.sqrt(mean(pts.map((v) => (v - avg) ** 2))) : null,
      starts: played.filter((x) => x.st === 5).length,
      recentStarts: done.slice(-5).filter((x) => x.p != null && x.st === 5).length,
      recentGames: Math.min(5, done.length),
    };
  };
  const cur = summarize(seasons[seasons.length - 1]);
  const prev = summarize(seasons[seasons.length - 2]);
  return { cur, prev };
}

/**
 * Bayes-artige Glättung: Früh in der Saison ist der Ø-Wert sehr wackelig (2–4 Spiele).
 * Die Vorsaison geht mit bis zu 6 "virtuellen Spielen" ein, je nach Anzahl ihrer Einsätze.
 */
export function blendedAverage(ap, curGames, hist) {
  const prev = hist?.prev;
  if (!prev || !prev.games || prev.avg == null) return { value: ap, weight: 0 };
  const k = 6 * Math.min(1, prev.games / 20);
  if (ap == null || !curGames) return { value: prev.avg * 0.9, weight: 1 };
  const value = (ap * curGames + prev.avg * k) / (curGames + k);
  return { value, weight: k / (curGames + k) };
}

// ---------------------------------------------------------------- Marktwert-Trend

/** Trend aus dem 92-Tage-Verlauf: Steigung der letzten 3 bzw. 14 Tage + Trendwende-Signal. */
export function mvTrend(history) {
  const it = (history?.it || []).slice().sort((a, b) => a.dt - b.dt);
  if (it.length < 5) return null;
  const last = it[it.length - 1].mv;
  const at = (daysBack) => it[Math.max(0, it.length - 1 - daysBack)].mv;
  const s3 = (last - at(3)) / 3;
  const s14 = (last - at(14)) / Math.min(14, it.length - 1);
  const hi = Math.max(...it.map((x) => x.mv));
  const lo = Math.min(...it.map((x) => x.mv));
  let signal = null;
  if (s3 < 0 && s14 > 0 && last > lo + 0.6 * (hi - lo)) signal = 'Hoch überschritten';
  else if (s3 > 0 && s14 < 0) signal = 'Trendwende nach oben';
  else if (s3 > 0 && s14 > 0) signal = 'stabiler Aufwärtstrend';
  else if (s3 < 0 && s14 < 0) signal = 'Abwärtstrend';
  return { s3, s14, hi, lo, rangePos: hi > lo ? (last - lo) / (hi - lo) : 0.5, signal };
}
