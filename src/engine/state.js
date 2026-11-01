// state.js - createGame / startGame and dealing a hand.
//
// SERIALISABILITY IS LOAD-BEARING: every state survives JSON.parse(JSON.stringify(state))
// unchanged. Plain JSON only, null never undefined, no functions or class instances.
//
// Seats are 0..n-1 clockwise; "left of X" is (X + 1) mod n. Who is human or bot is a UI
// concern and is NOT in the engine state. Everything "per player" is an array indexed by seat.
//
// The state shape, in brief (each field is described where it is created, below):
//   kind 'game', schema, seed, n, rules, params, rulesCode, rng, deals,
//   firstDealer, dealer, handNo, handSize, tricksPerHand,
//   phase 'fall' | 'play' | 'over', toAct, leader,
//   hands, setAside, lines, piles, discard, pending, falls,
//   trickNo, trick, tricks, handLog, totals, penalties, measures, result.

import { CONSTANTS, resolveVariants, rulesCode, deriveParams } from './rules.js';
import { makeRng, rngInt, shuffle } from './rng.js';
import { fullDeck, sortCards, isCard } from './cards.js';

const filled = (n, f) => Array.from({ length: n }, f);

function emptyMeasures(n) {
  return {
    hands: 0, // completed hands
    tricks: 0, // completed tricks
    trumpTricks: 0, // tricks won by a personal trump
    clashTricks: 0, // tricks in which 2+ personal trumps were played (trump clashes)
    trumpTies: 0, // tricks decided by the TRUMP_TIES rule (two equal trumps, R6.8)
    leaderWins: 0, // tricks won by their leader
    riseSizes: filled(CONSTANTS.MAX_LINE_LIMIT + 1, () => 0), // tricks won banking 0, 1, 2, 3 cards
    tricksWon: filled(n, () => 0),
    trumpTricksWon: filled(n, () => 0),
    banked: filled(n, () => 0), // cards banked over the game
    knockOffs: filled(n, () => 0), // cards knocked off lines (R7.2)
    leftover: filled(n, () => 0), // line cards left at hand ends (R9.2)
    bonusPoints: filled(n, () => 0), // full-line bonus points scored (R7.3a)
  };
}

/** Cards dealt to each player in the hand about to be dealt, or 0 if the game must end (RV3.3). */
export function nextHandSize(state) {
  const p = state.params;
  if (state.rules.FORMAT === 'pad') return state.handNo < p.handsPerGame ? p.handSize : 0;
  const inPiles = state.piles.reduce((a, pile) => a + pile.length, 0);
  const hs = Math.min(p.handCap, Math.floor((p.deckSize - inPiles) / state.n));
  return hs >= p.minHand ? hs : 0;
}

function checkDeal(deal, n, hs, deck) {
  if (!deal || !Array.isArray(deal.hands) || deal.hands.length !== n || deal.hands.some((h) => !Array.isArray(h) || h.length !== hs)) {
    throw new Error(`A fixed deal needs ${n} hands of ${hs} cards`);
  }
  const avail = new Set(deck);
  const all = [...deal.hands.flat(), ...(deal.setAside || [])];
  for (const c of all) if (!isCard(c) || !avail.has(c)) throw new Error(`Card ${JSON.stringify(c)} is not in the deck for this hand`);
  if (new Set(all).size !== all.length) throw new Error('A fixed deal contains a card twice');
}

/**
 * Deals hand `state.handNo` (R3, R2.5): sets the dealer and first leader, shuffles and deals,
 * and starts the first fall (R4) or, under FIRST_FALL top, lays every first card at once (RV2.2).
 * Pushes events when `events` is an array.
 */
export function dealHand(state, events) {
  const { n, params, rules } = state;
  const h = state.handNo;
  const hs = nextHandSize(state);
  if (!hs) throw new Error('No hand can be dealt: the game is over');
  state.dealer = (state.firstDealer + h) % n; // R2.5
  state.leader = (state.dealer + 1) % n;

  let deck;
  if (rules.FORMAT === 'pad') {
    deck = fullDeck(params.colours); // R3.1, R9.5: every card back each hand
    state.piles = filled(n, () => []);
  } else {
    const inPiles = new Set(state.piles.flat()); // RV3.2: score piles stay out
    deck = fullDeck(params.colours).filter((c) => !inPiles.has(c));
  }

  // packets[seat] in dealing order: seat left of the dealer first (R3.3).
  const packets = filled(n, () => []);
  let setAside;
  const fixed = state.deals && state.deals[h] ? state.deals[h] : null;
  if (fixed) {
    checkDeal(fixed, n, hs, deck);
    for (let s = 0; s < n; s++) packets[s] = [...fixed.hands[s]];
    const dealt = new Set(fixed.hands.flat());
    setAside = fixed.setAside ? [...fixed.setAside] : deck.filter((c) => !dealt.has(c));
    if (dealt.size + setAside.length !== deck.length) throw new Error('A fixed deal must account for every card in the deck');
  } else {
    shuffle(state.rng, deck);
    for (let i = 0; i < n; i++) packets[(state.dealer + 1 + i) % n] = deck.slice(i * hs, (i + 1) * hs);
    setAside = deck.slice(n * hs);
  }

  state.handSize = hs;
  state.tricksPerHand = hs - 1; // R2.3
  state.setAside = sortCards(setAside); // R3.2, R3.4
  state.lines = filled(n, () => []); // R3.5
  state.discard = [];
  state.trick = null;
  state.tricks = [];
  state.trickNo = 0;
  state.toAct = state.leader;
  if (events) events.push({ type: 'hand-started', handNo: h, dealer: state.dealer, leader: state.leader, handSize: hs, setAsideCount: state.setAside.length, handsPerGame: params.handsPerGame });

  if (rules.FIRST_FALL === 'top') {
    // RV2.2: the first card dealt to each player falls; no decision (marked auto).
    const falls = packets.map((p) => p[0]);
    state.hands = packets.map((p) => sortCards(p.slice(1)));
    state.lines = falls.map((c) => [c]);
    state.falls = [...falls];
    state.pending = null;
    state.phase = 'play';
    if (events) events.push({ type: 'falls-revealed', handNo: h, falls: [...falls], auto: true });
  } else {
    // R4.3: one secret decision per seat, from the first leader clockwise (R4.4).
    state.hands = packets.map((p) => sortCards(p));
    state.pending = filled(n, () => null);
    state.falls = null;
    state.phase = 'fall';
  }
}

/**
 * A new game, dealt and ready for the first decision, plus the events of the start.
 * @param {object} opts
 * @param {number|string} opts.seed       drives the first dealer (if random) and every shuffle
 * @param {number} opts.players           3, 4 or 5 (R1.5)
 * @param {object} [opts.rules]           variant overrides (rules.js VARIANTS)
 * @param {number|null} [opts.firstDealer] seat of the first dealer; default drawn from the seed (R2.4)
 * @param {Array<{hands: string[][], setAside?: string[]}>|null} [opts.deals]
 *        fixed deals by hand index (replays, tests): hands by seat, each exactly as dealt
 *        (index 0 = first card dealt, the one that falls under FIRST_FALL top). Hands without
 *        an entry are shuffled from the seed.
 * @returns {{ state: object, events: object[] }}
 */
export function startGame(opts = {}) {
  const { seed, players: n, firstDealer = null, deals = null } = opts;
  if (seed === undefined || seed === null) throw new Error('startGame needs a seed');
  const rules = resolveVariants(opts.rules || {});
  const params = deriveParams(rules, n);
  const rng = makeRng(seed);
  let dealer0;
  if (firstDealer === null || firstDealer === undefined) dealer0 = rngInt(rng, n); // R2.4
  else if (Number.isInteger(firstDealer) && firstDealer >= 0 && firstDealer < n) dealer0 = firstDealer;
  else throw new Error(`firstDealer must be a seat 0..${n - 1} or null, got ${firstDealer}`);

  const state = {
    kind: 'game',
    schema: 1,
    seed: String(seed),
    n,
    rules,
    params,
    rulesCode: rulesCode(rules, n),
    rng,
    deals: deals ? JSON.parse(JSON.stringify(deals)) : null,
    firstDealer: dealer0,
    dealer: dealer0,
    handNo: 0,
    handSize: 0,
    tricksPerHand: 0,
    phase: 'fall',
    toAct: null,
    leader: null,
    hands: filled(n, () => []),
    setAside: [],
    lines: filled(n, () => []),
    piles: filled(n, () => []),
    discard: [],
    pending: null,
    falls: null,
    trickNo: 0,
    trick: null,
    tricks: [],
    handLog: [],
    totals: filled(n, () => 0),
    penalties: filled(n, () => 0),
    measures: emptyMeasures(n),
    result: null,
  };
  const events = [{ type: 'game-started', players: n, firstDealer: dealer0, rules: { ...rules }, rulesCode: state.rulesCode, handsPerGame: params.handsPerGame }];
  dealHand(state, events);
  return { state, events };
}

/** startGame without the events. The first decision of a game is never a single option. */
export function createGame(opts = {}) {
  return startGame(opts).state;
}
