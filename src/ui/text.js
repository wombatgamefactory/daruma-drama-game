// text.js - the sentences the UI shows: trick log lines, turn prompts, hover hints, tiebreak
// explanations. Pure functions of data (no DOM), so they run in Node tests.
//
// `names` is the per-seat label array from the controller ('You', 'Mia', 'Easy bot 2' ...).
// A seat called "You" gets second-person verbs ("You led", "your trump").

import { COLOUR_NAMES, cardColour, cardName, listCardNames } from '../engine/index.js';

const isYou = (name) => name === 'You';

/** 'Sam' -> "Sam's", 'You' -> 'your'. */
export function poss(name) {
  return isYou(name) ? 'your' : `${name}'s`;
}

/** Third-person verb to the form that agrees with the name ('wins' -> 'win' for You). */
function v(name, third, second) {
  return isYou(name) ? (second || third.replace(/s$/, '')) : third;
}

const colourName = (c) => COLOUR_NAMES[c];

/**
 * One plain-English line for a finished trick, e.g.
 * "Mia led Blue 7; Sam trumped with Gold 4 (Gold is Sam's trump) and wins, banking 3; Ann followed with Blue 2."
 * @param {{leader:number, ledColour:string, plays:{seat:number, card:string, trump:boolean}[]}} trick
 * @param {object} ev  the trick-won event
 */
export function trickSentence(trick, ev, names) {
  const led = trick.ledColour;
  const parts = trick.plays.map((p, i) => {
    const who = names[p.seat];
    const win = p.seat === ev.winner;
    let clause;
    if (i === 0) clause = `${who} ${v(who, 'led')} ${cardName(p.card)}`;
    else if (p.trump) clause = `${who} ${v(who, 'trumped')} with ${cardName(p.card)} (${colourName(cardColour(p.card))} is ${poss(who)} trump)`;
    else if (cardColour(p.card) === led) clause = `${who} ${v(who, 'followed')} with ${cardName(p.card)}`;
    else clause = `${who} had no ${colourName(led)} and ${v(who, 'threw')} ${cardName(p.card)}`;
    if (win) clause += ` and ${v(who, 'wins')}, ${ev.bankSize ? `banking ${ev.bankSize}${ev.bonus ? ` +${ev.bonus} bonus` : ''}` : 'banking nothing'}`;
    return clause;
  });
  let s = `${parts.join('; ')}.`;
  if (ev.tie) s += ' Equal trumps: the tie rule decided it.';
  if (ev.knocked.length) s += ` Knocked off: ${ev.knocked.map((k) => `${poss(names[k.seat])} ${cardName(k.card)}`).join(', ')}.`;
  return s;
}

/** The short banner under the trick: "Sam wins with Gold 4 and banks 3". */
export function winnerBanner(banner, names) {
  const who = names[banner.winner];
  const bank = banner.bankSize ? `banks ${banner.bankSize}${banner.bonus ? ` +${banner.bonus} bonus` : ''}` : 'banks nothing';
  const how = banner.byTrump ? ` (${colourName(banner.trumpColour)} trump)` : '';
  return `${who} ${v(who, 'wins')} with ${cardName(banner.card)}${how} and ${v(who, 'banks')}${bank.slice(bank.indexOf(' '))}`;
}

/**
 * What the human should do now, as a sentence. `view` = the seat's view; `legalCount` =
 * number of playable cards.
 */
export function turnPrompt(view, names) {
  if (view.phase === 'fall') {
    return 'Choose a card to lay down as your first fall. Everyone chooses in secret; the cards are turned over together. Its colour is your trump until you rise.';
  }
  const t = view.trick;
  if (!t) return 'You lead. Play any card: its colour is the colour led.';
  const led = view.hand.filter((c) => cardColour(c) === t.ledColour);
  if (led.length === 1 && view.hand.length > 1) return `${colourName(t.ledColour)} was led. ${cardName(led[0])} is your only ${colourName(t.ledColour)} card, so it is the only card you can play.`;
  if (view.hand.length === 1) return `${colourName(t.ledColour)} was led. ${cardName(view.hand[0])} is your last card, so you play it.`;
  if (led.length) return `${colourName(t.ledColour)} was led. You hold ${colourName(t.ledColour)}, so you must follow it.`;
  const trump = view.trumps[view.seat];
  if (trump === t.ledColour) return `${colourName(t.ledColour)} was led and you have none. Play anything; your trump is also ${colourName(trump)}, so you cannot trump this trick.`;
  if (trump) return `${colourName(t.ledColour)} was led and you have none. Play anything; ${colourName(trump)} is your trump, so a ${colourName(trump)} card can win.`;
  return `${colourName(t.ledColour)} was led and you have none. Play anything; you have no trump, so you cannot win this trick.`;
}

/** The sentence for the status line when a bot or another human is to act. */
export function waitingText(board, names, seatTypes) {
  if (board.phase === 'over') return 'Game over.';
  if (board.toAct === null) return '';
  const who = names[board.toAct];
  if (board.phase === 'fall') return `${who} ${isYou(who) ? 'are' : 'is'} choosing a first fall.`;
  const bot = seatTypes && seatTypes[board.toAct] !== 'human';
  return `${who} ${isYou(who) ? 'are' : 'is'} ${bot ? 'thinking' : 'to play'}.`;
}

/** Hover / tap hint for a card the human may play, from previewCard(). */
export function previewText(pv, names, lineNote) {
  if (!pv) return '';
  const name = cardName(pv.card);
  if (pv.kind === 'fall') return `${name} would be your first fall: ${colourName(cardColour(pv.card))} becomes your trump.`;
  if (pv.kind === 'lead') return `${name}: you would lead ${colourName(cardColour(pv.card))}. Everyone else must follow it if they can.`;
  const trumpNote = pv.trump ? ` ${name} is your trump, so it counts above the led colour.` : '';
  if (pv.wins) {
    const bank = pv.bankSize ? `bank ${pv.bankSize} card${pv.bankSize === 1 ? '' : 's'}${pv.bonus ? ` and a full-line bonus of ${pv.bonus}` : ''}` : 'bank nothing (your line is empty)';
    if (pv.final) return `${name} wins the trick, and you ${bank}.${trumpNote}`;
    return `${name} would win the trick as it stands; ${pv.remaining} still to play. If it holds you ${bank}.${trumpNote}`;
  }
  const w = names[pv.winnerSeat];
  const fall = lineNote ? ` ${lineNote}` : '';
  if (pv.final) return `${name} loses: ${w} ${v(w, 'wins')} with ${cardName(pv.winnerCard)}.${fall}`;
  return `${name} would not win as it stands (${w} ${isYou(w) ? 'are' : 'is'} ahead with ${cardName(pv.winnerCard)}; ${pv.remaining} still to play).${fall}`;
}

/** "Your line is full: Red 3 would be knocked off ..." for a losing card, or ''. */
export function lineNote(board, seat, limit) {
  const line = board.lines[seat];
  if (line.length >= limit) return `Your line is full, so ${cardName(line[0])} would be knocked off.`;
  return '';
}

/** Colour list with names, e.g. "Red, Gold and Blue". */
export function colourList(colours) {
  const names = colours.map(colourName);
  if (names.length <= 1) return names.join('') || 'no colours';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Players who share a total, grouped: [[seat, seat], ...] only groups of two or more. */
export function tiedGroups(result) {
  const byTotal = new Map();
  for (const r of result.ranking) {
    if (!byTotal.has(r.total)) byTotal.set(r.total, []);
    byTotal.get(r.total).push(r.seat);
  }
  return [...byTotal.values()].filter((g) => g.length > 1);
}

/**
 * The tiebreak explanation for the end screen. It names only players who were tied on total
 * (R11.5), or returns '' when nobody was tied at the top.
 */
export function tiebreakText(result, names) {
  const tied = result.tiedOnTotal;
  if (tied.length < 2) return '';
  const label = (s) => names[s];
  const join = (seats) => (seats.length === 1 ? label(seats[0]) : seats.length === 2 ? `${label(seats[0])} and ${label(seats[1])}` : `${seats.slice(0, -1).map(label).join(', ')} and ${label(seats[seats.length - 1])}`);
  const head = `${join(tied)} tied on ${result.winningScore}.`;
  const colours = result.tiebreak === 'colours';
  const counts = colours
    ? `Colours banked over the game: ${tied.map((s) => `${label(s)} ${result.colourCounts[s]}`).join(', ')}.`
    : `Cards left on the line at the ends of hands: ${tied.map((s) => `${label(s)} ${result.leftCounts[s]}`).join(', ')}.`;
  if (result.shared && !result.tiebreakUsed) {
    // The shared-win rule, or a tiebreak that could not split anyone.
    return result.tiebreak === 'shared' ? `${head} The win is shared.` : `${head} ${counts} Still level, so the win is shared.`;
  }
  if (result.tiebreakUsed) {
    const w = result.winners;
    const rule = colours ? 'most different colours in their score piles' : 'fewest cards left on the line';
    return `${head} Tiebreak: ${rule}. ${counts} ${join(w)} ${w.length > 1 ? 'share the win' : (isYou(label(w[0])) ? 'win' : 'wins')}.`;
  }
  return head;
}

/** One-line summary of the hand for the hand-end panel and the log. */
export function handEndText(ev, names) {
  const scores = ev.scores.map((x, s) => `${names[s]} ${x}`).join(', ');
  return `Hand ${ev.handNo + 1} scores: ${scores}.`;
}

export { listCardNames };
