// components.js - HTML string builders for the game screen: seats, fall lines, the trick, the hand,
// the score pad, the log and the overlays (pass-and-play cover, end of hand, end of game).
// Pure string functions of a view-model `vm` built in main.js; no DOM access, no game logic.
//
// vm = { board, names, types, humanSeats, me, shown, hand, reasons, hints, myTurn, view, ui, log,
//        state (read-only: handLog, result, params), frame (the playback frame or null) }

import { COLOUR_NAMES, COLOURS, trumpOf, cardColour, cardName, cardNumber } from '../engine/index.js';
import { esc, img, cardImg, cardBackImg, glyphImg, avatarId } from './assets.js';
import { turnPrompt, waitingText, winnerBanner, tiebreakText, tiedGroups, colourList, poss } from './text.js';

export { esc };

const youName = (n) => n === 'You';
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

export function typeLabel(type) {
  if (type === 'human') return 'Human';
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} bot`;
}

function badge(vm, s) {
  const t = vm.types[s];
  return `<span class="badge badge--${t === 'human' ? 'human' : 'bot'}">${esc(typeLabel(t))}</span>`;
}

function avatar(s, cls = 'seat__avatar') {
  return img(avatarId(s), { cls, alt: '', label: '', w: 256, h: 256 });
}

// ---------- fall lines ----------

function scard(card, { trump = false, fx = '', size = '' } = {}) {
  const tag = trump ? `<span class="scard__tag" title="Trump: ${esc(COLOUR_NAMES[cardColour(card)])}">${glyphImg(cardColour(card))}</span>` : '';
  return `<li class="scard${trump ? ' is-trump' : ''}${size ? ` scard--${size}` : ''}${fx ? ` ${fx}` : ''}" title="${esc(cardName(card))}">${cardImg(card, { alt: cardName(card) })}${tag}</li>`;
}

function lineHtml(vm, s) {
  const b = vm.board;
  const fx = b.fx;
  const line = b.lines[s];
  let items = '';
  if (b.phase === 'fall' && b.chosen) {
    items = b.chosen[s]
      ? `<li class="scard scard--back" title="First fall chosen, face down">${cardBackImg()}</li>`
      : '<li class="line__empty">Choosing a first fall</li>';
  } else if (fx && fx.rose && fx.rose.seat === s && fx.rose.cards.length) {
    // The winner's line rises: ghost copies of the banked cards turn upright and lift away.
    items = fx.rose.cards.map((c, i) => `<li class="scard fx-rise" style="--i:${i}" aria-hidden="true">${cardImg(c)}</li>`).join('');
  } else if (line.length) {
    items = line.map((c, i) => {
      const fell = fx && fx.fell && fx.fell.some((f) => f.seat === s && f.card === c);
      return scard(c, { trump: i === 0, fx: fell ? 'fx-fall' : (fx && fx.revealed ? 'fx-reveal' : '') });
    }).join('');
  } else {
    items = '<li class="line__empty">No fallen cards</li>';
  }
  if (fx && fx.knocked) {
    for (const k of fx.knocked) {
      if (k.seat === s) items = `<li class="scard fx-knock" aria-hidden="true">${cardImg(k.card)}</li>${items}`;
    }
  }
  const t = trumpOf(line);
  const label = line.length
    ? `Fall line, oldest first: ${line.map(cardName).join(', ')}. Trump ${COLOUR_NAMES[t]}. Banks ${line.length} if it wins.`
    : 'Fall line is empty. No trump.';
  return `<ol class="line" aria-label="${esc(label)}">${items}</ol>`;
}

// ---------- seats ----------

export function seatHtml(vm, s, area) {
  const b = vm.board;
  const name = vm.names[s];
  const line = b.lines[s];
  const t = b.phase === 'play' ? trumpOf(line) : null;
  const toAct = b.toAct === s && b.phase !== 'over';
  const tags = [];
  if (b.phase !== 'over' && b.dealer === s) tags.push('<span class="tag tag--dealer" title="Dealer this hand">Dealer</span>');
  if (toAct) tags.push(`<span class="tag tag--turn">${b.phase === 'fall' ? 'Choosing' : (vm.types[s] === 'human' && vm.humanSeats.length === 1 ? 'Your turn' : 'To play')}</span>`);
  const rising = vm.board.fx && vm.board.fx.rose && vm.board.fx.rose.seat === s;
  const bank = line.length;
  const total = b.totals[s] + b.handBanked[s];
  const trumpBox = t
    ? `<div class="stat stat--trump trump--${t}" title="${esc(`${poss(name)} personal trump is ${COLOUR_NAMES[t]}: the colour of the leftmost card in the line`)}"><span class="stat__label">Trump</span><span class="stat__value">${glyphImg(t, 'glyph--sm')}<b>${esc(COLOUR_NAMES[t])}</b></span></div>`
    : `<div class="stat stat--trump trump--none" title="${esc(b.phase === 'fall' ? 'Trumps are set once the first falls are turned over' : `${name} ${youName(name) ? 'have' : 'has'} no fallen cards, so no trump`)}"><span class="stat__label">Trump</span><span class="stat__value"><b>no trump</b></span></div>`;
  const bankBox = `<div class="stat stat--bank${bank ? '' : ' is-zero'}" title="${esc(`${name} would bank ${plural(bank, 'card', 'cards')} by winning a trick now: the whole line rises into the score pile`)}"><span class="stat__label">Bank if win</span><span class="stat__value"><b>${bank}</b></span></div>`;
  return `<article class="seat area-${area}${toAct ? ' is-turn' : ''}${rising ? ' is-rising' : ''}" data-seat="${s}" aria-label="${esc(name)}">
    <header class="seat__head">
      ${avatar(s)}
      <div class="seat__id"><b class="seat__name">${esc(name)}</b>${badge(vm, s)}</div>
      <div class="seat__tags">${tags.join('')}</div>
    </header>
    <div class="seat__stats">${trumpBox}${bankBox}</div>
    ${lineHtml(vm, s)}
    <footer class="seat__score">
      <span class="pile${rising ? ' fx-bump' : ''}" title="${esc(`Score pile: cards banked ${b.pad ? 'this hand' : 'so far'}`)}">${img('score-pile', { cls: 'pile__icon', alt: '', label: '', w: 192, h: 192 })}<b>${b.piles[s]}</b> in pile</span>
      <span class="total" title="Running total: ${esc(plural(total, 'point', 'points'))}${b.pad ? ', including the cards banked this hand' : ''}">Total <b>${total}</b></span>
      <span class="held" title="Cards still in hand">${b.handCounts[s]} in hand</span>
    </footer>
  </article>`;
}

// ---------- the table: seats round the trick ----------

export function tableHtml(vm) {
  const n = vm.board.n;
  const seats = [];
  for (let k = 0; k < n; k++) {
    const s = (vm.me + k) % n;
    seats.push(seatHtml(vm, s, k === 0 ? 'me' : `r${k}`));
  }
  return `<div class="table" data-n="${n}">
    ${seats.slice(1).join('')}
    <div class="area-centre">${centreHtml(vm)}</div>
    ${seats[0]}
  </div>`;
}

// ---------- status + trick ----------

export function statusHtml(vm) {
  const b = vm.board;
  const names = vm.names;
  let line1;
  if (b.phase === 'over') line1 = 'Game over';
  else {
    const hand = `Hand ${Math.min(b.handNo + 1, b.handsPerGame || 99)}${b.handsPerGame ? ` of ${b.handsPerGame}` : ''}`;
    const trick = b.phase === 'fall' ? 'first fall' : `Trick ${Math.min(b.trickNo + 1, b.tricksPerHand)} of ${b.tricksPerHand}`;
    line1 = `${hand} &middot; ${trick} &middot; Dealer: ${esc(names[b.dealer])}`;
  }
  let prompt = '';
  if (vm.myTurn && vm.view && !vm.frame) prompt = turnPrompt(vm.view, names);
  else prompt = waitingText(b, names, vm.types);
  return `<div class="status" role="status"><p class="status__line">${line1}</p><p class="status__prompt" id="prompt">${esc(prompt)}</p></div>`;
}

function centreHtml(vm) {
  const b = vm.board;
  const names = vm.names;
  let body;
  if (b.phase === 'fall') {
    const done = (b.chosen || []).filter(Boolean).length;
    body = `<div class="trick trick--fall"><p class="trick__title">First fall</p>
      <p class="trick__msg">Everyone lays one card face down. They are turned over together.</p>
      <ul class="chosen" aria-label="Who has chosen">${names.map((n, s) => `<li class="${b.chosen && b.chosen[s] ? 'is-done' : ''}">${esc(n)}: ${b.chosen && b.chosen[s] ? 'chosen' : 'waiting'}</li>`).join('')}</ul>
      <p class="trick__sub">${done} of ${b.n} chosen</p></div>`;
  } else if (b.phase === 'over') {
    body = '<div class="trick"><p class="trick__title">Game over</p></div>';
  } else {
    const t = b.trick;
    const order = Array.from({ length: b.n }, (_, k) => (b.leader + k) % b.n);
    const slots = order.map((s) => {
      const p = t && t.plays.find((x) => x.seat === s);
      if (!p) return `<li class="tplay tplay--empty"><span class="tplay__slot"></span><span class="tplay__who">${esc(names[s])}</span></li>`;
      const win = t.winner === s;
      const tags = [];
      if (t.plays[0].seat === s) tags.push('led');
      if (p.trump) tags.push('trump');
      if (win) tags.push('wins');
      return `<li class="tplay${win ? ' is-winner' : ''}${p.trump ? ' is-trump' : ''}${t.winner !== null && !win ? ' is-lost' : ''}"><span class="tplay__card">${cardImg(p.card, { alt: cardName(p.card) })}</span><span class="tplay__who">${esc(names[s])}</span><span class="tplay__tags">${tags.map((x) => `<i class="mark mark--${x}">${x}</i>`).join('')}</span></li>`;
    }).join('');
    const title = t ? `Trick ${t.n} &middot; <span class="led led--${t.ledColour}">${glyphImg(t.ledColour, 'glyph--xs')}${esc(COLOUR_NAMES[t.ledColour])} led</span>` : `Trick ${Math.min(b.trickNo + 1, b.tricksPerHand)}`;
    let msg = '';
    if (b.banner) msg = winnerBanner(b.banner, names);
    else if (!t) msg = b.toAct !== null ? `${names[b.toAct]} ${youName(names[b.toAct]) ? 'lead' : 'leads'} the next trick.` : '';
    body = `<div class="trick"><p class="trick__title">${title}</p><ol class="tplays">${slots}</ol><p class="trick__msg${b.banner ? ' is-banner' : ''}" id="trick-msg">${esc(msg)}</p></div>`;
  }
  const discards = `<p class="trick__meta"><button type="button" class="linkbtn" data-action="open-discards">Discard pile: ${b.discard.length}</button></p>`;
  return `${statusHtml(vm)}${body}${discards}`;
}

// ---------- the hand ----------

export function handHtml(vm) {
  const hand = vm.hand;
  if (!hand) return '';
  const first = vm.board.phase === 'fall';
  const items = hand.map((card, i) => {
    const reason = vm.reasons.get(card) || null;
    const hint = vm.hints.get(card) || null;
    const legal = vm.myTurn && !reason;
    const cls = ['card', `card--${cardColour(card)}`];
    if (!vm.myTurn) cls.push('is-wait');
    else if (legal) cls.push('is-legal'); else cls.push('is-blocked');
    if (i === 0 || cardColour(hand[i - 1]) !== cardColour(card)) cls.push('is-first');
    if (vm.ui.selected === card) cls.push('is-selected');
    let mark = '';
    if (legal && hint && hint.kind === 'follow') mark = `<span class="card__hint ${hint.wins ? 'is-win' : 'is-lose'}" aria-hidden="true">${hint.wins ? '&#10003;' : '&#10007;'}</span>`;
    const title = !vm.myTurn ? `${cardName(card)}: wait for your turn` : (reason || `${first ? 'Lay down' : 'Play'} ${cardName(card)}`);
    const hintSr = legal && hint && hint.kind === 'follow' ? (hint.wins ? ' (would win the trick as it stands)' : ' (would not win)') : '';
    return `<button type="button" class="${cls.join(' ')}" data-action="play" data-card="${card}" title="${esc(title)}" aria-label="${esc(cardName(card) + hintSr)}"${legal ? '' : ' aria-disabled="true"'}>${cardImg(card)}${mark}</button>`;
  }).join('');
  return `<div class="hand" role="group" aria-label="Your hand, sorted by colour">${items}</div>`;
}

export function handBoxHtml(vm) {
  const b = vm.board;
  const who = vm.humanSeats.length > 1 ? `${esc(vm.names[vm.shown])}'s hand` : 'Your hand';
  if (vm.hand === null) {
    // Pass-and-play and it is not this human's decision (or nobody is human): never show a hand.
    if (vm.humanSeats.length === 0) return '';
    return `<div class="handbox handbox--hidden"><p class="handbox__title">Hands are hidden</p>${cardBackImg('handbox__back')}</div>`;
  }
  const legend = vm.myTurn && vm.view.phase === 'play' && vm.view.trick
    ? '<p class="legend"><span class="hint-dot is-win">&#10003;</span> would win the trick as it stands <span class="hint-dot is-lose">&#10007;</span> would not. Dimmed cards cannot be played: hover or tap one to see why.</p>'
    : (vm.myTurn && vm.view.phase === 'play' ? '<p class="legend">You lead: any card may be played. Dimmed cards cannot be played.</p>' : '');
  const title = vm.myTurn && b.phase === 'fall' ? `${who}: choose your first fall` : `${who} <span>sorted by colour</span>`;
  return `<div class="handbox${vm.myTurn ? ' is-turn' : ''}">
    <p class="handbox__title">${title}</p>
    <div class="hand-wrap">${handHtml(vm)}</div>
    ${legend}
    <p class="preview" id="preview" aria-live="polite"></p>
    <p class="note" id="note" role="status">${esc(vm.ui.note || '')}</p>
  </div>`;
}

// ---------- score pad and log ----------

export function padHtml(vm) {
  const b = vm.board;
  const log = vm.state.handLog;
  const names = vm.names;
  const rows = [];
  for (let h = 0; h < (b.handsPerGame || log.length); h++) {
    if (h < log.length && (h < b.handNo || b.phase === 'over')) {
      const rec = log[h];
      rows.push(`<tr><th scope="row">Hand ${h + 1}</th>${rec.scores.map((x) => `<td>${x}</td>`).join('')}</tr>`);
    } else if (h === b.handNo && b.phase !== 'over') {
      rows.push(`<tr class="is-now"><th scope="row">Hand ${h + 1} <small>so far</small></th>${b.handBanked.map((x) => `<td>${x}</td>`).join('')}</tr>`);
    } else {
      rows.push(`<tr class="is-todo"><th scope="row">Hand ${h + 1}</th>${names.map(() => '<td>&middot;</td>').join('')}</tr>`);
    }
  }
  const totals = b.totals.map((t, s) => t + b.handBanked[s]);
  return `<table class="pad"><caption class="sr-only">Score pad</caption>
    <thead><tr><th scope="col"></th>${names.map((n, s) => `<th scope="col" title="${esc(n)}">${avatar(s, 'pad__avatar')}<span class="pad__name">${esc(n)}</span></th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><th scope="row">Total</th>${totals.map((t) => `<td>${t}</td>`).join('')}</tr></tfoot></table>`;
}

export function logHtml(vm) {
  const items = vm.log.slice().reverse().slice(0, 60).map((l) => `<li class="log__item log__item--${l.kind || 'info'}">${esc(l.text)}</li>`).join('');
  return `<ol class="log__list" id="log" aria-label="What has happened, newest first">${items || '<li class="log__item">Nothing yet.</li>'}</ol>`;
}

export function sideHtml(vm) {
  const open = (k, d = true) => (vm.ui.panels[k] === undefined ? d : vm.ui.panels[k]) ? ' open' : '';
  return `<aside class="side">
    <details class="panel" data-panel="pad"${open('pad')}><summary>Score pad</summary>${padHtml(vm)}</details>
    <details class="panel" data-panel="log"${open('log')}><summary>What happened</summary>${logHtml(vm)}</details>
  </aside>`;
}

// ---------- overlays ----------

/** Pass-and-play cover: nothing from the game is in the DOM while it is up. */
export function coverHtml(vm, seat, phase) {
  const name = vm.names[seat];
  const msg = phase === 'fall' ? 'Choose your first fall in secret.' : 'It is your turn to play.';
  return `<div class="cover" id="cover" role="dialog" aria-modal="true" aria-labelledby="cover-title">
    <div class="cover__card">
      ${avatar(seat, 'cover__avatar')}
      <p class="cover__kicker">Pass the device</p>
      <h2 id="cover-title">Pass to ${esc(name)}</h2>
      <p class="cover__msg">${esc(msg)} Everyone else look away.</p>
      <button type="button" class="btn btn--primary btn--big" data-action="reveal" data-seat="${seat}">I am ${esc(name)}: show my hand</button>
    </div>
  </div>`;
}

function miniCards(cards) {
  if (!cards.length) return '<span class="muted">none</span>';
  return `<span class="mini">${cards.map((c) => `<span class="mini__card" title="${esc(cardName(c))}">${cardImg(c, { alt: cardName(c) })}</span>`).join('')}</span>`;
}

export function handSummaryHtml(vm, modal) {
  const ev = modal.event;
  const names = vm.names;
  const last = vm.state.phase === 'over' && modal.handNo === vm.state.handLog.length - 1;
  const rows = names.map((n, s) => {
    const pen = ev.penalties[s] ? ` <small>(${ev.penalties[s]} off for the line)</small>` : '';
    return `<tr><th scope="row">${avatar(s, 'pad__avatar')}${esc(n)}</th><td class="num"><b>${ev.scores[s]}</b>${pen}</td><td>${miniCards(ev.lost[s])}</td><td class="num">${ev.totals[s]}</td></tr>`;
  }).join('');
  const hp = vm.state.params.handsPerGame;
  const title = `Hand ${modal.handNo + 1}${hp ? ` of ${hp}` : ''} is over`;
  return `<div class="overlay" data-overlay="hand"><div class="end end--hand" role="dialog" aria-modal="true" aria-labelledby="hand-title">
    <h2 id="hand-title">${esc(title)}</h2>
    <p class="end__lead">Each player scores the cards they banked this hand. Cards still lying in a fall line are lost.</p>
    <div class="table-wrap"><table class="summary"><thead><tr><th scope="col">Player</th><th scope="col">Scored</th><th scope="col">Lost on the line</th><th scope="col">Total</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="end__buttons"><button type="button" class="btn btn--primary btn--big" data-action="continue" id="continue">${last ? 'See the final result' : 'Deal the next hand'}</button></div>
  </div></div>`;
}

export function gameEndHtml(vm) {
  const result = vm.state.result;
  const names = vm.names;
  const winners = result.winners;
  const wName = winners.map((s) => names[s]);
  let headline;
  if (result.shared) headline = `Shared win: ${wName.slice(0, -1).join(', ')}${wName.length > 1 ? ' and ' : ''}${wName[wName.length - 1]}`;
  else headline = `${wName[0]} ${youName(wName[0]) ? 'win' : 'wins'}!`;
  const groups = tiedGroups(result);
  const tiedSeats = new Set(groups.flat());
  const rows = result.ranking.map((r) => {
    const win = winners.includes(r.seat);
    const tied = tiedSeats.has(r.seat);
    const cols = tied ? `<span class="rank__cols" title="Colours banked over the game">${result.coloursBanked[r.seat].map((c) => glyphImg(c, 'glyph--sm')).join('')}<small>${result.colourCounts[r.seat]} colour${result.colourCounts[r.seat] === 1 ? '' : 's'}</small></span>` : '';
    const eq = result.ranking.filter((x) => x.rank === r.rank).length > 1 ? '=' : '';
    return `<li class="rank${win ? ' is-winner' : ''}"><span class="rank__pos">${eq}${r.rank}</span>${avatar(r.seat, 'rank__avatar')}<span class="rank__who"><b>${esc(names[r.seat])}</b>${badge(vm, r.seat)}${win ? `<i class="crown">${result.shared ? 'Shared win' : 'Winner'}</i>` : ''}</span>${cols}<span class="rank__total"><b>${r.total}</b> pts</span></li>`;
  }).join('');
  const tb = tiebreakText(result, names);
  const code = vm.state.rulesCode;
  const padRows = vm.state.handLog.map((h, i) => `<tr><th scope="row">Hand ${i + 1}</th>${h.scores.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('');
  return `<div class="overlay" data-overlay="end"><div class="end end--game" role="dialog" aria-modal="true" aria-labelledby="end-title">
    <p class="end__kicker">Fall seven times, stand up eight.</p>
    <h2 id="end-title">${esc(headline)}</h2>
    ${tb ? `<p class="end__tiebreak" id="tiebreak">${esc(tb)}</p>` : ''}
    <ol class="ranking" aria-label="Final ranking">${rows}</ol>
    <details class="panel"><summary>Score pad</summary><table class="pad pad--end"><thead><tr><th></th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>${padRows}</tbody><tfoot><tr><th>Total</th>${result.totals.map((t) => `<td>${t}</td>`).join('')}</tr></tfoot></table></details>
    <p class="end__rules">${code === 'std' ? 'Standard rules.' : `Non-standard rules were on: ${esc(code)}.`}</p>
    <div class="end__buttons">
      <button type="button" class="btn btn--primary btn--big" data-action="again">Play again</button>
      <button type="button" class="btn" data-action="new">Change setup</button>
      <button type="button" class="btn btn--quiet" data-action="review">Look at the table</button>
      <button type="button" class="btn btn--quiet" data-action="open-stats">Stats</button>
    </div>
  </div></div>`;
}

export function endBarHtml(vm) {
  const result = vm.state.result;
  const w = result.winners.map((s) => vm.names[s]).join(' and ');
  return `<div class="endbar" role="status"><span><b>Game over.</b> ${esc(result.shared ? `Shared win: ${w}.` : `${w} ${youName(w) ? 'win' : 'wins'}.`)}</span><button type="button" class="btn btn--primary" data-action="again">Play again</button><button type="button" class="btn" data-action="show-end">Show result</button><button type="button" class="btn btn--quiet" data-action="open-stats">Stats</button></div>`;
}

export function discardsHtml(vm) {
  const cards = vm.board.discard.slice();
  const byColour = COLOURS.map((c) => {
    const these = cards.filter((x) => cardColour(x) === c).sort((a, b) => cardNumber(a) - cardNumber(b));
    return these.length ? `<p class="disc"><span class="disc__label">${glyphImg(c, 'glyph--sm')}${esc(COLOUR_NAMES[c])}</span> ${these.map((x) => `<span class="numchip numchip--${c}" title="${esc(cardName(x))}">${cardNumber(x)}</span>`).join('')}</p>` : '';
  }).join('');
  return `<p>Winning cards, knocked-off cards and cards lost on the lines this hand (${cards.length}). Everyone saw them, so you may look.</p>${byColour || '<p class="muted">Nothing has been discarded yet.</p>'}`;
}
