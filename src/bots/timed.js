// timed.js - Medium bot: a port of the Python "timed" bot (class Bot in the original Python simulator) and, through the
// same decision function, the "greedy" archetype (greedy.js). Level id 'medium'.
//
// The idea: a card you lose with stays in front of you and only pays when you
// win a trick, so the question is WHEN to rise. Timed rises when its line is full (the next loss would
// knock a card off) or when the hand is nearly over (2 tricks or fewer left); otherwise it loses on
// purpose, building voids and a long line. Greedy rises as soon as it has any card in its line.
//
// Python's choices, kept decision for decision (the fixture test checks this):
//   * first fall  - the colour with most cards in hand (a tie goes to the later colour in code order),
//                   and its lowest card.
//   * leading     - wants to rise: the highest card; else the lowest card.
//   * following   - wants to rise and a legal card would win the trick as it stands: the lowest such card.
//                   Otherwise lose: with an empty line (this card becomes the trump) the card from the
//                   colour held most, lowest number first; otherwise dump the highest losing card, off-trump
//                   colours first, then from the shortest colour. No losing card: the lowest legal card.
//   * "would win" ignores seats that play after this one, exactly as the Python does.
//
// Ties: Python's min/max keep the first of equal candidates in HAND ORDER, which in the Python sim is the
// random deal order. The web engine always keeps hands sorted (colour order, then number), so here the
// first of equal candidates in that sorted order wins. The decision-match fixture presents the Python bot
// with sorted hands, so the two agree exactly.
//
// Variants: the line limit, the trump tie rule and the hand length come from the view (view.params /
// view.rules / view.trickNo), so every V1-V8 value works. FIRST_FALL top has no fall decision at all, and
// the 'shrinking' format only changes how many tricks are left.
//
// Bots only ever see viewFor(state, seat); timedChoice() is also called by Hard's rollouts with the pieces
// of a determinised state (a fully known state in which the deciding seat's own cards are its hand).

import { COLOURS, cardColour, cardNumber, trickWinner, legalActionsFromView } from '../engine/index.js';

// ---- tuning constants (Python values) -------------------------------------------------------------
/** Timed rises on its own when this many tricks or fewer are left in the hand (Python: tricks_left <= 2). */
export const TIMED_HAND_END_TRICKS = 2;

const colourIndex = (colour) => COLOURS.indexOf(colour);

/** Does this bot want to win the trick it is in (or leading) with `lineLen` cards in its line? */
export function wantsWin(kind, lineLen, tricksLeft, lineLimit) {
  if (kind === 'greedy') return lineLen >= 1;
  return lineLen >= lineLimit || (lineLen >= 1 && tricksLeft <= TIMED_HAND_END_TRICKS);
}

/** First element with the best key (keys are arrays compared lexicographically); `sign` +1 = max, -1 = min. */
function firstBest(list, keyOf, sign) {
  let best = null;
  let bestKey = null;
  for (const item of list) {
    const key = keyOf(item);
    if (bestKey === null || sign * compareKeys(key, bestKey) > 0) { best = item; bestKey = key; }
  }
  return best;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Python Counter(c[0] for c in hand): cards per colour. */
function colourCounts(hand) {
  const cnt = {};
  for (const c of hand) { const col = cardColour(c); cnt[col] = (cnt[col] || 0) + 1; }
  return cnt;
}

/** The first fall (Python Bot.opening for timed and greedy). `hand` is sorted. */
export function timedOpening(hand) {
  const cnt = colourCounts(hand);
  let bestColour = null;
  for (const col of Object.keys(cnt)) {
    if (bestColour === null || cnt[col] > cnt[bestColour] || (cnt[col] === cnt[bestColour] && colourIndex(col) > colourIndex(bestColour))) bestColour = col;
  }
  return firstBest(hand.filter((c) => cardColour(c) === bestColour), (c) => [cardNumber(c)], -1);
}

/**
 * The timed / greedy card for a play decision.
 * @param {object} p
 * @param {'timed'|'greedy'} p.kind
 * @param {string[]} p.hand       the deciding seat's hand, sorted (colour order, then number)
 * @param {string[]} p.legal      its legal cards, in hand order
 * @param {{seat:number,card:string}[]} p.plays   the cards already in the trick ([] when leading)
 * @param {(string|null)[]} p.trumps  every seat's trump colour for this trick (fixed at the trick's start)
 * @param {number} p.me           the deciding seat
 * @param {string[]} p.line       its own fall line
 * @param {number} p.tricksLeft   tricks left in the hand including this one
 * @param {number} p.lineLimit
 * @param {'first'|'last'} p.tieRule
 */
export function timedPlay({ kind, hand, legal, plays, trumps, me, line, tricksLeft, lineLimit, tieRule }) {
  const want = wantsWin(kind, line.length, tricksLeft, lineLimit);
  const num = (c) => [cardNumber(c)];
  if (plays.length === 0) {
    // leading: a seat that wants to rise leads high, otherwise low
    return want ? firstBest(legal, num, +1) : firstBest(legal, num, -1);
  }
  const winners = [];
  const losers = [];
  for (const c of legal) {
    const w = trickWinner([...plays, { seat: me, card: c }], trumps, tieRule);
    (w.seat === me ? winners : losers).push(c);
  }
  if (want && winners.length) return firstBest(winners, num, -1);
  if (losers.length) {
    const cnt = colourCounts(hand);
    if (line.length === 0) {
      // this card becomes my trump: a colour I hold plenty of, lowest number first
      return firstBest(losers, (c) => [-cnt[cardColour(c)], cardNumber(c)], -1);
    }
    // dump the highest loser in my shortest non-trump colour (builds voids)
    const myTrump = cardColour(line[0]);
    return firstBest(losers, (c) => [cardColour(c) !== myTrump ? 1 : 0, -cnt[cardColour(c)], cardNumber(c)], +1);
  }
  return firstBest(legal, num, -1);
}

/** Cards of `hand` that may be played to a trick led in `ledColour` (null = leading). */
export function legalOf(hand, ledColour) {
  if (ledColour === null) return hand;
  const same = hand.filter((c) => cardColour(c) === ledColour);
  return same.length ? same : hand;
}

/** The decision of a timed / greedy bot from a view (the bot interface). */
export function chooseTimedFromView(kind, view) {
  const legalActions = legalActionsFromView(view);
  if (legalActions.length === 1) return legalActions[0];
  if (view.phase === 'fall') return { type: 'fall', card: timedOpening(view.hand) };
  const me = view.seat;
  const trick = view.trick;
  const card = timedPlay({
    kind,
    hand: view.hand,
    legal: legalOf(view.hand, trick ? trick.ledColour : null),
    plays: trick ? trick.plays : [],
    trumps: trick ? trick.trumps : view.trumps,
    me,
    line: view.lines[me],
    tricksLeft: view.tricksPerHand - view.trickNo,
    lineLimit: view.params.lineLimit,
    tieRule: view.rules.TRUMP_TIES,
  });
  return { type: 'play', card };
}

export const timedBot = {
  id: 'medium',
  label: 'Medium',
  chooseAction(view) {
    return chooseTimedFromView('timed', view);
  },
};
