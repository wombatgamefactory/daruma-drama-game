// sim-check.mjs - the simulator is deterministic and its records are consistent (~5 s).
// Same seed twice gives identical JSON (also across worker threads); every game terminates with the
// right number of tricks; records agree with the engine's result; bad arguments are refused; one sanity
// number (timed bots, 4p, no bonus: about 4.9 cards banked per hand, Python 4.9); the report runs.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runSim, runSimThreaded } from './sim.mjs';
import { report, winnersBy } from './sim-report.mjs';
import { suite } from './lib.mjs';

const { check, done } = suite('sim-check');
const run = (argv) => runSim(parseArgs(argv));
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// ---- determinism, termination, consistency ----
for (const argv of [
  ['--players=3', '--seats=easy', '--games=60', '--seed=7'],
  ['--players=4', '--seats=medium,easy,greedy,medium', '--games=60', '--seed=7', '--jitter=10'],
  ['--players=5', '--seats=medium', '--games=40', '--seed=9', '--variant.LINE_LIMIT=2', '--variant.LEFTOVER=minus1'],
  ['--players=4', '--seats=medium', '--games=60', '--seed=3', '--variant.TIEBREAK=colours', '--variant.FULL_LINE_BONUS=0'],
]) {
  const a = JSON.stringify(run(argv));
  const b = JSON.stringify(run(argv));
  check(`same seed, same JSON (${argv.slice(0, 3).join(' ')})`, a === b);
  const games = JSON.parse(a);
  const n = parseArgs(argv).players;
  const tricksPer = n === 3 ? 30 : 40;
  check('every game played all its tricks', games.every((g) => g.tricks === tricksPer && g.hs.length === n));
  check('each hand score row matches the totals', games.every((g) => g.tot.every((t, s) => g.hs.reduce((x, h) => x + h[s], 0) === t)));
  check('a winner has the top total and a tiebreak never widens the tie', games.every((g) => g.win.length >= 1 && g.win.length <= g.tied.length && g.win.every((s) => g.tot[s] === Math.max(...g.tot))));
  const tbArg = (argv.find((x) => x.startsWith('--variant.TIEBREAK=')) || '=leftover').split('=')[1];
  const tbRule = { leftover: ['fewestLost'], colours: ['colours'], shared: [] }[tbArg];
  check(`the ${tbArg} tiebreak in the report agrees with the engine`, games.every((g) => JSON.stringify(winnersBy(g, tbRule)) === JSON.stringify(g.win)));
}
check('different seeds differ', JSON.stringify(run(['--games=30', '--seed=1', '--seats=easy'])) !== JSON.stringify(run(['--games=30', '--seed=2', '--seats=easy'])));
{
  const a = parseArgs(['--players=4', '--seats=medium,easy,easy,easy', '--games=24', '--seed=5']);
  const serial = JSON.stringify(runSim(a));
  const threaded = JSON.stringify((await runSimThreaded({ ...a, threads: 3 })).games);
  check('worker threads give the same games as one thread', serial === threaded);
  const rot = runSim(a);
  check('seat rotation moves the bot list', rot[0].lv[0] === 'medium' && rot[1].lv[3] === 'medium' && rot[1].lv[0] === 'easy');
}

// ---- refusals ----
{
  let threw = 0;
  for (const bad of [['--variant.NOPE=1'], ['--variant.LINE_LIMIT=9'], ['--seats=genius'], ['--players=2'], ['--players=4', '--seats=easy,easy'], ['--const.NOPE=1']]) {
    try { parseArgs(bad); } catch { threw++; }
  }
  check('bad variants, bots and counts are refused', threw === 6, `${threw}/6`);
}

// ---- one sanity number: timed bots, 4p, banked cards per hand (Python 4.9; no bonus, as in the Python) ----
{
  const games = run(['--players=4', '--seats=medium', '--games=300', '--seed=1', '--variant.FULL_LINE_BONUS=0']);
  const perHand = mean(games.flatMap((g) => g.hs.flat()));
  check('4p medium: 4.5 to 5.4 cards banked per hand', perHand > 4.5 && perHand < 5.4, perHand.toFixed(2));
  const trump = games.reduce((s, g) => s + g.trump, 0) / games.reduce((s, g) => s + g.tricks, 0);
  check('4p medium: 22% to 32% of tricks won by a personal trump', trump > 0.22 && trump < 0.32, trump.toFixed(3));
}

// ---- the report ----
{
  const dir = mkdtempSync(join(tmpdir(), 'sim-check-'));
  try {
    const f = join(dir, 'a.json');
    const a = parseArgs(['--players=3', '--seats=medium,greedy,easy', '--games=40', '--seed=1']);
    writeFileSync(f, JSON.stringify({ meta: { players: 3, seats: a.seats, rotate: true, jitter: 0, variants: {}, consts: {}, rules: a.rules }, games: runSim(a) }));
    const text = report([f]);
    check('report prints the summary, bot table and tiebreak analysis', /tie for 1st/.test(text) && /Win % by bot level/.test(text) && /Tiebreak analysis/.test(text));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

done();
