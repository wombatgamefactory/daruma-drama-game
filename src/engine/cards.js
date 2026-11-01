// cards.js - card ids, the deck, sorting and display names.
//
// A card id is a string `<colour>-<number>`, e.g. 'red-7', 'gold-11' (R1.1). The same string
// names the card face asset: assets/cards/card-<id>.webp. Every card is unique (R1.1), so
// a card id identifies one physical card.

import { COLOURS, COLOUR_NAMES, CONSTANTS } from './rules.js';

export function cardColour(card) {
  return card.slice(0, card.indexOf('-'));
}

export function cardNumber(card) {
  return Number(card.slice(card.indexOf('-') + 1));
}

export function makeCard(colour, number) {
  return `${colour}-${number}`;
}

/** True if `card` is a well-formed id whose colour is in `colours`. */
export function isCard(card, colours = COLOURS) {
  if (typeof card !== 'string' || !/^[a-z]+-\d{1,2}$/.test(card)) return false;
  const n = cardNumber(card);
  return colours.includes(cardColour(card)) && n >= CONSTANTS.MIN_NUMBER && n <= CONSTANTS.MAX_NUMBER;
}

/** The deck for the given colours, ordered by colour (R1.3) then number. */
export function fullDeck(colours = COLOURS) {
  const deck = [];
  for (const c of COLOURS) {
    if (!colours.includes(c)) continue;
    for (let r = CONSTANTS.MIN_NUMBER; r <= CONSTANTS.MAX_NUMBER; r++) deck.push(makeCard(c, r));
  }
  return deck;
}

/** Sort key: colour order (R1.3) then number. */
export function compareCards(a, b) {
  const dc = COLOURS.indexOf(cardColour(a)) - COLOURS.indexOf(cardColour(b));
  return dc !== 0 ? dc : cardNumber(a) - cardNumber(b);
}

export function sortCards(cards) {
  return [...cards].sort(compareCards);
}

/** 'gold-7' -> 'Gold 7'. */
export function cardName(card) {
  return `${COLOUR_NAMES[cardColour(card)]} ${cardNumber(card)}`;
}

/** ['red-3', 'red-7'] -> 'Red 3 and Red 7'; three or more use commas. */
export function listCardNames(cards) {
  const names = cards.map(cardName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A fall line's trump colour: the colour of its leftmost (oldest) card, or null (R8.1, R6.5). */
export function trumpOf(line) {
  return line.length ? cardColour(line[0]) : null;
}
