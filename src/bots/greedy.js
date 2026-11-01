// greedy.js - the Python "greedy" bot, a simulator ARCHETYPE (id 'greedy'). Not offered in the UI menus
// (offered: false) but registered, so the simulator can seat it: --seats=greedy,timed,... uses ids from botLevels().
//
// Greedy is timed.js with one change: it wants to rise as soon as it has any card in its line, instead of
// waiting for a full line or the end of the hand (the "does timing your rise matter?" test).
// Everything else (first fall, leading, what to lose with, tie order) is shared with the timed bot, exactly as
// in the Python sim where both are the same class with a different wants_win().

import { chooseTimedFromView } from './timed.js';

export const greedyBot = {
  id: 'greedy',
  label: 'Greedy',
  offered: false,
  chooseAction(view) {
    return chooseTimedFromView('greedy', view);
  },
};
