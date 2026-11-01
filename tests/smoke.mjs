// smoke.mjs - Easy bots only: 1000 games at each of 3, 4 and 5 players, and 1000 games under
// every non-default variant value (player counts rotating 3/4/5). Every game must terminate,
// with zero refused bot actions, legalActionsFromView = getValidActions at every decision,
// card conservation after every action (R13.1), and the state JSON round-tripping (play
// continues on the parsed copy). The same seed must give an identical game.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import {
  startGame, applyAction, getValidActions, getActionBlockReason, viewFor, legalActionsFromView,
  makeRng, deriveSeed, VARIANTS,
} from '../src/engine/index.js';
import { getBot } from '../src/bots/index.js';
import { suite, conservation } from './lib.mjs';

const { check, done } = suite('smoke');
const GAMES = 1000;
const MAX_ACTIONS_PER_GAME = 600; // a 5-player game is under 300 decisions; near this is a livelock
const ROUND_TRIP_EVERY_STEP_GAMES = 30; // per run: the first N games round-trip after every action; the rest after every hand

/** Plays a game with Easy bots; returns counters. */
function playOut(players, rules, seed, everyStep) {
  const r = { refusals: 0, actions: 0, roundTripBad: 0, viewBad: 0, consBad: 0, consProblem: '', over: false, events: [] };
  const started = startGame({ seed, players, rules });
  let state = started.state;
  r.events.push(...started.events);
  const rngs = Array.from({ length: players }, (_, s) => makeRng(deriveSeed(seed, 'bot', s)));
  while (state.toAct !== null && r.actions < MAX_ACTIONS_PER_GAME) {
    const seat = state.toAct;
    const view = viewFor(state, seat);
    if (JSON.stringify(legalActionsFromView(view)) !== JSON.stringify(getValidActions(state))) r.viewBad++;
    const action = getBot('easy').chooseAction(view, rngs[seat]);
    if (getActionBlockReason(state, action) !== null) { r.refusals++; break; }
    const handBefore = state.handNo;
    r.events.push(...applyAction(state, action));
    r.actions++;
    const c = conservation(state);
    if (!c.ok) { r.consBad++; r.consProblem = r.consProblem || c.problem; }
    if (everyStep || state.handNo !== handBefore || state.toAct === null) {
      const text = JSON.stringify(state);
      const copy = JSON.parse(text);
      if (JSON.stringify(copy) !== text) r.roundTripBad++;
      state = copy; // continue on the round-tripped copy
    }
  }
  r.over = state.phase === 'over' && state.result !== null;
  r.state = state;
  return r;
}

function run(label, playersFor, rules, games = GAMES) {
  let refusals = 0; let unfinished = 0; let rt = 0; let view = 0; let cons = 0; let firstProblem = ''; let actions = 0; let shared = 0; let tiebreaks = 0;
  for (let i = 0; i < games; i++) {
    const r = playOut(playersFor(i), rules, deriveSeed('smoke', label, i), i < ROUND_TRIP_EVERY_STEP_GAMES);
    refusals += r.refusals; rt += r.roundTripBad; view += r.viewBad; cons += r.consBad; actions += r.actions;
    if (!firstProblem && r.consProblem) firstProblem = r.consProblem;
    if (!r.over) unfinished++;
    else { shared += r.state.result.shared; tiebreaks += r.state.result.tiebreakUsed; }
  }
  check(`${label}: ${games} games terminate`, unfinished === 0, `${unfinished} unfinished`);
  check(`${label}: zero refused bot actions`, refusals === 0, `${refusals}`);
  check(`${label}: legalActionsFromView = getValidActions at every decision`, view === 0, `${view}`);
  check(`${label}: card conservation after every action`, cons === 0, `${cons}: ${firstProblem}`);
  check(`${label}: state JSON round-trips`, rt === 0, `${rt}`);
  console.log(`  ${label}: ${games} games, ${(actions / games).toFixed(0)} decisions/game, shared wins ${shared}, tiebreaks ${tiebreaks}`);
}

const t0 = process.hrtime.bigint();
for (const n of [3, 4, 5]) run(`std ${n}p`, () => n, {});
for (const def of VARIANTS) {
  for (const value of def.values) {
    if (value === def.default) continue;
    // DECK_3P only matters at 3 players: play all its games there.
    run(`${def.name}=${value}`, def.onlyFor ? () => def.onlyFor[0] : (i) => 3 + (i % 3), { [def.name]: value });
  }
}

// Determinism: same seed, same game (state and events).
{
  const once = (seed) => { const r = playOut(4, {}, seed, false); return JSON.stringify([r.state, r.events]); };
  check('same seed -> identical game (state and events)', once('det-1') === once('det-1'));
  check('different seed -> different game', once('det-1') !== once('det-2'));
}
console.log(`  smoke time ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s`);
done();
