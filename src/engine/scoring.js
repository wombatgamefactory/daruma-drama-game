// scoring.js - the game result: totals, ranking, tiebreak and shared wins (R10, R11).

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

/**
 * The result of a finished game (also usable mid-game as a provisional standing).
 * @returns {{
 *   totals: number[], handScores: number[][], penalties: number[],
 *   colourCounts: number[], coloursBanked: string[][],
 *   winners: number[], shared: boolean, tiebreakUsed: boolean, tiedOnTotal: number[],
 *   ranking: {seat:number, total:number, colours:number, rank:number}[],
 *   winningScore: number, margin: number, hands: number, tricks: number }}
 *   winners: seats that win (more than one = shared win, R11.2).
 *   tiebreakUsed: the colour count (R11.1) separated players tied on the top total.
 *   margin: top total minus the next-best total (0 on a tie).
 *   ranking: by total, then colour count when TIEBREAK is colours (R10.3); equal on both = equal rank.
 */
export function gameResult(state) {
  const n = state.n;
  const totals = [...state.totals];
  const banked = bankedOverGame(state);
  const coloursBanked = banked.map((cards) => COLOURS.filter((c) => cards.some((x) => cardColour(x) === c)));
  const colourCounts = coloursBanked.map((c) => c.length);
  const byColours = state.rules.TIEBREAK === 'colours';

  const top = Math.max(...totals);
  const tied = totals.map((t, s) => (t === top ? s : -1)).filter((s) => s >= 0);
  let winners = tied;
  if (byColours && tied.length > 1) {
    const best = Math.max(...tied.map((s) => colourCounts[s])); // R11.1
    winners = tied.filter((s) => colourCounts[s] === best); // R11.2: still tied -> shared
  }
  const key = (s) => [totals[s], byColours ? colourCounts[s] : 0];
  const better = (a, b) => key(a)[0] > key(b)[0] || (key(a)[0] === key(b)[0] && key(a)[1] > key(b)[1]);
  const seats = Array.from({ length: n }, (_, s) => s);
  const ranking = [...seats]
    .sort((a, b) => totals[b] - totals[a] || (byColours ? colourCounts[b] - colourCounts[a] : 0) || a - b)
    .map((s) => ({ seat: s, total: totals[s], colours: colourCounts[s], rank: 1 + seats.filter((o) => better(o, s)).length }));
  const sorted = [...totals].sort((a, b) => b - a);
  return {
    totals,
    handScores: state.handLog.map((h) => [...h.scores]),
    penalties: [...state.penalties],
    colourCounts,
    coloursBanked,
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
