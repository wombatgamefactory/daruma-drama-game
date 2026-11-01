// describe.js - plain-English text for actions and events (log lines, button labels).
//
// Pure: takes data, returns strings. `names` is an optional per-seat label array supplied by
// the UI (e.g. ['You', 'Mia', 'Easy bot']); without it seats are 'Seat 1', 'Seat 2', ...

import { COLOUR_NAMES } from './rules.js';
import { cardName, listCardNames } from './cards.js';

export function seatName(seat, names) {
  return names && names[seat] ? names[seat] : `Seat ${seat + 1}`;
}

/** 'wins' -> 'win' when the subject is "You". */
function verb(subject, v) {
  if (!/^You\b/.test(subject)) return v;
  if (v === 'has') return 'have';
  return v.replace(/s$/, ''); // every verb used here takes a plain -s
}

function possessive(subject) {
  return /^You$/.test(subject) ? 'your' : `${subject}'s`;
}

function plural(k, one, many) {
  return `${k} ${k === 1 ? one : many}`;
}

export function describeAction(action) {
  if (!action) return '';
  if (action.type === 'fall') return `Lay ${cardName(action.card)} as your first fall`;
  if (action.type === 'play') return `Play ${cardName(action.card)}`;
  return JSON.stringify(action);
}

/**
 * One log line per event, or null for events not worth a line.
 * @param {object} ev
 * @param {string[]} [names]
 */
export function describeEvent(ev, names) {
  const who = (s) => seatName(s, names);
  switch (ev.type) {
    case 'game-started':
      return `New game for ${ev.players} players (${ev.rulesCode === 'std' ? 'standard rules' : `playtest rules: ${ev.rulesCode}`}).`;
    case 'hand-started': {
      const d = who(ev.dealer);
      const l = who(ev.leader);
      const of = ev.handsPerGame ? ` of ${ev.handsPerGame}` : '';
      return `Hand ${ev.handNo + 1}${of}: ${d} ${verb(d, 'deals')} ${ev.handSize} cards each; ${l} ${verb(l, 'leads')} first.`;
    }
    case 'fall-chosen':
      return null; // secret and frequent; the reveal is logged
    case 'falls-revealed': {
      const parts = ev.falls.map((c, s) => `${who(s)} ${cardName(c)}`);
      return `First falls${ev.auto ? ' (first card dealt)' : ''}: ${parts.join(', ')}.`;
    }
    case 'card-played': {
      const s = who(ev.seat);
      if (ev.asLeader) return `${s} ${verb(s, 'leads')} ${cardName(ev.card)}.`;
      if (ev.trump) return `${s} ${verb(s, 'trumps')} with ${cardName(ev.card)}.`;
      return `${s} ${verb(s, 'plays')} ${cardName(ev.card)}.`;
    }
    case 'trick-won': {
      const s = who(ev.winner);
      const how = ev.byTrump ? ` (${COLOUR_NAMES[ev.trumpColour]} is ${possessive(s)} trump)` : '';
      const bank = ev.bankSize ? `banks ${ev.bankSize}${ev.bonus ? ` plus a full-line bonus of ${ev.bonus}` : ''}` : 'banks nothing';
      const tie = ev.tie ? ' Equal trumps: the tie rule decides.' : '';
      const knocked = ev.knocked.length ? ` Knocked off: ${ev.knocked.map((k) => `${who(k.seat)}'s ${cardName(k.card)}`).join(', ')}.` : '';
      return `${s} ${verb(s, 'wins')} trick ${ev.trickNo} with ${cardName(ev.card)}${how} and ${verb(s, bank.split(' ')[0])}${bank.slice(bank.indexOf(' '))}.${tie}${knocked}`;
    }
    case 'hand-ended': {
      const scores = ev.scores.map((x, s) => `${who(s)} ${x}`).join(', ');
      const lostSeats = ev.lost.map((l, s) => (l.length ? `${who(s)} ${listCardNames(l)}` : null)).filter(Boolean);
      const lost = lostSeats.length ? ` Lost on the lines: ${lostSeats.join('; ')}.` : '';
      return `Hand ${ev.handNo + 1} over. Scores: ${scores}.${lost}`;
    }
    case 'game-over': {
      const names2 = ev.winners.map(who);
      const tbName = ev.tiebreak === 'colours' ? 'most different colours' : 'fewest cards left on the line';
      const tbVal = (seat) => (ev.tiebreak === 'colours' ? ev.colourCounts[seat] : ev.leftCounts[seat]);
      if (ev.shared) return `Shared win: ${names2.join(' and ')} on ${ev.winningScore}${ev.tiebreakUsed ? `, after the tiebreak, ${tbName} (${tbVal(ev.winners[0])} each)` : ''}.`;
      const w = names2[0];
      if (ev.tiebreakUsed) {
        const others = ev.tiedOnTotal.filter((s) => s !== ev.winners[0]).map(tbVal);
        return `${w} ${verb(w, 'wins')} on ${ev.winningScore}, by the tiebreak: ${tbName} (${tbVal(ev.winners[0])} against ${others.join(', ')}).`;
      }
      return `${w} ${verb(w, 'wins')} with ${plural(ev.winningScore, 'point', 'points')}, ${ev.margin} ahead.`;
    }
    default:
      return null;
  }
}
