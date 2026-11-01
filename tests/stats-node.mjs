// stats-node.mjs - local stats store, CSV/JSON export, the stats summary, the analytics parameter
// whitelist and the bug-report snapshot, all in Node (fake localStorage, stubbed window.gtag).
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/stats-node.mjs

import { suite } from './lib.mjs';
import { createController } from '../src/ui/controller.js';
import { botLevels } from '../src/bots/index.js';
import { VARIANTS } from '../src/engine/index.js';
import {
  createStatsStore, createRecorder, toCsv, toJson, csvCell, CSV_COLUMNS, summarise, exportFilename, gameToRow,
  STORE_KEY, MAX_GAMES, migrate,
} from '../src/ui/stats-store.js';
import { statsHtml } from '../src/ui/stats-view.js';
import * as analytics from '../src/ui/analytics.js';
import { buildReport, logAction, logEvent, _resetLogs, archiveReport, loadArchive, ARCHIVE_MAX, BUG_REPORT_EMAIL } from '../src/ui/bug-report.js';

const { check, done } = suite('stats-node');

// ---------- helpers ----------
function fakeStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const throwing = () => { throw new Error('blocked'); };

/** Minimal RFC 4180 parser for the round trip. */
function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const offered = new Set(botLevels().filter((l) => l.offered !== false).map((l) => l.id));
const lvl = (l) => (offered.has(l) ? l : 'easy');

/** Plays the game out: bots by runBots(), humans take the first legal action. Stops early after `stopAfterTricks`. */
function drive(ctl, stopAfterTricks = Infinity) {
  for (let guard = 0; guard < 5000 && !ctl.isFinished(); guard++) {
    if (ctl.state.measures.tricks >= stopAfterTricks) return;
    if (ctl.isBotTurn()) ctl.stepBot();
    else ctl.play(ctl.legalActions()[0]);
  }
}

/**
 * A mirror of main.js (sessionInfo + fireEventHooks): same hooks, same info shape, driven from the
 * controller. seats: [{ type, name }]. Returns the controller.
 */
function runSession({ seats, rules = {}, seed, stopAfterTricks }, hooks) {
  const ctl = createController({ seats, rules, seed });
  const startedAt = Date.now();
  const info = () => ({
    seed: ctl.seed, players: ctl.seats.length, seats: ctl.seats.map((s) => ({ type: s.type, name: s.name })), names: [...ctl.names],
    humanSeats: [...ctl.humanSeats], rules: { ...ctl.state.rules }, rulesCode: ctl.state.rulesCode, handNo: ctl.state.handNo, startedAt, state: ctl.state,
  });
  let ended = false;
  ctl.subscribe(() => {
    const i = info();
    for (const ev of ctl.lastEvents) {
      if (ev.type === 'trick-won') hooks.onTrickEnd({ ...i, event: ev });
      else if (ev.type === 'hand-ended') hooks.onHandEnd({ ...i, event: ev, record: ctl.state.handLog[ev.handNo] });
      else if (ev.type === 'game-over' && !ended) { ended = true; hooks.onGameEnd({ ...i, result: ev, durationMs: Date.now() - startedAt }); }
    }
  });
  hooks.onGameStart(info());
  drive(ctl, stopAfterTricks);
  ctl.abandon = () => hooks.onGameAbandoned(info());
  return ctl;
}

const NONE = { onGameStart() {}, onTrickEnd() {}, onHandEnd() {}, onGameEnd() {}, onGameAbandoned() {} };

// ---------- store: append, cap, blocked storage ----------
{
  const st = fakeStorage();
  const store = createStatsStore(() => st);
  const rec = createRecorder(store);
  const hooks = { ...NONE, onGameStart: (i) => rec.gameStart(i), onGameEnd: (i) => rec.gameEnd(i) };
  runSession({ seats: [{ type: 'human', name: 'Zed' }, { type: lvl('medium') }, { type: 'easy' }, { type: 'easy' }], seed: 5 }, hooks);
  runSession({ seats: [{ type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 6, rules: { LINE_LIMIT: '2', LEFTOVER: 'minus1' } }, hooks);
  runSession({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 7, rules: { TIEBREAK: 'shared' } }, hooks);
  let data = store.load();
  check('store: three games appended', data.games.length === 3, String(data.games.length));
  const [a, b, c] = data.games;
  check('store: record header', a.v === 1 && a.players === 4 && a.seed === '5' && !Number.isNaN(Date.parse(a.date)) && typeof a.id === 'string');
  check('store: standard game is rules_code std with the full rules object', a.rules_code === 'std' && Object.keys(a.rules).length === VARIANTS.length && a.rules.LINE_LIMIT === '3');
  check('store: variant game has its code and rules', b.rules_code === 'line-2+leftover-minus1' && b.rules.LINE_LIMIT === '2' && b.rules.LEFTOVER === 'minus1');
  check('store: shared tiebreak code', c.rules_code === 'tie-shared' && c.players === 5);
  check('store: seats hold type, level, seat index; name only for a typed human name', a.seats.length === 4 && a.seats[0].type === 'human' && a.seats[0].level === null && a.seats[0].name === 'Zed' && a.seats[1].type === 'bot' && a.seats[1].level === lvl('medium') && a.seats[1].name === undefined && a.seats.every((s, i) => s.seat === i) && c.seats[0].name === undefined);
  check('store: one score row per hand, one score per seat', a.hand_scores.length === a.hands && a.hands === 4 && a.hand_scores.every((h) => h.length === 4) && c.hands === 5);
  check('store: totals equal the summed hand scores (minus1 aside)', a.totals.every((t, s) => t === a.hand_scores.reduce((x, h) => x + h[s], 0)));
  check('store: ranking, winners and winning score agree', a.ranking.length === 4 && a.winners.every((s) => a.totals[s] === a.winning_score) && a.winning_score === Math.max(...a.totals) && a.ranking.filter((r) => r.rank === 1).length === a.winners.length);
  check('store: tricks, trump tricks, rise sizes and lost cards', a.tricks === 40 && a.trump_tricks >= 0 && a.trump_tricks <= a.tricks && a.rise_sizes.length === 4 && a.rise_sizes.reduce((x, y) => x + y, 0) === a.tricks && a.lost_cards.length === 4 && a.knock_offs.length === 4);
  check('store: margin and tie flags are consistent', a.margin >= 0 && (!a.tied_on_total || a.margin === 0) && (!a.tiebreak_used || a.tied_on_total));
  check('store: duration and seed recorded', Number.isInteger(a.seconds) && a.seconds >= 0);
  check('store: stored under the versioned key', st.m.has(STORE_KEY) && JSON.parse(st.m.get(STORE_KEY)).v === 1);

  // cap
  const big = fakeStorage();
  const capStore = createStatsStore(() => big);
  for (let i = 0; i < MAX_GAMES + 25; i++) capStore.addGame({ ...a, seconds: i });
  const loaded = capStore.load();
  check('store: capped at MAX_GAMES, oldest dropped', loaded.games.length === MAX_GAMES && loaded.games[0].seconds === 25 && loaded.games[MAX_GAMES - 1].seconds === MAX_GAMES + 24);

  // summary
  const sum = summarise(data.games);
  check('summary: totals add up', sum.total === 3 && sum.allTotal === 3);
  check('summary: seat kinds add up to every seat played', Object.values(sum.byKind).reduce((x, k) => x + k.seats, 0) === 4 + 3 + 5);
  check('summary: seat position counts add up', sum.bySeat.reduce((x, p) => x + p.seats, 0) === 12 && sum.bySeat[0].seats === 3 && sum.bySeat[4].seats === 1);
  check('summary: wins by kind equal winners over games', Object.values(sum.byKind).reduce((x, k) => x + k.wins, 0) === data.games.reduce((x, g) => x + g.winners.length, 0));
  check('summary: split by player count', Object.keys(sum.byPlayers).join() === '3,4,5' && sum.byPlayers[4].games === 1 && sum.byPlayers[4].hands === 16);
  check('summary: average score per hand matches the records', Math.abs(sum.avgScorePerHand - data.games.flatMap((g) => g.hand_scores.flat()).reduce((x, y) => x + y, 0) / data.games.flatMap((g) => g.hand_scores.flat()).length) < 1e-9);
  check('summary: by-rules table has a row per code with counts', sum.byRules.length === 3 && sum.byRules[0].code === 'std' && sum.byRules.reduce((x, r) => x + r.games, 0) === 3);
  const only = summarise(data.games, 'line-2+leftover-minus1');
  check('summary: filter by rules_code keeps only those games, by-rules stays whole', only.total === 1 && only.allTotal === 3 && only.byRules.length === 3 && only.byPlayers[3].games === 1);
  check('summary: human v bot-level rows', sum.humanVs[lvl('medium')].games >= 1 && sum.humanVs.easy.games >= 1);
  const html = statsHtml(data);
  check('view: stats html names every rules code and the section headings', ['std', 'line-2+leftover-minus1', 'tie-shared', 'Win rate by seat type', 'Win rate by seat position', 'Scores by player count', 'Ties and the tiebreak'].every((t) => html.includes(t)));
  check('view: filter select offered with 2+ codes; filtered view says so', html.includes('data-action="stats-filter"') && statsHtml(data, 'tie-shared').includes('under tie-shared'));
  check('view: empty state and corrupt records', /No games recorded yet/.test(statsHtml({ games: [] })) && /No games recorded yet/.test(statsHtml({ games: [null, 3, {}] })));
  check('view: a typed name never appears in the stats screen', !html.includes('Zed'));

  // exports
  const csv = toCsv(data.games);
  const rows = parseCsv(csv);
  const col = (name) => CSV_COLUMNS.indexOf(name);
  check('csv: header then one row per game', rows.length === 4 && rows[0].join(',') === CSV_COLUMNS.join(','));
  check('csv: every row has the header width', rows.every((r) => r.length === CSV_COLUMNS.length));
  check('csv: has a rule column per variant and rules_code', VARIANTS.every((v) => col(`rule_${v.name.toLowerCase()}`) > 0) && rows[2][col('rules_code')] === 'line-2+leftover-minus1' && rows[2][col('rule_line_limit')] === '2' && rows[2][col('rule_leftover')] === 'minus1');
  check('csv: values round-trip', rows[1][col('players')] === '4' && rows[1][col('seed')] === '5' && rows[1][col('seat1_type')] === 'human' && rows[1][col('seat1_name')] === 'Zed' && rows[1][col('seat2_type')] === lvl('medium') && rows[1][col('seat5_type')] === '' && Number(rows[1][col('winning_score')]) === a.winning_score && Number(rows[1][col('tricks')]) === 40);
  check('csv: totals and hand scores', rows[1][col('totals')] === a.totals.join(' ') && rows[1][col('hand_scores')].split('|').length === 4 && rows[3][col('hand_scores')].split('|').length === 5);
  check('csv: winners are 1-based seats', rows[1][col('winner_seats')] === a.winners.map((s) => s + 1).join(' '));
  check('csv: LF only (no CR)', !csv.includes('\r'));
  check('csv: quoting', csvCell('a,b') === '"a,b"' && csvCell('say "hi"') === '"say ""hi"""' && csvCell('x\ny') === '"x\ny"' && csvCell(null) === '' && csvCell(3) === '3');
  check('csv: awkward value survives parse', parseCsv(toCsv([{ ...a, seats: [{ seat: 0, type: 'human', level: null, name: 'a,"b"\nc' }, ...a.seats.slice(1)] }]))[1][col('seat1_name')] === 'a,"b"\nc');
  check('csv: gameToRow width matches', gameToRow(a).length === CSV_COLUMNS.length);
  const json = JSON.parse(toJson(data));
  check('json: valid, has every record and the schema', json.schema === 1 && json.game === 'daruma-drama' && json.games.length === 3 && JSON.stringify(json.games) === JSON.stringify(data.games));
  check('filename: daruma-drama-stats-YYYY-MM-DD', exportFilename('csv', new Date(2026, 10, 1)) === 'daruma-drama-stats-2026-11-01.csv');

  // clear
  store.clear();
  check('store: clear empties', store.load().games.length === 0 && !st.m.has(STORE_KEY));
}

// ---------- store: blocked / throwing storage ----------
{
  const bad = createStatsStore(throwing);
  let ok = true;
  try {
    ok = bad.addGame({ x: 1 }) === false && bad.load().games.length === 0 && bad.clear() === false;
  } catch { ok = false; }
  check('blocked storage: nothing throws, store forgets', ok);
  const nul = createStatsStore(() => null);
  check('null storage tolerated', nul.addGame({}) === false && nul.load().games.length === 0);
  const half = fakeStorage();
  half.setItem = () => { throw new Error('QuotaExceededError'); };
  check('quota error tolerated', createStatsStore(() => half).addGame({}) === false);
  const corrupt = fakeStorage();
  corrupt.setItem(STORE_KEY, '{not json');
  check('corrupt data reads as empty and can be overwritten', createStatsStore(() => corrupt).load().games.length === 0 && createStatsStore(() => corrupt).addGame({ a: 1 }) === true);
  const wrongVer = fakeStorage();
  wrongVer.setItem(STORE_KEY, JSON.stringify({ v: 99, games: [{}] }));
  check('unknown schema version ignored', createStatsStore(() => wrongVer).load().games.length === 0);

  // a whole session with throwing storage still plays to the end
  const rec = createRecorder(bad);
  const ctl = runSession({ seats: [{ type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 3 }, { ...NONE, onGameStart: (i) => rec.gameStart(i), onGameEnd: (i) => rec.gameEnd(i) });
  check('blocked storage: game still finishes', ctl.isFinished());
}

// ---------- analytics ----------
{
  const calls = [];
  globalThis.window = { gtag: (...a) => calls.push(a), addEventListener() {} };
  analytics._reset();
  const hooks = {
    onGameStart: (i) => analytics.trackGameStart(i), onTrickEnd: (i) => analytics.trackTrickEnd(i), onHandEnd: (i) => analytics.trackHandEnd(i),
    onGameEnd: (i) => analytics.trackGameEnd(i), onGameAbandoned: () => analytics.trackGameAbandoned(),
  };
  const g1 = runSession({ seats: [{ type: 'human', name: 'Secret Name' }, { type: lvl('medium') }, { type: 'easy' }, { type: 'easy' }], seed: 11 }, hooks);
  const g2 = runSession({ seats: [{ type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 12, rules: { LINE_LIMIT: '2' } }, hooks);
  analytics.trackStatsViewed(); analytics.trackStatsExported(); analytics.trackRulesOpened();
  analytics.trackVariantChanged({ name: 'LINE_LIMIT', value: '2', players: 4, rulesCode: 'line-2' });
  const names = calls.map((c) => c[1]);
  check('analytics: every call is an event with an object', calls.every((c) => c[0] === 'event' && c[2] && typeof c[2] === 'object'));
  for (const n of ['game_start', 'hand_end', 'game_end', 'stats_viewed', 'stats_exported', 'rules_opened', 'variant_changed']) check(`analytics: ${n} fired`, names.includes(n));
  check('analytics: every event name is known', names.every((n) => analytics.EVENT_NAMES.includes(n)));
  const allKeys = new Set(calls.flatMap((c) => Object.keys(c[2])));
  check('analytics: params are a subset of the whitelist', [...allKeys].every((k) => analytics.ALLOWED_PARAMS.includes(k)), [...allKeys].join(','));
  check('analytics: whitelist is the 16 agreed params', analytics.ALLOWED_PARAMS.length === 16);
  check('analytics: values are numbers or short tokens only', calls.every((c) => Object.values(c[2]).every((v) => typeof v === 'number' || /^[A-Za-z0-9_,.+-]{1,60}$/.test(v))));
  check('analytics: typed name never sent', !JSON.stringify(calls).includes('Secret'));

  const gs = calls.filter((c) => c[1] === 'game_start').map((c) => c[2]);
  check('analytics: game_start params', gs[0].game_name === 'daruma-drama' && gs[0].player_count === 4 && gs[0].human_players === 1 && gs[0].bot_players === 3 && gs[0].bot_levels === [lvl('medium'), 'easy', 'easy'].sort().join(',') && gs[0].rules_code === 'std', JSON.stringify(gs[0]));
  check('analytics: game_start carries rules_code and "none" bots reads right', gs[1].rules_code === 'line-2' && gs[1].human_players === 0 && gs[1].bot_levels === 'easy,easy,easy');
  const he = calls.filter((c) => c[1] === 'hand_end').map((c) => c[2]);
  check('analytics: one hand_end per hand, numbered from 1', he.filter((h) => h.player_count === 4).map((h) => h.hand_number).join() === '1,2,3,4' && he.filter((h) => h.player_count === 3).length === 3);
  check('analytics: hand_end carries tricks in the hand and a duration', he.every((h) => h.tricks >= 7 && Number.isInteger(h.duration_seconds)));
  const ge = calls.filter((c) => c[1] === 'game_end').map((c) => c[2]);
  check('analytics: game_end fires once per game', ge.length === 2);
  const s1 = g1.state; const r1 = s1.result;
  const wk = r1.shared ? 'shared' : (r1.winners[0] === 0 ? 'human' : ge[0].winner_seat_type);
  check('analytics: game_end result summary matches the game', ge[0].winning_score === r1.winningScore && ge[0].winning_margin === r1.margin && ge[0].tiebreak_used === (r1.tiebreakUsed ? 'yes' : 'no') && ge[0].winner_seat_type === wk && ge[0].tricks === 40 && ge[0].hands === 4 && Number.isInteger(ge[0].duration_seconds), JSON.stringify(ge[0]));
  check('analytics: human_rank is the best human rank; absent with no humans', ge[0].human_rank === r1.ranking.find((r) => r.seat === 0).rank && ge[1].human_rank === undefined);
  check('analytics: trump_trick_pct is a 0-100 integer from the measures', ge[0].trump_trick_pct === Math.round((100 * s1.measures.trumpTricks) / s1.measures.tricks) && ge[0].trump_trick_pct >= 0 && ge[0].trump_trick_pct <= 100);
  check('analytics: winner_seat_type is a seat kind or shared', ge.every((g) => ['human', 'easy', 'medium', 'hard', 'shared'].includes(g.winner_seat_type)), ge.map((g) => g.winner_seat_type).join());
  check('analytics: other events carry no result params', calls.filter((c) => c[1] !== 'game_end').every((c) => Object.keys(c[2]).every((k) => !['winner_seat_type', 'winning_score', 'winning_margin', 'tiebreak_used', 'human_rank', 'trump_trick_pct'].includes(k))));
  const ve = calls.find((c) => c[1] === 'variant_changed')[2];
  check('analytics: variant_changed sends only game, player count and the code', JSON.stringify(Object.keys(ve).sort()) === JSON.stringify(['game_name', 'player_count', 'rules_code']) && ve.rules_code === 'line-2');
  check('analytics: stats events carry only the game name', ['stats_viewed', 'stats_exported', 'rules_opened'].every((n) => JSON.stringify(calls.find((c) => c[1] === n)[2]) === '{"game_name":"daruma-drama"}'));

  // the whitelist is enforced in code: unknown keys and non-token values are dropped
  calls.length = 0;
  analytics.trackGameStart({ players: 4, seats: [{ type: 'human', name: 'Bob Smith' }, { type: 'easy' }], rulesCode: 'std', seed: 99, winnerName: 'Bob', email: 'a@b.c' });
  check('analytics: extra info keys never reach gtag', calls.every((c) => Object.keys(c[2]).every((k) => analytics.ALLOWED_PARAMS.includes(k))) && !JSON.stringify(calls).includes('Bob'));
  const dirty = analytics.clean({ game_name: 'daruma-drama', rules_code: 'a sentence with spaces', bot_levels: { x: 1 }, tricks: NaN, hands: 3, name: 'Bob', player_count: '4' });
  check('analytics: clean() drops free text, objects, NaN and unknown keys', JSON.stringify(dirty) === '{"game_name":"daruma-drama","player_count":"4","hands":3}', JSON.stringify(dirty));

  // abandonment: through the hook, and through pagehide
  analytics._reset(); calls.length = 0;
  const g3 = runSession({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed: 13, stopAfterTricks: 12 }, hooks);
  g3.abandon();
  const ab = calls.find((c) => c[1] === 'game_abandoned');
  check('analytics: abandoning a running game fires game_abandoned', !!ab);
  check('analytics: abandoned carries usage and progress only', ab && ab[2].tricks >= 12 && ab[2].hands >= 1 && ab[2].player_count === 3 && ab[2].human_players === 1 && Object.keys(ab[2]).every((k) => analytics.ALLOWED_PARAMS.includes(k) && !['winning_score', 'winner_seat_type'].includes(k)), JSON.stringify(ab && ab[2]));
  calls.length = 0;
  g3.abandon();
  check('analytics: abandonment fires once', calls.length === 0);
  let pagehide = null;
  globalThis.window = { gtag: (...a) => calls.push(a), addEventListener: (n, f) => { if (n === 'pagehide') pagehide = f; } };
  analytics.installAbandonTracking();
  analytics._reset(); calls.length = 0;
  analytics.trackGameStart({ players: 3, seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], rulesCode: 'std' });
  pagehide();
  const pb = calls.find((c) => c[1] === 'game_abandoned');
  check('analytics: pagehide mid-game fires game_abandoned with the beacon directive only extra', !!pb && pb[2].transport_type === 'beacon' && Object.keys(pb[2]).filter((k) => !analytics.ALLOWED_PARAMS.includes(k)).join() === 'transport_type');
  analytics._reset(); calls.length = 0;
  runSession({ seats: [{ type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 14 }, hooks);
  const ended = calls.filter((c) => c[1] === 'game_end').length;
  calls.length = 0;
  pagehide();
  check('analytics: a finished game is not abandoned afterwards', ended === 1 && calls.length === 0);

  // no gtag: silent
  globalThis.window = {};
  let threw = false;
  try { analytics.trackGameStart({ players: 3, seats: [] }); analytics.trackGameEnd({}); analytics.trackStatsViewed(); analytics.trackVariantChanged({}); } catch { threw = true; }
  check('analytics: no gtag is a silent no-op', !threw);
  globalThis.window = { gtag() { throw new Error('boom'); } };
  try { analytics.trackGameStart({ players: 3, seats: [] }); analytics.trackStatsViewed(); } catch { threw = true; }
  check('analytics: a throwing gtag never reaches the caller', !threw);
  delete globalThis.window;
}

// ---------- bug report ----------
{
  _resetLogs();
  const st = fakeStorage();
  globalThis.localStorage = st;
  globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2 };
  globalThis.location = { href: 'http://x/?seed=1' };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test-agent' }, configurable: true });

  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed: 21, rules: { LINE_LIMIT: '2' } });
  ctl.runBots();
  ctl.play(ctl.legalActions()[0]);
  const before = JSON.stringify(ctl.state);
  for (let i = 0; i < 70; i++) logAction({ seat: 0, card: 'red-1', n: i });
  logEvent('refused-click', 'x');
  const r = buildReport({ ctl, screen: 'game' }, { title: 'Stuck', happened: 'it hung', expected: 'it moves' });
  check('bug: state not mutated', JSON.stringify(ctl.state) === before);
  check('bug: valid JSON round trip', JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r));
  check('bug: header fields', r.schemaVersion === 1 && /^daruma-\d{8}-\d{6}-[a-z0-9]+$/.test(r.id) && !Number.isNaN(Date.parse(r.timestamp)));
  check('bug: environment', r.environment.url === 'http://x/?seed=1' && r.environment.userAgent === 'test-agent' && r.environment.viewport.width === 800 && r.environment.devicePixelRatio === 2);
  check('bug: player words', r.player.title === 'Stuck' && r.player.whatHappened === 'it hung' && r.player.whatIExpected === 'it moves');
  check('bug: full game state included', r.game && r.game.kind === 'game' && r.game.hands && r.game.tricks && r.game.rulesCode === 'line-2');
  check('bug: controller seats, seed and rules', r.controller.seats[0].type === 'human' && r.controller.seed === 21 && r.controller.rulesCode === 'line-2' && r.controller.rules.LINE_LIMIT === '2');
  const d = r.diagnostics;
  check('bug: diagnostics for the human seat', d && d.seat === 0 && d.cards.length === r.game.hands[0].length && Array.isArray(d.legalCards));
  check('bug: a block reason for each illegal card, null for each legal one', d.cards.every((c) => (d.legalCards.includes(c.card) ? c.blockReason === null : typeof c.blockReason === 'string')));
  check('bug: action log capped at 60, newest kept', r.actionLog.length === 60 && r.actionLog[59].n === 69);
  check('bug: event log has the refusal', r.eventLog.some((e) => e.kind === 'refused-click'));
  check('bug: mailto address is the contact address', BUG_REPORT_EMAIL === 'info@wombatgamefactory.com');
  const none = buildReport({ ctl: null, screen: 'landing' }, {});
  check('bug: works on the landing page (no game)', none.game === null && none.diagnostics === null && none.schemaVersion === 1);
  const broken = buildReport({ ctl: { get state() { throw new Error('x'); } } }, {});
  check('bug: a failing section becomes an error, not a throw', broken && broken.schemaVersion === 1 && broken.game && broken.game.error);

  // a finished game still reports
  const fin = createController({ seats: [{ type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 22 });
  fin.runBots();
  const fr = buildReport({ ctl: fin, screen: 'game' }, {});
  check('bug: a finished game still gives diagnostics', fr.game.phase === 'over' && fr.diagnostics && !fr.diagnostics.error && fr.diagnostics.legalCards.length === 0);

  for (let i = 0; i < ARCHIVE_MAX + 5; i++) archiveReport({ ...none, id: `r${i}` });
  const arch = loadArchive();
  check('bug: archive capped at 20, oldest evicted', arch.length === ARCHIVE_MAX && arch[0].id === 'r5');
  globalThis.localStorage = { getItem: throwing, setItem: throwing, removeItem: throwing };
  check('bug: archive tolerates blocked storage', archiveReport(none) === false && loadArchive().length === 0);
  delete globalThis.localStorage; delete globalThis.window; delete globalThis.location;
}

// ---------- records from before the 01/11/2026 rules change ----------
{
  const oldRules = { LINE_LIMIT: '3', FIRST_FALL: 'chosen', FORMAT: 'pad', HAND_SIZE: 'standard', DECK_3P: 'full', LEFTOVER: 'lost', TIEBREAK: 'colours', TRUMP_TIES: 'first' };
  const a = migrate({ players: 4, rules: oldRules, rules_code: 'std' });
  check('migrate: an old standard-rules record is relabelled tie-colours+bonus-0', a.rules_code === 'tie-colours+bonus-0' && a.rules.FULL_LINE_BONUS === '0');
  const b = migrate({ players: 4, rules: { ...oldRules, LINE_LIMIT: '2' }, rules_code: 'line-2' });
  check('migrate: an old variant record keeps its variant and gains the old defaults', b.rules_code === 'line-2+tie-colours+bonus-0');
  const c = migrate({ players: 4, rules: { ...oldRules, TIEBREAK: 'shared' }, rules_code: 'tie-shared' });
  check('migrate: an old shared-tiebreak record stays tie-shared', c.rules_code === 'tie-shared+bonus-0');
  const nowRec = { players: 4, rules: { ...oldRules, TIEBREAK: 'leftover', FULL_LINE_BONUS: '2' }, rules_code: 'std' };
  check('migrate: a record with FULL_LINE_BONUS is left alone', migrate(nowRec) === nowRec);
}

done();
