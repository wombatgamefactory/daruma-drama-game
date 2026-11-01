// actions.js - applyAction (returns events).
//
// applyAction(state, action) mutates `state` and RETURNS the events it produced; nothing is
// logged into the state. It throws, before changing anything, if getActionBlockReason refuses.
//
// After the action, every decision that has exactly ONE legal option is applied at once and
// its events carry `auto: true` (R20.2): e.g. the only card of the led colour, the last card
// of a hand (so the last trick of every hand plays itself), and so on until a real decision
// or the end of the game. Hand ends and the next deal happen inside the same call.
//
// A completed trick (state.tricks, and handLog[h].tricks) is:
//   { n, leader, ledColour, trumps, plays: [{ seat, card, trump }], winner, winningCard,
//     byTrump, trumpsPlayed, tie, bank, bonus, knocked: [{ seat, card }] }
//   trumps   every seat's trump colour (or null) for the whole trick (R6.6)
//   bank     the winner's line before the trick, now in their score pile (R7.3)
//   bonus    full-line bonus points for that rise (R7.3a: the bank was a full line), else 0
//   knocked  cards knocked off the left of a line by a 4th (or L+1th) card (R7.2)
//   tie      decided by TRUMP_TIES (two equal trumps of different colours, R6.8)

import { cardColour, trumpOf } from './cards.js';
import { getActionBlockReason, getValidActions, isTrumpPlay, trickWinner } from './legality.js';
import { dealHand, nextHandSize } from './state.js';
import { gameResult } from './scoring.js';

/**
 * Applies one action by state.toAct, then any forced (single-option) decisions.
 * @param {object} state
 * @param {{type:'fall'|'play', card:string}} action
 * @param {{silent?: boolean}} [opts]  silent: skip building events (search / simulator speed)
 * @returns {object[]} events (empty array when silent)
 */
export function applyAction(state, action, opts = {}) {
  const reason = getActionBlockReason(state, action);
  if (reason !== null) throw new Error(reason);
  const events = opts.silent ? null : [];
  doAction(state, action, events, false);
  runForced(state, events);
  return events || [];
}

/** Applies single-option decisions until a real choice or the end (R20.2). */
function runForced(state, events) {
  while (state.toAct !== null) {
    const acts = getValidActions(state);
    if (acts.length !== 1) return;
    doAction(state, acts[0], events, true);
  }
}

function doAction(state, action, events, auto) {
  if (action.type === 'fall') chooseFall(state, action.card, events, auto);
  else playCard(state, action.card, events, auto);
}

function chooseFall(state, card, events, auto) {
  const seat = state.toAct;
  const n = state.n;
  state.hands[seat] = state.hands[seat].filter((c) => c !== card);
  state.pending[seat] = card; // R4.3: hidden until everyone has chosen
  if (events) events.push({ type: 'fall-chosen', handNo: state.handNo, seat, auto }); // no card: still secret
  // R4.4: choices are taken from the first leader clockwise.
  for (let k = 1; k < n; k++) {
    const next = (seat + k) % n;
    if (state.pending[next] === null) { state.toAct = next; return; }
  }
  // R4.2: all in, revealed together; each is the first card of its line (R4.1, R13.3).
  const falls = [...state.pending];
  state.lines = falls.map((c) => [c]);
  state.falls = falls;
  state.pending = null;
  state.phase = 'play';
  state.toAct = state.leader; // R5.1
  if (events) events.push({ type: 'falls-revealed', handNo: state.handNo, falls: [...falls], auto: false });
}

function playCard(state, card, events, auto) {
  const seat = state.toAct;
  state.hands[seat] = state.hands[seat].filter((c) => c !== card);
  if (state.trick === null) {
    // R5.2: the lead sets the led colour. R6.6: trumps fixed for the whole trick.
    state.trick = { n: state.trickNo + 1, leader: seat, ledColour: cardColour(card), trumps: state.lines.map(trumpOf), plays: [] };
  }
  const t = state.trick;
  const trump = isTrumpPlay(card, t.ledColour, t.trumps[seat]);
  t.plays.push({ seat, card, trump });
  if (events) events.push({ type: 'card-played', handNo: state.handNo, trickNo: t.n, seat, card, asLeader: t.plays.length === 1, trump, auto });
  if (t.plays.length < state.n) {
    state.toAct = (seat + 1) % state.n; // R6.0 clockwise
    return;
  }
  resolveTrick(state, events);
}

function resolveTrick(state, events) {
  const t = state.trick;
  const m = state.measures;
  const limit = state.params.lineLimit;
  // R7.8 (a): the winner from the cards and the pre-trick trumps.
  const win = trickWinner(t.plays, t.trumps, state.rules.TRUMP_TIES);
  const w = win.seat;
  const bank = [...state.lines[w]];
  const bonus = bank.length === limit ? state.params.fullLineBonus : 0; // R7.3a
  const knocked = [];
  // R7.8 (b), R7.1, R7.2: every loser falls at the right end; over the limit, the leftmost is knocked off.
  for (const p of t.plays) {
    if (p.seat === w) continue;
    const line = state.lines[p.seat];
    line.push(p.card);
    if (line.length > limit) {
      const off = line.shift();
      state.discard.push(off); // R13.2
      knocked.push({ seat: p.seat, card: off });
      m.knockOffs[p.seat]++;
    }
  }
  // R7.8 (c), R7.3, R7.4, R7.6: the winner banks the whole line; the winning card is discarded.
  state.piles[w].push(...bank);
  state.lines[w] = [];
  state.discard.push(win.card);

  m.tricks++;
  m.tricksWon[w]++;
  m.banked[w] += bank.length;
  m.riseSizes[bank.length]++;
  if (bonus) m.bonusPoints[w] += bonus;
  if (win.byTrump) { m.trumpTricks++; m.trumpTricksWon[w]++; }
  if (win.trumpsPlayed >= 2) m.clashTricks++;
  if (win.tie) m.trumpTies++;
  if (w === t.leader) m.leaderWins++;

  const record = { ...t, winner: w, winningCard: win.card, byTrump: win.byTrump, trumpsPlayed: win.trumpsPlayed, tie: win.tie, bank, bonus, knocked };
  state.tricks.push(record);
  state.trick = null;
  state.trickNo++;
  state.leader = w; // R7.5, R12.4
  state.toAct = w;
  if (events) {
    events.push({ type: 'trick-won', handNo: state.handNo, trickNo: record.n, winner: w, card: win.card, byTrump: win.byTrump, trumpColour: win.byTrump ? t.trumps[w] : null, bank: [...bank], bankSize: bank.length, bonus, knocked: knocked.map((k) => ({ ...k })), trumpsPlayed: win.trumpsPlayed, tie: win.tie });
  }
  if (state.trickNo >= state.tricksPerHand) endHand(state, events); // R9.1
}

function endHand(state, events) {
  const n = state.n;
  const minus1 = state.rules.LEFTOVER === 'minus1';
  const lost = state.lines.map((l) => [...l]);
  const banked = Array.from({ length: n }, (_, s) => state.tricks.filter((t) => t.winner === s).flatMap((t) => t.bank));
  const knockOffs = Array.from({ length: n }, (_, s) => state.tricks.reduce((a, t) => a + t.knocked.filter((k) => k.seat === s).length, 0));
  const bonuses = Array.from({ length: n }, (_, s) => state.tricks.filter((t) => t.winner === s).reduce((a, t) => a + t.bonus, 0));
  // R9.2 / RV6.2: line cards are lost (or -1 each); R9.3: score = cards banked this hand + full-line bonuses.
  const penalties = lost.map((l) => (minus1 ? l.length : 0));
  const scores = banked.map((b, s) => b.length + bonuses[s] - penalties[s]);
  for (let s = 0; s < n; s++) {
    state.discard.push(...state.lines[s]); // R13.2
    state.lines[s] = [];
    state.totals[s] += scores[s];
    state.penalties[s] += penalties[s];
    state.measures.leftover[s] += lost[s].length;
  }
  state.measures.hands++;
  state.handLog.push({
    handNo: state.handNo,
    dealer: state.dealer,
    firstLeader: (state.dealer + 1) % n,
    handSize: state.handSize,
    falls: [...state.falls],
    scores,
    banked,
    bonuses,
    lost,
    penalties,
    knockOffs,
    tricks: state.tricks,
  });
  state.tricks = [];
  if (events) events.push({ type: 'hand-ended', handNo: state.handNo, scores: [...scores], lost: lost.map((l) => [...l]), penalties: [...penalties], bankedCounts: banked.map((b) => b.length), bonuses: [...bonuses], totals: [...state.totals] });

  state.handNo++;
  if (nextHandSize(state) === 0) {
    // R10.1 (pad: everyone has dealt once) / RV3.2 (shrinking: cannot deal 4 each).
    state.phase = 'over';
    state.toAct = null;
    state.result = gameResult(state);
    if (events) events.push({ type: 'game-over', ...JSON.parse(JSON.stringify(state.result)) });
    return;
  }
  dealHand(state, events);
}
