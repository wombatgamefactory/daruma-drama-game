// qa-run.mjs - browser QA over the whole game, run from a sub-path the way GitHub Pages serves it.
//
// 1. Copies the tracked files (plus any untracked, un-ignored ones) into
//    <system temp>/daruma-drama-game-qa/site/daruma-drama-game/ and serves <temp>/site on a
//    CASE-SENSITIVE static server (a request must match a real file name exactly, like Pages).
// 2. Drives the game in headless Chromium: 3, 4 and 5 players against every bot level, all-bot
//    games, pass-and-play with 2 and 3 humans, a game under every rules variant, the stats screen
//    and its exports, the bug reporter, the rule book link, the consent banner / analytics loading
//    on a real-looking host name, several widths, reduced motion, keyboard play, first-paint image
//    weight and a case check of every referenced path.
// 3. Prints PASS/FAIL per check, writes screenshots to <temp>/daruma-drama-game-qa/shots/ and a
//    JSON summary to <temp>/daruma-drama-game-qa/qa-results.json. Exit 1 if anything fails.
//
// Needs Playwright (not a dependency of this repo): found as `playwright`, in the global npm root,
// or from PLAYWRIGHT_PATH. Run: node tests/qa/qa-run.mjs [--only=<scenario substring>] [--widths=390,1440]

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VARIANTS } from '../../src/engine/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(os.tmpdir(), `daruma-drama-game-qa${process.env.QA_TAG ? `-${process.env.QA_TAG}` : ''}`);
const SITE = path.join(TMP, 'site');
const SUB = 'daruma-drama-game';
const PUBLIC = `https://www.wombatgamefactory.com/${SUB}/`;
const SHOTS = path.join(TMP, 'shots');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const SIZES_ONLY = (process.argv.find((a) => a.startsWith('--widths=')) || '').slice(9).split(',').filter(Boolean).map(Number);

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
if (!chromium) { console.log('qa-run: Playwright not found'); process.exit(1); }

// ---------- the sub-path copy of the site ----------
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
const tracked = git('ls-files');
const untracked = git('ls-files', '-o', '--exclude-standard');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
const served = new Set(); // exact-case relative paths under SITE
for (const f of [...tracked, ...untracked]) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) continue; // tracked but deleted in the working tree
  const dst = path.join(SITE, SUB, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  served.add(`${SUB}/${f}`);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.md': 'text/markdown' };
const requestLog = []; // { url, status }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel.endsWith('/')) rel += 'index.html';
  if (!served.has(rel) && served.has(`${rel}/index.html`)) rel += '/index.html';
  const ok = served.has(rel);
  requestLog.push({ url: url.pathname, status: ok ? 200 : 404 });
  if (!ok) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(path.join(SITE, rel)).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/${SUB}/`;

// ---------- result bookkeeping ----------
const results = []; // { scenario, name, pass, detail }
let current = null;
const shotsByScenario = new Map();
function check(name, cond, detail = '') {
  const pass = !!cond;
  results.push({ scenario: current, name, pass, detail: String(detail || '') });
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail && !pass ? ` -- ${detail}` : ''}`);
  return pass;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, `${slug(current || 'qa')}--${slug(name)}.png`);
  try { await page.screenshot({ path: file, ...opts }); } catch (e) { console.log(`  (screenshot failed: ${e.message})`); return null; }
  if (!shotsByScenario.has(current)) shotsByScenario.set(current, []);
  shotsByScenario.get(current).push(file);
  return file;
}
async function scenario(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  current = name;
  console.log(`\n== ${name}`);
  const t0 = Date.now();
  try { await fn(); } catch (e) { check('scenario ran without throwing', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------- browser plumbing ----------
const browser = await chromium.launch();
const problems = []; // console errors/warnings, page errors, failed requests, HTTP >= 400
const imageBytes = new Map();
const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com/;
const NOISE = (t) => FONT_HOSTS.test(t);
async function newPage(w = 1440, h = 900, opts = {}, init = null, b = browser) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, ...opts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const tag = `[${current} @${w}]`;
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !NOISE(m.text())) problems.push(`${tag} console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
  page.on('requestfailed', (r) => { if (!NOISE(r.url())) problems.push(`${tag} request failed: ${r.url()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !NOISE(r.url())) problems.push(`${tag} HTTP ${r.status()} ${r.url()}`); });
  return page;
}
const touchOpts = (w) => (w < 700 ? { hasTouch: true, isMobile: true } : {});

/** Opens the setup page and starts a game. types: seat types; rules: { NAME: value }. */
async function setup(page, { players = 4, types = ['human', 'easy', 'easy', 'easy', 'easy'], names = [], rules = {}, q = 'seed=11', delay = 30, reload = true } = {}) {
  if (reload) await page.goto(`${BASE}?botdelay=${delay}&${q}`);
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

/** A click that never waits out a full timeout: false when the target moved or vanished (the caller loops). */
async function tryClick(locator, opts = {}) {
  try { await locator.click({ timeout: 3000, ...opts }); return true; } catch { return false; }
}

/**
 * Plays every human decision (first legal card; tries a dimmed card now and then) until the game-end
 * panel is up. On a phone-width page (touch) the first tap previews and the second plays.
 */
async function playHuman(page, { maxMs = 240000, tryIllegal = 3 } = {}) {
  const touch = page.viewportSize().width < 700;
  const st = { plays: 0, falls: 0, covers: 0, coverLeaks: 0, summaries: 0, illegalTried: 0, tooltipMatches: 0, hints: 0 };
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await page.locator('.end--game').count()) break;
    if (await page.locator('.cover').count()) {
      st.covers++;
      if (await page.locator('.hand, .card, .cardimg, .table, .log__list, .line').count()) st.coverLeaks++;
      await tryClick(page.locator('.cover .btn--primary'));
      continue;
    }
    if (await page.locator('#continue').count()) { if (await tryClick(page.locator('#continue'))) st.summaries++; continue; }
    const legal = page.locator('.hand .card.is-legal');
    if (await legal.count()) {
      const blocked = page.locator('.hand .card.is-blocked');
      if (st.illegalTried < tryIllegal && await blocked.count()) {
        const title = await blocked.first().getAttribute('title');
        if (await tryClick(blocked.first(), { force: true })) {
          st.illegalTried++;
          const note = await page.textContent('#note').catch(() => '');
          if (title && /must follow/.test(title) && title === note) st.tooltipMatches++;
        }
      }
      if (await page.locator('.hand .card__hint').count()) st.hints++;
      const fall = ((await page.locator('.handbox__title').textContent().catch(() => '')) || '').includes('first fall');
      const first = legal.first();
      if (!(await tryClick(first))) continue; // re-rendered under the pointer: look again
      if (touch && await page.locator('.hand .card.is-selected').count()) await tryClick(page.locator('.hand .card.is-selected').first());
      st.plays++;
      if (fall) st.falls++;
    } else await page.waitForTimeout(25);
  }
  return st;
}

const waitEnd = (page, ms = 120000) => page.waitForSelector('.end--game', { timeout: ms });
const badText = (page) => page.evaluate(() => /\bundefined\b|\bNaN\b|\[object |\bnull\b/.test(document.body.innerText));

// ---------- in-page audits ----------
const AUDIT = () => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const out = { hscroll: document.documentElement.scrollWidth - vw, vscroll: document.documentElement.scrollHeight - vh, clipped: [], off: [], vw, vh };
  const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
  const insideScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (['auto', 'scroll', 'hidden', 'clip'].includes(cs.overflowX)) { const r = p.getBoundingClientRect(); if (r.left >= -1 && r.right <= vw + 1) return true; }
    }
    return false;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.sr-only') || el.closest('.hand .card')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (['hidden', 'clip'].includes(cs.overflowX) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && !el.matches('details, .hero__art, picture, .scard, .line, .tplay__card')) out.clipped.push(`${name(el)} "${el.textContent.trim().slice(0, 24)}" in ${el.parentElement ? name(el.parentElement) : "?"} (${el.scrollWidth}>${el.clientWidth})`);
    if (cs.position !== 'fixed' && !el.closest('.overlay, .cover') && (r.right > vw + 1 || r.left < -1) && !insideScroller(el)) out.off.push(`${name(el)} [${Math.round(r.left)},${Math.round(r.right)}]`);
  }
  return out;
};
async function audit(page, label, { allowVScroll = true } = {}) {
  const a = await page.evaluate(AUDIT);
  check(`${label}: no horizontal scroll`, a.hscroll <= 0, `scrollWidth - clientWidth = ${a.hscroll}`);
  check(`${label}: nothing outside the viewport horizontally`, a.off.length === 0, a.off.slice(0, 4).join('; '));
  check(`${label}: no clipped text`, a.clipped.length === 0, a.clipped.slice(0, 4).join('; '));
  if (!allowVScroll) check(`${label}: fits the viewport height without page scroll`, a.vscroll <= 0, `scrollHeight - clientHeight = ${a.vscroll}`);
  return a;
}

const CONTRAST = () => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') return null; // art behind: cannot judge
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 0.99) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const c of stack.reverse()) base = blend(c, base);
    return base;
  };
  const seen = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (!/[A-Za-z0-9]/.test(t.nodeValue)) continue; // decorative marks (the dots in an empty score-pad row) carry no information
    const el = t.parentElement;
    if (!el || el.closest('.sr-only, .hand .card, script, style')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    if (op < 0.99) continue;
    const fg = parse(cs.color); const bg = bgOf(el);
    if (!fg || !bg) continue;
    const f = blend(fg, bg);
    const L1 = lum(f); const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      const key = `${el.tagName.toLowerCase()}.${(el.className || '').toString().trim().split(/\s+/)[0]} ${cs.color} on ${cs.backgroundColor}`;
      if (!seen.has(key)) seen.set(key, { ratio: Math.round(ratio * 100) / 100, need, text: t.nodeValue.trim().slice(0, 40) });
    }
  }
  return [...seen.entries()].map(([k, v]) => `${k}: ${v.ratio}:1 (need ${v.need}) "${v.text}"`);
};

const SCREENS = [
  { w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1024, h: 768 }, { w: 768, h: 1024 }, { w: 390, h: 844 }, { w: 360, h: 740 },
].filter((s) => !SIZES_ONLY.length || SIZES_ONLY.includes(s.w));

// =====================================================================================
await scenario('Static check: referenced paths match file names exactly (Pages is case-sensitive)', async () => {
  const exact = new Set(tracked);
  const lower = new Map(tracked.map((f) => [f.toLowerCase(), f]));
  const bad = [];
  let refs = 0;
  const verify = (from, ref) => {
    if (/^(https?:|data:|mailto:|#|\/\/)/.test(ref)) return;
    const clean = ref.split('#')[0].split('?')[0];
    if (!clean) return;
    const resolved = path.posix.normalize(clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(from), clean));
    refs++;
    if (exact.has(resolved)) return;
    bad.push(`${from} -> ${ref}${lower.has(resolved.toLowerCase()) ? ` (case differs: ${lower.get(resolved.toLowerCase())})` : ' (no such file)'}`);
  };
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of read('index.html').matchAll(/\b(?:src|href)="([^"]+)"/g)) verify('index.html', m[1]);
  for (const m of read('style.css').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) verify('style.css', m[1]);
  for (const f of tracked.filter((t) => /^src\/.*\.js$/.test(t))) {
    const text = read(f);
    for (const m of text.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) verify(f, m[1]);
    for (const m of text.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]/g)) verify(f, m[1]);
    for (const m of text.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g)) verify(f, m[1]);
    for (const m of text.matchAll(/new Worker\(\s*['"]([^'"]+)['"]/g)) verify(f, m[1]);
    for (const m of text.matchAll(/['"`]((?:assets|rules)\/[^'"`$]+\.[a-z0-9]+)['"`]/gi)) verify('index.html', m[1]); // page-relative strings
  }
  // the built-in art table in assets.js: 'file.webp' under assets/, plus the 55 generated card paths
  const art = read('src/ui/assets.js');
  for (const m of art.matchAll(/:\s*'([a-z0-9/.-]+\.(?:webp|png|jpg))'/g)) verify('assets/x', m[1]);
  for (const c of ['red', 'gold', 'green', 'blue', 'purple']) for (let n = 1; n <= 11; n++) verify('assets/x', `cards/card-${c}-${n}.webp`);
  let manifestAbs = 0;
  const manifest = JSON.parse(read('assets/manifest.json'));
  for (const a of manifest.assets) {
    if (/^([a-z]:|[\\/])/i.test(a.file) || /[a-z]:\\/i.test(JSON.stringify(a))) manifestAbs++;
    verify('assets/manifest.json', a.file);
  }
  check(`${refs} references checked, every one an exact-case match for a tracked file`, bad.length === 0, bad.slice(0, 6).join('; '));
  check('assets/manifest.json has no absolute or Windows paths', manifestAbs === 0, `${manifestAbs} entries`);
  const upper = tracked.filter((f) => /[A-Z]/.test(f) && !/^README\.md$/.test(f));
  check('tracked file names are lowercase (nothing relies on case)', upper.length === 0, upper.slice(0, 5).join(', '));
});

await scenario('Landing page from the sub-path: first paint weight, links, social tags', async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const page = await newPage(w, h, touchOpts(w));
    let bytes = 0; const imgs = [];
    page.on('response', async (r) => {
      if (r.request().resourceType() === 'image') { try { const b = (await r.body()).length; bytes += b; imgs.push(`${path.basename(new URL(r.url()).pathname)} ${Math.round(b / 1024)}KB`); } catch { /* aborted */ } }
    });
    await page.goto(`${BASE}`, { waitUntil: 'load' });
    await page.waitForSelector('#setup-form');
    await page.waitForLoadState('networkidle');
    imageBytes.set(`landing-${w}`, bytes);
    check(`first paint at ${w}px loads under 2 MB of images (${(bytes / 1048576).toFixed(2)} MB: ${imgs.join(', ')})`, bytes < 2 * 1048576, `${bytes} bytes`);
    if (w === 1440) {
      check('title and hook render', (await page.title()) === 'Daruma Drama' && /personal trump/.test(await page.textContent('.hero__hook')) && /stand up eight/.test(await page.textContent('.hero__strap')));
      const meta = (sel) => page.$eval(sel, (m) => m.content || m.href);
      const og = await meta('meta[property="og:image"]');
      const ogu = await meta('meta[property="og:url"]');
      const can = await meta('link[rel=canonical]');
      check(`og:image, og:url and canonical are absolute URLs under ${PUBLIC}`, og.startsWith(PUBLIC) && ogu === PUBLIC && can === PUBLIC, `${og} | ${ogu} | ${can}`);
      const ogPath = og.replace(PUBLIC, '');
      check('og:image path exists as a published file', served.has(`${SUB}/${ogPath}`), ogPath);
      const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/manifest.json'), 'utf8')).assets.find((a) => a.file === ogPath.replace('assets/', ''));
      const ow = Number(await meta('meta[property="og:image:width"]')); const oh = Number(await meta('meta[property="og:image:height"]'));
      check('og:image width and height match the art manifest', man && man.width === ow && man.height === oh, JSON.stringify({ ow, oh, man: man && [man.width, man.height] }));
      const tw = await meta('meta[name="twitter:image"]');
      check('twitter:image is absolute and the same file', tw === og, tw);
      check('description meta is present and describes the game', /3 to 5 players/.test(await meta('meta[name=description]')));
      const href = await page.getAttribute('a[data-action=rulebook]', 'href');
      const r = await page.request.get(new URL(href, BASE).href);
      const body = await r.body();
      check(`rule book PDF link (${href}) answers 200 application/pdf from the sub-path (${Math.round(body.length / 1024)} KB)`, r.status() === 200 && /pdf/.test(r.headers()['content-type'] || '') && body.slice(0, 4).toString() === '%PDF', `${r.status()} ${r.headers()['content-type']}`);
      check('rule book link opens in a new tab safely (target=_blank with rel=noopener)', (await page.getAttribute('a[data-action=rulebook]', 'target')) === '_blank' && /noopener/.test(await page.getAttribute('a[data-action=rulebook]', 'rel')));
      check('assets/manifest.json served', (await page.request.get(`${BASE}assets/manifest.json`)).status() === 200);
      check('favicon served as an image', await page.evaluate(async () => { const l = document.querySelector('link[rel=icon]'); const r = await fetch(l.href); return r.ok && /image/.test(r.headers.get('content-type')); }));
      check('root of the origin is not the game (so every path in the page is relative to the sub-path)', (await page.request.get(`${ORIGIN}/`)).status() === 404);
      check('hero image loaded', await page.$eval('.hero__img', (i) => i.complete && i.naturalWidth > 100));
      await shot(page, 'landing-1440', { fullPage: true });
    } else {
      await shot(page, 'landing-390', { fullPage: true });
    }
    await page.close();
  }
});

await scenario('Consent banner and analytics load on a real host name, in order', async () => {
  // The page skips CookieYes and gtag on localhost / 127.0.0.1. Map the published host name to this
  // server so the loader runs the way it does live, and answer the two third-party scripts with stubs.
  const b2 = await chromium.launch({ args: ['--host-resolver-rules=MAP www.wombatgamefactory.com 127.0.0.1'] });
  try {
    const seen = [];
    const ctx = await b2.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.route(/cdn-cookieyes\.com/, (r) => { seen.push('cookieyes'); r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.__cookieyes = true;' }); });
    await ctx.route(/googletagmanager\.com/, (r) => { seen.push('gtag'); r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.__gtagjs = true;' }); });
    await ctx.route(/google-analytics\.com/, (r) => r.abort());
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`http://www.wombatgamefactory.com:${PORT}/${SUB}/?seed=1`);
    await page.waitForSelector('#setup-form');
    await page.waitForFunction(() => window.__gtagjs === true, null, { timeout: 8000 }).catch(() => {});
    check('CookieYes script requested first, then gtag.js', seen[0] === 'cookieyes' && seen[1] === 'gtag', seen.join(','));
    check('both third-party scripts executed and the page has no script errors', await page.evaluate(() => window.__cookieyes === true && window.__gtagjs === true) && errs.length === 0, errs.join('; '));
    check('dataLayer holds the js and config calls for the shared GA4 property', await page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).some((a) => a[0] === 'config' && a[1] === 'G-FNNQF917JJ')));
    check('the loader tag ids are the expected ones', await page.evaluate(() => !!document.getElementById('cookieyes') && [...document.scripts].some((s) => /gtag\/js\?id=G-FNNQF917JJ/.test(s.src))));
    await page.close();
    await ctx.close();
  } finally { await b2.close(); }
  // and the other side: nothing third-party is requested on localhost
  const page = await newPage(1280, 800);
  const third = [];
  page.on('request', (r) => { if (/cookieyes|googletagmanager|google-analytics/.test(r.url())) third.push(r.url()); });
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  await page.waitForTimeout(400);
  check('on 127.0.0.1 no consent banner or analytics script is requested', third.length === 0, third.join(', '));
  await page.close();
});

await scenario('Responsive: landing page at every width', async () => {
  for (const { w, h } of SCREENS) {
    const page = await newPage(w, h, touchOpts(w));
    await page.goto(`${BASE}?seed=1`);
    await page.waitForSelector('#setup-form');
    await audit(page, `landing ${w}px`);
    await page.check('input[name=players][value="5"]');
    await audit(page, `landing ${w}px with 5 seats`);
    await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
    await audit(page, `landing ${w}px with the Playtest rules panel open`);
    await shot(page, `landing-${w}`, { fullPage: true });
    await page.close();
  }
});

// ---------- full games against bots: 3, 4 and 5 players, every level ----------
for (const level of ['easy', 'medium', 'hard']) {
  for (const n of [3, 4, 5]) {
    await scenario(`Human v ${level} bots, ${n} players, to the end`, async () => {
      const page = await newPage(1440, 900);
      const types = ['human', level, level, level, level];
      await setup(page, { players: n, types, q: `seed=${n * 7 + (level === 'easy' ? 1 : level === 'medium' ? 2 : 3)}` });
      await page.waitForSelector('.hand .card.is-legal', { timeout: 60000 });
      check('the game opens at the top of the page (not scrolled to where "Start game" was)', (await page.evaluate(() => window.scrollY)) === 0);
      check(`${n} seats on the table, each with a trump box and a bank box`, (await page.locator('.seat').count()) === n && (await page.locator('.seat .stat--trump').count()) === n && (await page.locator('.seat .stat--bank').count()) === n);
      check(`${n === 5 ? 9 : 11} cards in hand and a "choose your first fall" step`, (await page.locator('.hand .card').count()) === (n === 5 ? 9 : 11) && /choose your first fall/i.test(await page.textContent('.handbox__title')));
      await shot(page, 'first-fall');
      await page.evaluate(() => { window.__gap = 0; let last = performance.now(); setInterval(() => { const t = performance.now(); window.__gap = Math.max(window.__gap, t - last); last = t; }, 16); });
      const s = await playHuman(page);
      check(`${n} first fall(s) chosen, ${n} hands and summaries`, s.falls === n && s.summaries === n, JSON.stringify(s));
      check('game-end panel up with a ranking, seat badges and a winner', (await page.locator('.end--game').count()) === 1 && (await page.locator('.ranking .rank').count()) === n && (await page.locator('.ranking .badge').count()) === n && (await page.locator('.rank.is-winner').count()) >= 1);
      check('badges say Human once and the bot level for the rest', (await page.locator('.ranking .badge--human').count()) === 1 && (await page.locator(`.ranking .badge--bot`).allTextContents()).every((t) => new RegExp(level, 'i').test(t)));
      check('illegal cards explain themselves (tooltip equals the click message)', s.illegalTried === 0 || s.tooltipMatches === s.illegalTried, `${s.tooltipMatches}/${s.illegalTried}`);
      check('legal cards carried a would-win hint', s.hints > 3);
      const tricks = n === 5 ? 8 : 10;
      check(`the log has one trick line per trick (${n * tricks})`, (await page.locator('.log__item--trick').count()) === n * tricks, `${await page.locator('.log__item--trick').count()}`);
      check('the end screen has no "undefined", "NaN" or "null" text', !(await badText(page)));
      if (level !== 'easy') {
        const gap = await page.evaluate(() => window.__gap);
        check(`${level} bot: main thread never stalled (longest gap ${Math.round(gap)} ms < 250)`, gap < 250);
        check(`${level} bot: decisions came from a Web Worker`, (await page.evaluate(() => document.body.dataset.botMode)) === 'worker');
      }
      await shot(page, 'end');
      await audit(page, 'end panel 1440');
      await page.click('.end--game [data-action=review]');
      await page.waitForSelector('.endbar');
      await audit(page, 'end bar after "Look at the table"');
      await page.click('.endbar [data-action=again]');
      await page.waitForSelector('.hand .card.is-legal');
      check('Play again deals a fresh game with the same setup', (await page.locator('.seat').count()) === n && (await page.locator('.log__item--trick').count()) === 0);
      await page.close();
    });
  }
}

await scenario('All-bot games (3, 4 and 5 seats, mixed levels) finish by themselves', async () => {
  for (const [n, types, seed] of [[3, ['hard', 'medium', 'easy'], 3], [4, ['medium', 'medium', 'hard', 'easy'], 4], [5, ['easy', 'easy', 'medium', 'hard', 'easy'], 5]]) {
    const page = await newPage(1280, 800);
    await setup(page, { players: n, types, q: `seed=${seed}`, delay: 15 });
    await page.waitForSelector('.seat');
    check(`${n} bots: no hand is shown, nothing to click`, (await page.locator('.hand .card').count()) === 0);
    await page.waitForTimeout(500);
    await shot(page, `bots-${n}-midgame`);
    await waitEnd(page, 150000);
    check(`${n} bots: the game ends with a ranking and mixed seat badges`, (await page.locator('.ranking .rank').count()) === n && (await page.locator('.ranking .badge--bot').count()) === n);
    check(`${n} bots: no "undefined"/"NaN" text`, !(await badText(page)));
    await shot(page, `bots-${n}-end`);
    await page.close();
  }
});

await scenario('Pass-and-play: 2 and 3 humans, the hand is never visible under the cover', async () => {
  const cases = [
    { label: '2 humans + 1 bot (3 players)', n: 3, types: ['human', 'human', 'easy'], names: ['Ann', 'Bo', ''] },
    { label: '3 humans + 1 bot (4 players)', n: 4, types: ['human', 'human', 'easy', 'human'], names: ['Ann', 'Bo', '', 'Cy'] },
    { label: '3 humans (3 players)', n: 3, types: ['human', 'human', 'human'], names: ['Ann', 'Bo', 'Cy'] },
  ];
  for (const c of cases) {
    for (const { w, h } of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
      if (w === 390 && c.label.startsWith('3 humans + 1 bot')) continue; // keep the run short: 390 px covers 2 humans and 3 humans/3p
      const page = await newPage(w, h, touchOpts(w));
      await page.addInitScript(() => {
        window.__leaks = 0; window.__covers = 0;
        new MutationObserver(() => {
          const cover = document.querySelector('.cover');
          if (cover) { window.__covers++; if (document.querySelector('.hand, .card, .cardimg, .table, .log__list, .line, .seat')) window.__leaks++; }
        }).observe(document, { subtree: true, childList: true, attributes: true });
      });
      await setup(page, { players: c.n, types: c.types, names: c.names, q: 'seed=2', delay: 20 });
      await page.waitForSelector('.cover');
      const tag = `${c.label} @${w}`;
      check(`${tag}: the first screen is a cover (the first fall is hidden too) with no card, table or line in the DOM`, (await page.locator('.hand, .card, .cardimg, .table, .log__list, .line, .seat').count()) === 0 && /Pass to (Ann|Bo|Cy)/.test(await page.textContent('.cover h2')));
      const cov = await page.evaluate(() => { const r = document.querySelector('.cover').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, text: document.body.innerText }; });
      check(`${tag}: the cover fills the whole viewport`, cov.l <= 0 && cov.t <= 0 && cov.w >= w - 1 && cov.h >= h - 1, JSON.stringify(cov).slice(0, 120));
      check(`${tag}: the cover says nothing about anyone's cards (no card names, no scores)`, !/\b(red|gold|green|blue|purple)[- ]?\d/i.test(cov.text) && !/\b\d+ in pile\b/.test(cov.text));
      if (w === 1440 && c.n === 3 && c.types.filter((t) => t === 'human').length === 2) {
        await shot(page, 'cover');
        await audit(page, 'cover 1440');
      } else if (w === 390) { await shot(page, `cover-${c.n}p-390`); await audit(page, `cover ${c.n}p 390`); }
      const s = await playHuman(page, { maxMs: 240000 });
      const leaks = await page.evaluate(() => window.__leaks);
      const covers = await page.evaluate(() => window.__covers);
      const humans = c.types.filter((t) => t === 'human').length;
      check(`${tag}: a cover before every human decision, first fall included (${s.covers} covers, ${s.falls} falls for ${c.n} hands)`, s.covers >= humans * c.n * 5 && s.falls === humans * c.n, JSON.stringify(s));
      check(`${tag}: a MutationObserver saw ${covers} cover mutations and never a hand, card, table or seat behind one`, leaks === 0 && covers > 0 && s.coverLeaks === 0, `${leaks} leaks`);
      check(`${tag}: the game ends with a ranking`, (await page.locator('.rank').count()) === c.n);
      if (w === 1440 && c.n === 4) await shot(page, 'end');
      await page.close();
    }
  }
  // the revealed hand shows only my cards
  const page = await newPage(1440, 900);
  await setup(page, { players: 3, types: ['human', 'human', 'easy'], names: ['Ann', 'Bo', ''], q: 'seed=2' });
  await page.click('.cover .btn--primary');
  await page.waitForSelector('.hand .card');
  const shownHands = await page.locator('.hand').count();
  check('after revealing: one hand in the DOM, the other seats show lines only', shownHands === 1 && (await page.locator('.hand .card').count()) === 11);
  await shot(page, 'revealed-hand');
  // the rules dialog over a cover must not expose anything either
  await page.close();
  const p2 = await newPage(1440, 900);
  await setup(p2, { players: 3, types: ['human', 'human', 'easy'], q: 'seed=2' });
  await p2.waitForSelector('.cover');
  check('no Rules button or any control other than the reveal button on the cover', (await p2.locator('.cover button').count()) === 1);
  await p2.close();
});

// ---------- rules variants ----------
await scenario('Every non-standard rules value: an all-bot game under it finishes, names the rules and shows no broken text', async () => {
  for (const v of VARIANTS) {
    for (const val of v.values.filter((x) => x !== v.default)) {
      const n = v.onlyFor ? v.onlyFor[0] : 4;
      const page = await newPage(1280, 800);
      await setup(page, { players: n, types: ['easy', 'medium', 'easy', 'easy', 'easy'], rules: { [v.name]: val }, q: 'seed=21', delay: 0 });
      await page.waitForSelector('.seat');
      check(`${v.name}=${val}: visible "non-standard rules" flag during play`, (await page.locator('.rules-flag').count()) === 1 && new RegExp(`${v.code}-${val}`).test(await page.textContent('.rules-flag')));
      await waitEnd(page, 120000);
      check(`${v.name}=${val}: the game ends, the end panel names the rules, no broken text`, /Non-standard rules were on/.test(await page.textContent('.end__rules')) && !(await badText(page)), (await page.textContent('.end__rules')).slice(0, 80));
      if (v.name === 'FORMAT') await shot(page, 'format-shrinking-end');
      await page.close();
    }
  }
});

await scenario('Human games under the unusual rules (shrinking deck, ten-card hands, no purple, first fall = top card, scaled line)', async () => {
  const runs = [
    { label: 'FORMAT=shrinking', players: 4, rules: { FORMAT: 'shrinking' }, seed: 8 },
    { label: 'HAND_SIZE=ten, 5 players', players: 5, rules: { HAND_SIZE: 'ten' }, seed: 9 },
    { label: 'DECK_3P=drop_purple, 3 players', players: 3, rules: { DECK_3P: 'drop_purple' }, seed: 10 },
    { label: 'FIRST_FALL=top + LINE_LIMIT=scaled + LEFTOVER=minus1', players: 4, rules: { FIRST_FALL: 'top', LINE_LIMIT: 'scaled', LEFTOVER: 'minus1' }, seed: 12 },
  ];
  for (const r of runs) {
    const page = await newPage(1280, 900);
    await setup(page, { players: r.players, types: ['human', 'easy', 'medium', 'easy', 'easy'], rules: r.rules, q: `seed=${r.seed}` });
    await page.waitForSelector('.hand .card.is-legal');
    check(`${r.label}: flag shown`, (await page.locator('.rules-flag').count()) === 1);
    const midText = await badText(page);
    await shot(page, `${slug(r.label)}-start`);
    const s = await playHuman(page);
    check(`${r.label}: human plays to the end (${s.plays} plays, ${s.summaries} hand summaries)`, (await page.locator('.end--game').count()) === 1 && s.plays > 10, JSON.stringify(s));
    check(`${r.label}: no "undefined"/"NaN" at the start or at the end`, !midText && !(await badText(page)));
    await shot(page, `${slug(r.label)}-end`);
    await page.close();
  }
});

// ---------- stats ----------
await scenario('Stats screen: empty state, filled state split by rules, CSV and JSON exports, Clear', async () => {
  const page = await newPage(1280, 900);
  await page.goto(`${BASE}?botdelay=0&seed=61`);
  await page.waitForSelector('#setup-form');
  await page.click('.landing [data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
  check('empty state before any game', /No games recorded yet/.test(await page.textContent('.dialog .st')));
  check('export buttons are disabled when empty', await page.$eval('[data-action=export-csv]', (b) => b.disabled) && await page.$eval('[data-action=export-json]', (b) => b.disabled));
  await shot(page, 'stats-empty');
  await audit(page, 'stats empty 1280');
  await page.keyboard.press('Escape');
  const plan = [
    { players: 3, types: ['easy', 'medium', 'hard'], rules: {} },
    { players: 4, types: ['medium', 'medium', 'easy', 'easy'], rules: {} },
    { players: 5, types: ['easy', 'easy', 'easy', 'medium', 'easy'], rules: { LINE_LIMIT: '2' } },
    { players: 4, types: ['easy', 'easy', 'easy', 'easy'], rules: { LEFTOVER: 'minus1', TIEBREAK: 'shared' } },
  ];
  for (const g of plan) {
    await setup(page, { ...g, reload: false });
    await waitEnd(page, 120000);
    await page.click('.end--game [data-action=new]');
    await page.waitForSelector('#setup-form');
    await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
    await page.click('[data-action=reset-rules]');
  }
  // one human game so "Human against each bot level" has a row
  await setup(page, { players: 3, types: ['human', 'easy', 'easy'], reload: false });
  await playHuman(page);
  await page.click('.end--game [data-action=open-stats]');
  await page.waitForSelector('.dialog .st__table');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('daruma-stats-v1')).games);
  check(`stats list every game played (${stored.length} stored of 5)`, stored.length === 5);
  const lead = await page.textContent('.dialog .st__lead');
  check('lead line counts the 5 games', /^\s*5\s+games played/.test(lead), lead.slice(0, 60));
  const sections = await page.$$eval('.st h3', (hs) => hs.map((h) => h.textContent));
  check('all stats sections present', ['Win rate by seat type', 'Win rate by seat position', 'Scores by player count', 'Ties and the tiebreak', 'By rules'].every((s) => sections.includes(s)) && sections.some((s) => /Human against/.test(s)), sections.join(' | '));
  const codes = await page.$$eval('.st__table tbody th', (ths) => ths.map((t) => t.textContent.trim()));
  check('by-rules table lists standard rules and each variant code', codes.includes('Standard rules') && codes.includes('line-2') && codes.some((c) => /leftover-minus1/.test(c) && /tie-shared/.test(c)), codes.join(' | '));
  check('no "undefined"/"NaN" text on the stats screen', !(await badText(page)));
  await shot(page, 'stats-filled');
  await audit(page, 'stats filled 1280');
  await page.selectOption('[data-action=stats-filter]', 'line-2');
  check('filtering by a rules code shows just that game', /^\s*1\s+game played under line-2/.test(await page.textContent('.dialog .st__lead')));
  await page.selectOption('[data-action=stats-filter]', 'all');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]);
  const csv = fs.readFileSync(await csvDl.path(), 'utf8');
  const lines = csv.trim().split('\n');
  check(`CSV export: dated name (${csvDl.suggestedFilename()}), header plus one row per game, LF line endings`, /^daruma-drama-stats-\d{4}-\d{2}-\d{2}\.csv$/.test(csvDl.suggestedFilename()) && lines.length === stored.length + 1 && !csv.includes('\r'), `${lines.length} lines`);
  check('CSV rows are valid: same quoted-field count as the header', (() => { const cols = (l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).length; return lines.every((l) => cols(l) === cols(lines[0])); })());
  const [jsDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-json]')]);
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(await jsDl.path(), 'utf8')); } catch { /* reported below */ }
  check(`JSON export is valid JSON (${jsDl.suggestedFilename()}) and equals the store`, parsed && JSON.stringify(parsed.games) === JSON.stringify(stored));
  check('stored records carry rules_code and no human name was typed into the data', stored.every((g) => typeof g.rules_code === 'string') && !JSON.stringify(stored).includes('Secret'));
  // the same records at phone width: tables scroll inside their container, not the page
  const keep = await page.evaluate(() => localStorage.getItem('daruma-stats-v1'));
  const phone = await newPage(390, 844, touchOpts(390));
  await phone.addInitScript(([key, val]) => { try { localStorage.setItem(key, val); } catch { /* none */ } }, ['daruma-stats-v1', keep]);
  await phone.goto(`${BASE}?botdelay=0`);
  await phone.waitForSelector('#setup-form');
  await phone.click('.landing [data-action=open-stats]');
  await phone.waitForSelector('.dialog .st__table');
  await audit(phone, 'stats dialog 390');
  const geo = await phone.evaluate(() => {
    const d = document.querySelector('.dialog').getBoundingClientRect();
    const dlg = document.querySelector('.dialog');
    const sc = [...document.querySelectorAll('.st__scroll')].map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, scrolls: e.scrollWidth > e.clientWidth + 1, ox: getComputedStyle(e).overflowX }; });
    return { dl: d.left, dr: d.right, vw: innerWidth, dlgOverflow: dlg.scrollWidth - dlg.clientWidth, sc };
  });
  check('390 px: the stats dialog is inside the viewport and does not scroll sideways itself', geo.dl >= 0 && geo.dr <= geo.vw && geo.dlgOverflow <= 1, JSON.stringify({ dl: geo.dl, dr: geo.dr, over: geo.dlgOverflow }));
  check(`390 px: every table sits in a scroll container inside the dialog (${geo.sc.length} tables, ${geo.sc.filter((s) => s.scrolls).length} scroll sideways inside it)`, geo.sc.length >= 5 && geo.sc.every((s) => s.ox === 'auto' && s.l >= 0 && s.r <= geo.vw), JSON.stringify(geo.sc));
  await shot(phone, 'stats-390');
  await shot(phone, 'stats-390-full', { fullPage: true });
  const buttons = await phone.evaluate(() => [...document.querySelectorAll('.dialog__buttons .btn')].map((b) => { const r = b.getBoundingClientRect(); return { l: r.left, r: r.right, h: r.height }; }));
  check('390 px: export / clear / close buttons are inside the viewport and at least 36 px tall', buttons.length >= 4 && buttons.every((b) => b.l >= 0 && b.r <= 390 && b.h >= 36), JSON.stringify(buttons));
  await phone.close();
  // Clear
  page.once('dialog', (d) => d.dismiss());
  await page.click('[data-action=clear-stats]');
  check('Clear: dismissing the confirm keeps the data', (await page.locator('.dialog .st__table').count()) > 0);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=clear-stats]');
  await page.waitForSelector('.st__empty');
  check('Clear: accepting empties the store and the screen', (await page.evaluate(() => localStorage.getItem('daruma-stats-v1'))) === null);
  await shot(page, 'stats-after-clear');
  await page.close();
});

await scenario('Stats dialog keyboard: focus on the rules filter survives a change, Escape returns to the opener', async () => {
  const page = await newPage(1280, 900);
  // two rules codes so the filter exists
  await page.goto(`${BASE}?botdelay=0&seed=71`);
  await page.waitForSelector('#setup-form');
  await setup(page, { players: 3, types: ['easy', 'easy', 'easy'], reload: false });
  await waitEnd(page, 90000);
  await page.click('.end--game [data-action=new]');
  await page.waitForSelector('#setup-form');
  await setup(page, { players: 3, types: ['easy', 'easy', 'easy'], rules: { LINE_LIMIT: '2' }, reload: false });
  await waitEnd(page, 90000);
  await page.click('.end--game [data-action=new]');
  await page.waitForSelector('#setup-form');
  await page.focus('.landing [data-action=open-stats]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.dialog .st__filter select');
  check('opening the dialog with Enter moves focus into it (the close button)', await page.evaluate(() => !!document.activeElement.closest('.dialog')));
  check('the page behind the dialog is inert', await page.evaluate(() => document.getElementById('app').inert === true));
  await page.focus('[data-action=stats-filter]');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('[data-action=stats-filter]').value !== 'all', null, { timeout: 4000 }).catch(() => {});
  const afterOne = await page.evaluate(() => ({ focused: document.activeElement === document.querySelector('[data-action=stats-filter]'), value: document.querySelector('[data-action=stats-filter]').value, lead: document.querySelector('.st__lead').textContent }));
  check(`after changing the filter by keyboard, focus is still on the filter (value ${afterOne.value})`, afterOne.focused && afterOne.value !== 'all', JSON.stringify(afterOne).slice(0, 160));
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const afterTwo = await page.evaluate(() => ({ focused: document.activeElement === document.querySelector('[data-action=stats-filter]'), value: document.querySelector('[data-action=stats-filter]').value }));
  check('a second keyboard change works without tabbing back (focus kept, value moved on)', afterTwo.focused && afterTwo.value !== afterOne.value, JSON.stringify({ afterOne: afterOne.value, afterTwo }));
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  check('Tab stays inside the dialog', await page.evaluate(() => !!document.activeElement.closest('.dialog')));
  await shot(page, 'stats-keyboard');
  await page.keyboard.press('Escape');
  check('Escape closes the dialog and returns focus to the Stats button', (await page.locator('.dialog').count()) === 0 && await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'open-stats'));
  await page.close();
});

// ---------- bug reporter ----------
await scenario('Bug reporter: button and Ctrl+Shift+B download valid JSON; the button never covers the hand', async () => {
  const page = await newPage(1440, 900, { permissions: [] });
  await setup(page, { players: 4, types: ['human', 'easy', 'easy', 'easy'], q: 'seed=11' });
  await page.waitForSelector('.hand .card.is-legal');
  check('bug button is on the page, attached to body', (await page.locator('body > #bug-button').count()) === 1);
  await playHuman(page, { maxMs: 6000 }).catch(() => {});
  await tryClick(page.locator('.hand .card.is-legal').first());
  await page.waitForTimeout(200);
  check('bug button survives re-renders', (await page.locator('body > #bug-button').count()) === 1);
  await page.click('#bug-button');
  await page.waitForSelector('#bug-form');
  await page.fill('#bug-form [name=title]', 'QA run: by button');
  await page.fill('#bug-form [name=happened]', 'checking');
  await shot(page, 'bug-modal');
  await audit(page, 'bug modal 1440');
  const [d1] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  let r1 = null; try { r1 = JSON.parse(fs.readFileSync(await d1.path(), 'utf8')); } catch { /* below */ }
  check(`button: valid JSON report (${d1.suggestedFilename()}) with state, diagnostics and an action log`, r1 && r1.schemaVersion === 1 && r1.game && r1.diagnostics && Array.isArray(r1.actionLog) && r1.actionLog.length >= 2);
  check('button: no "error" keys anywhere in the report sections', r1 && !JSON.stringify(r1).includes('"error"'), r1 ? (JSON.stringify(r1).match(/"error":"[^"]*"/) || [''])[0] : 'no report');
  check('button: environment recorded (viewport, user agent)', r1 && r1.environment && r1.environment.viewport !== undefined);
  check('mailto link names the public contact address only', (await page.locator('.bug a[href^="mailto:info@wombatgamefactory.com?"]').count()) === 1);
  await shot(page, 'bug-saved');
  await page.click('.bug .btn--primary');
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [d2] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  let r2 = null; try { r2 = JSON.parse(fs.readFileSync(await d2.path(), 'utf8')); } catch { /* below */ }
  check('Ctrl+Shift+B mid-game: valid JSON report', r2 && r2.schemaVersion === 1 && typeof r2.id === 'string');
  await page.click('.bug .btn--primary');
  // landing
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=quit]');
  await page.waitForSelector('#setup-form');
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [d3] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  let r3 = null; try { r3 = JSON.parse(fs.readFileSync(await d3.path(), 'utf8')); } catch { /* below */ }
  check('Ctrl+Shift+B on the landing page: valid JSON report', r3 && r3.schemaVersion === 1);
  await page.click('.bug .btn--primary');
  // end screen
  await setup(page, { players: 3, types: ['easy', 'easy', 'easy'], q: 'seed=5', delay: 0, reload: false });
  await waitEnd(page);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [d4] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  let r4 = null; try { r4 = JSON.parse(fs.readFileSync(await d4.path(), 'utf8')); } catch { /* below */ }
  check('Ctrl+Shift+B on the end screen: valid JSON report', r4 && r4.schemaVersion === 1);
  await page.close();

  // the button must not sit on top of the hand cards, at any width, at any scroll position
  for (const { w, h } of SCREENS) {
    const p = await newPage(w, h, touchOpts(w));
    await setup(p, { players: 4, types: ['human', 'easy', 'easy', 'easy'], q: 'seed=9', delay: 0 });
    await p.waitForSelector('.hand .card.is-legal');
    await p.waitForTimeout(250);
    const cover = await p.evaluate(async () => {
      const btn = document.getElementById('bug-button').getBoundingClientRect();
      const max = document.documentElement.scrollHeight - innerHeight;
      const cards = [...document.querySelectorAll('.hand .card')];
      // 1. page scrolled to the very bottom: no card may sit under the button
      window.scrollTo(0, max);
      await new Promise((r) => requestAnimationFrame(r));
      const atEnd = cards.filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.left < btn.right && btn.left < r.right && r.top < btn.bottom && btn.top < r.bottom; }).map((c) => c.dataset.card);
      // 2. each card brought to the middle of the screen: the card itself, not the button, is hit at its centre and corners
      const blocked = [];
      for (const c of cards) {
        c.scrollIntoView({ block: 'center', inline: 'nearest' });
        await new Promise((r) => requestAnimationFrame(r));
        const r = c.getBoundingClientRect();
        const pts = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]];
        for (const [fx, fy] of pts) {
          const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
          if (!el || !c.contains(el)) { blocked.push(`${c.dataset.card}@${fx},${fy}: ${el ? (el.id || el.className || el.tagName) : 'none'}`); break; }
        }
      }
      window.scrollTo(0, 0);
      return { max, atEnd, blocked, btn: [Math.round(btn.left), Math.round(btn.top), Math.round(btn.width)] };
    });
    check(`${w}x${h}: bug button does not cover a hand card when the page is scrolled to the bottom`, cover.atEnd.length === 0, JSON.stringify(cover).slice(0, 220));
    check(`${w}x${h}: every hand card is fully clickable when scrolled to the middle of the screen (button never on top)`, cover.blocked.length === 0, cover.blocked.slice(0, 4).join('; '));
    await p.close();
  }
  const phone = await newPage(390, 844, touchOpts(390));
  await phone.goto(`${BASE}`);
  await phone.waitForSelector('#setup-form');
  await phone.click('#bug-button');
  await phone.waitForSelector('#bug-form');
  await audit(phone, 'bug modal 390');
  await shot(phone, 'bug-modal-390');
  await phone.close();
});

// ---------- rules dialog and the rule book ----------
await scenario('Rules dialog and rule book PDF', async () => {
  const page = await newPage(1280, 800);
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  await page.click('.topnav [data-action=open-rules]');
  await page.waitForSelector('.dialog');
  check('rules dialog opens with its heading and six steps', /How to play/.test(await page.textContent('.dialog h2')) && (await page.locator('.dialog .how__steps > li').count()) === 6);
  check('dialog is modal (page behind is inert) and focus is inside it', await page.evaluate(() => document.getElementById('app').inert && !!document.activeElement.closest('.dialog')));
  await shot(page, 'rules-dialog');
  await audit(page, 'rules dialog 1280');
  const href = await page.getAttribute('.dialog a[data-action=rulebook]', 'href');
  const res = await page.request.get(new URL(href, BASE).href);
  const body = await res.body();
  check(`PDF link "${href}" is 200 from the sub-path and is a PDF (${Math.round(body.length / 1024)} KB)`, res.status() === 200 && body.slice(0, 4).toString() === '%PDF');
  await page.keyboard.press('Escape');
  check('Escape closes the dialog and returns focus to the opener', (await page.locator('.dialog').count()) === 0 && await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'open-rules'));
  await page.click('button[type=submit]');
  await page.waitForSelector('.hand .card');
  await page.click('.topbar [data-action=open-rules]');
  await page.waitForSelector('.dialog');
  await shot(page, 'rules-dialog-in-game');
  await page.click('.dialog .btn--primary');
  check('rules dialog opens and closes in-game; the game is untouched', (await page.locator('.hand .card').count()) === 11 || (await page.locator('.hand .card').count()) === 10);
  const ev = await page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event' && a[1] === 'rules_opened').length);
  check('rules_opened was queued for each opening of the dialog', ev === 2, String(ev));
  await page.close();
  for (const w of [390, 360]) {
    const p = await newPage(w, 740, touchOpts(w));
    await p.goto(`${BASE}`);
    await p.waitForSelector('#setup-form');
    await p.click('.topnav [data-action=open-rules]');
    await p.waitForSelector('.dialog');
    await audit(p, `rules dialog ${w}`);
    await shot(p, `rules-dialog-${w}`);
    await p.close();
  }
});

// ---------- responsive sweep ----------
await scenario('Responsive sweep: in-game, hand summary, end panel and dialogs at every width', async () => {
  for (const { w, h } of SCREENS) {
    for (const n of [4, 5]) {
      const page = await newPage(w, h, touchOpts(w));
      await setup(page, { players: n, types: ['human', 'medium', 'easy', 'easy', 'easy'], q: 'seed=9', delay: 0 });
      await page.waitForSelector('.hand .card.is-legal');
      await page.waitForTimeout(250);
      const tag = `${n}p ${w}x${h}`;
      check(`first fall ${tag}: the game opens at the top of the page`, (await page.evaluate(() => window.scrollY)) === 0);
      await audit(page, `first fall ${tag}`);
      const geo = await page.evaluate(() => {
        const t = document.querySelector('.table').getBoundingClientRect();
        const c = [...document.querySelectorAll('.hand .card')].map((e) => e.getBoundingClientRect());
        const hb = document.querySelector('.handbox').getBoundingClientRect();
        return { tl: t.left, tr: t.right, cards: c.length, handOk: c.every((x) => x.left >= hb.left - 0.5 && x.right <= hb.right + 0.5), cw: Math.min(...c.map((x) => x.width)), vw: innerWidth };
      });
      check(`${tag}: table inside the viewport with gutters`, geo.tl >= 0 && geo.tr <= geo.vw, JSON.stringify(geo));
      check(`${tag}: all ${geo.cards} hand cards inside the hand box, at least 44 px wide (${Math.round(geo.cw)} px)`, geo.handOk && geo.cw >= 44, JSON.stringify(geo));
      if (n === 4) await shot(page, `fall-${w}x${h}`, { fullPage: true });
      // play a couple of tricks, then audit mid-game
      for (let i = 0; i < 3; i++) {
        if (!(await tryClick(page.locator('.hand .card.is-legal').first()))) break;
        if (w < 700) await tryClick(page.locator('.hand .card.is-selected').first());
        await page.waitForFunction(() => document.querySelector('.hand .card.is-legal'), null, { timeout: 30000 }).catch(() => {});
      }
      await audit(page, `mid-game ${tag}`);
      if (n === 5) await shot(page, `mid-5p-${w}x${h}`, { fullPage: true });
      if (n === 4 && w === 1440) {
        const contrast = await page.evaluate(CONTRAST);
        check('text contrast on the game screen (solid backgrounds, 4.5:1 / 3:1 large)', contrast.length === 0, contrast.slice(0, 6).join(' || '));
      }
      await page.close();
    }
    // end of a hand (summary overlay), the end panel, the discard dialog and stats at this width
    const page = await newPage(w, h, touchOpts(w));
    await setup(page, { players: 3, types: ['human', 'easy', 'easy'], q: 'seed=13', delay: 0 });
    await page.waitForSelector('.hand .card.is-legal');
    let sawSummary = false;
    for (let guard = 0; guard < 400 && !(await page.locator('.end--game').count()); guard++) {
      if (await page.locator('#continue').count()) {
        if (!sawSummary) { sawSummary = true; await audit(page, `hand summary ${w}x${h}`); await shot(page, `hand-summary-${w}x${h}`); const b = await page.evaluate(() => { const r = document.querySelector('.end--hand').getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, vh: innerHeight, vw: innerWidth }; }); check(`hand summary ${w}x${h}: inside the viewport (it scrolls inside itself when tall)`, b.l >= 0 && b.r <= b.vw && b.t >= -1 && b.b <= b.vh + 1, JSON.stringify(b)); }
        await tryClick(page.locator('#continue'));
        continue;
      }
      const legal = page.locator('.hand .card.is-legal');
      if (await legal.count()) { if (await tryClick(legal.first()) && w < 700) await tryClick(page.locator('.hand .card.is-selected').first()); } else await page.waitForTimeout(20);
    }
    check(`${w}x${h}: a hand summary appeared and the game reached its end`, sawSummary && (await page.locator('.end--game').count()) === 1);
    await audit(page, `end panel ${w}x${h}`);
    const dlg = await page.evaluate(() => { const e = document.querySelector('.end--game').getBoundingClientRect(); return { t: e.top, b: e.bottom, l: e.left, r: e.right, vh: innerHeight, vw: innerWidth }; });
    check(`end panel ${w}x${h}: inside the viewport`, dlg.l >= 0 && dlg.r <= dlg.vw && dlg.t >= -1 && dlg.b <= dlg.vh + 1, JSON.stringify(dlg));
    await shot(page, `end-${w}x${h}`);
    await page.click('.end--game [data-action=open-stats]');
    await page.waitForSelector('.dialog .st');
    await audit(page, `stats ${w}x${h}`);
    await shot(page, `stats-${w}x${h}`);
    const dd = await page.evaluate(() => { const e = document.querySelector('.dialog').getBoundingClientRect(); return { l: e.left, r: e.right, vw: innerWidth }; });
    check(`stats dialog ${w}x${h}: within the viewport width`, dd.l >= 0 && dd.r <= dd.vw);
    await page.close();
  }
});

await scenario('Reduced motion', async () => {
  const probe = () => {
    window.__anim = { animated: 0, still: 0 };
    const tick = () => {
      for (const e of document.querySelectorAll('.fx-fall, .fx-rise, .fx-knock, .fx-reveal, .fx-bump')) {
        if (getComputedStyle(e).animationName !== 'none') window.__anim.animated++; else window.__anim.still++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const run = async (reduce) => {
    const page = await newPage(1280, 900, reduce ? { reducedMotion: 'reduce' } : {}, probe);
    await setup(page, { players: 4, q: 'seed=11', delay: 200 });
    await page.waitForSelector('.hand .card.is-legal');
    const transition = parseFloat(await page.$eval('.card', (e) => getComputedStyle(e).transitionDuration));
    for (let i = 0; i < 4; i++) {
      if (!(await tryClick(page.locator('.hand .card.is-legal').first()))) break;
      await page.waitForFunction(() => document.querySelector('.hand .card.is-legal'), null, { timeout: 30000 }).catch(() => {});
    }
    const anim = await page.evaluate(() => window.__anim);
    const running = await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).animationName !== 'none').length);
    await shot(page, reduce ? 'reduced' : 'default');
    await page.close();
    return { transition, anim, running };
  };
  const d = await run(false);
  check(`default: cards transition and the fall/rise effects animate (${d.anim.animated} animated samples)`, d.transition > 0 && d.anim.animated > 0, JSON.stringify(d));
  const r = await run(true);
  check('reduce: card transitions are off', r.transition === 0, JSON.stringify(r));
  check(`reduce: the fall/rise effect elements exist but never animate (${r.anim.still} samples, ${r.anim.animated} animated)`, r.anim.animated === 0, JSON.stringify(r.anim));
  check('reduce: no running animation on any element', r.running === 0, String(r.running));
});

await scenario('Keyboard play', async () => {
  const page = await newPage(1280, 800);
  await setup(page, { players: 4, q: 'seed=11', delay: 20 });
  await page.waitForSelector('.hand .card.is-legal');
  await page.focus('.hand .card.is-legal');
  check('focusing a legal card shows its hint', (await page.textContent('#preview')).length > 10);
  await page.keyboard.press('ArrowRight');
  check('ArrowRight moves focus to the next card', await page.evaluate(() => document.activeElement.classList.contains('card')));
  await page.keyboard.press('End');
  const last = await page.evaluate(() => document.activeElement === [...document.querySelectorAll('.hand .card')].pop());
  await page.keyboard.press('Home');
  const first = await page.evaluate(() => document.activeElement === document.querySelector('.hand .card'));
  check('Home and End jump to the last and first card', last && first);
  await page.focus('.hand .card.is-legal');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.log__item', { timeout: 15000 });
  check('Enter on a focused legal card plays it (the first fall)', (await page.locator('.log__item').count()) >= 1);
  // find a follow with a dimmed card, and check Enter explains instead of playing
  let found = false;
  for (let i = 0; i < 30 && !found; i++) {
    await page.waitForFunction(() => document.querySelector('.hand .card.is-legal') || document.querySelector('.end--game') || document.querySelector('#continue'), null, { timeout: 20000 }).catch(() => {});
    if (await page.locator('#continue').count()) { await tryClick(page.locator('#continue')); continue; }
    if (await page.locator('.hand .card.is-blocked').count()) { found = true; break; }
    if (!(await tryClick(page.locator('.hand .card.is-legal').first()))) await page.waitForTimeout(50);
  }
  check('reached a follow with dimmed cards in hand', found);
  if (found) {
    await page.focus('.hand .card.is-blocked');
    const before = await page.locator('.hand .card').count();
    await page.keyboard.press('Enter');
    check('Enter on a dimmed card shows the reason and does not play it', (await page.textContent('#note')).length > 10 && (await page.locator('.hand .card').count()) === before);
  }
  await page.keyboard.press('Escape');
  await page.click('.topbar [data-action=open-rules]');
  await page.waitForSelector('.dialog');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  check('Tab stays inside the open dialog', await page.evaluate(() => !!document.activeElement.closest('.dialog')));
  await page.keyboard.press('Escape');
  await shot(page, 'keyboard');
  await page.close();
});

await scenario('Leaving a game: Setup link, abandon confirm, analytics', async () => {
  const page = await newPage(1280, 800);
  await setup(page, { players: 4, q: 'seed=11', delay: 20 });
  await page.waitForSelector('.hand .card.is-legal');
  // the first fall is not a trick: leaving then costs nothing and asks nothing. Play on until a trick has been played.
  for (let i = 0; i < 6 && !(await page.locator('.log__item--trick').count()); i++) {
    if (!(await tryClick(page.locator('.hand .card.is-legal').first()))) await page.waitForTimeout(100);
    await page.waitForTimeout(150);
  }
  check('a trick has been played before leaving', (await page.locator('.log__item--trick').count()) >= 1);
  let seen = '';
  page.once('dialog', (d) => { seen = d.message(); d.dismiss(); });
  await page.click('[data-action=quit]');
  check('Setup mid-game asks before throwing the game away; Cancel keeps it', /Leave this game/.test(seen) && (await page.locator('.hand .card').count()) > 0);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=quit]');
  await page.waitForSelector('#setup-form');
  check('confirming returns to the setup screen with the previous choices kept', (await page.$eval('select[name=type1]', (s) => s.value)) === 'easy' && (await page.$eval('input[name=players]:checked', (r) => r.value)) === '4');
  const ev = await page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event' && a[1] === 'game_abandoned'));
  check('game_abandoned queued once, with usage params only', ev.length === 1 && ev[0][2].tricks >= 0 && !('winner_seat_type' in ev[0][2]), JSON.stringify(ev));
  await page.close();
});

await scenario('Console errors, warnings and HTTP 404s across the whole run', async () => {
  check(`no console errors/warnings, page errors, failed requests or HTTP >= 400 (${problems.length})`, problems.length === 0, [...new Set(problems)].slice(0, 8).join(' || '));
  const bad = requestLog.filter((r) => r.status >= 400 && r.url.startsWith(`/${SUB}/`)); // (the deliberate request for the bare origin is not a page request)
  check(`server log: ${requestLog.length} requests, none 404 (exact-case server)`, bad.length === 0, [...new Set(bad.map((b) => `${b.status} ${b.url}`))].slice(0, 8).join('; '));
  const missed = [...new Set(requestLog.filter((r) => r.status === 200).map((r) => r.url))].length;
  check(`${missed} distinct files requested and served`, missed > 20);
});

// ---------- report ----------
await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
const byScenario = new Map();
for (const r of results) { if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []); byScenario.get(r.scenario).push(r); }
const summary = [...byScenario.entries()].map(([name, rs]) => ({ scenario: name, pass: rs.every((r) => r.pass), checks: rs.length, failed: rs.filter((r) => !r.pass).map((r) => `${r.name} -- ${r.detail}`), screenshots: shotsByScenario.get(name) || [] }));
fs.writeFileSync(path.join(TMP, 'qa-results.json'), JSON.stringify({ summary, imageBytes: Object.fromEntries(imageBytes), results }, null, 2));
console.log('\n---------------- summary ----------------');
for (const s of summary) console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${s.scenario}  (${s.checks} checks${s.failed.length ? `, ${s.failed.length} failed` : ''})`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
