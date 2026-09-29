// Kleine Hilfsfunktionen: Formatierung, Escaping, Labels.

const CDN = 'https://kickbase.b-cdn.net/';

/** HTML-Escaping für alle Strings, die aus der API kommen (Managernamen sind frei wählbar!). */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
  }[c]));
}

/** Bild-URL nur für bekannte relative Kickbase-Pfade zulassen. */
export function img(path) {
  if (!path || typeof path !== 'string') return '';
  if (!/^[a-zA-Z0-9/_.-]+$/.test(path)) return '';
  return CDN + path;
}

const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export const num = (v) => (v == null || Number.isNaN(v) ? '–' : nf0.format(Math.round(v) + 0));
export const num1 = (v) => (v == null || Number.isNaN(v) ? '–' : nf1.format(v));

/** 12.523.177 -> "12,52 Mio." ; 850.000 -> "850 Tsd." */
export function eur(v) {
  if (v == null || Number.isNaN(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e6) return `${nf2.format(v / 1e6)} Mio.`;
  if (a >= 1e3) return `${nf0.format(v / 1e3)} Tsd.`;
  return `${nf0.format(v)} €`;
}

export function signedEur(v) {
  if (v == null || Number.isNaN(v)) return '–';
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + eur(Math.abs(v));
}

export function pct(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '–';
  const s = (v * 100).toFixed(digits).replace('.', ',');
  return (v > 0 ? '+' : '') + s + ' %';
}

export function deltaClass(v) {
  if (v > 0) return 'pos';
  if (v < 0) return 'neg';
  return '';
}

export const POS = { 1: 'TW', 2: 'ABW', 3: 'MF', 4: 'ST' };
export const POS_LONG = { 1: 'Torwart', 2: 'Abwehr', 3: 'Mittelfeld', 4: 'Sturm' };

// Kickbase-Status ist ein Bitfeld.
const STATUS_BITS = [
  [1, 'verletzt', 'crit'],
  [2, 'angeschlagen', 'warn'],
  [4, 'Aufbautraining', 'warn'],
  [8, 'Rotsperre', 'crit'],
  [16, 'Gelb-Rot-Sperre', 'crit'],
  [32, 'Gelbsperre', 'crit'],
  [64, 'nicht im Kader', 'crit'],
  [128, 'nicht in der Liga', 'crit'],
  [256, 'abwesend', 'crit'],
];

export function statusInfo(st) {
  if (!st) return null;
  const hits = STATUS_BITS.filter(([b]) => (st & b) === b);
  if (!hits.length) return { label: 'unklar', level: 'warn' };
  const level = hits.some((h) => h[2] === 'crit') ? 'crit' : 'warn';
  return { label: hits.map((h) => h[1]).join(', '), level };
}

// Startelf-Wahrscheinlichkeit laut Kickbase (1 = sicher … 5 = keine Chance)
export const PROB = {
  1: { label: 'Startelf sicher', short: 'sicher', level: 'good' },
  2: { label: 'Startelf wahrscheinlich', short: 'wahrsch.', level: 'good' },
  3: { label: 'Startelf unsicher', short: 'unsicher', level: 'warn' },
  4: { label: 'Startelf unwahrscheinlich', short: 'unwahrsch.', level: 'crit' },
  5: { label: 'kein Einsatz erwartet', short: 'raus', level: 'crit' },
};

export function countdown(seconds) {
  if (seconds == null) return '–';
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} T ${h} Std`;
  if (h > 0) return `${h} Std ${m} Min`;
  return `${m} Min`;
}

export function dateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `vor ${Math.max(1, Math.round(s / 60))} Min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std`;
  return `vor ${Math.round(s / 86400)} T`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
