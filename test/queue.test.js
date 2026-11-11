import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/core/ai/agent/queue.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeQueue(overrides = {}) {
  const config = { maxConcurrentChats: 2, maxConcurrentPerChat: 3, maxQueueDepth: 50, ...overrides };
  return createQueue({
    config,
    logger: { warn() {}, error() {}, debug() {} },
    metrics: { inc() {} },
    transport: { sendMessage: async () => {} },
    handle: async () => {},
  });
}

test('global concurrency cap holds when releases race new admissions', async () => {
  const queue = makeQueue();
  let active = 0;
  let peak = 0;
  /** @type {Array<() => void>} */
  const gates = [];
  const task = () =>
    new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      gates.push(() => {
        active -= 1;
        resolve(undefined);
      });
    });
  const all = [
    queue.parallel('c1', task),
    queue.parallel('c2', task),
    queue.parallel('c3', task),
    queue.parallel('c4', task),
  ];
  await tick();
  // Free both slots and admit two new tasks before the woken waiters resume.
  gates[0]();
  gates[1]();
  all.push(queue.parallel('c5', task), queue.parallel('c6', task));
  await tick();
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the cap of 2`);
  gates.slice(2).forEach((gate) => gate());
  await tick();
  gates.slice(4).forEach((gate) => gate());
  await Promise.all(all);
  assert.equal(queue.pending(), 0);
});

test('exclusive maintenance waits for running turns and blocks new turns', async () => {
  const queue = makeQueue({ maxConcurrentChats: 4 });
  /** @type {string[]} */
  const events = [];
  /** @type {() => void} */
  let finishTurn = () => {};
  const turnGate = new Promise((resolve) => {
    finishTurn = /** @type {() => void} */ (resolve);
  });
  const turn = queue.parallel('chat', async () => {
    events.push('turn:start');
    await turnGate;
    events.push('turn:end');
  });
  await tick();
  const maintenance = queue.exclusive('chat', async () => {
    events.push('maintenance:start');
    events.push('maintenance:end');
  });
  const nextTurn = queue.parallel('chat', async () => {
    events.push('next:start');
  });
  await tick();
  assert.deepEqual(events, ['turn:start']);
  finishTurn();
  await Promise.all([turn, maintenance, nextTurn]);
  assert.deepEqual(events, [
    'turn:start',
    'turn:end',
    'maintenance:start',
    'maintenance:end',
    'next:start',
  ]);
});

test('maintenance in one chat does not block turns in another chat', async () => {
  const queue = makeQueue({ maxConcurrentChats: 4 });
  /** @type {() => void} */
  let finishMaintenance = () => {};
  const gate = new Promise((resolve) => {
    finishMaintenance = /** @type {() => void} */ (resolve);
  });
  const maintenance = queue.exclusive('busy-chat', async () => {
    await gate;
  });
  await tick();
  let otherRan = false;
  const other = queue.parallel('other-chat', async () => {
    otherRan = true;
  });
  await tick();
  assert.equal(otherRan, true);
  finishMaintenance();
  await Promise.all([maintenance, other]);
});