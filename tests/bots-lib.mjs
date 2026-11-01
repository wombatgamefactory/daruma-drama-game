// bots-lib.mjs - helpers shared by tests/bots.mjs and its worker threads (tests/bots-worker.mjs).

import {
  createGame, applyAction, viewFor, legalActionsFromView, getActionBlockReason, makeRng, deriveSeed,
} from '../src/engine/index.js';
import { getBot } from '../src/bots/index.js';
import { searchAction } from '../src/bots/hard.js';

/** Hard at a small search budget, for the legality and variant sweeps (legality does not depend on the budget). */
export const FAST_HARD = { id: 'hard-fast', chooseAction: (view, rng) => searchAction(view, rng, { samples: 2 }).action };
export const botOf = (level) => (level === 'hard-fast' ? FAST_HARD : getBot(level));

/** Plays one game; `levels[seat]` names each seat's bot. Returns counters and the final state. */
export function playGame({ levels, seed, rules = {}, firstDealer = null, checkView = true }) {
  const players = levels.length;
  const state = createGame({ seed, players, rules, firstDealer });
  const rngs = Array.from({ length: players }, (_, s) => makeRng(deriveSeed(seed, 'bot', s)));
  let refusals = 0; let illegal = 0; let mutated = 0; let actions = 0;
  while (state.toAct !== null && actions < 1500) {
    const seat = state.toAct;
    const view = viewFor(state, seat);
    const before = checkView ? JSON.stringify(view) : null;
    const act = botOf(levels[seat]).chooseAction(view, rngs[seat]);
    if (checkView && JSON.stringify(view) !== before) mutated++;
    if (!legalActionsFromView(view).some((a) => a.type === act.type && a.card === act.card)) illegal++;
    if (getActionBlockReason(state, act) !== null) { refusals++; break; }
    applyAction(state, act, { silent: true });
    actions++;
  }
  return { state, refusals, illegal, mutated, actions, over: state.phase === 'over' && state.result !== null };
}

/** The strong level sits in seat i mod n of game i; everyone else plays `opp`. Shared wins count 1/winners. */
export function strengthRun(strong, opp, n, games, tag) {
  let credit = 0; let sharedGames = 0; let marginSum = 0;
  for (let i = 0; i < games; i++) {
    const strongSeat = i % n;
    const r = playGame({ levels: Array.from({ length: n }, (_, s) => (s === strongSeat ? strong : opp)), seed: deriveSeed(tag, n, i), checkView: false });
    const res = r.state.result;
    if (res.winners.includes(strongSeat)) credit += 1 / res.winners.length;
    if (res.shared) sharedGames++;
    marginSum += res.totals[strongSeat] - Math.max(...res.totals.filter((_, s) => s !== strongSeat));
  }
  const rate = credit / games;
  const base = 1 / n;
  const z = (rate - base) / Math.sqrt((base * (1 - base)) / games);
  return { n, games, rate, base, z, shared: sharedGames, margin: marginSum / games };
}

/** Seat levels for a table descriptor: { all: level } or { hardSeat: level, others: [levels cycled] } (the special seat rotates). */
export function tableLevels(spec, n, i) {
  if (spec.all) return Array(n).fill(spec.all);
  return Array.from({ length: n }, (_, s) => (s === i % n ? spec.special : spec.others[(s + i) % spec.others.length]));
}

/** Legality sweep: `gamesPerCount` games at each of 3, 4 and 5 players. Returns counters. */
export function legalitySweep({ spec, gamesPerCount, tag, counts = [3, 4, 5], viewCheckEvery = 4 }) {
  const out = { games: 0, refusals: 0, illegal: 0, mutated: 0, unfinished: 0 };
  for (const n of counts) {
    for (let i = 0; i < gamesPerCount; i++) {
      const r = playGame({ levels: tableLevels(spec, n, i), seed: deriveSeed('legal', tag, n, i), checkView: i % viewCheckEvery === 0 });
      out.games++; out.refusals += r.refusals; out.illegal += r.illegal; out.mutated += r.mutated;
      if (!r.over) out.unfinished++;
    }
  }
  return out;
}

/** One rule set across player counts and tables (medium, greedy, one hard-fast seat, sometimes all hard-fast). */
export function variantSweep({ label, rules, onlyFor, rounds }) {
  const counts = onlyFor || [3, 4, 5];
  const out = { games: 0, bad: 0, notes: [] };
  for (let i = 0; i < rounds; i++) {
    const n = counts[i % counts.length];
    const tables = [{ all: 'medium' }, { all: 'greedy' }, { special: 'hard-fast', others: ['medium'] }];
    if (i % 4 === 0) tables.push({ all: 'hard-fast' });
    for (const spec of tables) {
      const levels = tableLevels(spec, n, i);
      const r = playGame({ levels, seed: deriveSeed('var', label, i, levels.join()), rules });
      out.games++;
      if (!r.over || r.refusals || r.illegal || r.mutated) { out.bad++; if (out.notes.length < 3) out.notes.push(`${label} ${levels.join()}`); }
    }
  }
  return out;
}

export const JOBS = {
  legality: legalitySweep,
  variants: variantSweep,
  strength: ({ strong, opp, n, games, tag }) => strengthRun(strong, opp, n, games, tag),
};
