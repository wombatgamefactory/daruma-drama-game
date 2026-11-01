// ui-browser.mjs - drives the real UI in headless Chromium: landing and setup, human v Easy (every
// level that is registered), 3 / 4 / 5 players, bot v bot, pass-and-play (hands hidden, first fall
// included), a game under non-standard rules, the no-Worker fallback, reduced motion, phone widths
// and a clean console. Starts its own static server on a free port; needs Playwright, which is NOT a
// dependency of this repo: it is looked up as `playwright`, then in the global npm root, or from
// PLAYWRIGHT_PATH. Without it the suite prints SKIPPED (exit 0), or exits 1 with --require.
// Screenshots go to a fresh folder under the system temp folder (daruma-ui-shots-XXXXXX; the path is printed).
// Run: node tests/ui-browser.mjs [--require]

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { suite } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// One folder per run: a fixed name would be overwritten by the next run (or by a run in parallel), and on
// Windows an overwrite can fail while a virus scanner or indexer still holds the file from the last run.
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'daruma-ui-shots-'));
const { check, done } = suite('ui-browser');

async function loadPlaywright() {
  const tries = [() => import('playwright')];
  const dirs = [process.env.PLAYWRIGHT_PATH];
  try { dirs.push(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch { /* none */ }
  for (const d of dirs.filter(Boolean)) tries.push(() => import(pathToFileURL(path.join(d, 'index.mjs')).href));
  for (const t of tries) {
    try { const m = await t(); return m.chromium || (m.default && m.default.chromium); } catch { /* next */ }
  }
  return null;
}

const chromium = await loadPlaywright();
if (!chromium) {
  console.log('ui-browser: SKIPPED (Playwright not found)');
  process.exit(process.argv.includes('--require') ? 1 : 0);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    if (p.startsWith(ROOT) && fs.existsSync(path.join(p, 'index.html'))) { res.writeHead(200, { 'content-type': 'text/html' }); return fs.createReadStream(path.join(p, 'index.html')).pipe(res); }
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const problems = [];
async function newPage(w = 1280, h = 900, opts = {}, init = null) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...opts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${w}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${w}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[${w}] request failed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${w}] HTTP ${r.status()} ${r.url()}`); });
  return page;
}
// A screenshot is evidence for a human, never a pass/fail check: failing to take one must not end the run.
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }).catch((e) => console.log(`  (screenshot ${name} failed: ${String(e.message).slice(0, 80)})`));

/** A click that gives up after a few seconds and says so, instead of waiting out Playwright's 30 s default and throwing. */
async function tryClick(locator, opts = {}) {
  try { await locator.click({ timeout: 5000, ...opts }); return true; } catch { return false; }
}

/** Which bot levels the registry offers (read from the setup page itself). */
let levels = ['easy'];
{
  const page = await newPage();
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  levels = await page.$$eval('select[name=type1] option:not([disabled])', (o) => o.map((x) => x.value).filter((v) => v !== 'human'));
  await page.close();
}

console.log(`bot levels offered: ${levels.join(', ')}`);
async function setup(page, { players = 4, types = ['human', 'easy', 'easy', 'easy', 'easy'], names = [], rules = {}, q = 'seed=11', delay = 40 } = {}) {
  await page.goto(`${BASE}?botdelay=${delay}&${q}`);
  await page.waitForSelector('#setup-form');
  await page.check(`input[name=players][value="${players}"]`);
  for (let i = 0; i < players; i++) {
    await page.selectOption(`select[name=type${i}]`, types[i]);
    if (names[i]) await page.fill(`input[name=name${i}]`, names[i]);
  }
  if (Object.keys(rules).length) {
    await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
    for (const [k, v] of Object.entries(rules)) await page.selectOption(`select[name="rule-${k}"]`, v);
  }
  await page.click('#start');
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Plays every human decision (first legal card; tries one illegal card now and then) until the end panel. */
async function playHuman(page, stats = {}, limitMs = 150000) {
  Object.assign(stats, { plays: 0, falls: 0, covers: 0, coverLeaks: 0, summaries: 0, illegalTried: 0, tooltipMatches: 0, hints: 0 });
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (await page.locator('.end--game').count()) break;
    if (await page.locator('.cover').count()) {
      stats.covers++;
      if (await page.locator('.hand, .card, .cardimg, .table, .log__list').count()) stats.coverLeaks++;
      await tryClick(page.locator('.cover .btn--primary'));
      continue;
    }
    if (await page.locator('#continue').count()) { if (await tryClick(page.locator('#continue'))) stats.summaries++; continue; }
    const legal = page.locator('.hand .card.is-legal');
    if (await legal.count()) {
      const blocked = page.locator('.hand .card.is-blocked');
      if (stats.illegalTried < 4 && await blocked.count()) {
        const title = await blocked.first().getAttribute('title');
        if (await tryClick(blocked.first(), { force: true })) {
          stats.illegalTried++;
          const note = await page.textContent('#note');
          if (title && /must follow/.test(title) && title === note) stats.tooltipMatches++;
        }
      }
      if (await page.locator('.hand .card__hint').count()) stats.hints++;
      const fall = (await page.locator('.handbox__title').textContent()).includes('first fall');
      if (!(await tryClick(legal.first()))) continue; // re-rendered or dimmed under the pointer: look again
      stats.plays++;
      if (fall) stats.falls++;
    } else await page.waitForTimeout(30);
  }
  return stats;
}

// ---------- landing ----------
{
  const page = await newPage();
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  check('landing: title', (await page.title()) === 'Daruma Drama');
  check('landing: the hook', (await page.textContent('.hero__hook')) === 'Every card you lose with stays in front of you, knocked over. Your oldest fallen card is your own personal trump.');
  check('landing: the strapline', (await page.textContent('.hero__strap')) === 'Fall seven times, stand up eight.');
  check('landing: stat strip', /3-5[\s\S]*Players[\s\S]*30-40[\s\S]*Minutes[\s\S]*10\+[\s\S]*Ages/.test(await page.textContent('.stats')));
  const opts = await page.$$eval('select[name=type1] option', (o) => o.map((x) => x.value));
  check('landing: Human and the three bot levels are on the menu', ['human', 'easy', 'medium', 'hard'].every((v) => opts.includes(v)), opts.join(','));
  check('landing: Easy is selectable', levels.includes('easy'));
  check('landing: hint to watch bots', /Set every seat to a bot to watch a game/.test(await page.textContent('.hint')));
  check('landing: hero art loaded', await page.$eval('.hero__img', (i) => i.complete && i.naturalWidth > 100));
  const href = await page.getAttribute('a[data-action=rulebook]', 'href');
  const r = await page.request.get(BASE + href);
  check('landing: rule book PDF link works', href === 'rules/daruma-drama-rule-book-v5.pdf' && r.status() === 200 && (await r.body()).slice(0, 4).toString() === '%PDF');
  check('landing: Playtest rules collapsed, no note', !(await page.$eval('#rules-panel', (d) => d.open)) && !(await page.isVisible('#rules-note')));
  await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
  const rows = await page.locator('.rule:visible').count();
  check('landing: one visible switch per VARIANTS row (8 at four players, the 3-player deck hidden)', rows === 8, `${rows}`);
  await page.selectOption('select[name="rule-LINE_LIMIT"]', '2');
  check('landing: a non-standard switch shows the visible note', await page.isVisible('#rules-note') && /Non-standard rules are on \(line-2\)/.test(await page.textContent('#rules-note')));
  await page.click('[data-action=reset-rules]');
  check('landing: Standard rules resets and clears the note', !(await page.isVisible('#rules-note')) && (await page.inputValue('select[name="rule-LINE_LIMIT"]')) === '3');
  await page.check('input[name=players][value="3"]');
  check('landing: 3 players shows 3 seats and the 3-player-only switch', (await page.locator('.seatform:visible').count()) === 3 && (await page.locator('.rule:visible').count()) === 9);
  await page.check('input[name=players][value="5"]');
  check('landing: 5 players shows 5 seats', (await page.locator('.seatform:visible').count()) === 5);
  const og = await page.$eval('meta[property="og:url"]', (m) => m.content);
  check('landing: og:url is the published address', og === 'https://www.wombatgamefactory.com/daruma-drama-game/', og);
  await shot(page, 'landing-1280');
  await page.click('[data-action=open-rules]');
  check('landing: the How to play dialog opens and closes with Escape', (await page.locator('.dialog').count()) === 1 && /First fall/.test(await page.textContent('.dialog')));
  await page.keyboard.press('Escape');
  check('landing: Escape closes the dialog', (await page.locator('.dialog').count()) === 0);
  await page.close();
}

// ---------- human v Easy, 4 players ----------
{
  const page = await newPage();
  await setup(page, { names: ['Mia'] });
  await page.waitForSelector('.hand .card.is-legal');
  check('4p: seats round the table with trump and bank readable for all', (await page.locator('.seat').count()) === 4 && (await page.locator('.seat .stat--trump').count()) === 4 && (await page.locator('.seat .stat--bank').count()) === 4);
  check('4p: the first fall is a clear step', /choose your first fall/i.test(await page.textContent('.handbox__title')) && /first fall/i.test(await page.textContent('#prompt')));
  check('4p: bots show as waiting before the human chooses', /Choosing a first fall/.test(await page.textContent('.table')));
  await shot(page, 'fall-1280');
  const s = await playHuman(page);
  check('4p: human plays 4 first falls and at least 20 card plays, game ends', s.falls === 4 && s.plays >= 4 + 4 * 5 && (await page.locator('.end--game').count()) === 1, `${s.plays} plays, ${s.falls} falls`);
  check('4p: every hand end showed a summary (4)', s.summaries === 4, `${s.summaries}`);
  check('4p: illegal cards explain themselves (tooltip equals the note)', s.illegalTried > 0 && s.tooltipMatches === s.illegalTried, `${s.tooltipMatches}/${s.illegalTried}`);
  check('4p: legal cards carry a would-win hint', s.hints > 5);
  check('4p: end screen ranks everyone with seat badges and a winner', (await page.locator('.ranking .rank').count()) === 4 && (await page.locator('.ranking .badge').count()) === 4 && (await page.locator('.rank.is-winner').count()) >= 1);
  check('4p: the typed name is used', /Mia/.test(await page.textContent('.ranking')));
  check('4p: the log has one trick line per trick', (await page.locator('.log__item--trick').count()) === 40, `${await page.locator('.log__item--trick').count()}`);
  await shot(page, 'end-1280');
  check('4p: no horizontal scroll at the end', (await overflow(page)) <= 0);
  await page.click('.end--game [data-action=again]');
  await page.waitForSelector('.hand .card.is-legal');
  check('play again starts a new game with the same setup', (await page.locator('.seat').count()) === 4 && (await page.locator('.log__item--trick').count()) === 0);
  await page.close();
}

// ---------- every registered level, and 3 / 5 players ----------
for (const level of levels.filter((l) => l !== 'easy')) {
  const page = await newPage();
  await setup(page, { players: 5, types: ['human', level, level, level, level], q: 'seed=5' });
  await page.waitForSelector('.hand .card.is-legal', { timeout: 60000 });
  await page.evaluate(() => { window.__gap = 0; let last = performance.now(); setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; }, 16); });
  const s = await playHuman(page);
  const gap = await page.evaluate(() => window.__gap);
  check(`5p human v 4 ${level}: game ends`, (await page.locator('.end--game').count()) === 1 && s.falls === 5);
  check(`5p human v 4 ${level}: decisions run in a Web Worker`, (await page.evaluate(() => document.body.dataset.botMode)) === 'worker');
  check(`5p human v 4 ${level}: the main thread never stalls (longest gap < 250 ms)`, gap < 250, `${Math.round(gap)} ms`);
  await page.close();
}
{
  const page = await newPage();
  await setup(page, { players: 3, types: ['human', 'easy', 'easy'], q: 'seed=3' });
  await page.waitForSelector('.hand .card.is-legal');
  const s = await playHuman(page);
  check('3p: game ends after 3 hands', (await page.locator('.end--game').count()) === 1 && s.summaries === 3 && s.falls === 3, `${s.summaries} summaries`);
  await page.close();
  const p5 = await newPage();
  await setup(p5, { players: 5, types: ['human', 'easy', 'easy', 'easy', 'easy'], q: 'seed=4' });
  await p5.waitForSelector('.hand .card.is-legal');
  check('5p: nine cards in hand and five seats', (await p5.locator('.hand .card').count()) === 9 && (await p5.locator('.seat').count()) === 5);
  const s5 = await playHuman(p5);
  check('5p: game ends after 5 hands', (await p5.locator('.end--game').count()) === 1 && s5.summaries === 5, `${s5.summaries}`);
  await p5.close();
}

// ---------- bot v bot, with and without Workers ----------
{
  const page = await newPage();
  await setup(page, { players: 3, types: ['easy', 'easy', 'easy'], q: 'seed=3' });
  await page.waitForSelector('.end--game', { timeout: 90000 });
  check('bot v bot: finishes by itself', (await page.locator('.rank').count()) === 3);
  check('bot v bot: no hand is shown', (await page.locator('.hand .card').count()) === 0);
  await page.close();
  const p2 = await newPage(1280, 900, {}, () => { delete window.Worker; });
  await setup(p2, { players: 3, types: ['easy', 'easy', 'easy'], q: 'seed=4' });
  await p2.waitForSelector('.end--game', { timeout: 90000 });
  check('no Worker: falls back to synchronous bots and still finishes', (await p2.evaluate(() => document.body.dataset.botMode)) === 'sync');
  await p2.close();
}

// ---------- pass and play ----------
{
  const page = await newPage();
  await setup(page, { players: 4, types: ['human', 'human', 'easy', 'human'], names: ['Ann', 'Bo', '', 'Cy'], q: 'seed=2' });
  await page.waitForSelector('.cover');
  check('pass-and-play: the first screen is a cover with no card or table in the DOM', (await page.locator('.card, .cardimg, .hand, .table').count()) === 0 && /Pass to (Ann|Bo|Cy)/.test(await page.textContent('.cover h2')));
  await shot(page, 'cover-1280');
  await page.keyboard.press('Control+Shift+B');
  check('pass-and-play: the bug button is hidden and Ctrl+Shift+B does nothing while the cover is up (a report holds every hand)', !(await page.locator('#bug-button').isVisible()) && (await page.locator('.bug').count()) === 0);
  const s = await playHuman(page);
  check('pass-and-play: a cover before every human decision, the first fall included, never a leak', s.covers >= 40 && s.coverLeaks === 0 && s.falls === 12, `${s.covers} covers, ${s.coverLeaks} leaks, ${s.falls} falls`);
  check('pass-and-play: the game ends with a ranking', (await page.locator('.rank').count()) === 4);
  await page.close();
}

// ---------- a non-standard variant ----------
{
  const page = await newPage();
  await setup(page, { players: 3, types: ['human', 'easy', 'easy'], rules: { LINE_LIMIT: '2', LEFTOVER: 'minus1', FIRST_FALL: 'top' }, q: 'seed=6' });
  await page.waitForSelector('.hand .card.is-legal');
  check('variant: a visible flag says the rules are non-standard', /Non-standard rules: line-2\+fall-top\+leftover-minus1/.test(await page.textContent('.rules-flag')));
  check('variant: first fall top means no first-fall step, trumps already set', !/first fall/i.test(await page.textContent('.handbox__title')) && (await page.locator('.seat .stat--trump:not(.trump--none)').count()) === 3);
  const s = await playHuman(page);
  check('variant: the game ends and the end screen names the rules', (await page.locator('.end--game').count()) === 1 && /Non-standard rules were on/.test(await page.textContent('.end__rules')) && s.falls === 0);
  await page.close();
}

// ---------- tie-break explanation appears only when someone tied (seed search is not needed: check the text rules) ----------

// ---------- motion ----------
{
  const page = await newPage(1280, 900);
  await setup(page, { q: 'seed=11', delay: 800 });
  await page.waitForSelector('.hand .card.is-legal');
  check('motion: cards transition by default', parseFloat(await page.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) > 0);
  await page.close();
  const rm = await newPage(1280, 900, { reducedMotion: 'reduce' });
  await setup(rm, { q: 'seed=11', delay: 800 });
  await rm.waitForSelector('.hand .card.is-legal');
  check('motion: prefers-reduced-motion turns the transitions off', parseFloat(await rm.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) === 0);
  await rm.close();
}

// ---------- falling and rising are shown ----------
{
  const page = await newPage(1280, 900);
  await setup(page, { players: 4, q: 'seed=11', delay: 800 });
  await page.waitForSelector('.hand .card.is-legal');
  await page.locator('.hand .card.is-legal').first().click();
  let sawFall = false; let sawRise = false; let sawDecided = false;
  const t0 = Date.now();
  for (let i = 0; i < 12 && Date.now() - t0 < 60000;) {
    if (await page.locator('.fx-fall').count()) sawFall = true;
    if (await page.locator('.fx-rise').count()) sawRise = true;
    if (await page.locator('.tplay.is-winner').count()) sawDecided = true;
    const legal = page.locator('.hand .card.is-legal');
    if (await legal.count()) { await legal.first().click(); i++; } else await page.waitForTimeout(40);
    if (sawFall && sawRise && sawDecided) break;
  }
  check('animation: the trick winner is marked, losers fall, the winner rises', sawFall && sawRise && sawDecided, `fall ${sawFall} rise ${sawRise} winner ${sawDecided}`);
  await page.close();
}

// ---------- responsive ----------
for (const [w, h] of [[1440, 900], [1024, 800], [390, 844]]) {
  for (const n of [3, 4, 5]) {
    const page = await newPage(w, h, w < 700 ? { hasTouch: true, isMobile: true } : {});
    await page.goto(`${BASE}?seed=1`);
    await page.waitForSelector('#setup-form');
    if (n === 4) {
      check(`responsive ${w}px: landing has no horizontal scroll`, (await overflow(page)) <= 0);
      await shot(page, `landing-${w}`);
    }
    await setup(page, { players: n, types: ['human', 'medium', 'easy', 'easy', 'easy'].map((t) => (t === 'medium' && !levels.includes('medium') ? 'easy' : t)), q: 'seed=9' });
    await page.waitForSelector('.hand .card.is-legal');
    check(`responsive ${w}px ${n}p: first fall has no horizontal scroll`, (await overflow(page)) <= 0);
    if (n === 4) await shot(page, `fall-${w}`);
    for (let i = 0; i < 4; i++) {
      await page.locator('.hand .card.is-legal').first().click();
      if (w < 700) await page.locator('.hand .card.is-legal, .hand .card.is-selected').first().click().catch(() => {});
      await page.waitForFunction(() => document.querySelector('.hand .card.is-legal'), null, { timeout: 30000 });
    }
    const box = await page.$eval('.table', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; });
    check(`responsive ${w}px ${n}p: mid-game has no horizontal scroll, table fits with gutters`, (await overflow(page)) <= 0 && box[0] >= 0 && box[1] <= w, JSON.stringify(box));
    if (n !== 3) await shot(page, `play-${n}p-${w}`);
    await page.close();
  }
}

// ---------- keyboard ----------
{
  const page = await newPage();
  await setup(page, { q: 'seed=11' });
  await page.waitForSelector('.hand .card.is-legal');
  await page.focus('.hand .card.is-legal');
  check('keyboard: focusing a card shows its hint', (await page.textContent('#preview')).length > 10);
  await page.keyboard.press('ArrowRight');
  check('keyboard: arrow keys move along the hand', await page.evaluate(() => document.activeElement.classList.contains('card')));
  await page.close();
}

const real = problems.filter((p) => !/fonts\.(googleapis|gstatic)\.com/.test(p)); // web fonts are optional, with fallbacks
check('console is clean (no errors, warnings, failed requests)', real.length === 0, real.slice(0, 5).join(' || '));

await browser.close();
server.close();
console.log(`screenshots: ${SHOTS}`);
done();
