// Minimale SVG-Charts ohne externe Bibliotheken (keine Drittanbieter = kein Tracking).
import { eur, esc, num } from './util.js';

const W = 340, H = 170, PAD = { l: 44, r: 10, t: 12, b: 22 };

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const lo = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = lo; v <= max + step * 0.5; v += step) ticks.push(v);
  return ticks;
}

const shortEur = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(Math.abs(v) >= 1e7 ? 0 : 1).replace('.', ',')} M` : `${Math.round(v / 1e3)} T`);

/**
 * Linienchart für Marktwert-Verlauf.
 * points: [{x: Date, y: number}], extra: {hLine: {y, label}}
 */
export function lineChart(points, { hLine, label = 'Marktwert' } = {}) {
  if (!points.length) return '<p class="muted">Keine Daten.</p>';
  const ys = points.map((p) => p.y).concat(hLine ? [hLine.y] : []);
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const x0 = points[0].x.getTime(), x1 = points[points.length - 1].x.getTime() || x0 + 1;
  const sx = (x) => PAD.l + ((x - x0) / Math.max(1, x1 - x0)) * (W - PAD.l - PAD.r);
  const sy = (y) => PAD.t + (1 - (y - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x.getTime()).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
  const area = `${d}L${sx(x1).toFixed(1)},${sy(y0)}L${sx(x0).toFixed(1)},${sy(y0)}Z`;
  const grid = ticks.map((t) => `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sy(t)}" y2="${sy(t)}"/><text class="axis" x="${PAD.l - 6}" y="${sy(t) + 3}" text-anchor="end">${shortEur(t)}</text>`).join('');
  const fmt = (dt) => dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const xl = `<text class="axis" x="${PAD.l}" y="${H - 6}">${fmt(points[0].x)}</text><text class="axis" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${fmt(points[points.length - 1].x)}</text>`;
  const hl = hLine ? `<line class="ref" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sy(hLine.y)}" y2="${sy(hLine.y)}"/><text class="axis ref-label" x="${W - PAD.r}" y="${sy(hLine.y) - 4}" text-anchor="end">${esc(hLine.label)}</text>` : '';
  const data = esc(JSON.stringify(points.map((p) => [sx(p.x.getTime()), sy(p.y), fmt(p.x), p.y])));
  return `<div class="chart" data-kind="line" data-points="${data}" data-label="${esc(label)}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}-Verlauf">
      ${grid}${hl}<path class="area" d="${area}"/><path class="line" d="${d}"/>${xl}
      <line class="cross" x1="0" x2="0" y1="${PAD.t}" y2="${H - PAD.b}" visibility="hidden"/>
      <circle class="dot" r="4" visibility="hidden"/>
    </svg><div class="tip" hidden></div></div>`;
}

/**
 * Balken für Punkte je Spieltag (positiv/negativ).
 * bars: [{label, value|null, sub}]
 */
export function barChart(bars, { label = 'Punkte' } = {}) {
  if (!bars.length) return '<p class="muted">Keine Daten.</p>';
  const vals = bars.map((b) => b.value ?? 0);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(10, ...vals));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const sy = (y) => PAD.t + (1 - (y - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
  const bw = (W - PAD.l - PAD.r) / bars.length;
  const gap = Math.min(4, bw * 0.25);
  const grid = ticks.map((t) => `<line class="grid${t === 0 ? ' zero' : ''}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sy(t)}" y2="${sy(t)}"/><text class="axis" x="${PAD.l - 6}" y="${sy(t) + 3}" text-anchor="end">${num(t)}</text>`).join('');
  const rects = bars.map((b, i) => {
    const x = PAD.l + i * bw + gap / 2;
    if (b.value == null) return `<text class="axis" x="${x + (bw - gap) / 2}" y="${sy(0) - 3}" text-anchor="middle">·</text>`;
    const top = sy(Math.max(0, b.value)), bot = sy(Math.min(0, b.value));
    return `<rect class="${b.value < 0 ? 'bar-neg' : 'bar'}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}" rx="2"/>`;
  }).join('');
  const every = Math.ceil(bars.length / 9);
  const xl = bars.map((b, i) => (i % every === 0 ? `<text class="axis" x="${PAD.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>` : '')).join('');
  const data = esc(JSON.stringify(bars.map((b, i) => [PAD.l + i * bw + bw / 2, sy(Math.max(0, b.value ?? 0)), `${b.label}${b.sub ? ' · ' + b.sub : ''}`, b.value])));
  return `<div class="chart" data-kind="bar" data-points="${data}" data-label="${esc(label)}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} je Spieltag">${grid}${rects}${xl}
    <line class="cross" x1="0" x2="0" y1="${PAD.t}" y2="${H - PAD.b}" visibility="hidden"/></svg>
    <div class="tip" hidden></div></div>`;
}

/** Tooltip-Verhalten (Maus + Touch) an alle Charts in root anhängen. */
export function wireCharts(root) {
  root.querySelectorAll('.chart').forEach((el) => {
    const pts = JSON.parse(el.dataset.points);
    const svg = el.querySelector('svg');
    const tip = el.querySelector('.tip');
    const cross = el.querySelector('.cross');
    const dot = el.querySelector('.dot');
    const isLine = el.dataset.kind === 'line';
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * W;
      let best = 0;
      for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - x) < Math.abs(pts[best][0] - x)) best = i;
      const [px, py, lab, v] = pts[best];
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      if (dot) { dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible'); }
      tip.hidden = false;
      tip.innerHTML = `<b>${esc(v == null ? '–' : isLine ? eur(v) : num(v) + ' Pkt')}</b><span>${esc(lab)}</span>`;
      const left = (px / W) * r.width;
      tip.style.left = `${Math.min(Math.max(left, 50), r.width - 50)}px`;
    };
    const leave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dot?.setAttribute('visibility', 'hidden'); };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', leave);
  });
}
