// scoring.js - the game result: totals, ranking, tiebreak and shared wins (R10, R11).
// Tiebreak (TIEBREAK): leftover = fewest line cards left at hand ends (standard since 01/11/2026),
// colours = most different colours banked, shared = no tiebreak.

import { COLOURS } from './rules.js';
import { cardColour } from './cards.js';

/** Number of different colours among `cards` (R11.1). */
export function colourCount(cards) {
  return new Set(cards.map(cardColour)).size;
}

/** Every card each seat banked over the whole game, from the hand records (R11.1, R11.4). */
export function bankedOverGame(state) {
  return Array.from({ length: state.n }, (_, s) => state.handLog.flatMap((h) => h.banked[s]));
}

/** Cards each seat left on its fall line at the ends of hands, over the whole game (R11.1). */
export function leftOverGame(state) {
  return Array.from({ length: state.n }, (_, s) => state.handLog.reduce((a, h) => a + h.lost[s].length, 0));
}

/**
 * The result of a finished game (also usable mid-game as a provisional standing).
 * @returns {{
 *   totals: number[], handScores: number[][], penalties: number[],
 *   colourCounts: number[], coloursBanked: string[][], leftCounts: number[], bonusPoints: number[],
 *   tiebreak: 'leftover'|'colours'|'shared',
 *   winners: number[], shared: boolean, tiebreakUsed: boolean, tiedOnTotal: number[],
 *   ranking: {seat:number, total:number, colours:number, left:number, rank:number}[],
 *   winningScore: number, margin: number, hands: number, tricks: number }}
 *   winners: seats that win (more than one = shared win, R11.2).
 *   tiebreakUsed: the tiebreak (R11.1) separated players tied on the top total.
 *   leftCounts: line cards left at hand ends over the game (fewest wins the leftover tiebreak).
 *   margin: top total minus the next-best total (0 on a tie).
 *   ranking: by total, then the tiebreak (R10.3); equal on both = equal rank.
 */
export function gameResult(state) {
  const n = state.n;
  const totals = [...state.totals];
  const banked = bankedOverGame(state);
  const coloursBanked = banked.map((cards) => COLOURS.filter((c) => cards.some((x) => cardColour(x) === c)));
  const colourCounts = coloursBanked.map((c) => c.length);
  const leftCounts = leftOverGame(state);
  const tiebreak = state.rules.TIEBREAK;
  // The tiebreak as a number where more is better (R11.1); 0 for everyone under 'shared'.
  const tb = (s) => (tiebreak === 'colours' ? colourCounts[s] : tiebreak === 'leftover' ? -leftCounts[s] : 0);

  const top = Math.max(...totals);
  const tied = totals.map((t, s) => (t === top ? s : -1)).filter((s) => s >= 0);
  let winners = tied;
  if (tied.length > 1) {
    const best = Math.max(...tied.map(tb)); // R11.1
    winners = tied.filter((s) => tb(s) === best); // R11.2: still tied -> shared
  }
  const better = (a, b) => totals[a] > totals[b] || (totals[a] === totals[b] && tb(a) > tb(b));
  const seats = Array.from({ length: n }, (_, s) => s);
  const ranking = [...seats]
    .sort((a, b) => totals[b] - totals[a] || tb(b) - tb(a) || a - b)
    .map((s) => ({ seat: s, total: totals[s], colours: colourCounts[s], left: leftCounts[s], rank: 1 + seats.filter((o) => better(o, s)).length }));
  const sorted = [...totals].sort((a, b) => b - a);
  return {
    totals,
    handScores: state.handLog.map((h) => [...h.scores]),
    penalties: [...state.penalties],
    colourCounts,
    coloursBanked,
    leftCounts,
    bonusPoints: [...state.measures.bonusPoints],
    tiebreak,
    winners,
    shared: winners.length > 1,
    tiebreakUsed: winners.length < tied.length,
    tiedOnTotal: tied,
    ranking,
    winningScore: top,
    margin: sorted[0] - sorted[1],
    hands: state.handLog.length,
    tricks: state.measures.tricks,
  };
}
