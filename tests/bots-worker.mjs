// bots-worker.mjs - a worker thread for tests/bots.mjs: runs one named job from bots-lib.mjs and posts the result.
import { parentPort, workerData } from 'node:worker_threads';
import { JOBS } from './bots-lib.mjs';

parentPort.postMessage(JOBS[workerData.job](workerData.args));
