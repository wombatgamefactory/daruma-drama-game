// preview.js - "would this card win now?", by clone-and-apply.
//
// The UI never re-derives a rule. To hint at a card it copies the state, applies the card with the
// engine, and reads what happened: if the trick completed (the engine plays forced moves on its
// own) the trick-won event says who won and what was banked; if the trick is still open, the
// engine's trickWinner() names who leads it right now. The real state is never touched.

import { applyAction, getActionBlockReason, trickWinner, isTrumpPlay } from '../engine/index.js';

/**
 * @param {object} state  the live state; the seat to act is state.toAct
 * @param {string} card
 * @returns {null | { kind: 'fall'|'lead'|'follow', seat, card, trump, wins, final, remaining, winnerSeat, winnerCard, bankSize }}
 *   null if the card may not be played now.
 *   follow: wins = this card would win the trick (final: the trick is decided; otherwise it
 *   leads for now and `remaining` plays are still to come), bankSize = cards the seat would bank.
 */
export function previewCard(state, card) {
  const seat = state.toAct;
  if (seat === null || state.phase === 'over') return null;
  const action = { type: state.phase === 'fall' ? 'fall' : 'play', card };
  if (getActionBlockReason(state, action) !== null) return null;
  if (state.phase === 'fall') return { kind: 'fall', seat, card, trump: false, wins: false, final: false, remaining: 0, winnerSeat: null, winnerCard: null, bankSize: 0 };
  const bankSize = state.lines[seat].length;
  if (!state.trick) return { kind: 'lead', seat, card, trump: false, wins: false, final: false, remaining: state.n - 1, winnerSeat: seat, winnerCard: card, bankSize };

  const trickN = state.trick.n;
  const trump = isTrumpPlay(card, state.trick.ledColour, state.trick.trumps[seat]);
  const sim = JSON.parse(JSON.stringify(state));
  const events = applyAction(sim, action);
  const won = events.find((e) => e.type === 'trick-won' && e.handNo === state.handNo && e.trickNo === trickN);
  if (won) {
    return { kind: 'follow', seat, card, trump, wins: won.winner === seat, final: true, remaining: 0, winnerSeat: won.winner, winnerCard: won.card, bankSize };
  }
  const win = trickWinner(sim.trick.plays, sim.trick.trumps, sim.rules.TRUMP_TIES);
  return { kind: 'follow', seat, card, trump, wins: win.seat === seat, final: false, remaining: state.n - sim.trick.plays.length, winnerSeat: win.seat, winnerCard: win.card, bankSize };
}
