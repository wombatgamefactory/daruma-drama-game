// legality.js - legal actions, block reasons and the trick-winner rule.
//
// ONE implementation of "which cards may this seat play": legalCards(). It reads only the
// actor's own hand and the led colour, so getValidActions (full state) and
// legalActionsFromView (a bot's view, view.js) both call it and cannot disagree.
// applyAction refuses through getActionBlockReason, which asks the same function.
//
// Actions: { type: 'fall', card } during phase 'fall' (R4), { type: 'play', card } during
// phase 'play' (R5, R6). The acting seat is always state.toAct.

import { COLOUR_NAMES } from './rules.js';
import { cardColour, cardNumber, cardName, listCardNames } from './cards.js';

/**
 * The cards a seat may play to a trick (R5.2, R6.1, R6.2).
 * @param {string[]} hand
 * @param {string|null} ledColour  null when the seat is leading
 */
export function legalCards(hand, ledColour) {
  if (ledColour === null) return [...hand]; // R5.2, R5.3: lead anything
  const same = hand.filter((c) => cardColour(c) === ledColour);
  return same.length ? same : [...hand]; // R6.1 must follow; R6.2 otherwise any card
}

/** Is `card`, played by a seat whose trump is `trump`, a trump in a trick led in `ledColour`? (R6.2, R6.4, R6.5) */
export function isTrumpPlay(card, ledColour, trump) {
  const col = cardColour(card);
  return trump !== null && col !== ledColour && col === trump;
}

/**
 * The winner of a (possibly partial) trick (R6.3, R6.8, R12.2).
 * @param {{seat:number, card:string}[]} plays  in play order; plays[0] is the lead
 * @param {(string|null)[]} trumps              every seat's trump colour at the start of the trick (R6.6)
 * @param {'first'|'last'} [tieRule]            TRUMP_TIES (V8)
 * @returns {{ index:number, seat:number, card:string, byTrump:boolean, trumpsPlayed:number, tie:boolean }}
 *   tie: the winner was decided by the tie rule (another trump of the same number was played).
 */
export function trickWinner(plays, trumps, tieRule = 'first') {
  if (!plays.length) throw new Error('trickWinner needs at least the lead');
  const led = cardColour(plays[0].card);
  let best = -1;
  let bestClass = 0;
  let bestNum = -1;
  let trumpsPlayed = 0;
  plays.forEach((p, i) => {
    const num = cardNumber(p.card);
    const trump = isTrumpPlay(p.card, led, trumps[p.seat]);
    if (trump) trumpsPlayed++;
    const cls = trump ? 2 : (cardColour(p.card) === led ? 1 : 0); // R12.2: trump > led colour > not eligible
    if (cls === 0) return;
    if (cls > bestClass || (cls === bestClass && num > bestNum)) {
      best = i; bestClass = cls; bestNum = num;
    } else if (cls === bestClass && num === bestNum && tieRule === 'last') {
      best = i; // RV8.2: only trumps can tie (R6.8)
    }
  });
  const byTrump = bestClass === 2;
  const tie = byTrump && plays.filter((p) => isTrumpPlay(p.card, led, trumps[p.seat]) && cardNumber(p.card) === bestNum).length > 1;
  return { index: best, seat: plays[best].seat, card: plays[best].card, byTrump, trumpsPlayed, tie };
}

/** The legal actions of `seat` in a state-like object (state or view) whose toAct is `seat`. */
function actionsFor(phase, hand, trick) {
  if (phase === 'fall') return hand.map((card) => ({ type: 'fall', card })); // R4.5, R20.1
  if (phase === 'play') return legalCards(hand, trick ? trick.ledColour : null).map((card) => ({ type: 'play', card }));
  return [];
}

/** Every legal action for state.toAct; empty when nobody may act (R20.1). Complete and sound. */
export function getValidActions(state) {
  if (state.toAct === null || state.phase === 'over') return [];
  return actionsFor(state.phase, state.hands[state.toAct], state.trick);
}

/** Internal: shared with view.js. */
export { actionsFor as legalActionsFor };

/**
 * Why `seat` may not play (or, in the first fall, choose) `card` now, as a sentence addressed
 * to that player, or null if it is legal. For UI tooltips; checks in rule-book order.
 */
export function getPlayBlockReason(state, seat, card) {
  if (state.phase === 'over') return 'The game is over.';
  if (seat !== state.toAct) {
    if (state.phase === 'fall' && state.pending && state.pending[seat] !== null && state.pending[seat] !== undefined) return 'You have already chosen your first fall.';
    return state.phase === 'fall' ? 'Wait: another player is choosing a first fall.' : 'It is not your turn.';
  }
  const hand = state.hands[seat];
  if (!hand.includes(card)) return `You do not hold ${typeof card === 'string' && card.includes('-') ? cardName(card) : JSON.stringify(card)}.`;
  if (state.phase === 'fall') return null; // R4.5: any card may fall
  const led = state.trick ? state.trick.ledColour : null;
  const legal = legalCards(hand, led);
  if (legal.includes(card)) return null;
  return `You must follow ${COLOUR_NAMES[led]}: you hold ${listCardNames(legal)}.`; // R6.1
}

/** Why an action object is refused, or null. */
export function getActionBlockReason(state, action) {
  if (!action || (action.type !== 'fall' && action.type !== 'play') || typeof action.card !== 'string') {
    return `Unknown action ${JSON.stringify(action)}; actions are { type: 'fall' | 'play', card }.`;
  }
  if (state.phase === 'over' || state.toAct === null) return 'The game is over.';
  if (state.phase === 'fall' && action.type !== 'fall') return 'Choose your first fall before any card is played.';
  if (state.phase === 'play' && action.type !== 'play') return 'The first fall is over: play a card to the trick.';
  return getPlayBlockReason(state, state.toAct, action.card);
}
