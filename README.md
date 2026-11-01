# Daruma Drama

A trick-taking card game for 3 to 5 players, played in the browser. About 30 to 40 minutes a game, ages 10 and up.

*Fall seven times, stand up eight.* Every card you lose with stays in front of you, knocked over, in a **fall line**. Your oldest fallen card is your own **personal trump**. Lose tricks to build a line, then win one to rise and bank every card in it as points. The art of the game is choosing when to stand up.

**Play it online: <https://www.wombatgamefactory.com/daruma-drama-game/>**

## How a game goes

- Everyone gets 11 cards (9 with five players). Together, each player secretly lays one card face up on its side in front of them: the **first fall**. The colour of the leftmost card in your line is your trump.
- The player left of the dealer leads. You must follow the colour led if you can. If you cannot, you may play any card, and a card of your trump colour will trump.
- The highest card of the colour led wins unless someone trumps. The highest trump wins.
- Every loser's card falls onto the right-hand end of their line (three cards at most: a fourth knocks the leftmost off, and your trump changes). The winner banks their whole line into their score pile (1 point a card, plus 2 bonus points for rising from a full line of three) and leads next with an empty line.
- A hand lasts until the cards run out. Cards still lying in a line are lost; you score the cards you banked. Everybody deals once, so a game is 3 to 5 hands. Highest total wins; if players tie, the one who left the fewest cards on their line at the ends of hands wins.

The printed rule book is in [`rules/`](rules/daruma-drama-rule-book-v5.pdf), and the page has a short how-to-play.

## What is in the game

- 3, 4 or 5 seats. Each seat can be a human or an Easy, Medium or Hard bot. Set every seat to a bot to watch a game.
- Pass and play: with two or more humans on one device, a cover hides each hand between turns, including during the simultaneous first fall.
- When you follow, a mark on each playable card shows whether it would win the trick as it stands, and every card you cannot play says why.
- For learners, you play every card yourself, even when only one is legal. Tick "Play forced cards for me" on the setup screen to have those played automatically.
- A **Playtest rules** panel on the setup screen with the rules that are still being tested (line limit, first fall, game format, hand size, 3-player deck, line cards at hand end, tiebreak, equal trumps, full-line bonus). Every recorded game notes which rules it used.
- A local stats screen with CSV and JSON export, split by the rules each game was played under. Results stay in your browser.
- A built-in "report a problem" button (also Ctrl+Shift+B) that saves a JSON snapshot of the game as it stands, for bug reports. Nothing is sent automatically; it prepares an email to info@wombatgamefactory.com.
- The live site uses Google Analytics behind a cookie-consent banner. It counts games started and finished, and for each finished game sends a short anonymous summary: number of players, the kind of seat that won (human, a bot level, or shared), the winning score and margin, whether the tiebreak was used, and which rules were on. No names or free text are sent. Neither the banner nor Analytics loads on localhost.

## Run it locally

There is no build step and nothing to install. The game is plain JavaScript modules, HTML and CSS.

```sh
npm run dev
```

This serves the folder on <http://localhost:8080> (it uses `npx http-server`, so it needs Node.js and an internet connection the first time). Any other static file server works too: serve the repository root and open `index.html` through it. Opening the file directly from disk will not work in most browsers, because modules need a server.

Two URL options are handy while testing: `?seed=7` makes the deals repeatable, and `?botdelay=50` sets the pause (in milliseconds) before each bot move.

## Tests

```sh
npm test
```

Runs every Node test suite: the engine's purity, the rules (one check per numbered rule), a replay of games recorded from the original Python simulator, a smoke test that plays thousands of bot games under every rules variant, the game controller, the three bot levels, the simulator, the stats store, the analytics whitelist and the interface helpers. It needs only Node.js.

```sh
npm run test:browser
```

Drives the real page in headless Chromium: full games against each bot level at 3, 4 and 5 players, pass-and-play, a game under non-standard rules, the stats screen and exports, the bug reporter and several screen widths. This one needs [Playwright](https://playwright.dev) (`npm install -g playwright`, then `npx playwright install chromium`); the tests look for it in the global npm folder, or in the folder named by the `PLAYWRIGHT_PATH` environment variable.

Two more scripts are for people preparing a release:

```sh
npm run qa      # a longer browser run from a sub-path, with screenshots in your temp folder
npm run sweep   # checks that nothing private or oversized is in the files that would be published
```

## The bots

- **Easy** plays a random legal card.
- **Medium** is a port of the "timed" bot from the original Python simulator: it loses on purpose to build a line, and rises when its line is full or the hand is nearly over.
- **Hard** searches: it samples the cards it cannot see, plays each candidate out to the end of the hand against Medium-style opponents, and picks the card with the best expected score margin. It runs in a Web Worker so the page never freezes.

## Simulations

The bots and the rules can be measured without a browser. `npm run sim` plays many bot-versus-bot games and writes a JSON record; `tests/sim-report.mjs` summarises it.

```sh
# 400 four-player games, Medium at every seat, with 5% random noise so the seats are not copies of each other
npm run sim -- --players=4 --seats=medium --games=400 --seed=1 --jitter=5 --out=tests/tmp/medium.json

# 200 three-player games, one Hard against two Medium bots, under a non-standard rule set
npm run sim -- --players=3 --seats=hard,medium,medium --games=200 --seed=1 --variant.LINE_LIMIT=2 --variant.LEFTOVER=minus1 --out=tests/tmp/hard-v-medium.json

node tests/sim-report.mjs tests/tmp/medium.json tests/tmp/hard-v-medium.json
```

The header of `tests/sim.mjs` lists every option. Output goes to `tests/tmp/`, which is not tracked.

## Project layout

```text
index.html, style.css      the page and its styles
src/engine/                the rules: pure functions on a plain-JSON game state (no DOM, no clock)
src/bots/                  Easy, Medium and Hard bots (and a "greedy" bot the simulator can seat)
src/ui/                    the interface: setup page, game screen, stats, bug reporter, analytics
assets/                    runtime art, and manifest.json listing every image
rules/                     the printed rule book (PDF)
tests/                     Node suites, Playwright suites, the simulator and tests/qa (QA run and sweep)
```

The engine never touches the page, so the same code runs in the browser, in the Node tests and in the simulator.

## Credits

Game design: Dean Morris, Wombat Game Factory. Prototype art.
