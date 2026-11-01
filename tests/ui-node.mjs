// ui-node.mjs - Node-level checks of the UI's pure parts: the table model and its frames (the
// event reducer must land exactly on the live state after every action, in every variant), the
// sentences, the clone-and-apply hints, the landing/setup builders (Playtest rules generated
// from VARIANTS), the art ids against the manifest, and the pass-and-play hand-hiding rules.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/ui-node.mjs

import fs from 'node:fs';
import { suite, position, play } from './lib.mjs';
import { createController } from '../src/ui/controller.js';
import { boardFromState, reduceBoard, buildFrames, sameBoard } from '../src/ui/board.js';
import { trickSentence, tiebreakText, turnPrompt, previewText, winnerBanner, tiedGroups } from '../src/ui/text.js';
import { previewCard } from '../src/ui/preview.js';
import { makeVm } from '../src/ui/viewmodel.js';
import { tableHtml, handBoxHtml, sideHtml, coverHtml, handSummaryHtml, gameEndHtml, discardsHtml, statusHtml } from '../src/ui/components.js';
import { landingHtml, rulesPanelHtml, seatTypeOptions, uniqueNames, DEFAULT_SETUP, RULEBOOK_URL, LEVELS, safeCode } from '../src/ui/landing.js';
import { useManifest, assetUrl, builtInIds, img } from '../src/ui/assets.js';
import { botLevels } from '../src/bots/index.js';
import {
  startGame, applyAction, getValidActions, describeEvent, makeRng, rngPick, VARIANTS, DEFAULT_RULES, fullDeck, COLOURS,
} from '../src/engine/index.js';

const { check, done } = suite('ui-node');
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- art ids against the manifest ----------
{
  const manifest = JSON.parse(fs.readFileSync(new URL('../assets/manifest.json', import.meta.url), 'utf8'));
  const ids = new Set(manifest.assets.map((a) => a.id));
  check('assets: every built-in art id is in the manifest', builtInIds().every((id) => ids.has(id)), builtInIds().filter((id) => !ids.has(id)).join(','));
  check('assets: all 55 card faces are known', fullDeck(COLOURS).every((c) => ids.has(`card-${c}`)));
  check('assets: the files named by the manifest exist', manifest.assets.every((a) => fs.existsSync(new URL(`../assets/${a.file}`, import.meta.url))));
  useManifest(manifest);
  check('assets: assetUrl resolves a face and a glyph', assetUrl('card-gold-7') === 'assets/cards/card-gold-7.webp' && assetUrl('glyph-blue') === 'assets/glyph-blue.webp');
  check('assets: an unknown id gives a text chip, not a broken image', /asset-chip/.test(img('nope', { label: 'Nope' })) && !/<img/.test(img('nope')));
}

// ---------- sentences ----------
{
  const names = ['Mia', 'Sam', 'Ann', 'Bo'];
  // Mia leads Blue 7. Sam (trump Gold, line 3) has no Blue, trumps with Gold 4 and wins banking 3.
  const g = position({
    hands: [['blue-7', 'red-1'], ['gold-4', 'red-2'], ['blue-2', 'red-3'], ['blue-9', 'red-4']],
    lines: [[], ['gold-1', 'red-5', 'red-6'], [], []], leader: 0, tricksLeft: 9,
  });
  const ev = play(g, 'blue-7', 'gold-4', 'blue-2', 'blue-9');
  const won = ev.find((e) => e.type === 'trick-won');
  const s = trickSentence(g.tricks[0], won, names);
  check('sentence: trump win names the trump, the winner, the bank and the full-line bonus', /^Mia led Blue 7; Sam trumped with Gold 4 \(Gold is Sam's trump\) and wins, banking 3 \+2 bonus; Ann followed with Blue 2; Bo followed with Blue 9\.$/.test(s), s);
  check('banner: says who won with what and what was banked', winnerBanner({ winner: 1, card: 'gold-4', bankSize: 3, byTrump: true, trumpColour: 'gold' }, names) === 'Sam wins with Gold 4 (Gold trump) and banks 3');
}
{
  const names = ['You', 'Sam', 'Ann'];
  const g = position({ players: 3, hands: [['red-9', 'red-1'], ['blue-2', 'blue-3'], ['red-3', 'red-4']], lines: [[], ['red-5'], []], leader: 0, tricksLeft: 9 });
  const ev = play(g, 'red-9', 'blue-2', 'red-3');
  const won = ev.find((e) => e.type === 'trick-won');
  const s = trickSentence(g.tricks[0], won, names);
  check('sentence: second person for You, off-colour discard explained, banking nothing', /^You led Red 9 and win, banking nothing; Sam had no Red and threw Blue 2; Ann followed with Red 3\./.test(s), s);
}
{
  const g = position({ players: 3, hands: [['red-9', 'red-1'], ['red-2', 'red-3'], ['red-4', 'red-5']], lines: [[], ['gold-1', 'gold-2', 'gold-3'], []], leader: 0, tricksLeft: 9 });
  const ev = play(g, 'red-9', 'red-2', 'red-4');
  const won = ev.find((e) => e.type === 'trick-won');
  const s = trickSentence(g.tricks[0], won, ['Mia', 'Sam', 'Ann']);
  check('sentence: a full line says what was knocked off', /Knocked off: Sam's Gold 1\.$/.test(s), s);
}
{
  const names = ['Ann', 'Bo', 'Cy'];
  const mk = (tied, winners, shared, used, counts, tiebreak = 'colours') => ({ tiedOnTotal: tied, winners, shared, tiebreakUsed: used, winningScore: 14, colourCounts: counts, leftCounts: counts, tiebreak, ranking: [] });
  check('tiebreak text: colours decide, tied players only', /^Ann and Bo tied on 14\. Tiebreak: most different colours in their score piles\. Colours banked over the game: Ann 5, Bo 4\. Ann wins\.$/.test(tiebreakText(mk([0, 1], [0], false, true, [5, 4, 2]), names)), tiebreakText(mk([0, 1], [0], false, true, [5, 4, 2]), names));
  const lt = tiebreakText(mk([0, 1], [1], false, true, [3, 1, 0], 'leftover'), names);
  check('tiebreak text: fewest left decides (the standard rule), tied players only', /^Ann and Bo tied on 14\. Tiebreak: fewest cards left on the line\. Cards left on the line at the ends of hands: Ann 3, Bo 1\. Bo wins\.$/.test(lt), lt);
  check('tiebreak text: a shared win says shared', /the win is shared\.$/i.test(tiebreakText(mk([0, 1], [0, 1], true, false, [4, 4, 1], 'leftover'), names)) && /The win is shared\.$/.test(tiebreakText(mk([0, 1], [0, 1], true, false, [4, 4, 1], 'shared'), names)));
  check('tiebreak text: no tie at the top says nothing', tiebreakText(mk([0], [0], false, false, [3, 2, 1]), names) === '');
  check('tied groups: only groups of two or more', JSON.stringify(tiedGroups({ ranking: [{ seat: 0, total: 9 }, { seat: 1, total: 9 }, { seat: 2, total: 4 }] })) === '[[0,1]]');
}

// ---------- clone-and-apply hints ----------
{
  let checks = 0; let mutated = 0; let finalMismatch = 0; let openMismatch = 0; let leads = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const players = 3 + (seed % 3);
    const { state } = startGame({ seed, players });
    const rng = makeRng(`p${seed}`);
    while (state.phase !== 'over') {
      const before = JSON.stringify(state);
      for (const a of getValidActions(state)) {
        const pv = previewCard(state, a.card);
        if (JSON.stringify(state) !== before) mutated++;
        if (!pv) continue;
        if (pv.kind === 'lead') leads++;
        if (pv.kind === 'follow') {
          checks++;
          const copy = JSON.parse(before);
          const events = applyAction(copy, a);
          const won = events.find((e) => e.type === 'trick-won' && e.trickNo === state.trick.n && e.handNo === state.handNo);
          if (pv.final) {
            if (!won || (won.winner === state.toAct) !== pv.wins || won.winner !== pv.winnerSeat || (pv.wins && won.bankSize !== pv.bankSize)) finalMismatch++;
          } else if (won || pv.remaining < 1) openMismatch++;
        }
      }
      applyAction(state, rngPick(rng, getValidActions(state)));
    }
  }
  check('hints: clone-and-apply never mutates the state', mutated === 0);
  check('hints: a decided trick agrees with the engine (winner, bank)', checks > 500 && finalMismatch === 0, `${checks} checks, ${finalMismatch} mismatches`);
  check('hints: an open trick reports who leads it for now', openMismatch === 0 && leads > 50);
  const h = position({ hands: [['blue-7', 'red-1'], ['gold-4', 'red-2'], ['blue-2', 'red-3'], ['blue-9', 'red-4']], leader: 0, tricksLeft: 9 });
  play(h, 'blue-7');
  check('hints: a card the engine would refuse (not in hand) gives null', previewCard(h, 'blue-11') === null);
  check('hints: a playable follow card gives a hint', previewCard(h, 'gold-4') !== null);
}

// ---------- the table model: events land exactly on the live state ----------
{
  const CONFIGS = [
    { rules: {} }, { rules: { FIRST_FALL: 'top' } }, { rules: { FORMAT: 'shrinking' } }, { rules: { LINE_LIMIT: '2', LEFTOVER: 'minus1' } },
    { rules: { LINE_LIMIT: 'scaled', HAND_SIZE: 'ten', TRUMP_TIES: 'last', TIEBREAK: 'shared' } }, { rules: { DECK_3P: 'drop_purple' } },
  ];
  let actions = 0; let drift = 0; let firstDrift = ''; let framesBad = 0; let modals = 0; let handEnds = 0; let decided = 0; let tricks = 0; let games = 0;
  for (const cfg of CONFIGS) {
    for (let seed = 1; seed <= 12; seed++) {
      for (const players of [3, 4, 5]) {
        for (const humans of [[0], [0, 2], []]) {
          if (humans.some((h) => h >= players)) continue;
          if (!(seed <= 4 || humans.length === 1)) continue;
          let started;
          try { started = startGame({ seed: seed * 7 + players, players, rules: cfg.rules }); } catch (e) { continue; }
          games++;
          const state = started.state;
          const names = Array.from({ length: players }, (_, i) => `P${i + 1}`);
          let board = boardFromState(state, humans);
          const rng = makeRng(`b${seed}${players}`);
          while (state.phase !== 'over') {
            const action = rngPick(rng, getValidActions(state));
            const seat = state.toAct;
            const events = applyAction(state, action);
            const ctx = { names, describe: describeEvent, trickText: trickSentence, liveHands: (s) => state.hands[s], fall: action.type === 'fall' && humans.includes(seat) ? { seat, card: action.card } : null };
            const frames = buildFrames(board, events, ctx);
            actions++;
            if (frames.length) board = frames[frames.length - 1].board;
            const live = boardFromState(state, humans);
            if (!sameBoard(board, live)) { drift++; if (!firstDrift) firstDrift = `${JSON.stringify(cfg.rules)} seed ${seed} p${players}: ${diffKeys(board, live)}`; board = live; }
            // frame sanity
            for (const f of frames) {
              if (f.hold === Infinity && !f.modal) framesBad++;
              if (f.modal) modals++;
              if (f.kind === 'decided') { decided++; if (f.board.trick.winner === null || !f.board.banner) framesBad++; }
              if (f.kind === 'resolve') { tricks++; if (!f.log || !/\.$/.test(f.log)) framesBad++; }
            }
            const he = events.filter((e) => e.type === 'hand-ended').length;
            handEnds += he;
            if (frames.filter((f) => f.modal).length !== he) framesBad++;
            if (events.some((e) => e.type === 'trick-won' && !frames.some((f) => f.kind === 'decided'))) framesBad++;
          }
        }
      }
    }
  }
  check('board: walking the events lands exactly on the live state, every action, every variant', drift === 0, `${actions} actions in ${games} games, ${drift} drifts, first: ${firstDrift}`);
  check('board: frames are well formed (decided beat per trick, one modal per hand end)', framesBad === 0 && modals === handEnds && handEnds > 40 && decided === tricks && tricks > 500, `bad ${framesBad}, modals ${modals}, hand ends ${handEnds}, decided ${decided}, tricks ${tricks}`);
}
function diffKeys(a, b) {
  const keys = Object.keys(a).filter((k) => !['fx', 'last', 'banner'].includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return keys.map((k) => `${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`).join(' | ');
}
{
  // The last trick of a hand plays itself, so ONE action can end the hand and deal the next: the
  // frames must still show that trick, the summary, and then the new hand.
  let seen = 0; let ok = true;
  for (let seed = 1; seed <= 6; seed++) {
    const { state } = startGame({ seed, players: 4 });
    let board = boardFromState(state, [0]);
    const rng = makeRng(`z${seed}`);
    while (state.phase !== 'over') {
      const action = rngPick(rng, getValidActions(state));
      const events = applyAction(state, action);
      const frames = buildFrames(board, events, { names: ['A', 'B', 'C', 'D'], describe: describeEvent, trickText: trickSentence, liveHands: (s) => state.hands[s], fall: null });
      if (frames.length) board = frames[frames.length - 1].board;
      if (events.some((e) => e.type === 'hand-ended')) {
        seen++;
        const kinds = frames.map((f) => f.kind);
        const iEnd = kinds.indexOf('hand-end');
        const iNext = kinds.indexOf('deal');
        if (!(iEnd > kinds.lastIndexOf('resolve') && (state.phase === 'over' ? iNext === -1 : iNext > iEnd))) ok = false;
        if (state.phase !== 'over' && frames[iEnd].board.lines.every((l) => l.length === 0) && events.find((e) => e.type === 'hand-ended').lost.flat().length > 0) ok = false;
      }
    }
  }
  check('board: a hand end shows the last trick, then the summary (lines still hold the lost cards), then the deal', seen >= 20 && ok, `${seen} hand ends`);
}

// ---------- landing and setup ----------
{
  const levels = botLevels();
  const html = landingHtml(levels, DEFAULT_SETUP, '');
  check('landing: the hook, the strapline and the stat strip', html.includes('Every card you lose with stays in front of you, knocked over. Your oldest fallen card is your own personal trump.') && html.includes('Fall seven times, stand up eight.') && /3-5<\/b><span>Players[\s\S]*30-40<\/b><span>Minutes[\s\S]*10\+<\/b><span>Ages/.test(html));
  check('landing: the rule book link points at the v5 PDF', RULEBOOK_URL === 'rules/daruma-drama-rule-book-v5.pdf' && html.includes(`href="${RULEBOOK_URL}"`));
  check('landing: the watch-the-bots hint', /Set every seat to a bot to watch a game/.test(html));
  check('landing: seats for 3, 4 and 5 players, names editable', [0, 1, 2, 3, 4].every((i) => html.includes(`name="type${i}"`) && html.includes(`name="name${i}"`)) && ['3', '4', '5'].every((n) => html.includes(`name="players" value="${n}"`)));
  const rules = rulesPanelHtml(DEFAULT_SETUP);
  check('rules panel: one row per VARIANTS entry with every value and its description', VARIANTS.every((v) => rules.includes(`name="rule-${v.name}"`) && v.values.every((x) => rules.includes(`value="${x}"`)) && rules.includes(v.label)));
  check('rules panel: collapsed, with a Standard rules reset', /<details class="rules"/.test(rules) && !/<details class="rules"[^>]* open/.test(rules) && /data-action="reset-rules"/.test(rules));
  check('rules panel: the 3-player-only switch is flagged', /data-rule="DECK_3P" data-only-for="3"/.test(rules));
  check('setup: standard rules code is std; a change is not', safeCode(DEFAULT_SETUP) === 'std' && safeCode({ players: 4, rules: { ...DEFAULT_RULES, LINE_LIMIT: '2' } }) === 'line-2');
  const only = seatTypeOptions([{ id: 'easy', label: 'Easy', offered: true }], 'easy');
  check('setup: a bot level the registry lacks is shown but disabled', /value="medium" disabled/.test(only) && /value="hard" disabled/.test(only) && !/value="easy" disabled/.test(only) && LEVELS.length === 3);
  const all = seatTypeOptions(['easy', 'medium', 'hard'].map((id) => ({ id, label: id, offered: true })), 'hard');
  check('setup: with all three levels registered none is disabled', !/disabled/.test(all) && /value="hard" selected/.test(all));
  check('setup: duplicate typed names are made unique', JSON.stringify(uniqueNames(['Sam', '', 'sam', 'Sam'])) === '["Sam","","sam 2","Sam 3"]');
}

// ---------- pass-and-play: hands stay hidden ----------
{
  const ctl = createController({ seats: [{ type: 'human', name: 'Ann' }, { type: 'human', name: 'Bo' }, { type: 'easy' }, { type: 'human', name: 'Cy' }], seed: 'pp-ui' });
  const ui = { frame: null, modal: null, selected: null, note: '', panels: {} };
  const rng = makeRng('pp-ui');
  let leaks = 0; let covers = 0; let handsShown = 0; let fallCovers = 0; let guard = 0; let wrongShown = 0;
  while (!ctl.isFinished() && guard++ < 2000) {
    ctl.runBots();
    if (ctl.isFinished()) break;
    const board = boardFromState(ctl.state, ctl.humanSeats);
    if (ctl.needsHandoff()) {
      covers++;
      if (ctl.state.phase === 'fall') fallCovers++;
      const html = coverHtml({ names: ctl.names }, ctl.state.toAct, ctl.state.phase);
      if (/data-card|cardimg|class="hand/.test(html)) leaks++;
      const vm = makeVm({ ctl, ui, board, log: [] });
      if (vm.hand !== null) leaks++;
      ctl.reveal(ctl.state.toAct);
      continue;
    }
    const vm = makeVm({ ctl, ui, board, log: [] });
    if (vm.hand !== null) { handsShown++; if (vm.shown !== ctl.state.toAct || !ctl.isHumanTurn()) wrongShown++; }
    // a bystander view (during a replay) never shows a hand with 2+ humans
    const replay = makeVm({ ctl, ui: { ...ui, frame: { board } }, board, log: [] });
    if (replay.hand !== null) leaks++;
    const hb = handBoxHtml(replay);
    if (/data-card/.test(hb)) leaks++;
    ctl.play(rngPick(rng, ctl.legalActions()));
  }
  check('pass-and-play: a cover before every human decision, the first fall included', ctl.isFinished() && covers >= 20 && fallCovers >= 3, `${covers} covers, ${fallCovers} on the first fall`);
  check('pass-and-play: no card in a cover and no hand outside its owner\'s own decision', leaks === 0 && wrongShown === 0 && handsShown > 20, `${leaks} leaks, ${wrongShown} wrong, ${handsShown} shown`);
}
{
  // A lone human: their hand is always there, with a reason on every card they may not play and a hint on the rest.
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 31 });
  const ui = { frame: null, modal: null, selected: null, note: '', panels: {} };
  const rng = makeRng('lone');
  let blocked = 0; let blockedWithReason = 0; let hinted = 0; let legalSeen = 0; let guard = 0; let htmlBad = 0; let turns = 0;
  while (!ctl.isFinished() && guard++ < 2000) {
    ctl.runBots();
    if (ctl.isFinished()) break;
    const board = boardFromState(ctl.state, ctl.humanSeats);
    const vm = makeVm({ ctl, ui, board, log: [{ text: 'x', kind: 'info' }] });
    turns++;
    for (const c of vm.hand) {
      if (vm.reasons.get(c)) { blocked++; if (/must follow/.test(vm.reasons.get(c))) blockedWithReason++; } else { legalSeen++; if (vm.hints.get(c)) hinted++; }
    }
    const out = [tableHtml(vm), handBoxHtml(vm), sideHtml(vm), statusHtml(vm)].join('');
    if (/undefined|NaN|\[object/.test(out)) htmlBad++;
    if (!vm.myTurn || !vm.hand.length) htmlBad++;
    ctl.play(rngPick(rng, ctl.legalActions()));
  }
  check('lone human: illegal cards carry the must-follow reason, legal cards a hint', blocked > 5 && blockedWithReason === blocked && hinted === legalSeen, `${blocked} blocked, ${hinted}/${legalSeen} hinted`);
  check('screens render without undefined/NaN at every human decision', htmlBad === 0 && turns > 20);
  const end = createController({ seats: [{ type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 8 });
  end.runBots();
  const board = boardFromState(end.state, []);
  const vm = makeVm({ ctl: end, ui, board, log: [] });
  const html = gameEndHtml(vm);
  check('end screen: ranking rows with seat badges, play again', /<ol class="ranking"/.test(html) && /badge/.test(html) && /data-action="again"/.test(html) && !/undefined|NaN/.test(html));
  check('end screen: a hand summary and the discard dialog render', !/undefined|NaN/.test(handSummaryHtml(vm, { handNo: 0, event: end.state.handLog[0] && { handNo: 0, scores: end.state.handLog[0].scores, lost: end.state.handLog[0].lost, penalties: end.state.handLog[0].penalties, totals: end.state.totals } })) && !/undefined|NaN/.test(discardsHtml(vm)));
}
{
  // The prompt tells the player what is forced.
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed: 5 });
  ctl.runBots();
  const v = ctl.view(0);
  check('prompt: the first fall is explained', /first fall/i.test(turnPrompt(v, ctl.names)) && /trump/.test(turnPrompt(v, ctl.names)));
  check('hint text: a first fall names the trump colour it would set', /would be your first fall/.test(previewText(previewCard(ctl.state, v.hand[0]), ctl.names, '')));
}

done();
