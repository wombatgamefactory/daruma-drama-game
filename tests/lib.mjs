// lib.mjs - a tiny check harness shared by the suites (no framework), plus game helpers.

import { createGame, applyAction, fullDeck, sortCards } from '../src/engine/index.js';

export function suite(name) {
  let pass = 0;
  const failures = [];
  function check(label, cond, detail = '') {
    if (cond) pass++;
    else failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
  }
  function done() {
    for (const f of failures) console.log(`  FAIL ${f}`);
    console.log(`${name}: ${pass} passed, ${failures.length} failed`);
    if (failures.length) process.exitCode = 1;
    return failures.length === 0;
  }
  return { check, done };
}

export const roundTrip = (x) => JSON.parse(JSON.stringify(x));
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

/**
 * A hand-built position in the middle of a hand, phase 'play', nobody's trick started.
 * @param {object} o
 * @param {number} [o.players]      default 4
 * @param {string[][]} o.hands      cards in hand by seat
 * @param {string[][]} [o.lines]    fall lines by seat (default empty)
 * @param {number} [o.leader]       seat to lead (default 0)
 * @param {number} [o.tricksLeft]   tricks until the hand ends (default hands[leader].length)
 * @param {object} [o.rules]
 * @param {string[][]} [o.piles]
 */
export function position({ players = 4, hands, lines = null, leader = 0, tricksLeft = null, rules = {}, piles = null }) {
  const g = createGame({ seed: 1, players, rules, firstDealer: (leader - 1 + players) % players });
  g.hands = hands.map((h) => sortCards(h));
  g.lines = lines ? lines.map((l) => [...l]) : hands.map(() => []);
  g.piles = piles ? piles.map((p) => [...p]) : hands.map(() => []);
  g.discard = [];
  g.pending = null;
  g.falls = g.lines.map((l) => l[0] || null);
  g.phase = 'play';
  g.leader = leader;
  g.toAct = leader;
  g.trick = null;
  g.tricks = [];
  g.trickNo = 0;
  g.tricksPerHand = tricksLeft === null ? hands[leader].length : tricksLeft;
  const used = new Set([...g.hands.flat(), ...g.lines.flat(), ...g.piles.flat()]);
  g.setAside = fullDeck(g.params.colours).filter((c) => !used.has(c));
  return g;
}

/**
 * Plays cards in order, each by whoever is to act; a card that the engine already auto-played
 * (single legal option, R20.2) is skipped. Returns all events.
 */
export function play(state, ...cards) {
  let events = [];
  for (const card of cards) {
    if (events.some((e) => (e.type === 'card-played' || e.type === 'fall-chosen') && e.auto && e.card === card)) continue;
    const type = state.phase === 'fall' ? 'fall' : 'play';
    events = events.concat(applyAction(state, { type, card }));
  }
  return events;
}

/**
 * Every card's location: returns { ok, problem }. R13.1: each card of the deck is in exactly
 * one of hands, lines, the trick, score piles, discard, set-aside, pending first falls.
 */
const DECKS = new Map(); // colours key -> Set of the deck's cards

export function conservation(state) {
  // Fast path: count every placed card into a Set; only on a failure build the detail.
  const key = state.params.colours.join();
  if (!DECKS.has(key)) DECKS.set(key, new Set(fullDeck(state.params.colours)));
  const deckSet = DECKS.get(key);
  const fast = new Set();
  let count = 0;
  const add = (c) => { fast.add(c); count++; };
  for (const h of state.hands) for (const c of h) add(c);
  for (const l of state.lines) for (const c of l) add(c);
  for (const p of state.piles) for (const c of p) add(c);
  if (state.trick) for (const p of state.trick.plays) add(p.card);
  for (const c of state.discard) add(c);
  for (const c of state.setAside) add(c);
  if (state.pending) for (const c of state.pending) if (c !== null) add(c);
  if (count === deckSet.size && fast.size === deckSet.size) {
    let all = true;
    for (const c of fast) if (!deckSet.has(c)) { all = false; break; }
    if (all) return { ok: true, problem: '' };
  }
  return conservationDetail(state);
}

function conservationDetail(state) {
  const seen = new Map();
  const put = (c, where) => {
    if (seen.has(c)) return `${c} in ${seen.get(c)} and ${where}`;
    seen.set(c, where);
    return null;
  };
  const places = [];
  state.hands.forEach((h, s) => h.forEach((c) => places.push([c, `hand ${s}`])));
  state.lines.forEach((l, s) => l.forEach((c) => places.push([c, `line ${s}`])));
  state.piles.forEach((p, s) => p.forEach((c) => places.push([c, `pile ${s}`])));
  if (state.trick) state.trick.plays.forEach((p) => places.push([p.card, 'trick']));
  state.discard.forEach((c) => places.push([c, 'discard']));
  state.setAside.forEach((c) => places.push([c, 'set-aside']));
  if (state.pending) state.pending.forEach((c, s) => { if (c !== null) places.push([c, `pending ${s}`]); });
  for (const [c, w] of places) {
    const p = put(c, w);
    if (p) return { ok: false, problem: p };
  }
  const deck = fullDeck(state.params.colours);
  if (seen.size !== deck.length) return { ok: false, problem: `${seen.size} cards placed, deck has ${deck.length}` };
  for (const c of deck) if (!seen.has(c)) return { ok: false, problem: `${c} is nowhere` };
  return { ok: true, problem: '' };
}
