// board.js - the presentation model: what the table looks like, and how it changes event by event.
//
// One call of applyAction can play many forced moves, end the hand, deal the next one and even
// end the game (R20.2). So the screen cannot simply draw `state` after each action: it would
// jump over the last trick of every hand. Instead the UI keeps a small "board" (everything that
// is drawn: fall lines, pile counts, the trick on the table, hand counts, the turn) and walks
// the returned events over it, one frame per beat, so every trick and every hand end is seen.
//
//   boardFromState(state, humanSeats)    the board for a live state
//   reduceBoard(board, event, ctx)       the board after one engine event (a fresh copy)
//   buildFrames(board, events, ctx)      the frames to show, in order, for one action's events
//
// No rules live here: every number comes from an event (who won, what was banked, what was
// knocked off). tests/ui-node.mjs replays thousands of actions and requires that walking the
// events over the board before the action gives exactly boardFromState(state after the action).
// Pure and DOM-free: runs in Node.

import { cardColour } from '../engine/index.js';

const copy = (x) => JSON.parse(JSON.stringify(x));

/** Fields that only exist while a frame is on screen (excluded from the live-board equality test). */
export const TRANSIENT = ['fx', 'last', 'banner'];

/**
 * @param {object} state        the live engine state
 * @param {number[]} humanSeats seats whose hand the UI may need to show (others get null)
 */
export function boardFromState(state, humanSeats = []) {
  const n = state.n;
  const handBanked = Array.from({ length: n }, (_, s) => state.tricks.filter((t) => t.winner === s).reduce((a, t) => a + t.bank.length + (t.bonus || 0), 0)); // points this hand
  return {
    n,
    pad: state.rules.FORMAT === 'pad',
    lineLimit: state.params.lineLimit,
    handNo: state.handNo,
    handsPerGame: state.params.handsPerGame,
    handSize: state.handSize,
    tricksPerHand: state.tricksPerHand,
    phase: state.phase,
    dealer: state.dealer,
    leader: state.leader,
    toAct: state.toAct,
    trickNo: state.trickNo, // completed tricks this hand
    lines: copy(state.lines),
    piles: state.piles.map((p) => p.length),
    handBanked,
    totals: [...state.totals],
    trick: state.trick ? { n: state.trick.n, leader: state.trick.leader, ledColour: state.trick.ledColour, plays: state.trick.plays.map((p) => ({ seat: p.seat, card: p.card, trump: p.trump })), winner: null } : null,
    chosen: state.pending ? state.pending.map((c) => c !== null) : null,
    hands: state.hands.map((h, s) => (humanSeats.includes(s) ? [...h] : null)),
    handCounts: state.hands.map((h) => h.length),
    discard: [...state.discard],
    fx: null,
    last: null,
    banner: null,
  };
}

function nextUnchosen(chosen, seat, n) {
  for (let k = 1; k < n; k++) {
    const s = (seat + k) % n;
    if (!chosen[s]) return s;
  }
  return null;
}

/**
 * The board after one engine event. `ctx`:
 *   liveHands(seat)   the live state's hand for a human seat (used when a hand is dealt)
 *   fall              { seat, card } for the first fall the human just chose (the event has no card)
 */
export function reduceBoard(board, ev, ctx = {}) {
  const b = copy(board);
  b.fx = null;
  b.banner = null;
  switch (ev.type) {
    case 'game-started':
      return b;
    case 'hand-started': {
      b.handNo = ev.handNo;
      b.dealer = ev.dealer;
      b.leader = ev.leader;
      b.handSize = ev.handSize;
      b.tricksPerHand = ev.handSize - 1;
      b.phase = 'fall';
      b.toAct = ev.leader;
      b.trickNo = 0;
      b.lines = Array.from({ length: b.n }, () => []);
      if (b.pad) b.piles = Array.from({ length: b.n }, () => 0);
      b.handBanked = Array.from({ length: b.n }, () => 0);
      b.trick = null;
      b.last = null;
      b.chosen = Array.from({ length: b.n }, () => false);
      b.handCounts = Array.from({ length: b.n }, () => ev.handSize);
      b.hands = b.hands.map((h, s) => (h === null ? null : (ctx.liveHands ? [...ctx.liveHands(s)] : [])));
      b.discard = [];
      return b;
    }
    case 'fall-chosen': {
      b.chosen[ev.seat] = true;
      b.handCounts[ev.seat]--;
      if (b.hands[ev.seat] && ctx.fall && ctx.fall.seat === ev.seat) b.hands[ev.seat] = b.hands[ev.seat].filter((c) => c !== ctx.fall.card);
      b.toAct = nextUnchosen(b.chosen, ev.seat, b.n);
      return b;
    }
    case 'falls-revealed': {
      b.lines = ev.falls.map((c) => [c]);
      b.chosen = null;
      b.phase = 'play';
      b.toAct = b.leader;
      if (ev.auto) b.handCounts = b.handCounts.map((x) => x - 1); // FIRST_FALL top: the first card dealt fell
      b.fx = { revealed: true };
      return b;
    }
    case 'card-played': {
      if (ev.asLeader) b.trick = { n: ev.trickNo, leader: ev.seat, ledColour: cardColour(ev.card), plays: [], winner: null };
      b.trick.plays.push({ seat: ev.seat, card: ev.card, trump: ev.trump });
      b.handCounts[ev.seat]--;
      if (b.hands[ev.seat]) b.hands[ev.seat] = b.hands[ev.seat].filter((c) => c !== ev.card);
      b.toAct = b.trick.plays.length < b.n ? (ev.seat + 1) % b.n : null;
      b.last = null;
      return b;
    }
    case 'trick-won': {
      const t = b.trick;
      const fell = [];
      for (const p of t.plays) {
        if (p.seat === ev.winner) continue;
        b.lines[p.seat].push(p.card);
        fell.push({ seat: p.seat, card: p.card });
      }
      for (const k of ev.knocked) {
        const off = b.lines[k.seat].shift();
        if (off !== k.card) throw new Error(`board: knocked ${k.card} but the leftmost card was ${off}`);
      }
      b.lines[ev.winner] = [];
      b.piles[ev.winner] += ev.bankSize;
      b.handBanked[ev.winner] += ev.bankSize + (ev.bonus || 0); // points: cards + full-line bonus
      b.discard.push(...ev.knocked.map((k) => k.card), ev.card);
      b.trickNo = ev.trickNo;
      b.leader = ev.winner;
      b.toAct = ev.winner;
      b.last = { trick: copy(t), event: copy(ev) };
      b.trick = null;
      b.fx = { fell, knocked: copy(ev.knocked), rose: { seat: ev.winner, cards: [...ev.bank] } };
      return b;
    }
    case 'hand-ended': {
      b.totals = [...ev.totals];
      b.handBanked = Array.from({ length: b.n }, () => 0);
      b.discard.push(...ev.lost.flat());
      b.lines = Array.from({ length: b.n }, () => []);
      b.handNo = ev.handNo + 1;
      b.toAct = null;
      b.fx = { handEnded: true };
      return b;
    }
    case 'game-over':
      b.phase = 'over';
      b.toAct = null;
      return b;
    default:
      return b;
  }
}

/** Compares two boards ignoring transient display fields. */
export function sameBoard(a, b) {
  const strip = (x) => { const c = copy(x); for (const k of TRANSIENT) delete c[k]; return JSON.stringify(c); };
  return strip(a) === strip(b);
}

/**
 * Frames for the events of ONE action, starting from `board` (what is on screen now).
 * A frame: { board, hold, kind, log?, modal?, announce? }
 *   hold   ms to stay on the frame before the next one, BEFORE pacing scale (the UI multiplies);
 *          `Infinity` = wait for the player (a modal). 0 = go straight on.
 * ctx adds `names` (seat labels) and `trickText(trick, event, names)` for the log sentence,
 * `describe(ev, names)` for the other log lines.
 */
export function buildFrames(board, events, ctx) {
  const frames = [];
  let b = board;
  const push = (board2, extra) => { frames.push({ board: board2, hold: 0, kind: 'plain', ...extra }); b = board2; };
  for (const ev of events) {
    switch (ev.type) {
      case 'hand-started': {
        const nb = reduceBoard(b, ev, ctx);
        push(nb, { kind: 'deal', hold: 350, log: ctx.describe(ev, ctx.names) });
        break;
      }
      case 'fall-chosen':
        push(reduceBoard(b, ev, ctx), { kind: 'choose', hold: 0 });
        break;
      case 'falls-revealed': {
        const nb = reduceBoard(b, ev, ctx);
        push(nb, { kind: 'reveal', hold: 1300, log: ctx.describe(ev, ctx.names) });
        break;
      }
      case 'card-played': {
        const nb = reduceBoard(b, ev, ctx);
        push(nb, { kind: 'card', hold: ev.auto ? 450 : 0 });
        break;
      }
      case 'trick-won': {
        // Beat 1: all the cards are down and the winner is marked; beat 2: the cards fall and rise.
        const decided = copy(b);
        decided.trick.winner = ev.winner;
        decided.trick.winningCard = ev.card;
        decided.trick.byTrump = ev.byTrump;
        decided.trick.tie = ev.tie;
        decided.banner = { winner: ev.winner, card: ev.card, bankSize: ev.bankSize, bonus: ev.bonus || 0, byTrump: ev.byTrump, trumpColour: ev.trumpColour };
        push(decided, { kind: 'decided', hold: 1250 });
        const nb = reduceBoard(b, ev, ctx);
        push(nb, { kind: 'resolve', hold: 800, log: ctx.trickText(nb.last.trick, ev, ctx.names), logKind: 'trick' });
        break;
      }
      case 'hand-ended': {
        // Show the summary over the table as it stands (lines still hold the cards that are lost).
        const modal = { kind: 'hand', handNo: ev.handNo, event: copy(ev) };
        push(copy(b), { kind: 'hand-end', hold: Infinity, modal });
        const nb = reduceBoard(b, ev, ctx);
        push(nb, { kind: 'plain', hold: 0 });
        break;
      }
      case 'game-over':
        push(reduceBoard(b, ev, ctx), { kind: 'over', hold: 0, log: ctx.describe(ev, ctx.names) });
        break;
      default:
        break;
    }
  }
  return frames;
}
