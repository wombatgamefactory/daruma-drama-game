// hard.js - Hard bot: determinised Monte Carlo search with timed rollouts. Level id 'hard'.
//
// At each real decision (a first fall or a card to play):
//   1. Sample HARD_SAMPLES worlds consistent with what this seat can see: the cards it cannot place are
//      dealt to the other hands honouring every colour a seat has shown it lacks (engine determinise()),
//      and a rival's still-hidden first fall is drawn from its sampled hand.
//   2. In EACH world, play every candidate action, then finish the hand with the Medium (timed) policy for
//      EVERY seat, this seat included, using the real engine (applyAction), so every variant is honoured.
//   3. Score a rollout by the final-score margin: my running total minus the best rival's running total when
//      the hand ends. The score of an action is the mean over worlds. The same worlds are used for every
//      candidate (common random numbers), so the comparison between candidates is paired and much less noisy.
//   4. On the last hand of the game the end-of-game tiebreak (most colours banked, shared wins) is a minor
//      term: HARD_WIN_BONUS for a sole win, half of it for a shared win, minus it for a loss.
//
// The bot sees only its view; the worlds are built from it. It draws from the rng it is given (so a game
// is reproducible from a seed) and never reads a clock: the cost per decision is bounded by a fixed budget
// of rollouts, not by time.

import { applyAction, determinise, legalActionsFromView } from '../engine/index.js';
import { timedOpening, timedPlay, legalOf, chooseTimedFromView } from './timed.js';

// ---- tuning constants ------------------------------------------------------------------------------------
/** Worlds sampled per decision when there are few candidates (the nominal sample count). */
export const HARD_SAMPLES = 40;
/** Fewest worlds per decision, however many candidates there are. */
export const HARD_MIN_SAMPLES = 6;
/** Cap on rollouts per decision (worlds x candidates): keeps a decision under ~250 ms at 5 players in Node. */
export const HARD_MAX_ROLLOUTS = 440;
/** Margin points added to the score of the action Medium would choose (a prior that damps sampling noise). */
export const HARD_TIMED_PRIOR = 0.15;
/** Margin points for winning the whole game outright (half if shared, negative if lost); last hand only. */
export const HARD_WIN_BONUS = 0.25;

const cloneMeasures = (m) => ({ ...m, riseSizes: [...m.riseSizes], tricksWon: [...m.tricksWon], trumpTricksWon: [...m.trumpTricksWon], banked: [...m.banked], knockOffs: [...m.knockOffs], leftover: [...m.leftover], bonusPoints: [...m.bonusPoints] });

/** A copy of a determinised state that applyAction can mutate without touching the original (history shared). */
function cloneWorld(s) {
  return {
    ...s,
    rng: { s: s.rng.s },
    hands: s.hands.map((h) => h.slice()),
    lines: s.lines.map((l) => l.slice()),
    piles: s.piles.map((p) => p.slice()),
    discard: s.discard.slice(),
    pending: s.pending ? s.pending.slice() : null,
    trick: s.trick ? { ...s.trick, plays: s.trick.plays.slice() } : null,
    tricks: s.tricks.slice(),
    handLog: s.handLog.slice(),
    totals: s.totals.slice(),
    penalties: s.penalties.slice(),
    measures: cloneMeasures(s.measures),
  };
}

/** The action the timed (Medium) policy takes for the seat to act in a full state. */
function timedAction(st) {
  const seat = st.toAct;
  const hand = st.hands[seat];
  if (st.phase === 'fall') return { type: 'fall', card: timedOpening(hand) };
  const trick = st.trick;
  const card = timedPlay({
    kind: 'timed',
    hand,
    legal: legalOf(hand, trick ? trick.ledColour : null),
    plays: trick ? trick.plays : [],
    trumps: trick ? trick.trumps : null,
    me: seat,
    line: st.lines[seat],
    tricksLeft: st.tricksPerHand - st.trickNo,
    lineLimit: st.params.lineLimit,
    tieRule: st.rules.TRUMP_TIES,
  });
  return { type: 'play', card };
}

/** Plays the rest of the hand with the timed policy for every seat; returns the margin of seat `me`. */
function rollout(st, me, handNo) {
  while (st.toAct !== null && st.handNo === handNo) applyAction(st, timedAction(st), { silent: true });
  let best = -Infinity;
  for (let s = 0; s < st.n; s++) if (s !== me && st.totals[s] > best) best = st.totals[s];
  let value = st.totals[me] - best;
  if (st.phase === 'over' && st.result) {
    // last hand of the game: the tiebreak only matters when totals tie, so keep it a minor term
    const r = st.result;
    if (r.winners.includes(me)) value += r.winners.length === 1 ? HARD_WIN_BONUS : HARD_WIN_BONUS / 2;
    else value -= HARD_WIN_BONUS;
  }
  return value;
}

/** How many worlds to sample for this many candidate actions. */
export function samplesFor(candidates) {
  return Math.max(HARD_MIN_SAMPLES, Math.min(HARD_SAMPLES, Math.floor(HARD_MAX_ROLLOUTS / candidates)));
}

/** The best action by mean margin; exposes the scores for tests and tuning. */
export function searchAction(view, rng, { samples = null, prior = HARD_TIMED_PRIOR } = {}) {
  const legal = legalActionsFromView(view);
  if (legal.length === 1) return { action: legal[0], scores: [0] };
  const me = view.seat;
  const nWorlds = samples === null ? samplesFor(legal.length) : samples;
  const sums = legal.map(() => 0);
  for (let w = 0; w < nWorlds; w++) {
    const world = determinise(view, rng);
    const handNo = world.handNo;
    for (let i = 0; i < legal.length; i++) {
      const st = cloneWorld(world);
      applyAction(st, legal[i], { silent: true });
      sums[i] += rollout(st, me, handNo);
    }
  }
  const timedChoice = chooseTimedFromView('timed', view);
  let bestIndex = 0;
  let bestScore = -Infinity;
  const scores = sums.map((sum, i) => sum / nWorlds + (legal[i].card === timedChoice.card ? prior : 0));
  for (let i = 0; i < legal.length; i++) {
    if (scores[i] > bestScore) { bestScore = scores[i]; bestIndex = i; }
  }
  return { action: legal[bestIndex], scores };
}

export const hardBot = {
  id: 'hard',
  label: 'Hard',
  chooseAction(view, rng) {
    return searchAction(view, rng).action;
  },
};
