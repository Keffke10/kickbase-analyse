// Entwickler-Test: lädt eine Liga und gibt die Analyse aus.
// Nutzung: KB_EMAIL=... KB_PASS=... [KB_LEAGUE=Name] node scripts/smoke-test.mjs
// Zugangsdaten niemals in Dateien speichern!
import { login, Kickbase } from '../js/api.js';
import { loadLeague, analyze } from '../js/model.js';

const { KB_EMAIL, KB_PASS, KB_LEAGUE } = process.env;
if (!KB_EMAIL || !KB_PASS) { console.error('KB_EMAIL und KB_PASS setzen'); process.exit(1); }

const s = await login(KB_EMAIL, KB_PASS);
const league = s.leagues.find((l) => !KB_LEAGUE || l.name === KB_LEAGUE) ?? s.leagues[0];
console.log('Liga:', league.name);
const kb = new Kickbase(s.token, league.id, league.cpi);
const t0 = Date.now();
const raw = await loadLeague(kb, () => {});
const a = analyze(raw, s.user.id);
console.log(`geladen in ${Date.now() - t0} ms, Spieler: ${a.all.length}, Fair-Value R²=${a.fair.r2?.toFixed(2)} (n=${a.fair.n})`);
console.log('Budget', a.budget, 'nächster Spieltag', a.nextDay, a.nextDate);
const f = (p) => `${p.name.padEnd(16)} ${String(p.pos)} xP=${p.xp.toFixed(0).padStart(4)} xS=${p.xs.toFixed(0).padStart(4)} MW=${(p.mv/1e6).toFixed(1).padStart(5)} fair=${p.fair ? (p.fair/1e6).toFixed(1).padStart(5) : '    -'} mom=${(p.mom*100).toFixed(1).padStart(5)}%`;
console.log('\nAufstellung', a.lineup.formation, a.lineup.total.toFixed(0));
a.lineup.xi.forEach((p) => console.log('  ', f(p), p.inCurrentXI ? '' : '(NEU)'));
console.log('\nMarkt:'); a.market.sort((x, y) => y.buyScore - x.buyScore).forEach((p) => console.log('  ', f(p), p.buyScore, p.buyLabel, 'Gebot', (p.bid/1e6).toFixed(2)));
console.log('\nVerkauf:'); a.mine.sort((x, y) => y.sellScore - x.sellScore).slice(0, 6).forEach((p) => console.log('  ', f(p), p.sellScore, p.sellLabel));
console.log('\nTausch:'); a.swaps.forEach((s2) => console.log(`   ${s2.sell.name} -> ${s2.buy.name} +${s2.gain.toFixed(0)} Pkt, netto ${(s2.net/1e6).toFixed(2)} Mio`));
console.log('\nUnterbewertet (frei):'); a.all.filter((p) => !p.ownerId && p.ap > 40 && p.gap != null).sort((x, y) => y.gap - x.gap).slice(0, 5).forEach((p) => console.log('  ', f(p)));
