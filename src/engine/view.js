// view.js - what one seat may know (R18, R19), and helpers bots compute from it.
//
// viewFor(state, seat) is the ONLY thing a bot receives. It holds the seat's own hand, its own
// score pile and pending first fall, and everything public: every fall line (so every trump
// and bank size), the current trick, this hand's completed tricks (the public trick history,
// R19.10), the discard pile (R19.5), every seat's card counts, the pad. Never: another hand,
// another seat's pending first fall (R19.11, shown as 'hidden'), another score pile's cards
// (counts only, R19.4), the set-aside cards (count only, R19.3).
//
// Note: completed tricks keep `bank` (the line the winner banked). Those cards were face up on
// the line before the trick, so this is public history, not a peek into the pile; it lets a
// bot account for every card a careful human could.
// Voids are not announced (R20.3): shownVoids() derives them from the trick history.

import { cardColour, fullDeck, sortCards, trumpOf } from './cards.js';
import { legalActionsFor } from './legality.js';
import { forkRng, rngInt, shuffle } from './rng.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

// Fast copies of the history records (viewFor runs at every bot decision; JSON cloning the
// whole history there was the simulator's bottleneck).
const copyPlays = (plays) => plays.map((p) => ({ seat: p.seat, card: p.card, trump: p.trump }));
const copyTrick = (t) => ({ ...t, trumps: [...t.trumps], plays: copyPlays(t.plays), bank: t.bank ? [...t.bank] : t.bank, knocked: t.knocked ? t.knocked.map((k) => ({ seat: k.seat, card: k.card })) : t.knocked });
const copyMeasures = (m) => ({ ...m, riseSizes: [...m.riseSizes], tricksWon: [...m.tricksWon], trumpTricksWon: [...m.trumpTricksWon], banked: [...m.banked], knockOffs: [...m.knockOffs], leftover: [...m.leftover] });
function copyHand(h, seat) {
  return {
    ...h,
    falls: [...h.falls],
    scores: [...h.scores],
    banked: h.banked.map((b, s) => (s === seat ? [...b] : null)), // R19.4: own pile cards only
    lost: h.lost.map((l) => [...l]),
    penalties: [...h.penalties],
    knockOffs: [...h.knockOffs],
    tricks: h.tricks.map(copyTrick),
  };
}

/** The view of `seat` (0..n-1). Plain JSON; a fresh copy each call. */
export function viewFor(state, seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.n) throw new Error(`viewFor needs a seat 0..${state.n - 1}, got ${seat}`);
  let falls;
  if (state.phase === 'fall' && state.pending) {
    falls = state.pending.map((c, s) => (s === seat ? c : (c === null ? null : 'hidden'))); // R19.11
  } else {
    falls = state.falls ? [...state.falls] : null;
  }
  return {
    kind: 'view',
    seat,
    n: state.n,
    rules: { ...state.rules },
    params: { ...state.params, colours: [...state.params.colours] },
    rulesCode: state.rulesCode,
    phase: state.phase, // 'fall' | 'play' | 'over'
    toAct: state.toAct,
    hand: [...state.hands[seat]], // R19.1
    handCounts: state.hands.map((h) => h.length), // R19.8
    lines: state.lines.map((l) => [...l]), // R19.2
    trumps: state.lines.map(trumpOf),
    bankSizes: state.lines.map((l) => l.length),
    pileCounts: state.piles.map((p) => p.length), // R19.4
    myPile: [...state.piles[seat]],
    discard: [...state.discard], // R19.5
    setAsideCount: state.setAside.length, // R19.3
    falls, // during 'fall': own card, 'hidden' or null; afterwards every first fall of this hand
    firstDealer: state.firstDealer,
    dealer: state.dealer,
    leader: state.leader,
    handNo: state.handNo,
    handSize: state.handSize,
    tricksPerHand: state.tricksPerHand,
    trickNo: state.trickNo,
    trick: state.trick ? copyTrick(state.trick) : null, // R19.6
    tricks: state.tricks.map(copyTrick), // R19.10
    handLog: state.handLog.map((h) => copyHand(h, seat)), // banked: own cards only
    totals: [...state.totals], // R19.7
    penalties: [...state.penalties],
    measures: copyMeasures(state.measures),
    result: state.result ? clone(state.result) : null,
  };
}

/** The legal actions for the viewing seat, computed from the view alone (empty if not its turn). */
export function legalActionsFromView(view) {
  if (view.toAct !== view.seat) return [];
  return legalActionsFor(view.phase, view.hand, view.trick);
}

/**
 * Colours each seat has shown it lacks THIS HAND: playing off the led colour shows a void in
 * it (R20.3). Valid until the hand ends (no drawing, R9.1).
 * @returns {string[][]} by seat
 */
export function shownVoids(view) {
  const out = Array.from({ length: view.n }, () => new Set());
  const tricks = view.trick ? [...view.tricks, view.trick] : view.tricks;
  for (const t of tricks) for (const p of t.plays) if (cardColour(p.card) !== t.ledColour) out[p.seat].add(t.ledColour);
  return out.map((s) => view.params.colours.filter((c) => s.has(c)));
}

/** Every card of this hand's deck the viewer can place (own hand, lines, trick, discard, piles, own pending fall). */
function knownCards(view) {
  const known = new Set(view.hand);
  for (const l of view.lines) for (const c of l) known.add(c);
  if (view.trick) for (const p of view.trick.plays) known.add(p.card);
  for (const c of view.discard) known.add(c);
  for (const c of view.myPile) known.add(c);
  for (const t of view.tricks) for (const c of t.bank) known.add(c);
  if (view.rules.FORMAT === 'shrinking') for (const h of view.handLog) for (const t of h.tricks) for (const c of t.bank) known.add(c);
  if (view.falls) for (const c of view.falls) if (c && c !== 'hidden') known.add(c);
  return known;
}

/**
 * Cards the viewer cannot place: the other hands (with any hidden pending first falls) plus
 * the set-aside cards. Sorted.
 */
export function unknownCards(view) {
  const known = knownCards(view);
  return fullDeck(view.params.colours).filter((c) => !known.has(c));
}

/** Each seat's score pile as cards, rebuilt from the public trick history. */
function rebuildPiles(view) {
  const piles = Array.from({ length: view.n }, () => []);
  const hands = view.rules.FORMAT === 'shrinking' ? [...view.handLog.map((h) => h.tricks), view.tricks] : [view.tricks];
  for (const tricks of hands) for (const t of tricks) piles[t.winner].push(...t.bank);
  return piles;
}

/**
 * A complete game state consistent with the view, for search bots (clone it and play on with
 * applyAction). Other hands are dealt uniformly from the unknown cards, respecting shown voids
 * (retrying, then filling the most constrained seat first); the rest become the set-aside cards.
 * A seat whose first fall is 'hidden' gets a random card of its sampled hand as that fall.
 */
export function determinise(view, rng) {
  const n = view.n;
  const me = view.seat;
  const unknown = unknownCards(view);
  const voids = shownVoids(view).map((v) => new Set(v));
  const need = view.handCounts.map((c, s) => (s === me ? 0 : c + (view.falls && view.falls[s] === 'hidden' ? 1 : 0)));
  const others = Array.from({ length: n }, (_, s) => s).filter((s) => s !== me);

  let hands = null;
  for (let attempt = 0; attempt < 40 && !hands; attempt++) {
    const pool = shuffle(rng, [...unknown]);
    const order = attempt < 20 ? others : [...others].sort((a, b) => voids[b].size - voids[a].size);
    const got = Array.from({ length: n }, () => []);
    let ok = true;
    for (const s of order) {
      for (let i = 0; i < pool.length && got[s].length < need[s];) {
        if (voids[s].has(cardColour(pool[i]))) { i++; continue; }
        got[s].push(pool[i]);
        pool.splice(i, 1);
      }
      if (got[s].length < need[s]) { ok = false; break; }
    }
    if (ok) hands = got;
  }
  if (!hands) {
    // Voids cannot all be honoured (should not happen for a consistent view): ignore them.
    const pool = shuffle(rng, [...unknown]);
    hands = Array.from({ length: n }, () => []);
    for (const s of others) hands[s] = pool.splice(0, need[s]);
  }
  const taken = new Set(hands.flat());
  hands[me] = [...view.hand];

  let pending = null;
  if (view.phase === 'fall') {
    pending = view.falls.map((c, s) => {
      if (s === me) return c;
      if (c !== 'hidden') return null;
      return hands[s][rngInt(rng, hands[s].length)];
    });
    for (let s = 0; s < n; s++) if (s !== me && pending[s] !== null) hands[s] = hands[s].filter((c) => c !== pending[s]);
  }

  const piles = rebuildPiles(view);
  const handLog = view.handLog.map((h) => ({ ...clone(h), banked: Array.from({ length: n }, (_, s) => h.tricks.filter((t) => t.winner === s).flatMap((t) => t.bank)) }));
  return {
    kind: 'game',
    schema: 1,
    seed: 'determinised',
    n,
    rules: { ...view.rules },
    params: clone(view.params),
    rulesCode: view.rulesCode,
    rng: forkRng(rng),
    deals: null,
    firstDealer: view.firstDealer,
    dealer: view.dealer,
    handNo: view.handNo,
    handSize: view.handSize,
    tricksPerHand: view.tricksPerHand,
    phase: view.phase,
    toAct: view.toAct,
    leader: view.leader,
    hands: hands.map((h) => sortCards(h)),
    setAside: unknown.filter((c) => !taken.has(c)),
    lines: view.lines.map((l) => [...l]),
    piles,
    discard: [...view.discard],
    pending,
    falls: view.phase === 'fall' ? null : (view.falls ? [...view.falls] : null),
    trickNo: view.trickNo,
    trick: view.trick ? clone(view.trick) : null,
    tricks: clone(view.tricks),
    handLog,
    totals: [...view.totals],
    penalties: [...view.penalties],
    measures: clone(view.measures),
    result: view.result ? clone(view.result) : null,
  };
}
