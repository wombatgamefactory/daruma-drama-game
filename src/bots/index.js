// index.js - the bot registry, by level name.
//
// A bot is { id, label, chooseAction(view, rng) -> action, offered? }.
//   - `view` is viewFor(state, seat): never the full state (R20.3).
//   - `rng` is the bot's own RNG object; the driver derives it (deriveSeed(seed, 'bot', seat)).
//   - It must return one of legalActionsFromView(view): a { type: 'fall', card } during the
//     first fall, a { type: 'play', card } in a trick. It may keep no memory between calls
//     except caches that do not change its answers.
//   - `offered: false` keeps a bot out of the UI's seat menus (simulator archetypes).
//
// Levels: 'easy' (random.js), 'medium' (timed.js, port of the Python timed bot), 'hard' (hard.js,
// determinised Monte Carlo with timed rollouts) and the simulator-only archetype 'greedy' (greedy.js,
// offered: false; import it with getBot('greedy') or list it with botLevels()).

import { randomBot } from './random.js';
import { timedBot } from './timed.js';
import { greedyBot } from './greedy.js';
import { hardBot } from './hard.js';

const REGISTRY = new Map();

export function registerBot(bot) {
  if (!bot || typeof bot.id !== 'string' || typeof bot.chooseAction !== 'function') {
    throw new Error('A bot needs an id and a chooseAction(view, rng) function');
  }
  REGISTRY.set(bot.id, bot);
}

export function getBot(level) {
  const bot = REGISTRY.get(level);
  if (!bot) throw new Error(`Unknown bot level "${level}". Known: ${[...REGISTRY.keys()].join(', ')}`);
  return bot;
}

/** Every registered bot as { id, label, offered }. UI menus show those with offered !== false. */
export function botLevels() {
  return [...REGISTRY.values()].map((b) => ({ id: b.id, label: b.label, offered: b.offered !== false }));
}

registerBot(randomBot);
registerBot(timedBot);
registerBot(hardBot);
registerBot(greedyBot);
