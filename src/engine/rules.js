// rules.js - constants and the VARIANTS table. Data only, plus resolveVariants() and rulesCode().
//
// Rule numbers (R1.1 ... R22, RV1 ... RV8) cited throughout the engine and its tests refer to
// the numbered rule list this engine was written from; the printed rule book in rules/ states
// the same standard rules.
//
// Every playtest switch (a rule that is still open) is a row of VARIANTS. A game stores its
// resolved switch values at `state.rules` (plain JSON) and the numbers they imply at
// `state.params` (line limit, hand size, colours in the deck ...), both fixed at createGame.
// Logic reads `state.rules` / `state.params`, never these tables.
//
// CONSTANTS and DEFAULT_RULES are exported OBJECTS (not bare numbers) so a simulator probe
// can change a value at runtime (`--const.X=Y`) and every NEW game picks it up.
//
// A value that is declared but not in `implemented` makes resolveVariants throw, so nothing
// silently plays the default. (All declared values are implemented today.)

/** The five colours in code order (R1.3): Python colour indices 0..4. */
export const COLOURS = ['red', 'gold', 'green', 'blue', 'purple'];

export const COLOUR_NAMES = { red: 'Red', gold: 'Gold', green: 'Green', blue: 'Blue', purple: 'Purple' };

/** Bird and wish per colour (R1.1), for flavour text. */
export const COLOUR_THEME = {
  red: { bird: 'hawk', wish: 'luck' },
  gold: { bird: 'phoenix', wish: 'fortune' },
  green: { bird: 'sparrow', wish: 'health' },
  blue: { bird: 'owl', wish: 'learning' },
  purple: { bird: 'crane', wish: 'long life' },
};

/** Tunable numbers (R22). Mutable on purpose: see header. */
export const CONSTANTS = {
  MIN_NUMBER: 1,
  MAX_NUMBER: 11, // R1.1
  MIN_PLAYERS: 3, // R1.5
  MAX_PLAYERS: 5,
  HAND_SIZE_BY_COUNT: { 3: 11, 4: 11, 5: 9 }, // R3.2
  HAND_SIZE_TEN: 10, // RV4.2
  LINE_LIMIT_SCALED: { 3: 2, 4: 3, 5: 3 }, // RV1.2
  MIN_HAND_SHRINKING: 4, // RV3.2
  SHRINKING_HAND_CAP: 11, // RV3.3 (HAND_SIZE_TEN under V4 ten)
  DROPPED_COLOUR_3P: 'purple', // RV5.2
  MAX_LINE_LIMIT: 3, // largest line any variant allows (sizes the riseSizes measure)
};

/**
 * @typedef {object} VariantDef
 * @property {string} id            V1 ... V8
 * @property {string} name          constant name, used as the key in a rules object
 * @property {string} code          short code for rules_code
 * @property {string[]} values      every allowed value (strings)
 * @property {string[]} implemented values this engine plays; others throw
 * @property {string} default       the standard-rules value
 * @property {string} rule          rule numbers
 * @property {string} label         short label for a settings panel
 * @property {object} valueLabels   value -> short label for a settings panel
 * @property {string} description   one-sentence rule text
 * @property {number[]} [onlyFor]   player counts at which the switch has any effect
 */

/** @type {VariantDef[]} */
export const VARIANTS = [
  { id: 'V1', name: 'LINE_LIMIT', code: 'line', values: ['3', '2', 'scaled'], implemented: ['3', '2', 'scaled'],
    default: '3', rule: 'R7.2, RV1', label: 'Fall line limit',
    valueLabels: { 3: '3 cards', 2: '2 cards', scaled: '2 at 3 players, 3 at 4-5' },
    description: 'A fall line holds at most this many cards; one more knocks the leftmost off.' },
  { id: 'V2', name: 'FIRST_FALL', code: 'fall', values: ['chosen', 'top'], implemented: ['chosen', 'top'],
    default: 'chosen', rule: 'R4, RV2', label: 'First fall',
    valueLabels: { chosen: 'Chosen together', top: 'First card dealt' },
    description: 'chosen: everyone picks a card at the same time; top: the first card dealt to you falls automatically.' },
  { id: 'V3', name: 'FORMAT', code: 'fmt', values: ['pad', 'shrinking'], implemented: ['pad', 'shrinking'],
    default: 'pad', rule: 'R2.1, RV3', label: 'Format',
    valueLabels: { pad: 'Score pad, one hand each', shrinking: 'Shrinking deck, no pad' },
    description: 'pad: one hand per player, full deck each hand; shrinking: banked cards leave the deck until it cannot deal 4 each.' },
  { id: 'V4', name: 'HAND_SIZE', code: 'hand', values: ['standard', 'ten'], implemented: ['standard', 'ten'],
    default: 'standard', rule: 'R3.2, RV4', label: 'Hand size',
    valueLabels: { standard: '11 / 11 / 9', ten: '10 at every count' },
    description: 'standard: 11 cards at 3-4 players, 9 at 5; ten: 10 cards at every count.' },
  { id: 'V5', name: 'DECK_3P', code: 'deck3', values: ['full', 'drop_purple'], implemented: ['full', 'drop_purple'],
    default: 'full', rule: 'R1.1, RV5', label: '3-player deck', onlyFor: [3],
    valueLabels: { full: 'All 55 cards', drop_purple: '44 cards (no Purple)' },
    description: 'At three players only, drop_purple removes the 11 Purple cards.' },
  { id: 'V6', name: 'LEFTOVER', code: 'leftover', values: ['lost', 'minus1'], implemented: ['lost', 'minus1'],
    default: 'lost', rule: 'R9.2, RV6', label: 'Line cards at hand end',
    valueLabels: { lost: 'Lost (score 0)', minus1: '-1 each' },
    description: 'Cards still in your fall line at the end of a hand score nothing (lost) or -1 each (minus1).' },
  { id: 'V7', name: 'TIEBREAK', code: 'tie', values: ['colours', 'shared'], implemented: ['colours', 'shared'],
    default: 'colours', rule: 'R11, RV7', label: 'Tiebreak',
    valueLabels: { colours: 'Most different colours banked', shared: 'Shared win' },
    description: 'colours: of the players tied for most, the one with the most different colours banked over the game wins; shared: they share the win.' },
  { id: 'V8', name: 'TRUMP_TIES', code: 'trumptie', values: ['first', 'last'], implemented: ['first', 'last'],
    default: 'first', rule: 'R6.3, R6.8, RV8', label: 'Equal trumps',
    valueLabels: { first: 'First played wins', last: 'Last played wins' },
    description: 'Two personal trumps of different colours with the same number: the one played first (or last) wins.' },
];

/** Standard-rules values by name. Mutable on purpose (runtime probes); see header. */
export const DEFAULT_RULES = Object.fromEntries(VARIANTS.map((v) => [v.name, v.default]));

/**
 * Merges overrides onto DEFAULT_RULES and validates the result.
 * Numbers are accepted for LINE_LIMIT (2 -> '2'). Throws on an unknown name, a value that is
 * not allowed, or a value that is not implemented.
 * @param {object} [overrides]  e.g. { LINE_LIMIT: '2', LEFTOVER: 'minus1' }
 * @param {VariantDef[]} [table] for tests only
 * @returns {object} plain JSON rules object, every name present
 */
export function resolveVariants(overrides = {}, table = VARIANTS) {
  const byName = new Map(table.map((v) => [v.name, v]));
  for (const key of Object.keys(overrides || {})) {
    if (!byName.has(key)) {
      throw new Error(`Unknown rule "${key}". Known rules: ${table.map((v) => v.name).join(', ')}`);
    }
  }
  const defaults = table === VARIANTS ? DEFAULT_RULES : Object.fromEntries(table.map((v) => [v.name, v.default]));
  const rules = {};
  for (const def of table) {
    let value = overrides && Object.prototype.hasOwnProperty.call(overrides, def.name) ? overrides[def.name] : defaults[def.name];
    if (typeof value === 'number') value = String(value);
    if (!def.values.includes(value)) {
      throw new Error(`${def.name} must be one of ${def.values.join(', ')}, got ${JSON.stringify(value)}`);
    }
    if (!def.implemented.includes(value)) {
      throw new Error(`${def.name} = ${JSON.stringify(value)} is not implemented in the web engine`);
    }
    rules[def.name] = value;
  }
  return rules;
}

/**
 * The short rules code for stats and analytics: 'std' when every switch that has an
 * effect at this player count is at its default; otherwise the non-default values as
 * `code-value` joined with '+', in V1..V8 order, e.g. 'line-2+leftover-minus1'.
 * DECK_3P is omitted unless n is 3 (RV5.3). Without n, every switch is considered.
 * @param {object} rules  a resolved rules object
 * @param {number} [n]    player count
 */
export function rulesCode(rules, n) {
  const parts = [];
  for (const def of VARIANTS) {
    if (n !== undefined && def.onlyFor && !def.onlyFor.includes(n)) continue;
    if (rules[def.name] !== def.default) parts.push(`${def.code}-${rules[def.name]}`);
  }
  return parts.length ? parts.join('+') : 'std';
}

/**
 * The numbers a rules object implies at player count n, read from CONSTANTS now
 * (stored at state.params by createGame).
 * @returns {{ n:number, lineLimit:number, colours:string[], deckSize:number, handSize:number|null,
 *   handCap:number|null, minHand:number|null, handsPerGame:number|null }}
 *   handSize: pad format cards per player per hand; handCap/minHand: shrinking format;
 *   handsPerGame: pad = n, shrinking = null (variable).
 */
export function deriveParams(rules, n) {
  if (!Number.isInteger(n) || n < CONSTANTS.MIN_PLAYERS || n > CONSTANTS.MAX_PLAYERS) {
    throw new Error(`Daruma Drama needs ${CONSTANTS.MIN_PLAYERS} to ${CONSTANTS.MAX_PLAYERS} players, got ${n}`);
  }
  const lineLimit = rules.LINE_LIMIT === 'scaled' ? CONSTANTS.LINE_LIMIT_SCALED[n] : Number(rules.LINE_LIMIT);
  const colours = n === 3 && rules.DECK_3P === 'drop_purple'
    ? COLOURS.filter((c) => c !== CONSTANTS.DROPPED_COLOUR_3P)
    : [...COLOURS];
  const deckSize = colours.length * (CONSTANTS.MAX_NUMBER - CONSTANTS.MIN_NUMBER + 1);
  const pad = rules.FORMAT === 'pad';
  const ten = rules.HAND_SIZE === 'ten';
  const handSize = pad ? (ten ? CONSTANTS.HAND_SIZE_TEN : CONSTANTS.HAND_SIZE_BY_COUNT[n]) : null;
  if (pad && handSize * n > deckSize) throw new Error(`Hand size ${handSize} x ${n} players needs more than ${deckSize} cards`);
  return {
    n,
    lineLimit,
    colours,
    deckSize,
    handSize,
    handCap: pad ? null : (ten ? CONSTANTS.HAND_SIZE_TEN : CONSTANTS.SHRINKING_HAND_CAP),
    minHand: pad ? null : CONSTANTS.MIN_HAND_SHRINKING,
    handsPerGame: pad ? n : null,
  };
}
