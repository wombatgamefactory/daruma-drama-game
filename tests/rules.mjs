// rules.mjs - rules conformance: one check (or a few) per numbered rule of the rule list
// (R1.1 ... R22, RV1 ... RV8). Labels cite the rule numbers.
// Semantics: PERMANENTLY GREEN. A red line is a regression. Exit 1 on any failure.

import {
  COLOURS, CONSTANTS, VARIANTS, DEFAULT_RULES, resolveVariants, rulesCode, fullDeck, sortCards, cardName,
  createGame, startGame, applyAction, getValidActions, getPlayBlockReason, getActionBlockReason, trickWinner,
  viewFor, legalActionsFromView, shownVoids, unknownCards, determinise, gameResult, describeEvent,
  makeRng, rngInt, rngPick, shuffle, cardColour,
} from '../src/engine/index.js';
import { suite, position, play, conservation, roundTrip, same, throws } from './lib.mjs';

const { check, done } = suite('rules');

/** Plays random legal actions to the end; returns all events (including the start's if given). */
function playRandom(state, seed, startEvents = []) {
  const rng = makeRng(seed);
  const events = [...startEvents];
  let guard = 0;
  while (state.toAct !== null && guard++ < 1000) events.push(...applyAction(state, rngPick(rng, getValidActions(state))));
  return events;
}

function randomGame(players, rules = {}, seed = 'g', firstDealer = null) {
  const { state, events } = startGame({ seed, players, rules, firstDealer });
  const all = playRandom(state, `${seed}:play`, events);
  return { state, events: all };
}

// ---------- defaults are the standard rules ----------
check('defaults are the standard rules (line 3, chosen fall, pad, standard hands, full deck, lost, colours, first)', same(
  VARIANTS.map((v) => DEFAULT_RULES[v.name]), ['3', 'chosen', 'pad', 'standard', 'full', 'lost', 'colours', 'first']));
check('V1..V8 are all present in order', same(VARIANTS.map((v) => v.id), ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8']));

// ---------- R1 components ----------
{
  const deck = fullDeck();
  check('R1.1 55 distinct cards, 5 colours x 1..11', deck.length === 55 && new Set(deck).size === 55
    && COLOURS.every((c) => [...Array(11).keys()].every((i) => deck.includes(`${c}-${i + 1}`))));
  check('R1.1 colours are Red, Gold, Green, Blue, Purple', same(COLOURS, ['red', 'gold', 'green', 'blue', 'purple']) && cardName('gold-11') === 'Gold 11');
  const g = position({ hands: [['red-2', 'gold-1'], ['red-11', 'gold-2'], ['red-1', 'gold-3'], ['red-10', 'gold-4']] });
  play(g, 'red-2', 'red-11', 'red-1', 'red-10');
  check('R1.2 numbers rank 1 low to 11 high', g.handLog[0].tricks[0].winner === 1);
  const h = createGame({ seed: 'sort', players: 4 }).hands[0];
  check('R1.3 hands are sorted by colour (R, Gold, Green, Blue, Purple) then number', same(h, sortCards(h)) && COLOURS.indexOf(cardColour(h[0])) <= COLOURS.indexOf(cardColour(h[h.length - 1])));
  const s = createGame({ seed: 1, players: 3 });
  check('R1.4 the engine keeps a per-hand record and a public discard pile', Array.isArray(s.handLog) && Array.isArray(s.discard));
  check('R1.5 3 to 5 players; 2 and 6 refused', [3, 4, 5].every((n) => createGame({ seed: 1, players: n }).n === n)
    && throws(() => createGame({ seed: 1, players: 2 })) && throws(() => createGame({ seed: 1, players: 6 })));
  check('R1.6 seat types are not engine state (any seat may be human or bot)', !('seats' in s) && !('bots' in s));
}

// ---------- R2 game structure ----------
for (const [n, tricks] of [[3, 10], [4, 10], [5, 8]]) {
  const { state } = randomGame(n, {}, `struct${n}`);
  check(`R2.1 one hand per player at ${n} players`, state.phase === 'over' && state.handLog.length === n);
  check(`R2.3 ${tricks} tricks per hand, ${tricks * n} per game at ${n} players`, state.handLog.every((h) => h.tricks.length === tricks) && state.measures.tricks === tricks * n);
}
check('R2.2 the shrinking deck is a variant, not the default', DEFAULT_RULES.FORMAT === 'pad');
{
  const d = new Set();
  for (let i = 0; i < 60; i++) d.add(createGame({ seed: `dealer${i}`, players: 4 }).firstDealer);
  check('R2.4 first dealer drawn from the seed (all seats occur; same seed same dealer)', d.size === 4
    && createGame({ seed: 'x', players: 5 }).firstDealer === createGame({ seed: 'x', players: 5 }).firstDealer);
  check('R2.4 firstDealer option is honoured', createGame({ seed: 'x', players: 5, firstDealer: 3 }).firstDealer === 3 && throws(() => createGame({ seed: 1, players: 4, firstDealer: 4 })));
  const { state } = randomGame(5, {}, 'rot', 2);
  check('R2.5 the deal passes left: dealer(h) = (firstDealer + h) mod n', state.handLog.every((h, i) => h.dealer === (2 + i) % 5));
  check('R2.5 the player left of the dealer leads the first trick', state.handLog.every((h) => h.firstLeader === (h.dealer + 1) % 5 && h.tricks[0].leader === h.firstLeader));
  const { state: py } = randomGame(4, {}, 'py', 3);
  check('R2.5 firstDealer = n-1 gives the Python leader = h mod n', py.handLog.every((h, i) => h.firstLeader === i % 4));
}

// ---------- R3 setup ----------
{
  const a = createGame({ seed: 'deal', players: 4 });
  const b = createGame({ seed: 'deal', players: 4 });
  const c = createGame({ seed: 'deal2', players: 4 });
  check('R3.1 seeded shuffle: same seed same deal, other seed other deal', same(a.hands, b.hands) && !same(a.hands, c.hands));
  for (const [n, hs, aside] of [[3, 11, 22], [4, 11, 11], [5, 9, 10]]) {
    const g = createGame({ seed: `hs${n}`, players: n });
    check(`R3.2 ${hs} cards each and ${aside} set aside at ${n} players`, g.hands.every((h) => h.length === hs) && g.setAside.length === aside && conservation(g).ok);
  }
  // R3.3: replay the RNG: the seat left of the dealer gets the first packet.
  const rng = makeRng('deal');
  const dealer = rngInt(rng, 4);
  const deck = shuffle(rng, fullDeck());
  let ok = true;
  for (let i = 0; i < 4; i++) if (!same(a.hands[(dealer + 1 + i) % 4], sortCards(deck.slice(i * 11, (i + 1) * 11)))) ok = false;
  check('R3.3 packets dealt from the left of the dealer, handSize cards each', ok && a.dealer === dealer);
  const { state, events } = randomGame(4, {}, 'aside');
  void events;
  check('R3.4 set-aside cards are in no view, ever (also after the game, R20.5)', [0, 1, 2, 3].every((s) => {
    const v = JSON.stringify(viewFor(state, s));
    return !('setAside' in viewFor(state, s)) && state.setAside.every((x) => !viewFor(state, s).hand.includes(x)) && v.length > 0;
  }));
  check('R3.5 lines and piles start empty', a.lines.every((l) => l.length === 0) && a.piles.every((p) => p.length === 0));
}

// ---------- R4 the first fall ----------
{
  const { state: g, events: start } = startGame({ seed: 'fall', players: 4, firstDealer: 1 });
  check('R4.4 first-fall choices start with the first leader (left of the dealer)', g.phase === 'fall' && g.toAct === 2 && g.leader === 2);
  check('R4.5 every card in hand is a legal first fall', same(getValidActions(g).map((a) => a.card), g.hands[2]) && getValidActions(g).every((a) => a.type === 'fall'));
  check('R4.1 / R20.1 no card may be played to a trick before the first fall', getActionBlockReason(g, { type: 'play', card: g.hands[2][0] }) !== null);
  const choice = g.hands[2][3];
  const ev1 = applyAction(g, { type: 'fall', card: choice });
  check('R4.3 a chosen fall is not placed on the line yet', g.lines.every((l) => l.length === 0) && g.pending[2] === choice);
  check('R4.2 / R19.11 others see only "hidden"; the chooser sees its own card', viewFor(g, 3).falls[2] === 'hidden' && viewFor(g, 2).falls[2] === choice && viewFor(g, 0).falls[0] === null);
  check('R4.2 the fall-chosen event does not reveal the card', ev1.length === 1 && ev1[0].type === 'fall-chosen' && !('card' in ev1[0]) && !JSON.stringify(ev1).includes(choice));
  check('R4.4 next choice is clockwise (seat 3, then 0, then 1)', g.toAct === 3);
  check('R4.5 a confirmed fall cannot be changed', getPlayBlockReason(g, 2, g.hands[2][0]) !== null);
  check('R20.4 a bot choosing later sees no earlier pending choice', !JSON.stringify(viewFor(g, 3)).includes(`"${choice}"`));
  play(g, g.hands[3][0]);
  check('R4.4 order 2, 3, 0, 1', g.toAct === 0);
  play(g, g.hands[0][0]);
  check('R4.4 order 2, 3, 0, 1 (last)', g.toAct === 1);
  const last = g.hands[1][5];
  const ev = applyAction(g, { type: 'fall', card: last });
  const rev = ev.find((e) => e.type === 'falls-revealed');
  check('R4.2 all falls revealed together in one event', rev && rev.falls.length === 4 && rev.falls[1] === last && rev.falls[2] === choice && rev.auto === false);
  check('R4.1 each fall is the first card of its line, so the first trump', g.lines.every((l, s) => l.length === 1 && l[0] === rev.falls[s]) && viewFor(g, 0).trumps[2] === cardColour(choice));
  check('R4.1 / R13.3 the fall leaves the hand: handSize - 1 cards to play', g.hands.every((h) => h.length === 10) && g.hands[2].indexOf(choice) < 0);
  check('R5.1 after the fall the first leader leads', g.phase === 'play' && g.toAct === 2);
  check('R4.x start events: game-started then hand-started', start[0].type === 'game-started' && start[1].type === 'hand-started' && start[1].leader === 2);
  check('R13.1 conservation through the first fall', conservation(g).ok);
}

// ---------- R5, R6, R7, R8: a hand-built hand of four tricks ----------
{
  const g = position({
    hands: [['red-5', 'red-8', 'purple-1', 'purple-4'], ['gold-7', 'green-1', 'purple-2', 'blue-11'], ['red-10', 'red-3', 'blue-4', 'gold-11'], ['green-2', 'gold-5', 'purple-3', 'blue-10']],
    lines: [[], ['gold-2'], ['blue-6', 'red-1'], ['green-9']],
    leader: 0,
  });
  check('R5.2 the leader may lead any card', getValidActions(g).length === 4);
  let ev = play(g, 'red-5');
  check('R6.2 a seat with no card of the led colour may play any card', getValidActions(g).length === 4 && g.toAct === 1);
  ev = ev.concat(play(g, 'gold-7'));
  check('R6.1 a seat holding the led colour must follow (red-10 or red-3 only)', same(getValidActions(g).map((a) => a.card), ['red-3', 'red-10']));
  check('R6.1 block reason names the colour to follow', /must follow Red/.test(getPlayBlockReason(g, 2, 'blue-4')));
  check('R6.0 play goes clockwise from the leader', g.toAct === 2 && g.trick.plays.map((p) => p.seat).join('') === '01');
  ev = ev.concat(play(g, 'red-10', 'green-2'));
  const t1 = g.tricks[0];
  check('R6.2 an off-colour card of your own trump colour is a trump', t1.plays[1].trump === true && t1.plays[3].trump === true && t1.plays[2].trump === false);
  check('R6.3 highest trump wins; two different trumps compare numbers (Gold 7 beats Green 2)', t1.winner === 1 && t1.byTrump && t1.winningCard === 'gold-7');
  check('R6.6 trumps are fixed at the start of the trick', same(t1.trumps, [null, 'gold', 'blue', 'green']));
  check('R7.1 every loser falls at the right-hand end', same(g.lines[0], ['red-5']) && same(g.lines[2], ['blue-6', 'red-1', 'red-10']) && same(g.lines[3], ['green-9', 'green-2']));
  check('R7.3 the winner banks the whole pre-trick line', same(g.piles[1], ['gold-2']) && same(t1.bank, ['gold-2']));
  check('R7.3 / R13.2 the winning card goes to the discard pile, not the line or pile', same(g.discard, ['gold-7']));
  check('R7.4 the winner has an empty line, hence no trump', g.lines[1].length === 0 && viewFor(g, 0).trumps[1] === null);
  check('R7.5 / R12.4 the winner leads the next trick', g.toAct === 1 && g.leader === 1);
  check('R12.3 bank size = the winner\'s line length before the trick', ev.find((e) => e.type === 'trick-won').bankSize === 1);
  check('R7.9 the trick-won event names the winning card and the trump', ev.some((e) => e.type === 'trick-won' && e.card === 'gold-7' && e.trumpColour === 'gold'));
  check('R8.1 the view shows every trump (leftmost card) and bank size', same(viewFor(g, 2).trumps, ['red', null, 'blue', 'green']) && same(viewFor(g, 2).bankSizes, [1, 0, 3, 2]));
  check('R8.3 a line emptied by winning (seat 0 had none) gets a new trump on the next fall', viewFor(g, 0).trumps[0] === 'red');

  // Trick 2: seat 1 leads green-1; seat 2 trumps blue-4; seat 3 sheds gold-5 (not its trump); seat 0 trumps red-8.
  ev = play(g, 'green-1', 'blue-4', 'gold-5', 'red-8');
  const t2 = g.tricks[1];
  check('R6.2 an off-colour card that is not your trump cannot win (gold-5, trump green)', t2.plays[2].trump === false);
  check('R6.3 the higher trump of two colours wins (Red 8 over Blue 4)', t2.winner === 0 && t2.byTrump && t2.trumpsPlayed === 2);
  check('R7.2 a 4th card knocks the leftmost off to the discard pile', same(g.lines[2], ['red-1', 'red-10', 'blue-4']) && t2.knocked.length === 1 && t2.knocked[0].card === 'blue-6');
  check('R8.2 knocking off changes the trump (blue -> red)', viewFor(g, 0).trumps[2] === 'red');
  check('R8.2 falling on a line of 2 does not change the trump', same(g.lines[3], ['green-9', 'green-2', 'gold-5']) && viewFor(g, 0).trumps[3] === 'green');
  check('R7.8 discard order: knocked-off cards, then the winning card', same(g.discard, ['gold-7', 'blue-6', 'red-8']));
  check('R13.1 conservation mid-hand', conservation(g).ok);

  // Trick 3: seat 0 leads purple-1; purple-2 and purple-3 are forced (auto); seat 2 trumps red-3.
  ev = play(g, 'purple-1', 'purple-2', 'red-3', 'purple-3');
  check('R20.2 single-option decisions are auto-applied and marked auto', ev.filter((e) => e.type === 'card-played' && e.trickNo === 3).map((e) => e.auto).join() === 'false,true,false,true');
  // Trick 4 is one card each, so the engine plays it (R20.2) and the hand ends.
  check('R20.2 the last trick of a hand plays itself', ev.filter((e) => e.type === 'card-played' && e.trickNo === 4).every((e) => e.auto) && ev.filter((e) => e.trickNo === 4 && e.type === 'card-played').length === 4);
  check('R9.1 the hand ended after the last trick', g.handLog.length === 1 && g.handNo === 1);
  const h = g.handLog[0];
  const t3 = h.tricks[2];
  const t4 = h.tricks[3];
  check('R6.2 trick 3: a void seat\'s trump colour beats the led colour (Red 3 over Purple)', t3.winner === 2 && t3.byTrump && same(t3.bank, ['red-1', 'red-10', 'blue-4']));
  check('R8.3 / R6.2 trick 4: the new leftmost card (Purple 1) makes Purple 4 a trump', t4.winner === 0 && t4.byTrump && same(t4.bank, ['purple-1']));
  check('R9.2 line cards at hand end are lost (recorded, not scored)', same(h.lost, [[], ['green-1', 'purple-2', 'blue-11'], ['gold-11'], ['gold-5', 'purple-3', 'blue-10']]));
  check('R9.3 hand score = cards banked this hand', same(h.scores, [2, 1, 3, 0]) && same(g.totals, [2, 1, 3, 0]));
  check('R9.4 the hand record keeps scores, banked cards, lost cards, knock-offs and trick winners',
    same(h.banked, [['red-5', 'purple-1'], ['gold-2'], ['red-1', 'red-10', 'blue-4'], []]) && same(h.knockOffs, [0, 0, 1, 2]) && same(h.tricks.map((t) => t.winner), [1, 0, 2, 0]));
  check('R9.5 all cards come back for the next hand (fresh deal, piles cleared)', g.phase === 'fall' && g.piles.every((p) => p.length === 0) && conservation(g).ok && g.hands.every((x) => x.length === 11));
  check('R2.5 hand 2 is dealt by the next seat to the left', g.dealer === 0 && g.leader === 1);
}

// R6.4 / R6.5: a led-colour card is never a trump; an empty line has no trump.
{
  const g = position({ hands: [['red-5', 'gold-1'], ['red-9', 'red-3'], ['red-7', 'green-1'], ['blue-1', 'blue-2']], lines: [['red-1'], ['red-2'], [], []], leader: 0 });
  const ev = play(g, 'red-5', 'red-9', 'red-7', 'blue-1');
  const t = g.handLog[0].tricks[0];
  check('R6.4 the leader\'s card is never a trump, even in its own trump colour', t.plays[0].trump === false);
  check('R6.4 following in the led colour is never trumping, even when it is your trump colour', t.plays[1].trump === false && t.winner === 1 && t.byTrump === false);
  check('R6.5 an empty line has no trump: an off-colour card cannot win', t.plays[3].trump === false);
  check('R20.2 the only red (red-7) was auto-played', ev.find((e) => e.card === 'red-7').auto === true && ev.find((e) => e.card === 'red-9').auto === false);
}

// R6.8 / RV8: equal trumps of different colours.
for (const [rule, winner] of [['first', 1], ['last', 2]]) {
  const g = position({ hands: [['blue-5', 'red-1'], ['gold-6', 'red-2'], ['green-6', 'red-3'], ['blue-9', 'red-4']], lines: [[], ['gold-1'], ['green-1'], []], leader: 0, rules: { TRUMP_TIES: rule } });
  play(g, 'blue-5', 'gold-6', 'green-6', 'blue-9');
  const t = g.handLog[0].tricks[0];
  check(`R6.8 / RV8 TRUMP_TIES ${rule}: equal trumps go to the card played ${rule}`, t.winner === winner && t.tie && t.byTrump && g.measures.trumpTies === 1);
}

// R7.6: rising with nothing.
{
  const g = position({ hands: [['red-11', 'gold-1', 'blue-1'], ['red-2', 'gold-2', 'blue-2'], ['red-3', 'gold-3', 'blue-3'], ['red-4', 'gold-4', 'blue-4']], leader: 0 });
  const ev = play(g, 'red-11');
  const tw = ev.find((e) => e.type === 'trick-won');
  check('R7.6 a winner with an empty line banks nothing, discards the winning card and leads', tw && tw.bankSize === 0 && g.piles[0].length === 0 && same(g.discard, ['red-11']) && g.toAct === 0 && g.lines[0].length === 0);
}

// R7.7, R6.7, R13.1, R10.2 over random games.
{
  let captured = 0; let noWinner = 0; let negative = 0; let consBad = 0;
  for (let i = 0; i < 30; i++) {
    const n = 3 + (i % 3);
    const { state: g, events } = startGame({ seed: `rnd${i}`, players: n });
    const rng = makeRng(`rnd${i}:p`);
    while (g.toAct !== null) {
      applyAction(g, rngPick(rng, getValidActions(g)));
      if (!conservation(g).ok) consBad++;
    }
    void events;
    for (const h of g.handLog) {
      for (const t of h.tricks) if (t.winner === null || t.winner === undefined) noWinner++;
      for (let s = 0; s < n; s++) {
        const own = new Set([h.falls[s], ...h.tricks.flatMap((t) => t.plays.filter((p) => p.seat === s).map((p) => p.card))]);
        if (h.banked[s].some((c) => !own.has(c))) captured++;
      }
    }
    if (g.totals.some((x) => x < 0)) negative++;
  }
  check('R7.7 every banked card is one its owner fell with (nothing captured)', captured === 0, `${captured}`);
  check('R6.7 every trick has a winner', noWinner === 0);
  check('R13.1 conservation after every action (30 games)', consBad === 0, `${consBad}`);
  check('R10.2 totals are never negative under the default rules', negative === 0);
}

// R10 / R11 scoring, on crafted end states.
function ended(n, totals, banked, rules = {}) {
  const g = createGame({ seed: 1, players: n, rules });
  g.totals = [...totals];
  g.handLog = [{ handNo: 0, scores: [...totals], banked: banked.map((b) => [...b]), lost: banked.map(() => ['purple-11']), tricks: [] }];
  return gameResult(g);
}
{
  const r1 = ended(4, [10, 9, 8, 7], [['red-1'], [], [], []]);
  check('R10.1 the highest total wins', same(r1.winners, [0]) && !r1.shared && !r1.tiebreakUsed && r1.margin === 1 && r1.winningScore === 10);
  const r2 = ended(4, [10, 10, 8, 7], [['red-1', 'gold-1', 'green-1'], ['red-2', 'red-3', 'gold-2'], [], []]);
  check('R11.1 tied on total: most different colours across the piles wins (3 against 2)', same(r2.winners, [0]) && r2.tiebreakUsed && !r2.shared && same(r2.colourCounts.slice(0, 2), [3, 2]));
  const r3 = ended(4, [10, 10, 10, 7], [['red-1', 'gold-1'], ['red-2', 'gold-2', 'green-2'], ['red-3', 'gold-3', 'blue-3'], []]);
  check('R11.2 still tied on colours: the win is shared', same(r3.winners, [1, 2]) && r3.shared && r3.tiebreakUsed);
  const r4 = ended(4, [10, 10, 9, 7], [['red-1'], ['gold-2'], ['red-3', 'gold-3', 'blue-3', 'green-3', 'purple-3'], []]);
  check('R11.3 the tiebreak only looks at players tied for most', same(r4.winners, [0, 1]) && r4.shared && !r4.tiebreakUsed);
  check('R11.4 only banked cards count (lost Purple 11 does not add a colour)', r4.colourCounts[0] === 1);
  const g = createGame({ seed: 1, players: 3 });
  g.totals = [5, 5, 1];
  g.handLog = [{ banked: [['red-1'], ['gold-1'], []], scores: [3, 1, 1], tricks: [] }, { banked: [['gold-4'], ['gold-5'], []], scores: [2, 4, 0], tricks: [] }];
  const r5 = gameResult(g);
  check('R11.1 colours count over ALL hands\' piles (red + gold vs gold only)', same(r5.winners, [0]) && r5.colourCounts[0] === 2 && r5.colourCounts[1] === 1);
  const r6 = ended(4, [10, 10, 8, 8], [['red-1', 'gold-1', 'green-1'], ['red-2', 'gold-2'], ['red-3', 'gold-3', 'blue-3', 'green-3'], ['red-4', 'gold-4', 'blue-4', 'green-4']]);
  check('R10.3 ranking by total, then colour count; equal on both share a rank', same(r6.ranking.map((x) => [x.seat, x.rank]), [[0, 1], [1, 2], [2, 3], [3, 3]]));
  const r7 = ended(4, [10, 10, 8, 8], [['red-1', 'gold-1', 'green-1'], ['red-2', 'gold-2'], [], []], { TIEBREAK: 'shared' });
  check('R11.6 / RV7.2 TIEBREAK shared: tied players share the win, no colour count', same(r7.winners, [0, 1]) && r7.shared && !r7.tiebreakUsed && same(r7.ranking.map((x) => x.rank), [1, 1, 3, 3]));
  const text = describeEvent({ type: 'game-over', ...r2 }, ['Ann', 'Bo', 'Cy', 'Di']);
  check('R11.5 the result explains the tiebreak ("most different colours (3 against 2)")', /most different colours \(3 against 2\)/.test(text), text);
  check('R11.5 the result explains a shared win', /^Shared win: Bo and Cy/.test(describeEvent({ type: 'game-over', ...r3 }, ['Ann', 'Bo', 'Cy', 'Di'])));
}

// ---------- R12 trick summary ----------
{
  const tw = trickWinner([{ seat: 2, card: 'blue-3' }, { seat: 3, card: 'blue-9' }, { seat: 0, card: 'red-2' }, { seat: 1, card: 'gold-1' }], ['red', 'gold', null, 'blue']);
  check('R12.2 trick key: trump (3, n) > led (2, n) > ineligible', tw.seat === 0 && tw.byTrump && tw.trumpsPlayed === 2);
  const tw2 = trickWinner([{ seat: 0, card: 'blue-3' }, { seat: 1, card: 'green-11' }], [null, null]);
  check('R12.2 no trump: the highest led colour wins; off-colour is not eligible', tw2.seat === 0 && !tw2.byTrump);
}

// ---------- R13 cards ----------
{
  const { state } = randomGame(4, {}, 'r13');
  check('R13.2 at game end hands are empty and lines went to the discard pile', state.hands.every((h) => h.length === 0) && state.lines.every((l) => l.length === 0) && conservation(state).ok);
  check('R13.4 / R19.5 the discard pile is public in every view', same(viewFor(state, 1).discard, state.discard));
}

// ---------- RV1 LINE_LIMIT ----------
{
  const g = position({ hands: [['red-11', 'gold-1'], ['red-2', 'gold-2'], ['red-3', 'gold-3'], ['red-4', 'gold-4']], lines: [[], ['green-1', 'green-2'], [], []], rules: { LINE_LIMIT: '2' } });
  play(g, 'red-11');
  check('RV1.1 LINE_LIMIT 2: a 3rd card knocks the leftmost off', g.handLog[0].tricks[0].knocked.some((k) => k.seat === 1 && k.card === 'green-1') && g.handLog[0].lost[1].length <= 2);
  check('RV1.2 scaled: 2 at 3 players, 3 at 4 and 5', [3, 4, 5].map((n) => createGame({ seed: 1, players: n, rules: { LINE_LIMIT: 'scaled' } }).params.lineLimit).join() === '2,3,3');
  check('RV1 / R7.2 default limit is 3; numbers are accepted for LINE_LIMIT', createGame({ seed: 1, players: 4 }).params.lineLimit === 3 && resolveVariants({ LINE_LIMIT: 2 }).LINE_LIMIT === '2');
  let maxLine = 0;
  for (let i = 0; i < 10; i++) {
    const { state: s } = startGame({ seed: `l2-${i}`, players: 4, rules: { LINE_LIMIT: '2' } });
    const rng = makeRng(i);
    while (s.toAct !== null) { applyAction(s, rngPick(rng, getValidActions(s))); maxLine = Math.max(maxLine, ...s.lines.map((l) => l.length)); }
  }
  check('R17.2 under LINE_LIMIT 2 no line ever exceeds 2 (bank size 0..2)', maxLine === 2);
}

// ---------- RV2 FIRST_FALL top ----------
{
  const { state: g, events } = startGame({ seed: 'top', players: 4, rules: { FIRST_FALL: 'top' } });
  const rng = makeRng('top');
  const dealer = rngInt(rng, 4);
  const deck = shuffle(rng, fullDeck());
  const firsts = [0, 1, 2, 3].map((s) => deck[((s - dealer - 1 + 8) % 4) * 11]);
  check('RV2.2 top: the first card dealt to each player falls, no decision', g.phase === 'play' && same(g.lines.map((l) => l[0]), firsts));
  check('RV2.2 top: the hand keeps handSize - 1 cards; tricks per hand unchanged', g.hands.every((h) => h.length === 10) && g.tricksPerHand === 10);
  check('RV2.2 top: the reveal is marked auto', events.some((e) => e.type === 'falls-revealed' && e.auto === true) && !events.some((e) => e.type === 'fall-chosen'));
  const rest = playRandom(g, 'topplay');
  check('RV2 top: every hand starts without a fall decision', g.phase === 'over' && !rest.some((e) => e.type === 'fall-chosen'));
}

// ---------- RV3 FORMAT shrinking ----------
for (const n of [3, 4, 5]) {
  let ok = true; let ends = true; let rot = true; let totalsOk = true; const detail = [];
  for (let i = 0; i < 15; i++) {
    const { state: g } = randomGame(n, { FORMAT: 'shrinking' }, `shr${n}-${i}`);
    let inPiles = 0;
    g.handLog.forEach((h, k) => {
      const expect = Math.min(11, Math.floor((55 - inPiles) / n));
      if (h.handSize !== expect) { ok = false; detail.push(`hand ${k} size ${h.handSize} expected ${expect}`); }
      if (h.dealer !== (g.firstDealer + k) % n || h.firstLeader !== (h.dealer + 1) % n) rot = false;
      inPiles += h.banked.reduce((a, b) => a + b.length, 0);
    });
    if (Math.floor((55 - inPiles) / n) >= 4) ends = false;
    if (!same(g.totals, g.piles.map((p) => p.length))) totalsOk = false;
    if (g.handLog[0].handSize !== 11) ok = false;
  }
  check(`RV3.3 shrinking at ${n}p: hand size = min(11, floor(cards left / n)), 11 in the first hand`, ok, detail.slice(0, 2).join('; '));
  check(`RV3.2 shrinking at ${n}p: the game ends when the cards cannot give everyone 4`, ends);
  check(`RV3.3 shrinking at ${n}p: the deal still passes left and the left of the dealer leads`, rot);
  check(`RV3.2 shrinking at ${n}p: score = score pile size (piles stay out all game)`, totalsOk);
}
{
  let ok = true;
  for (let i = 0; i < 10; i++) {
    const { state: g } = randomGame(4, { FORMAT: 'shrinking', LEFTOVER: 'minus1' }, `shm${i}`);
    if (!same(g.totals, g.piles.map((p, s) => p.length - g.penalties[s])) || !same(g.penalties, g.measures.leftover)) ok = false;
  }
  check('RV3.3 shrinking + minus1: penalties come off the running total, piles keep their cards', ok);
}

// ---------- RV4 HAND_SIZE ten ----------
for (const n of [3, 4, 5]) {
  const g = createGame({ seed: `ten${n}`, players: n, rules: { HAND_SIZE: 'ten' } });
  check(`RV4.2 ten: 10 cards each, 9 tricks, ${55 - 10 * n} set aside at ${n}p`, g.hands.every((h) => h.length === 10) && g.tricksPerHand === 9 && g.setAside.length === 55 - 10 * n);
}

// ---------- RV5 DECK_3P drop_purple ----------
{
  const g = createGame({ seed: 'dp', players: 3, rules: { DECK_3P: 'drop_purple' } });
  check('RV5.2 drop_purple at 3p: a 44-card deck without Purple, 33 dealt, 11 aside', g.params.deckSize === 44 && !JSON.stringify(g).includes('purple-') && g.setAside.length === 11 && conservation(g).ok);
  const g4 = createGame({ seed: 'dp', players: 4, rules: { DECK_3P: 'drop_purple' } });
  check('RV5.3 drop_purple has no effect at 4 and 5 players', g4.params.deckSize === 55 && g4.rulesCode === 'std');
  check('RV5.3 rules_code shows deck3 only at 3 players', g.rulesCode === 'deck3-drop_purple');
}

// ---------- RV6 LEFTOVER minus1 ----------
{
  let ok = true; let negativeSeen = false;
  for (let i = 0; i < 40; i++) {
    const { state: g } = randomGame(3 + (i % 3), { LEFTOVER: 'minus1' }, `m1-${i}`);
    for (const h of g.handLog) h.scores.forEach((x, s) => { if (x !== h.banked[s].length - h.lost[s].length) ok = false; if (x < 0) negativeSeen = true; });
  }
  check('RV6.2 minus1: hand score = cards banked - cards left on the line', ok);
  check('RV6.2 minus1: hand scores can be negative', negativeSeen);
}

// ---------- variants table, resolveVariants, rules_code ----------
{
  check('variants: resolveVariants() with no overrides is the defaults', same(resolveVariants(), DEFAULT_RULES));
  check('variants: unknown rule names throw', throws(() => resolveVariants({ LINE_LIMT: '2' }), /Unknown rule/));
  check('variants: values outside the allowed list throw', throws(() => resolveVariants({ LINE_LIMIT: '4' }), /must be one of/));
  const table = [{ name: 'X', code: 'x', values: ['a', 'b'], implemented: ['a'], default: 'a' }];
  check('variants: declared but unimplemented values throw', throws(() => resolveVariants({ X: 'b' }, table), /not implemented/));
  check('variants: rules_code std for the defaults', rulesCode(resolveVariants(), 4) === 'std');
  check('variants: rules_code joins non-defaults in V1..V8 order', rulesCode(resolveVariants({ LEFTOVER: 'minus1', LINE_LIMIT: '2' }), 4) === 'line-2+leftover-minus1');
  check('variants: every variant value is in the table with a label', VARIANTS.every((v) => v.values.every((x) => v.implemented.includes(x) && v.valueLabels[x])));
  const all = { LINE_LIMIT: 'scaled', FIRST_FALL: 'top', FORMAT: 'shrinking', HAND_SIZE: 'ten', DECK_3P: 'drop_purple', LEFTOVER: 'minus1', TIEBREAK: 'shared', TRUMP_TIES: 'last' };
  let combos = true;
  for (const n of [3, 4, 5]) { const { state } = randomGame(n, all, `combo${n}`); if (state.phase !== 'over' || !conservation(state).ok) combos = false; }
  check('R17.1 every value combined still plays to the end', combos);
}

// ---------- R19 / R20 views and legal actions ----------
{
  const { state: g } = startGame({ seed: 'view', players: 5 });
  const rng = makeRng('view');
  for (let k = 0; k < 23; k++) applyAction(g, rngPick(rng, getValidActions(g)));
  const v = viewFor(g, 1);
  check('R19.1 the view has the own hand only', same(v.hand, g.hands[1]) && !('hands' in v) && same(v.handCounts, g.hands.map((h) => h.length)));
  check('R19.2 every fall line, trump and bank size is visible', same(v.lines, g.lines) && v.trumps.length === 5);
  check('R19.3 set-aside cards: count only', v.setAsideCount === g.setAside.length && g.setAside.every((c) => !v.hand.includes(c)));
  check('R19.4 score piles: counts for all, cards only for your own', same(v.pileCounts, g.piles.map((p) => p.length)) && same(v.myPile, g.piles[1]) && !('piles' in v));
  check('R19.6 the current trick is visible with who played what', same(v.trick, g.trick));
  check('R19.7 / R19.9 scores, toAct, leader, dealer, hand and trick numbers', same(v.totals, g.totals) && v.toAct === g.toAct && v.dealer === g.dealer && v.handNo === g.handNo && v.trickNo === g.trickNo);
  check('R19.10 the trick history of the hand is in the view', same(v.tricks, g.tricks));
  const others = g.hands.filter((_, s) => s !== 1).flat();
  check('R18 no other hand\'s card appears anywhere in the view', others.every((c) => !JSON.stringify(v.hand).includes(c)) && !JSON.stringify({ ...v, tricks: null, handLog: null, discard: null, lines: null, trick: null }).match(new RegExp(others.map((c) => `"${c}"`).join('|'))));
  check('R18 previous hands: other seats\' banked cards are not listed', v.handLog.every((h) => h.banked.every((b, s) => (s === 1 ? Array.isArray(b) : b === null))));
}
{
  // R20.1 complete and sound; R20.3 the view gives the same legal actions.
  let bad = 0; let viewBad = 0; let checked = 0;
  for (let i = 0; i < 12; i++) {
    const n = 3 + (i % 3);
    const g = createGame({ seed: `legal${i}`, players: n, rules: i % 4 === 3 ? { FIRST_FALL: 'top' } : {} });
    const rng = makeRng(`legal${i}`);
    while (g.toAct !== null) {
      const valid = getValidActions(g);
      const view = viewFor(g, g.toAct);
      if (!same(legalActionsFromView(view), valid)) viewBad++;
      const type = g.phase === 'fall' ? 'fall' : 'play';
      for (const card of [...g.hands[g.toAct], g.setAside[0], g.hands[(g.toAct + 1) % n][0]].filter(Boolean)) {
        const legal = valid.some((a) => a.card === card);
        const ok = !throws(() => applyAction(roundTrip(g), { type, card }));
        if (legal !== ok) bad++;
        checked++;
      }
      applyAction(g, rngPick(rng, valid));
    }
  }
  check('R20.1 getValidActions is complete and sound (every listed action applies; nothing else does)', bad === 0, `${bad} of ${checked}`);
  check('R20.3 legalActionsFromView(view) equals getValidActions(state)', viewBad === 0);
}
{
  // determinise: a full state consistent with a view (for search bots).
  let bad = 0; const problems = [];
  for (let i = 0; i < 20; i++) {
    const n = 3 + (i % 3);
    const rules = i % 5 === 4 ? { FORMAT: 'shrinking' } : {};
    const g = createGame({ seed: `det${i}`, players: n, rules });
    const rng = makeRng(`det${i}`);
    const stopAt = 2 + rngInt(rng, 60);
    for (let k = 0; k < stopAt && g.toAct !== null; k++) applyAction(g, rngPick(rng, getValidActions(g)));
    if (g.toAct === null) continue;
    const view = viewFor(g, g.toAct);
    const d = determinise(view, makeRng(i));
    const dv = viewFor(d, g.toAct);
    const pub = (x) => JSON.stringify([x.hand, x.handCounts, x.lines, x.trick, x.tricks, x.discard, x.pileCounts, x.totals, x.toAct, x.falls, x.phase]);
    const voids = shownVoids(view);
    const voidOk = d.hands.every((h, s) => s === g.toAct || h.every((c) => !voids[s].includes(cardColour(c))));
    const unknownOk = unknownCards(view).length === g.setAside.length + g.hands.reduce((a, h, s) => a + (s === g.toAct ? 0 : h.length), 0) + (g.pending ? g.pending.filter((c, s) => c !== null && s !== g.toAct).length : 0);
    const c = conservation(d);
    if (!c.ok || pub(dv) !== pub(view) || !voidOk || !unknownOk) { bad++; problems.push(`#${i}: ${c.problem} pub=${pub(dv) === pub(view)} voids=${voidOk} unknown=${unknownOk}`); continue; }
    playRandom(d, `det${i}:rest`);
    if (d.phase !== 'over' || !conservation(d).ok) { bad++; problems.push(`#${i}: did not play out`); }
  }
  check('R20.3 determinise(view) gives a full state that matches the view, honours shown voids and plays out', bad === 0, problems.slice(0, 3).join(' | '));
}

// ---------- R22 constants ----------
check('R22 constants: 3-5 players, hand sizes 11/11/9, line 3, shrinking min 4 and cap 11', CONSTANTS.MIN_PLAYERS === 3 && CONSTANTS.MAX_PLAYERS === 5
  && same(CONSTANTS.HAND_SIZE_BY_COUNT, { 3: 11, 4: 11, 5: 9 }) && DEFAULT_RULES.LINE_LIMIT === '3' && CONSTANTS.MIN_HAND_SHRINKING === 4 && CONSTANTS.SHRINKING_HAND_CAP === 11);

done();
