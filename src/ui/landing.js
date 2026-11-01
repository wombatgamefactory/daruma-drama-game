// landing.js - the landing page, which is also the setup screen (a sell sheet with a form in it),
// plus the How to play text that the in-game Rules dialog reuses. Pure string builders and two small
// form helpers; main.js owns the wiring.

import { VARIANTS, DEFAULT_RULES, COLOURS, COLOUR_NAMES, rulesCode, resolveVariants } from '../engine/index.js';
import { assetUrl, img, glyphImg, esc } from './assets.js';

export const RULEBOOK_URL = 'rules/daruma-drama-rule-book-v5.pdf';
export const MAX_SEATS = 5;

/** The bot levels offered, in menu order. A level that is not registered is shown but disabled. */
export const LEVELS = [
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
];

export const DEFAULT_SETUP = {
  players: 4,
  seats: [
    { type: 'human', name: '' }, { type: 'easy', name: '' }, { type: 'easy', name: '' }, { type: 'easy', name: '' }, { type: 'easy', name: '' },
  ],
  rules: { ...DEFAULT_RULES },
};

const ICON_PLAYERS = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="13" cy="12" r="6" fill="#D9A63C"/><path d="M3 34c0-7 4.5-12 10-12s10 5 10 12z" fill="#D9A63C"/><circle cx="28" cy="12" r="6" fill="#C3452A"/><path d="M18 34c0-7 4.5-12 10-12s10 5 10 12z" fill="#C3452A"/></svg>';
const ICON_TIME = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" fill="none" stroke="#D9A63C" stroke-width="3"/><path d="M20 10v10l7 4" stroke="#C3452A" stroke-width="3.2" stroke-linecap="round" fill="none"/></svg>';
const ICON_AGE = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="7" y="5" width="20" height="28" rx="3" fill="#D9A63C" transform="rotate(-10 17 19)"/><rect x="14" y="8" width="20" height="28" rx="3" fill="#C3452A" stroke="#3A1F16" stroke-width="1.5" transform="rotate(8 24 22)"/></svg>';

// ---------- How to play ----------

export function howToPlayHtml() {
  const colours = COLOURS.map((c) => `<li>${glyphImg(c, 'how__glyph')}<span>${esc(COLOUR_NAMES[c])}</span></li>`).join('');
  return `<div class="how">
    <p class="how__lead">Losing is how you build. Every trick you lose adds a fallen card to your line; winning lets you rise and bank that whole line as points. The art is choosing when to stand up.</p>
    <ol class="how__steps">
      <li><h3>First fall</h3><p>Everyone gets 11 cards (9 with five players). All at once, each player secretly picks one card and lays it face up on its side in front of them. That is your <b>fall line</b>. The colour of its <b>leftmost card</b> is your own <b>personal trump</b>.</p>
        <ul class="how__colours" aria-label="The five colours">${colours}</ul></li>
      <li><h3>Lead and follow</h3><p>The player left of the dealer leads any card. Everyone else plays in turn and <b>must follow the colour led</b> if they can. If they cannot, they may play any card.</p></li>
      <li><h3>Win</h3><p>The highest card of the colour led wins, unless someone <b>trumps</b>. You trump only when you cannot follow and you play a card of your trump colour. The highest trump wins; two trumps of the same number go to the one played first.</p></li>
      <li><h3>Fall and rise</h3><p>Every <b>loser's</b> card falls onto the right-hand end of their line. A line holds three cards: a fourth knocks the leftmost off, and your trump changes. The <b>winner banks their whole line</b> into their score pile, the winning card is discarded, and they lead next with an empty line and no trump. <b>Rise from a full line of three and score 2 bonus points.</b></p></li>
      <li><h3>Scoring</h3><p>A hand lasts until the cards run out (10 tricks, or 8 with five players). Cards still lying in a line are lost. You score the cards you banked, plus your full-line bonuses. Everybody deals once, so a game is 3 to 5 hands.</p></li>
      <li><h3>Winning</h3><p>The highest total wins. If players tie, the one who left the fewest cards on their line at the ends of hands wins; if that is also tied, the win is shared.</p></li>
    </ol>
    <p class="how__link"><a href="${RULEBOOK_URL}" target="_blank" rel="noopener" data-action="rulebook">Read the full rule book (PDF)</a></p>
  </div>`;
}

// ---------- the page ----------

function heroHtml() {
  const wide = assetUrl('hero-wide');
  const source = wide ? `<source media="(min-width: 700px)" srcset="${wide}">` : '';
  const fallback = img('key-art-main', { alt: 'Daruma Drama: a red Daruma stands among five toppled dolls on blue waves.', cls: 'hero__img', label: 'Daruma Drama', w: 1000, h: 747 });
  return `<div class="hero__art"><picture>${source}${fallback}</picture></div>`;
}

/** Options for a seat's type select. `levels` is botLevels() (what the registry offers). */
export function seatTypeOptions(levels, selected) {
  const have = new Set(levels.filter((l) => l.offered !== false).map((l) => l.id));
  const opts = [{ id: 'human', label: 'Human', ok: true }, ...LEVELS.map((l) => ({ id: l.id, label: `${l.label} bot`, ok: have.has(l.id) }))];
  return opts.map((o) => `<option value="${o.id}"${o.id === selected ? ' selected' : ''}${o.ok ? '' : ' disabled'}>${esc(o.label)}${o.ok ? '' : ' (not available yet)'}</option>`).join('');
}

function seatFieldset(i, levels, setup) {
  const seat = setup.seats[i];
  const type = have(levels, seat.type) ? seat.type : 'easy';
  return `<fieldset class="seatform" data-seat="${i}"${i >= setup.players ? ' hidden' : ''}>
      <legend>Seat ${i + 1}</legend>
      <label class="field"><span>Player</span><select name="type${i}">${seatTypeOptions(levels, type)}</select></label>
      <label class="field"><span>Name <small>(optional)</small></span><input name="name${i}" type="text" maxlength="16" autocomplete="off" value="${esc(seat.name)}" placeholder="${i === 0 ? 'You' : `Seat ${i + 1}`}"></label>
    </fieldset>`;
}

function have(levels, id) {
  return id === 'human' || levels.some((l) => l.id === id && l.offered !== false);
}

/** The "Playtest rules" panel, generated from the engine's VARIANTS table. */
export function rulesPanelHtml(setup) {
  const rows = VARIANTS.map((v) => {
    const opts = v.values.map((x) => `<option value="${esc(x)}"${setup.rules[v.name] === x ? ' selected' : ''}>${esc(v.valueLabels[x])}${x === v.default ? ' (standard)' : ''}</option>`).join('');
    return `<div class="rule" data-rule="${v.name}"${v.onlyFor ? ` data-only-for="${v.onlyFor.join(',')}"` : ''}>
        <label for="rule-${v.name}"><span class="rule__id">${v.id}</span> ${esc(v.label)}</label>
        <select name="rule-${v.name}" id="rule-${v.name}">${opts}</select>
        <p class="rule__desc">${esc(v.description)}</p>
      </div>`;
  }).join('');
  return `<details class="rules" id="rules-panel">
      <summary><span>Playtest rules</span> <small id="rules-summary">standard</small></summary>
      <p class="rules__intro">Open design questions, as switches. Each game records which rules it used.</p>
      ${rows}
      <button type="button" class="btn btn--quiet" data-action="reset-rules">Standard rules</button>
    </details>
    <p class="rules-note" id="rules-note" role="status" hidden></p>`;
}

/** The whole landing / setup page. `levels` is botLevels(); `setup` the form defaults; `message` an error. */
export function landingHtml(levels, setup = DEFAULT_SETUP, message = '') {
  const seats = Array.from({ length: MAX_SEATS }, (_, i) => seatFieldset(i, levels, setup)).join('');
  const radios = [3, 4, 5].map((n) => `<label class="seg"><input type="radio" name="players" value="${n}"${setup.players === n ? ' checked' : ''}><span>${n} players</span></label>`).join('');
  return `<div class="landing">
    <nav class="topnav" aria-label="Site">
      <span class="topnav__brand">Daruma Drama</span>
      <span class="topnav__links">
        <button type="button" class="linkbtn" data-action="open-rules">How to play</button>
        <button type="button" class="linkbtn" data-action="open-stats">Stats</button>
      </span>
    </nav>
    <header class="hero">
      ${heroHtml()}
      <h1 class="sr-only">Daruma Drama</h1>
      <div class="hero__text">
        <p class="hero__hook">Every card you lose with stays in front of you, knocked over. Your oldest fallen card is your own personal trump.</p>
        <p class="hero__strap">Fall seven times, stand up eight.</p>
        <p class="hero__sub">A trick-taking card game for friends. Lose tricks to build a line of fallen cards, then win one to rise and bank them all.</p>
      </div>
    </header>
    <ul class="stats" aria-label="At a glance">
      <li>${ICON_PLAYERS}<div><b>3-5</b><span>Players</span></div></li>
      <li>${ICON_TIME}<div><b>30-40</b><span>Minutes</span></div></li>
      <li>${ICON_AGE}<div><b>10+</b><span>Ages</span></div></li>
    </ul>
    <section class="panel setup-panel" aria-labelledby="setup-title">
      <h2 id="setup-title">Set up a game</h2>
      <form id="setup-form" novalidate>
        <fieldset class="players"><legend>Players</legend><div class="segs">${radios}</div></fieldset>
        <div class="setup__seats">${seats}</div>
        <p class="hint">Set every seat to a bot to watch a game. With two or more humans you pass the device, and a cover hides each hand between turns.</p>
        ${rulesPanelHtml(setup)}
        <p class="form-msg" role="alert">${esc(message)}</p>
        <button type="submit" class="btn btn--primary btn--big" id="start">Start game</button>
      </form>
    </section>
    <section class="panel" id="how" aria-labelledby="how-title">
      <h2 id="how-title">How to play</h2>
      ${howToPlayHtml()}
    </section>
    <footer class="footer">
      <span><b>Game design: Dean Morris</b> &middot; Wombat Game Factory &middot; London, UK</span>
      <span>Rule book v4 &middot; Prototype art</span>
    </footer>
  </div>`;
}

// ---------- form helpers ----------

/** Reads the form into a setup object (never throws). */
export function readSetup(form) {
  const v = (n) => (form.elements[n] ? form.elements[n].value : '');
  const checked = form.querySelector('input[name="players"]:checked');
  const players = checked ? Number(checked.value) : 4;
  const seats = Array.from({ length: MAX_SEATS }, (_, i) => ({ type: v(`type${i}`) || (i === 0 ? 'human' : 'easy'), name: v(`name${i}`).trim() }));
  const rules = {};
  for (const def of VARIANTS) rules[def.name] = v(`rule-${def.name}`) || def.default;
  return { players, seats, rules };
}

/** Shows only the seats and rule rows that apply, and keeps the "non-standard rules" note honest. */
export function syncSetupForm(form) {
  const setup = readSetup(form);
  form.querySelectorAll('fieldset.seatform').forEach((fs) => { fs.hidden = Number(fs.dataset.seat) >= setup.players; });
  form.querySelectorAll('.rule[data-only-for]').forEach((row) => {
    row.hidden = !row.dataset.onlyFor.split(',').map(Number).includes(setup.players);
  });
  const code = safeCode(setup);
  const summary = form.querySelector('#rules-summary');
  const note = form.querySelector('#rules-note');
  if (summary) summary.textContent = code === 'std' ? 'standard' : `non-standard: ${code}`;
  if (note) {
    note.hidden = code === 'std';
    note.textContent = code === 'std' ? '' : `Non-standard rules are on (${code}). This is a playtest game, not the standard Daruma Drama, and the result is recorded with these rules.`;
  }
}

/** The rules code for a setup, 'std' when standard. Never throws. */
export function safeCode(setup) {
  try { return rulesCode(resolveVariants(setup.rules), setup.players); } catch { return 'std'; }
}

/** Typed names made unique (case-insensitive): two "Sam"s become "Sam" and "Sam 2". */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    if (!n) return n;
    const key = n.toLowerCase();
    const k = (seen.get(key) || 0) + 1;
    seen.set(key, k);
    return k === 1 ? n : `${n} ${k}`;
  });
}

/** Whether a setup has two or more humans (pass-and-play). */
export function humanCount(setup) {
  return setup.seats.slice(0, setup.players).filter((s) => s.type === 'human').length;
}
