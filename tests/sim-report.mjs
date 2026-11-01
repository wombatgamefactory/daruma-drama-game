// sim-report.mjs - summarises one or more sim.mjs JSON files (several = side-by-side columns).
//
//   node tests/sim-report.mjs tests/tmp/a.json [tests/tmp/b.json ...] [--md] [--detail]
//
// Per file: win rate by seat and by bot level (Wilson 95% CI; a shared win counts 1/winners),
// score mean/sd, margin 1st-2nd, tie and tiebreak rates, the trick-taking measures, and the tiebreak
// analysis (how often first place is tied, how often the colour count separates it, and two alternatives
// worked out from the recorded games). --detail adds the by-seat and by-level tables for every file.
// Definitions: "tie for 1st" = two or more players on the top total BEFORE any tiebreak (the Python sims'
// "games with a tie for 1st"); "shared" = still tied after the tiebreak.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function wilson(k, n, z = 1.96) {
  if (n <= 0) return [0, 0];
  const p = k / n; const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
export const pct = (x, d = 1) => (x * 100).toFixed(d);
export const ci = (k, n) => { const [lo, hi] = wilson(k, n); return `${pct(k / n)} [${pct(lo)}, ${pct(hi)}]`; };
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / Math.max(1, xs.length - 1)); };
/** Normal-approximation interval half-width for a mean. */
const mci = (xs) => (1.96 * sd(xs)) / Math.sqrt(xs.length);
const pm = (xs, d = 2) => `${mean(xs).toFixed(d)} ±${mci(xs).toFixed(d)}`;

// ---------- tiebreak rules applied to recorded games ----------
// Each rule scores a seat (higher is better); applied to the players tied on the top total.
export const TIEBREAKS = {
  colours: { label: 'Most colours across all score piles (standard until 01/11/2026)', key: (g, s) => g.col[s] },
  lastBanked: { label: 'Alt A: most cards banked in the final hand', key: (g, s) => g.lastBanked[s] },
  fewestLost: { label: 'Fewest line cards left at hand ends (standard rule)', key: (g, s) => -g.lostBy[s] },
  tricksWon: { label: 'Alt C: most tricks won over the game', key: (g, s) => g.tw[s] },
  lastCols: { label: 'Alt D: most colours in the final hand\'s banked cards', key: (g, s) => g.lastCols[s] },
};

/** Winners of game g when the tied leaders are separated by `rules` in order. */
export function winnersBy(g, rules) {
  let w = g.tied;
  for (const r of rules) {
    if (w.length < 2) break;
    const k = TIEBREAKS[r].key;
    const best = Math.max(...w.map((s) => k(g, s)));
    w = w.filter((s) => k(g, s) === best);
  }
  return w;
}

function tiebreakTable(games) {
  const tied = games.filter((g) => g.tied.length > 1);
  const rows = [];
  const defs = [
    ['no tiebreak (all tied players share)', []],
    ['colours (old standard)', ['colours']],
    ['Alt A: final-hand cards banked', ['lastBanked']],
    ['fewest left on the line (standard)', ['fewestLost']],
    ['Alt C: most tricks won', ['tricksWon']],
    ['Alt D: colours in final hand', ['lastCols']],
    ['colours, then Alt A', ['colours', 'lastBanked']],
    ['colours, then Alt B', ['colours', 'fewestLost']],
    ['colours, then Alt A, then Alt B', ['colours', 'lastBanked', 'fewestLost']],
  ];
  for (const [label, rules] of defs) {
    let decided = 0; let shared = 0;
    for (const g of tied) { if (winnersBy(g, rules).length === 1) decided++; else shared++; }
    rows.push({ label, decided, shared, n: tied.length, nGames: games.length });
  }
  return { tiedGames: tied.length, rows };
}

// ---------- summary ----------
export function summarise(data) {
  const gs = data.games; const N = gs.length;
  const n = data.meta.players;
  const credit = (g, s) => (g.win.includes(s) ? 1 / g.win.length : 0);
  const outright = gs.filter((g) => g.win.length === 1).length;

  const bySeat = Array.from({ length: n }, (_, s) => ({ seat: s, k: sum(gs.map((g) => credit(g, s))), n: N }));
  const byOffset = Array.from({ length: n }, (_, o) => ({ off: o, k: sum(gs.map((g) => credit(g, (g.fd + o) % n))), n: N }));
  const levels = [...new Set(gs.flatMap((g) => g.lv))].sort();
  const byLevel = levels.map((lv) => {
    let k = 0; let k0 = 0; let seatGames = 0; const scores = []; const perHand = [];
    for (const g of gs) {
      for (let s = 0; s < n; s++) {
        if (g.lv[s] !== lv) continue;
        seatGames++; k += credit(g, s); k0 += g.tied.includes(s) ? 1 / g.tied.length : 0; scores.push(g.tot[s]);
        for (const h of g.hs) perHand.push(h[s]);
      }
    }
    return { lv, k, k0, n: seatGames, base: 1 / n, mean: mean(scores), perHand: mean(perHand) };
  });

  // chi-square of seat credits against an even split (df = n - 1)
  const exp = N / n;
  const chi = sum(bySeat.map((b) => ((b.k - exp) ** 2) / exp));

  const allTotals = gs.flatMap((g) => g.tot);
  const finals = gs.map((g) => Math.max(...g.tot));
  const margins = gs.map((g) => { const t = [...g.tot].sort((a, b) => b - a); return t[0] - t[1]; });
  const handScores = gs.flatMap((g) => g.hs.flat());
  const tricks = sum(gs.map((g) => g.tricks));
  const rise = [0, 1, 2, 3].map((i) => sum(gs.map((g) => g.rise[i] || 0)));
  const wins = sum(rise);
  const hands = sum(gs.map((g) => g.hs.length));
  const tied = gs.filter((g) => g.tied.length > 1);
  const colSeats = gs.flatMap((g) => g.col);

  return {
    N, n, outright, bySeat, byOffset, byLevel, chi,
    meanTotal: allTotals, meanFinal: finals, margins, handScores,
    meanTricks: mean(gs.map((g) => g.tricks)), meanHands: hands / N,
    trump: sum(gs.map((g) => g.trump)), tricks,
    clash: sum(gs.map((g) => g.clash)), tieTr: sum(gs.map((g) => g.tieTr)),
    leaderWins: sum(gs.map((g) => g.lead)),
    rise, wins,
    lostPerHand: sum(gs.map((g) => sum(g.lostBy))) / (hands * n),
    koPerGame: mean(gs.map((g) => sum(g.ko))),
    leadChanges: gs.map((g) => g.leadChanges),
    comeback: gs.filter((g) => g.comeback).length,
    tieFirst: tied.length,
    tbDecided: gs.filter((g) => g.tb).length,
    shared: gs.filter((g) => g.win.length > 1).length,
    colMean: mean(colSeats), col5: colSeats.filter((c) => c === 5).length, colSeatsN: colSeats.length,
    tiebreak: tiebreakTable(gs),
  };
}

// ---------- output ----------
function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => '| ' + r.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
  return [fmt(headers), '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |', ...rows.map(fmt)].join('\n');
}

export function labelOf(data) {
  const m = data.meta;
  const v = Object.entries(m.variants || {}).map(([k, x]) => `${k}=${x}`).join(' ');
  const c = Object.entries(m.consts || {}).map(([k, x]) => `${k}=${x}`).join(' ');
  return `${m.players}p ${m.seats.join(',')}${m.rotate ? '' : ' (fixed seats)'}${m.jitter ? ` j${m.jitter}` : ''}${v ? ` ${v}` : ''}${c ? ` ${c}` : ''}`;
}

export function report(files, { detail = false } = {}) {
  const loaded = files.map((f) => ({ f, data: JSON.parse(readFileSync(f, 'utf8')) }));
  const S = loaded.map((x) => ({ x, s: summarise(x.data) }));
  const out = [];
  const cols = ['', ...S.map(({ x }, i) => `[${i + 1}] ${labelOf(x.data)}`)];
  const row = (name, f) => [name, ...S.map(({ s }) => f(s))];
  out.push('== Summary ==');
  out.push(table(cols, [
    row('games', (s) => String(s.N)),
    row('hands / tricks per game', (s) => `${s.meanHands.toFixed(1)} / ${s.meanTricks.toFixed(1)}`),
    row('score per hand, mean ±95%', (s) => pm(s.handScores)),
    row('final total (mean, sd)', (s) => `${mean(s.meanTotal).toFixed(1)} (${sd(s.meanTotal).toFixed(1)})`),
    row('winner total, mean', (s) => mean(s.meanFinal).toFixed(1)),
    row('margin 1st-2nd, mean ±95%', (s) => pm(s.margins)),
    row('tie for 1st on total %  [CI]', (s) => ci(s.tieFirst, s.N)),
    row('tiebreak decided %', (s) => ci(s.tbDecided, s.N)),
    row('still shared after tiebreak %', (s) => ci(s.shared, s.N)),
    row('personal-trump tricks %', (s) => ci(s.trump, s.tricks)),
    row('trump clash tricks %', (s) => ci(s.clash, s.tricks)),
    row('trump-tie tricks %', (s) => ci(s.tieTr, s.tricks)),
    row('leader wins trick %', (s) => ci(s.leaderWins, s.tricks)),
    row('rise 0 / 1 / 2 / 3 cards, % of wins', (s) => s.rise.map((r) => pct(r / s.wins, 0)).join(' / ')),
    row('line cards lost per player-hand', (s) => s.lostPerHand.toFixed(2)),
    row('knock-offs per game', (s) => s.koPerGame.toFixed(1)),
    row('lead changes per game', (s) => pm(s.leadChanges)),
    row('final-hand comebacks %', (s) => ci(s.comeback, s.N)),
    row('colours banked per player (of 5)', (s) => s.colMean.toFixed(2)),
    row('players with all 5 colours %', (s) => ci(s.col5, s.colSeatsN)),
    row('seat chi-square (df n-1)', (s) => s.chi.toFixed(1)),
  ]));

  for (const { x, s } of S) {
    out.push('', `== [${S.indexOf(S.find((q) => q.x === x)) + 1}] ${labelOf(x.data)} ==`);
    out.push('Win % by bot level (shared win = 1/winners; base rate = 1/n):');
    out.push(table(['bot', 'seat-games', 'win % [95% CI]', 'no-tiebreak win %', 'base %', 'score/hand', 'final total'],
      s.byLevel.map((b) => [b.lv, b.n, ci(b.k, b.n), pct(b.k0 / b.n), pct(b.base), b.perHand.toFixed(2), b.mean.toFixed(2)])));
    if (detail || s.byLevel.length === 1 || !x.data.meta.rotate) {
      out.push('', 'Win % by seat number:');
      out.push(table(['seat', 'win % [95% CI]'], s.bySeat.map((b) => [b.seat, ci(b.k, b.n)])));
      out.push('', 'Win % by position after the first dealer (0 = dealer of hand 1, 1 = first leader):');
      out.push(table(['offset', 'win % [95% CI]'], s.byOffset.map((b) => [b.off, ci(b.k, b.n)])));
    }
    out.push('', `Tiebreak analysis (${s.tiebreak.tiedGames} of ${s.N} games had a tie for 1st on total):`);
    out.push(table(['rule', 'decided', 'still shared', 'decided % of ties', 'ties decided, % of ALL games'],
      s.tiebreak.rows.map((r) => [r.label, r.decided, r.shared, pct(r.decided / Math.max(1, r.n)), pct(r.decided / r.nGames, 2)])));
  }
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node tests/sim-report.mjs file.json [file2.json ...] [--detail]'); process.exit(2); }
  console.log(report(files, { detail: process.argv.includes('--detail') }));
}
