// stats-store.js - local play statistics. Results stay in the browser (localStorage); nothing
// here is ever sent anywhere. No DOM. Every storage access is inside try/catch, so the game
// works unchanged when storage is blocked, full or throwing: the store then just forgets.
//
// One key, `daruma-stats-v1`, holds { v: 1, games: [...] }, newest last, capped at MAX_GAMES
// (oldest dropped).
//
// Game record (schema 1), one per finished game:
//   v, id, date (ISO), players, seed (string),
//   rules {LINE_LIMIT ... TRUMP_TIES}, rules_code ('std' or e.g. 'line-2+leftover-minus1'),
//   seats [{ seat, type: 'human'|'bot', level: null|'easy'|'medium'|'hard', name? }]  (name only for a
//     human who typed one),
//   hand_scores [[score by seat] by hand], totals [by seat], ranking [{ seat, total, colours, rank }],
//   winners [seats], shared, tiebreak_used, tied_on_total (two or more seats level on the top total),
//   winning_score, margin, hands, tricks, trump_tricks, rise_sizes [0,1,2,3 cards banked],
//   lost_cards [line cards left at hand ends, by seat], knock_offs [by seat], seconds

import { VARIANTS, DEFAULT_RULES, rulesCode } from '../engine/index.js';

export const STORE_KEY = 'daruma-stats-v1';
export const STORE_VERSION = 1;
export const MAX_GAMES = 2000;

const empty = () => ({ v: STORE_VERSION, games: [] });

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** getStorage: () => Storage-like (getItem/setItem/removeItem); may throw or return null. */
export function createStatsStore(getStorage = defaultStorage) {
  function load() {
    try {
      const s = getStorage();
      if (!s) return empty();
      const raw = s.getItem(STORE_KEY);
      if (!raw) return empty();
      const data = JSON.parse(raw);
      if (!data || data.v !== STORE_VERSION) return empty();
      return { v: STORE_VERSION, games: Array.isArray(data.games) ? data.games.filter(isRecord).map(migrate) : [] };
    } catch { return empty(); }
  }

  function save(data) {
    for (const keep of [MAX_GAMES, 800, 200]) {
      try {
        const s = getStorage();
        if (!s) return false;
        s.setItem(STORE_KEY, JSON.stringify({ ...data, games: data.games.slice(-keep) }));
        return true;
      } catch { /* quota or blocked: retry smaller, then give up */ }
    }
    return false;
  }

  return {
    load,
    addGame(rec) {
      const data = load();
      data.games.push(rec);
      if (data.games.length > MAX_GAMES) data.games = data.games.slice(-MAX_GAMES);
      return save(data);
    },
    clear() {
      try { const s = getStorage(); if (s) s.removeItem(STORE_KEY); return true; } catch { return false; }
    },
  };
}

/**
 * Records saved before the standard rules changed (01/11/2026: full-line bonus 2, fewest-left
 * tiebreak) have no FULL_LINE_BONUS in their rules. Those games were played with no bonus and the
 * colours tiebreak (unless TIEBREAK said otherwise), so their rules_code is recomputed to say so
 * ('std' becomes 'tie-colours+bonus-0') and they are not mixed with today's 'std' games.
 */
export function migrate(g) {
  if (!g.rules || typeof g.rules !== 'object' || 'FULL_LINE_BONUS' in g.rules) return g;
  const rules = { ...g.rules, FULL_LINE_BONUS: '0', TIEBREAK: g.rules.TIEBREAK || 'colours' };
  try { return { ...g, rules, rules_code: rulesCode(rules, g.players) }; } catch { return g; }
}

/** A record read back from storage is trusted only as far as the summary needs. */
function isRecord(g) {
  return !!g && typeof g === 'object' && Array.isArray(g.seats) && Array.isArray(g.totals)
    && Array.isArray(g.winners) && typeof g.rules_code === 'string' && Number.isInteger(g.players);
}

// ---------- recording ----------

/** 'human' or the bot level: the "seat kind" the stats are split by. */
export const seatKind = (s) => (s.type === 'human' ? 'human' : (s.level || 'bot'));

/**
 * Turns the session hooks into records. `now` is injectable for tests. The record is built from the
 * finished game state (info.state) and the seat setup (info.seats: [{ type: 'human'|level, name }]).
 */
export function createRecorder(store, now = () => Date.now()) {
  let gameStartedAt = null;
  return {
    gameStart() { gameStartedAt = now(); },
    gameEnd(info) {
      const st = info.state;
      const res = st && st.result;
      if (!st || !res) return null;
      const m = st.measures;
      const d = new Date(now());
      const rec = {
        v: STORE_VERSION,
        id: `g${d.getTime().toString(36)}-${String(info.seed).slice(0, 12)}`,
        date: d.toISOString(),
        players: st.n,
        seed: String(info.seed),
        rules: { ...st.rules },
        rules_code: st.rulesCode,
        seats: info.seats.map((s, i) => {
          const human = s.type === 'human';
          const seat = { seat: i, type: human ? 'human' : 'bot', level: human ? null : s.type };
          if (human && s.name) seat.name = String(s.name).slice(0, 16);
          return seat;
        }),
        hand_scores: st.handLog.map((h) => [...h.scores]),
        totals: [...res.totals],
        ranking: res.ranking.map((r) => ({ seat: r.seat, total: r.total, colours: r.colours, rank: r.rank })),
        winners: [...res.winners],
        shared: !!res.shared,
        tiebreak_used: !!res.tiebreakUsed,
        tied_on_total: res.tiedOnTotal.length > 1,
        winning_score: res.winningScore,
        margin: res.margin,
        hands: st.handLog.length,
        tricks: m.tricks,
        trump_tricks: m.trumpTricks,
        rise_sizes: [...m.riseSizes],
        lost_cards: [...m.leftover],
        knock_offs: [...m.knockOffs],
        seconds: gameStartedAt === null ? 0 : Math.max(0, Math.round((now() - gameStartedAt) / 1000)),
      };
      store.addGame(rec);
      return rec;
    },
  };
}

// ---------- export ----------

const SEAT_COLS = [1, 2, 3, 4, 5].flatMap((n) => [`seat${n}_type`, `seat${n}_name`]);
export const CSV_COLUMNS = [
  'date', 'id', 'seed', 'players', 'rules_code',
  ...VARIANTS.map((v) => `rule_${v.name.toLowerCase()}`),
  ...SEAT_COLS,
  'hands', 'hand_scores', 'totals', 'ranks', 'winner_seats', 'shared_win', 'tiebreak_used', 'tied_on_total',
  'winning_score', 'margin', 'tricks', 'trump_tricks',
  'rise_0', 'rise_1', 'rise_2', 'rise_3', 'lost_cards', 'knock_offs', 'duration_seconds',
];

export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const bool = (b) => (b ? 'yes' : 'no');
const join = (a) => (Array.isArray(a) ? a.join(' ') : '');

/** Seats are 1-based in the CSV (Seat 1 ... Seat 5, as on screen). Seat type is human, easy, medium or hard. */
export function gameToRow(r) {
  const seatCells = [0, 1, 2, 3, 4].flatMap((i) => {
    const s = r.seats[i];
    return s ? [seatKind(s), s.name || ''] : ['', ''];
  });
  const rules = r.rules || {};
  const ranks = [...(r.ranking || [])].sort((a, b) => a.seat - b.seat).map((x) => x.rank);
  const rise = r.rise_sizes || [];
  return [
    r.date, r.id, r.seed, r.players, r.rules_code,
    ...VARIANTS.map((v) => (rules[v.name] !== undefined ? rules[v.name] : DEFAULT_RULES[v.name])),
    ...seatCells,
    r.hands, (r.hand_scores || []).map((h) => h.join(' ')).join('|'), join(r.totals), ranks.join(' '),
    r.winners.map((s) => s + 1).join(' '), bool(r.shared), bool(r.tiebreak_used), bool(r.tied_on_total),
    r.winning_score, r.margin, r.tricks, r.trump_tricks,
    rise[0], rise[1], rise[2], rise[3], join(r.lost_cards), join(r.knock_offs), r.seconds,
  ];
}

/** One header row plus one row per game; LF only so it is safe to paste into URLs and tools. */
export function toCsv(games) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const g of games) lines.push(gameToRow(g).map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}

export function toJson(data) {
  return JSON.stringify({ exported: new Date().toISOString(), game: 'daruma-drama', schema: STORE_VERSION, ...data }, null, 2);
}

/** `daruma-drama-stats-2026-11-01.csv`, local date. */
export function exportFilename(ext, d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `daruma-drama-stats-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${ext}`;
}

// ---------- summary ----------

export const KINDS = ['human', 'easy', 'medium', 'hard'];

const tally = () => ({ seats: 0, wins: 0 });

/**
 * Pure aggregation for the stats screen. `filter` is 'all' or a rules_code; the by-rules table
 * always covers every game so the codes can be compared side by side.
 */
export function summarise(allGames, filter = 'all') {
  const games = (allGames || []).filter(isRecord);
  const sel = filter === 'all' ? games : games.filter((g) => g.rules_code === filter);

  const byKind = Object.fromEntries(KINDS.map((k) => [k, tally()]));
  const bySeat = Array.from({ length: 5 }, tally);
  const humanVs = Object.fromEntries(['easy', 'medium', 'hard'].map((l) => [l, { games: 0, humanSeats: 0, humanWins: 0, botSeats: 0, botWins: 0 }]));
  const byPlayers = {};
  const ties = { games: sel.length, tied: 0, tiebreak: 0, shared: 0 };
  let handsScored = 0; let scoreSum = 0; let marginSum = 0;

  for (const g of sel) {
    const won = new Set(g.winners);
    const kinds = g.seats.map(seatKind);
    g.seats.forEach((s, i) => {
      const k = kinds[i];
      if (byKind[k]) { byKind[k].seats++; if (won.has(i)) byKind[k].wins++; }
      if (bySeat[i]) { bySeat[i].seats++; if (won.has(i)) bySeat[i].wins++; }
    });
    const humans = kinds.map((k, i) => (k === 'human' ? i : -1)).filter((i) => i >= 0);
    for (const level of Object.keys(humanVs)) {
      const bots = kinds.map((k, i) => (k === level ? i : -1)).filter((i) => i >= 0);
      if (!humans.length || !bots.length) continue;
      const h = humanVs[level];
      h.games++;
      h.humanSeats += humans.length; h.humanWins += humans.filter((i) => won.has(i)).length;
      h.botSeats += bots.length; h.botWins += bots.filter((i) => won.has(i)).length;
    }
    const p = byPlayers[g.players] || (byPlayers[g.players] = { games: 0, hands: 0, scoreSum: 0, marginSum: 0, winSum: 0 });
    p.games++;
    p.marginSum += g.margin || 0; p.winSum += g.winning_score || 0;
    for (const h of g.hand_scores || []) for (const x of h) { p.hands++; p.scoreSum += x; handsScored++; scoreSum += x; }
    marginSum += g.margin || 0;
    if (g.tied_on_total) ties.tied++;
    if (g.tiebreak_used) ties.tiebreak++;
    if (g.shared) ties.shared++;
  }

  const rows = new Map();
  for (const g of games) {
    const r = rows.get(g.rules_code) || { code: g.rules_code, games: 0, hands: 0, scoreSum: 0, marginSum: 0, tied: 0, tiebreak: 0, shared: 0 };
    r.games++; r.marginSum += g.margin || 0;
    for (const h of g.hand_scores || []) for (const x of h) { r.hands++; r.scoreSum += x; }
    if (g.tied_on_total) r.tied++;
    if (g.tiebreak_used) r.tiebreak++;
    if (g.shared) r.shared++;
    rows.set(g.rules_code, r);
  }
  const byRules = [...rows.values()].sort((a, b) => (a.code === 'std' ? -1 : b.code === 'std' ? 1 : b.games - a.games));

  return {
    total: sel.length,
    allTotal: games.length,
    filter,
    codes: byRules.map((r) => ({ code: r.code, games: r.games })),
    byKind, bySeat, humanVs, byPlayers, ties, byRules,
    avgScorePerHand: handsScored ? scoreSum / handsScored : null,
    avgMargin: sel.length ? marginSum / sel.length : null,
  };
}

export const statsStore = createStatsStore();
