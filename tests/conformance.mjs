// conformance.mjs - replays games recorded from the Python simulator's engine and requires the
// same legal-option counts, trick winners, trump wins, bank sizes, banked cards, lines left at
// hand end, knock-offs, hand scores, totals and top-scoring seats.
// Fixtures: tests/fixtures/python-conformance.json (pad format, the standard rules plus the
// variant settings the Python supports; the generator script is not part of this repo).
// The Python has no dealer: its leader of hand h is seat h mod n, i.e. firstDealer = n - 1.
// Semantics: PERMANENTLY GREEN. Exit 1 on any mismatch.

import { readFileSync } from 'node:fs';
import { createGame, applyAction, getValidActions } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('conformance');
const data = JSON.parse(readFileSync(new URL('./fixtures/python-conformance.json', import.meta.url), 'utf8'));
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const COLOUR = { R: 'red', Y: 'gold', G: 'green', B: 'blue', P: 'purple' };
const card = (code) => `${COLOUR[code[0]]}-${code.slice(1)}`;
const cards = (text) => (text ? text.split(' ').map(card) : []);
const ids = (list) => list.join(' ');

let games = 0;
let deals = 0;
let decisions = 0;
let autos = 0;
let mismatches = 0;
let trumpTies = 0;
for (const set of data.sets) {
  let setBad = 0;
  set.games.forEach((fx, i) => {
    const label = `${set.name} #${i} (${fx.n}p)`;
    const problems = [];
    const say = (p) => { if (problems.length < 4) problems.push(p); };
    try {
      const n = fx.n;
      const g = createGame({ seed: 0, players: n, rules: set.rules, firstDealer: n - 1, deals: fx.hands.map((h) => ({ hands: h.deal.map(cards) })) });
      fx.hands.forEach((h, hi) => {
        if (g.handNo !== hi || g.phase !== 'fall') { say(`hand ${hi}: not at its first fall (hand ${g.handNo}, ${g.phase})`); return; }
        const falls = cards(h.falls);
        while (g.phase === 'fall') applyAction(g, { type: 'fall', card: falls[g.toAct] });
        const plays = cards(h.plays);
        let k = 0;
        while (k < plays.length) {
          if (g.handNo !== hi || g.phase !== 'play') { say(`hand ${hi}: ended early at play ${k}`); break; }
          const nLegal = getValidActions(g).length;
          if (B36[nLegal] !== h.legal[k]) say(`hand ${hi} play ${k + 1}: ${nLegal} legal, python ${B36.indexOf(h.legal[k])}`);
          const events = applyAction(g, { type: 'play', card: plays[k] });
          decisions++;
          k++;
          for (const ev of events) {
            if (ev.type !== 'card-played' || !ev.auto || ev.handNo !== hi) continue;
            if (ev.card !== plays[k]) say(`hand ${hi} play ${k + 1}: engine auto-played ${ev.card}, python ${plays[k]}`);
            if (h.legal[k] !== '1') say(`hand ${hi} play ${k + 1}: auto-played but python had ${h.legal[k]} options`);
            autos++;
            k++;
          }
        }
        const rec = g.handLog[hi];
        if (!rec) { say(`hand ${hi}: no hand record`); return; }
        const winners = rec.tricks.map((t) => t.winner).join('');
        const trumpWins = rec.tricks.map((t) => (t.byTrump ? '1' : '0')).join('');
        const banks = rec.tricks.map((t) => t.bank.length).join('');
        trumpTies += rec.tricks.filter((t) => t.tie).length;
        if (winners !== h.winners) say(`hand ${hi}: trick winners ${winners} vs python ${h.winners}`);
        if (trumpWins !== h.trumpWins) say(`hand ${hi}: trump wins ${trumpWins} vs python ${h.trumpWins}`);
        if (banks !== h.banks) say(`hand ${hi}: bank sizes ${banks} vs python ${h.banks}`);
        for (let s = 0; s < n; s++) {
          if (ids(rec.banked[s]) !== ids(cards(h.banked[s]))) say(`hand ${hi} seat ${s}: banked ${ids(rec.banked[s])} vs python ${h.banked[s]}`);
          if (ids(rec.lost[s]) !== ids(cards(h.lines[s]))) say(`hand ${hi} seat ${s}: line at hand end ${ids(rec.lost[s])} vs python ${h.lines[s]}`);
        }
        if (rec.knockOffs.join() !== h.knocks.join()) say(`hand ${hi}: knock-offs ${rec.knockOffs} vs python ${h.knocks}`);
        if (rec.scores.join() !== h.scores.join()) say(`hand ${hi}: scores ${rec.scores} vs python ${h.scores}`);
        deals++;
      });
      if (g.phase !== 'over') say('game not over after the recorded hands');
      else {
        if (g.result.totals.join() !== fx.totals.join()) say(`totals ${g.result.totals} vs python ${fx.totals}`);
        if (g.result.tiedOnTotal.join() !== fx.winners.join()) say(`top seats ${g.result.tiedOnTotal} vs python ${fx.winners}`);
      }
    } catch (e) {
      say(`threw: ${e.message}`);
    }
    games++;
    if (problems.length) { mismatches++; setBad++; }
    check(label, problems.length === 0, problems.join('; '));
  });
  console.log(`  ${set.name}: ${set.games.length} games, ${setBad} mismatches`);
}
check('fixtures present (>= 100 games, >= 300 deals)', games >= 100 && deals >= 300, `${games} games, ${deals} deals`);
console.log(`  ${decisions} decisions replayed, ${autos} forced plays matched, ${trumpTies} equal-trump ties decided`);
console.log(`conformance: ${games} games (${deals} deals) replayed, ${mismatches} mismatches`);
done();
