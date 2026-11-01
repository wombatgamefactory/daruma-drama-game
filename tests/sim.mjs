// sim.mjs - headless bot-v-bot simulator for balance work (Daruma Drama).
//
//   node tests/sim.mjs --players=4 --seats=medium,medium,hard,easy --games=2000 --seed=1
//        [--rotate=1] [--jitter=5] [--threads=4] [--variant.LINE_LIMIT=2 ...] [--const.X=Y] [--out=path]
//
//  --players=3|4|5      table size. Default: the number of --seats entries (or 4).
//  --seats=a,b,c,d      bot level per seat: easy | medium | hard | greedy (ids from the bot registry).
//                       One entry fills every seat. Default: medium for every seat.
//  --games=N            games to play.
//  --seed=S             run seed; game i uses deriveSeed(S, 'game', i); bot and jitter streams are separate
//                       from the game's deal RNG, so a bot's choices never change the deals.
//  --rotate=1|0         1 (default): in game i seat s plays the bot listed at (s + i) mod n, so a bot's
//                       strength is spread over every seat and seat effects cancel out of bot results.
//                       0: the list is used as given every game (use it to read seat effects of mixed tables).
//  --jitter=N           N percent chance per decision of playing a random legal action instead of the bot's
//                       own choice. Default 0. Breaks the bots' first-of-equals tie order (see report).
//  --variant.NAME=VALUE a rules switch from the VARIANTS table, e.g. --variant.LINE_LIMIT=2 --variant.LEFTOVER=minus1
//                       (checked by the engine's resolveVariants, which throws on a bad name or value).
//  --const.NAME=VALUE   a numeric/JSON entry of the engine's CONSTANTS object (a probe, e.g. --const.MAX_LINE_LIMIT=3).
//  --threads=N          worker threads (default 1). Results are identical for any N: games are independent.
//  --out=path           JSON output (default tests/tmp/sim-<auto-name>.json).
//
// Deterministic for a fixed argument list: the JSON holds no clock values (timing goes to stderr).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  createGame, applyAction, viewFor, legalActionsFromView, makeRng, deriveSeed, rngInt, rngNext,
  VARIANTS, CONSTANTS, resolveVariants, cardColour,
} from '../src/engine/index.js';
import { getBot, botLevels } from '../src/bots/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// ---------- arguments ----------
export function parseArgs(argv) {
  const a = { players: null, seats: null, games: 1000, seed: 1, jitter: 0, rotate: true, threads: 1, out: null, variants: {}, consts: {} };
  for (const raw of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) throw new Error(`Bad argument "${raw}" (use --name=value)`);
    const [, key, val] = m;
    if (key.startsWith('variant.')) {
      const name = key.slice(8);
      if (!VARIANTS.some((v) => v.name === name)) throw new Error(`Unknown variant "${name}". Known: ${VARIANTS.map((v) => v.name).join(', ')}`);
      a.variants[name] = val;
    } else if (key.startsWith('const.')) {
      const name = key.slice(6);
      if (!(name in CONSTANTS)) throw new Error(`Unknown constant "${name}". Known: ${Object.keys(CONSTANTS).join(', ')}`);
      try { a.consts[name] = JSON.parse(val); } catch { a.consts[name] = val; }
    } else if (key === 'seats') a.seats = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'out') a.out = val;
    else if (key === 'rotate') a.rotate = !['0', 'false', 'no'].includes(val);
    else if (['players', 'games', 'jitter', 'threads'].includes(key)) {
      a[key] = Number(val);
      if (!Number.isFinite(a[key])) throw new Error(`--${key} must be a number`);
    } else if (key === 'seed') a.seed = /^\d+$/.test(val) ? Number(val) : val;
    else throw new Error(`Unknown option --${key}`);
  }
  if (!a.seats) a.seats = ['medium'];
  if (a.players === null) a.players = a.seats.length > 1 ? a.seats.length : 4;
  if (![3, 4, 5].includes(a.players)) throw new Error('--players must be 3, 4 or 5');
  if (a.seats.length === 1) a.seats = Array(a.players).fill(a.seats[0]);
  if (a.seats.length !== a.players) throw new Error(`--seats lists ${a.seats.length} bots for ${a.players} players`);
  const known = botLevels().map((l) => l.id);
  for (const s of a.seats) if (!known.includes(s)) throw new Error(`--seats: unknown bot "${s}" (${known.join(', ')})`);
  if (a.jitter < 0 || a.jitter > 100) throw new Error('--jitter is a percentage 0..100');
  if (!Number.isInteger(a.games) || a.games < 1) throw new Error('--games must be a positive integer');
  if (!Number.isInteger(a.threads) || a.threads < 1) throw new Error('--threads must be a positive integer');
  a.rules = resolveVariants(a.variants); // throws on a bad name or value
  return a;
}

function defaultOut(a) {
  const variants = Object.entries(a.variants).map(([k, v]) => `${k.toLowerCase().replace(/_/g, '-')}-${v}`).join('-');
  const consts = Object.entries(a.consts).map(([k, v]) => `${k.toLowerCase().replace(/_/g, '-')}-${v}`).join('-');
  const who = [...a.seats].join('-');
  const name = `sim-${a.players}p-${who}-n${a.games}-s${a.seed}${a.rotate ? '' : '-fixed'}${a.jitter ? `-j${a.jitter}` : ''}${variants ? `-${variants}` : ''}${consts ? `-${consts}` : ''}.json`;
  return resolve(HERE, 'tmp', name.toLowerCase());
}

// ---------- recording ----------
const distinctColours = (cards) => new Set(cards.map(cardColour)).size;
const soleLeader = (totals) => {
  const top = Math.max(...totals);
  const at = totals.map((t, s) => (t === top ? s : -1)).filter((s) => s >= 0);
  return at.length === 1 ? at[0] : null;
};

/**
 * One compact record from a finished game state.
 * lv = bot level by seat; tot = final totals; hs = scores by hand then seat; win = winning seats;
 * tied = seats tied on the top total (before any tiebreak); tb = the colour tiebreak separated them;
 * col = different colours banked over the whole game, by seat; the rest are explained in sim-report.mjs.
 */
export function recordGame(g, levels) {
  const m = g.measures;
  const r = g.result;
  const n = g.n;
  const hands = g.handLog;
  const running = [];
  let acc = Array(n).fill(0);
  for (const h of hands) {
    acc = acc.map((t, s) => t + h.scores[s]);
    running.push([...acc]);
  }
  // lead changes: the sole leader of the running total changes between two hands (ties for the lead count as no leader).
  let leadChanges = 0;
  let prev = null;
  for (const t of running) {
    const cur = soleLeader(t);
    if (cur !== null && prev !== null && cur !== prev) leadChanges++;
    if (cur !== null) prev = cur;
  }
  // final-hand comeback: no eventual winner was among the leaders (shared lead included) before the last hand.
  let comeback = false;
  if (running.length >= 2) {
    const before = running[running.length - 2];
    const top = Math.max(...before);
    comeback = !r.winners.some((s) => before[s] === top);
  }
  const last = hands[hands.length - 1];
  return {
    n,
    lv: [...levels],
    fd: g.firstDealer,
    tot: r.totals,
    hs: r.handScores,
    win: r.winners,
    tied: r.tiedOnTotal,
    tb: r.tiebreakUsed,
    col: r.colourCounts,
    tricks: m.tricks,
    trump: m.trumpTricks,
    clash: m.clashTricks,
    tieTr: m.trumpTies,
    lead: m.leaderWins,
    rise: [...m.riseSizes],
    tw: [...m.tricksWon],
    ko: [...m.knockOffs],
    lostBy: [...m.leftover],
    lastBanked: last.banked.map((b) => b.length),
    lastCols: last.banked.map(distinctColours),
    leadChanges,
    comeback,
  };
}

// ---------- playing ----------
function makeChooser(level, jitter, rngBot, rngJit) {
  const bot = getBot(level);
  return (view) => {
    if (jitter > 0 && rngNext(rngJit) * 100 < jitter) {
      const legal = legalActionsFromView(view);
      return legal[rngInt(rngJit, legal.length)];
    }
    return bot.chooseAction(view, rngBot);
  };
}

function playToEnd(state, choosers) {
  let guard = 0;
  while (state.toAct !== null) {
    const seat = state.toAct;
    const act = choosers[seat](viewFor(state, seat));
    applyAction(state, act, { silent: true });
    if (++guard > 5000) throw new Error('livelock');
  }
}

/** Plays games [from, to) of the run. Pure function of the arguments. */
export function runRange(a, from, to) {
  for (const [k, v] of Object.entries(a.consts)) CONSTANTS[k] = v;
  const n = a.players;
  const games = [];
  for (let i = from; i < to; i++) {
    const seed = deriveSeed(a.seed, 'game', i);
    const levels = Array.from({ length: n }, (_, s) => a.seats[a.rotate ? (s + i) % n : s]);
    const choosers = levels.map((lv, s) => makeChooser(lv, a.jitter, makeRng(deriveSeed(seed, 'bot', s)), makeRng(deriveSeed(seed, 'jitter', s))));
    const g = createGame({ seed, players: n, rules: a.variants });
    playToEnd(g, choosers);
    games.push(recordGame(g, levels));
  }
  return games;
}

export function runSim(a) {
  return runRange(a, 0, a.games);
}

/** Splits the run across worker threads; output order and content are the same as runSim. */
export async function runSimThreaded(a) {
  const t0 = Date.now();
  if (a.threads <= 1 || a.games < 2 * a.threads) return { games: runSim(a), ms: Date.now() - t0 };
  const size = Math.ceil(a.games / a.threads);
  const jobs = [];
  for (let from = 0; from < a.games; from += size) {
    const to = Math.min(a.games, from + size);
    jobs.push(new Promise((res, rej) => {
      const w = new Worker(SELF, { workerData: { a, from, to } });
      w.once('message', res);
      w.once('error', rej);
    }));
  }
  const parts = await Promise.all(jobs);
  return { games: parts.flat(), ms: Date.now() - t0 };
}

// ---------- worker entry ----------
if (!isMainThread && workerData && workerData.a) {
  parentPort.postMessage(runRange(workerData.a, workerData.from, workerData.to));
}

// ---------- main ----------
if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const { games, ms } = await runSimThreaded(a);
    const out = a.out ? resolve(a.out) : defaultOut(a);
    const meta = {
      tool: 'daruma-sim', version: 1, players: a.players, seats: a.seats, rotate: a.rotate, games: a.games, seed: a.seed,
      jitter: a.jitter, rules: a.rules, variants: a.variants, consts: a.consts,
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ meta, games }) + '\n');
    console.error(`${a.games} games in ${(ms / 1000).toFixed(1)}s`);
    console.log(out);
  } catch (e) {
    console.error(`sim: ${e.message}`);
    process.exit(2);
  }
}
