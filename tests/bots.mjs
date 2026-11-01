// bots.mjs - the Easy / Medium / Hard bots and the greedy archetype: legality, determinism, fidelity to the
// Python sim, variants, search sanity, timing and strength.
//
//  1. registry: easy, medium, hard offered; greedy registered but not offered.
//  2. legality: 500 games at each of 3, 4 and 5 players for Easy, Medium and Greedy (every seat the level), zero
//     refusals; Hard at 100 games per player count with a reduced search budget (--full: 500 games per player count at
//     the real budget) plus full all-Hard games at the real budget; every proposal is a legal action from the view; the
//     view is never mutated (checked in every 4th game).
//  3. determinism: same view and rng -> same action; Hard advances the rng, Medium and Greedy leave it alone.
//  4. Python decision match: tests/fixtures/python-bot-decisions.json holds games played by the REAL Python timed /
//     greedy / random bots (the generator script is not part of this repo); the
//     JS Medium and Greedy bots must choose the recorded card at every decision. Sabotage checks show the fixture
//     separates the policies.
//  5. variants: every non-default variant value and a few combinations; Medium, Greedy and Hard play legally to the end.
//  6. Hard sanity: it takes an obvious rise, leaves its view alone, and works on a deeply frozen view.
//  7. Hard timing at 5 players: median and p95 per decision (run alone, after the parallel jobs).
//  8. strength: one Medium v Easy opponents and one Hard v Medium opponents, strong seat rotated, win rate (a shared
//     win counts 1/winners) against the 1/N base rate, with game counts and z-scores.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.
//
// The long sweeps run in worker threads (tests/bots-worker.mjs, jobs in tests/bots-lib.mjs); results are deterministic
// because every game is seeded. Flags:  --full  runs the heavy versions (500 Hard legality games per player count at
// the real budget, 300 Hard strength games per player count; several minutes).

import { readFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  createGame, applyAction, viewFor, legalActionsFromView, makeRng, deriveSeed, VARIANTS,
} from '../src/engine/index.js';
import { getBot, botLevels } from '../src/bots/index.js';
import { searchAction, samplesFor, HARD_SAMPLES, HARD_MIN_SAMPLES, HARD_MAX_ROLLOUTS } from '../src/bots/hard.js';
import { suite, position, play } from './lib.mjs';
import { playGame } from './bots-lib.mjs';

const { check, done } = suite('bots');
const FULL = process.argv.includes('--full');
const startedAt = Date.now(); // a test file may read the clock; src/ may not
const now = () => Number(process.hrtime.bigint()) / 1e6;

// ---------- the parallel jobs (started first, collected at the end) ----------
const WORKER_URL = new URL('./bots-worker.mjs', import.meta.url);
const CONCURRENCY = Math.max(1, (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) - 1);
const queue = [];
let running = 0;
function job(name, args) {
  return new Promise((resolve, reject) => {
    queue.push({ name, args, resolve, reject });
    pump();
  });
}
function pump() {
  while (running < CONCURRENCY && queue.length) {
    const j = queue.shift();
    running++;
    const w = new Worker(WORKER_URL, { workerData: { job: j.name, args: j.args } });
    w.once('message', (m) => { j.resolve(m); });
    w.once('error', (e) => { running--; j.reject(e); pump(); });
    w.once('exit', () => { running--; pump(); });
  }
}

const HARD_GAMES = FULL ? { 3: 300, 4: 300, 5: 300 } : { 3: 30, 4: 24, 5: 24 };
const MED_GAMES = 400;
const jobs = {
  strengthHard: [3, 4, 5].map((n) => job('strength', { strong: 'hard', opp: 'medium', n, games: HARD_GAMES[n], tag: 'str-hm' })),
  // --full splits the 500-game Hard sweep by player count so the three run in parallel
  legalHard: FULL
    ? [3, 4, 5].map((n) => job('legality', { spec: { special: 'hard', others: ['medium'] }, gamesPerCount: 500, tag: 'hard-full', counts: [n] }))
    : [job('legality', { spec: { special: 'hard-fast', others: ['medium', 'easy', 'greedy'] }, gamesPerCount: 100, tag: 'hard-fast' })],
  legalHardAll: job('legality', { spec: { all: 'hard' }, gamesPerCount: FULL ? 6 : 2, tag: 'hard-all', viewCheckEvery: 1 }),
  legal: ['easy', 'medium', 'greedy'].map((level) => [level, job('legality', { spec: { all: level }, gamesPerCount: 500, tag: level })]),
  strengthMedium: [3, 4, 5].map((n) => [n, Promise.all([
    job('strength', { strong: 'easy', opp: 'easy', n, games: MED_GAMES, tag: 'str-ee' }),
    job('strength', { strong: 'medium', opp: 'easy', n, games: MED_GAMES, tag: 'str-me' }),
  ])]),
};
const ruleSets = [];
for (const def of VARIANTS) for (const value of def.values) if (value !== def.default) ruleSets.push({ label: `${def.name}=${value}`, rules: { [def.name]: value }, onlyFor: def.onlyFor || null });
ruleSets.push(
  { label: 'shrinking+top+minus1', rules: { FORMAT: 'shrinking', FIRST_FALL: 'top', LEFTOVER: 'minus1' }, onlyFor: null },
  { label: 'LINE_LIMIT=2+TRUMP_TIES=last+HAND_SIZE=ten', rules: { LINE_LIMIT: '2', TRUMP_TIES: 'last', HAND_SIZE: 'ten' }, onlyFor: null },
  { label: 'DECK_3P=drop_purple+LINE_LIMIT=scaled+TIEBREAK=shared', rules: { DECK_3P: 'drop_purple', LINE_LIMIT: 'scaled', TIEBREAK: 'shared' }, onlyFor: [3] },
);
const variantJobs = ruleSets.map((rs) => job('variants', { label: rs.label, rules: rs.rules, onlyFor: rs.onlyFor, rounds: 9 }));

// ---------- 1. registry ----------
{
  const levels = botLevels();
  const byId = Object.fromEntries(levels.map((l) => [l.id, l]));
  check('registry has easy, medium, hard, greedy', ['easy', 'medium', 'hard', 'greedy'].every((x) => byId[x]), levels.map((l) => l.id).join(','));
  check('labels are Easy / Medium / Hard', byId.easy.label === 'Easy' && byId.medium.label === 'Medium' && byId.hard.label === 'Hard');
  check('easy, medium and hard are offered; greedy is not', byId.easy.offered && byId.medium.offered && byId.hard.offered && !byId.greedy.offered);
  check('Hard exposes its sample count as a constant', Number.isInteger(HARD_SAMPLES) && HARD_SAMPLES >= HARD_MIN_SAMPLES && HARD_MAX_ROLLOUTS > 0, `${HARD_SAMPLES}/${HARD_MIN_SAMPLES}/${HARD_MAX_ROLLOUTS}`);
}

// ---------- 3. determinism and the rng ----------
{
  const g = createGame({ seed: 'bdet-view', players: 4 });
  for (const level of ['medium', 'greedy', 'hard']) {
    const seat = g.toAct;
    const view = viewFor(g, seat);
    const x = getBot(level).chooseAction(view, { s: 77 });
    const y = getBot(level).chooseAction(JSON.parse(JSON.stringify(view)), { s: 77 });
    check(`same view and rng -> same action (${level})`, JSON.stringify(x) === JSON.stringify(y));
  }
  const view = viewFor(g, g.toAct);
  const r1 = { s: 5 };
  getBot('medium').chooseAction(view, r1);
  getBot('greedy').chooseAction(view, r1);
  check('medium and greedy leave the rng untouched', r1.s === 5);
  const r2 = { s: 5 };
  getBot('hard').chooseAction(view, r2);
  check('hard draws from the rng it is given', r2.s !== 5);
  const run = (seed) => JSON.stringify(playGame({ levels: ['hard', 'medium', 'greedy', 'easy'], seed }).state);
  check('same seed and levels -> identical game (hard, medium, greedy, easy)', run('bdet-game') === run('bdet-game'));
}

// ---------- 4. Python decision match ----------
{
  const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/python-bot-decisions.json', import.meta.url)), 'utf8'));
  const COLOUR = { R: 'red', Y: 'gold', G: 'green', B: 'blue', P: 'purple' };
  const card = (code) => `${COLOUR[code[0]]}-${code.slice(1)}`;
  const cards = (text) => (text ? text.split(' ').map(card) : []);
  const LEVEL = { timed: 'medium', greedy: 'greedy' };
  /** Replays every fixture game; `levelFor(kind)` names the JS bot compared with the Python kind. */
  const replay = (levelFor) => {
    const res = { games: 0, decisions: 0, mismatches: 0, byKind: { timed: [0, 0], greedy: [0, 0] }, first: [] };
    for (const set of fx.sets) {
      for (const [gi, g] of set.games.entries()) {
        const n = g.n;
        const state = createGame({ seed: 0, players: n, rules: set.rules, firstDealer: n - 1, deals: g.hands.map((h) => ({ hands: h.deal.map(cards) })) });
        res.games++;
        const judge = (seat, expected, where) => {
          const kind = g.kinds[seat];
          const level = levelFor(kind);
          if (!level) return;
          const a = getBot(level).chooseAction(viewFor(state, seat), { s: 1 });
          res.decisions++; res.byKind[kind][0]++;
          if (a.card !== expected) {
            res.mismatches++; res.byKind[kind][1]++;
            if (res.first.length < 3) res.first.push(`${set.name} #${gi} ${where}: ${kind} js ${a.card} py ${expected}`);
          }
        };
        g.hands.forEach((h, hi) => {
          const falls = cards(h.falls);
          while (state.phase === 'fall') {
            judge(state.toAct, falls[state.toAct], `hand ${hi} first fall`);
            applyAction(state, { type: 'fall', card: falls[state.toAct] }, { silent: true });
          }
          const plays = cards(h.plays);
          let k = 0;
          while (k < plays.length) {
            judge(state.toAct, plays[k], `hand ${hi} play ${k + 1}`);
            const events = applyAction(state, { type: 'play', card: plays[k] }); // events: to skip the engine's forced plays
            k++;
            for (const ev of events) if (ev.type === 'card-played' && ev.auto && ev.handNo === hi) k++;
          }
        });
      }
    }
    return res;
  };
  const real = replay((kind) => LEVEL[kind] || null);
  check(`Medium and Greedy choose the Python bot's card at all ${real.decisions} decisions (${real.games} games, ${fx.sets.length} rule sets)`,
    real.mismatches === 0 && real.decisions > 10000, `${real.mismatches} mismatches; ${real.first.join('; ')}`);
  check(`both policies are exercised (timed ${real.byKind.timed[0]} decisions, greedy ${real.byKind.greedy[0]})`, real.byKind.timed[0] > 3000 && real.byKind.greedy[0] > 3000);
  console.log(`  decision match: ${real.decisions} decisions in ${real.games} games (${real.byKind.timed[0]} timed, ${real.byKind.greedy[0]} greedy), ${real.mismatches} mismatches`);
  // sabotage: other policies must disagree somewhere, or the fixture could not tell the bots apart
  const crossed = replay((kind) => (kind === 'timed' ? 'greedy' : kind === 'greedy' ? 'medium' : null));
  check('the fixture separates timed from greedy (swapped bots disagree often)', crossed.mismatches > 500, `${crossed.mismatches} mismatches`);
  const sabotaged = replay((kind) => (kind === 'timed' ? 'easy' : null));
  check('the fixture catches a different bot (Easy v Python timed)', sabotaged.mismatches > 500, `${sabotaged.mismatches} mismatches`);
}

// ---------- 6. Hard sanity ----------
{
  // A full line and the top card of the led colour in hand: rising now banks three cards, Hard must take it.
  const state = position({
    players: 3,
    hands: [['red-9', 'red-1', 'blue-2', 'blue-3'], ['red-5', 'green-1', 'green-2', 'green-3'], ['red-3', 'purple-1', 'purple-2', 'purple-3']],
    lines: [['gold-2', 'gold-3', 'gold-4'], [], []],
    leader: 1,
    rules: { LINE_LIMIT: '3' },
  });
  play(state, 'red-5', 'red-3');
  const view = viewFor(state, 0);
  const choice = searchAction(view, makeRng('sanity'), {}).action;
  check('Hard rises with the winning card when its line is full (Red 9 over Red 1)', state.toAct === 0 && choice.card === 'red-9', JSON.stringify(choice));
  check('searching leaves the view untouched', JSON.stringify(view) === JSON.stringify(viewFor(state, 0)));

  // Only the view is read: a state whose hidden cards differ gives the same view, and that is all a bot receives.
  const g = createGame({ seed: 'blind', players: 4 });
  const h = JSON.parse(JSON.stringify(g));
  const other = (g.toAct + 1) % 4;
  h.hands[other] = [...h.hands[other]].reverse();
  h.setAside = [...h.setAside].reverse();
  check('a bot is given only viewFor(): hidden hands and set-aside cards do not appear in it', JSON.stringify(viewFor(g, g.toAct)) === JSON.stringify(viewFor(h, g.toAct)));
  const frozen = (o) => { Object.freeze(o); for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) frozen(v); return o; };
  let threw = '';
  try {
    const fv = frozen(viewFor(g, g.toAct));
    for (const level of ['easy', 'medium', 'greedy', 'hard']) getBot(level).chooseAction(fv, { s: 3 });
  } catch (e) { threw = e.message; }
  check('every bot works on a deeply frozen view (never writes to it)', threw === '', threw);
  check('samplesFor shrinks the world count as candidates grow, within bounds', samplesFor(2) === HARD_SAMPLES && samplesFor(11) >= HARD_MIN_SAMPLES && samplesFor(11) <= HARD_SAMPLES && samplesFor(11) * 11 <= HARD_MAX_ROLLOUTS);
}

// ---------- 2, 5, 8: collect the parallel jobs ----------
{
  const t0 = Date.now();
  const sweepChecks = (label, r, perCount) => {
    check(`${label}: ${r.games} games (${perCount} per player count) finish`, r.unfinished === 0, `${r.unfinished} unfinished`);
    check(`${label}: every proposal is a legal action from the view`, r.illegal === 0, `${r.illegal} illegal`);
    check(`${label}: zero refused actions`, r.refusals === 0, `${r.refusals}`);
    check(`${label}: the view is never mutated`, r.mutated === 0, `${r.mutated}`);
  };
  for (const [level, p] of jobs.legal) sweepChecks(`${level} (all seats)`, await p, 500);
  {
    const parts = await Promise.all(jobs.legalHard);
    const sum = parts.reduce((a, r) => ({ games: a.games + r.games, refusals: a.refusals + r.refusals, illegal: a.illegal + r.illegal, mutated: a.mutated + r.mutated, unfinished: a.unfinished + r.unfinished }), { games: 0, refusals: 0, illegal: 0, mutated: 0, unfinished: 0 });
    sweepChecks(FULL ? 'hard (one seat, real budget)' : 'hard (one seat, reduced search budget)', sum, FULL ? 500 : 100);
  }
  sweepChecks(`hard (all seats, real budget)`, await jobs.legalHardAll, FULL ? 6 : 2);

  let games = 0; let bad = 0; const notes = [];
  for (const p of variantJobs) { const r = await p; games += r.games; bad += r.bad; notes.push(...r.notes); }
  check(`${games} games under ${ruleSets.length} rule sets (every non-default variant value plus combinations; Medium, Greedy, Hard) play legally to the end`, bad === 0, `${bad} bad: ${notes.slice(0, 3).join('; ')}`);

  // strength
  const row = (label, r) => console.log(`  ${label.padEnd(22)} ${r.n}p  win ${(100 * r.rate).toFixed(1)}% (base ${(100 * r.base).toFixed(1)}%)  n=${String(r.games).padStart(4)}  z=${r.z.toFixed(1).padStart(5)}  margin over best rival ${r.margin >= 0 ? '+' : ''}${r.margin.toFixed(2)}`);
  console.log('  strength (strong seat rotated; win = 1/winners for a shared win; z vs the 1/N base rate):');
  for (const [n, p] of jobs.strengthMedium) {
    const [base, m] = await p;
    const h = await jobs.strengthHard[n - 3];
    row('Easy v Easy (control)', base); row('Medium v Easy', m); row('Hard v Medium', h);
    check(`${n}p: Easy v Easy is at the base rate (|z| < 3.5)`, Math.abs(base.z) < 3.5, `z=${base.z.toFixed(2)}`);
    check(`${n}p: one Medium v Easy opponents wins clearly more than 1/${n} (z >= 3)`, m.z >= 3 && m.rate > base.rate, `${(100 * m.rate).toFixed(1)}%, z=${m.z.toFixed(2)}`);
    check(`${n}p: one Hard v Medium opponents wins clearly more than 1/${n} (z >= 3)`, h.z >= 3, `${(100 * h.rate).toFixed(1)}%, z=${h.z.toFixed(2)}`);
    check(`${n}p: ordering Easy < Medium < Hard (Easy at base, Medium above it, Hard ahead of Medium opponents on margin)`, base.rate < m.rate && h.margin > 0, `easy ${base.rate.toFixed(3)} medium ${m.rate.toFixed(3)} hard margin ${h.margin.toFixed(2)}`);
  }
  console.log(`  [parallel jobs finished ${((Date.now() - t0) / 1000).toFixed(1)} s after the main-thread checks; ${CONCURRENCY} worker thread(s)]`);
}

// ---------- 7. Hard timing at 5 players (alone on the machine) ----------
{
  const times = [];
  for (let gi = 0; gi < (FULL ? 12 : 5); gi++) {
    const seed = deriveSeed('timing', gi);
    const state = createGame({ seed, players: 5 });
    const rngs = Array.from({ length: 5 }, (_, s) => makeRng(deriveSeed(seed, 'bot', s)));
    while (state.toAct !== null) {
      const seat = state.toAct;
      const view = viewFor(state, seat);
      let act;
      if (seat === gi % 5 && legalActionsFromView(view).length > 1) {
        const t0 = now();
        act = getBot('hard').chooseAction(view, rngs[seat]);
        times.push(now() - t0);
      } else act = getBot('medium').chooseAction(view, rngs[seat]);
      applyAction(state, act, { silent: true });
    }
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  console.log(`  Hard at 5 players: ${times.length} decisions, median ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms, max ${q(1).toFixed(1)} ms (samples <= ${HARD_SAMPLES}, rollout budget ${HARD_MAX_ROLLOUTS})`);
  check('Hard decides in under 250 ms at p95 (5 players, Node)', q(0.95) < 250, `p95 ${q(0.95).toFixed(1)} ms`);
  check('Hard decides in under 250 ms at the median (5 players, Node)', q(0.5) < 250, `median ${q(0.5).toFixed(1)} ms`);
}

console.log(`  bots suite took ${((Date.now() - startedAt) / 1000).toFixed(1)} s${FULL ? ' (--full)' : ''}`);
done();
