import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordTransport } from '../src/platforms/discord/transport.js';
import { silentLogger } from '../test-utils/helpers.js';

function makeTransport(pings) {
  const client = {
    channels: {
      cache: new Map([
        ['c1', { sendTyping: async () => pings.push('c1') }],
        ['c2', { sendTyping: async () => pings.push('c2') }],
      ]),
    },
  };
  return createDiscordTransport({ token: 'test', client, logger: silentLogger });
}

test('parallel turns share one refcounted typing loop per channel', async () => {
  /** @type {string[]} */
  const pings = [];
  const transport = makeTransport(pings);

  const stopA = transport.startTyping('c1');
  const stopB = transport.startTyping('c1');
  assert.deepEqual(pings, ['c1'], 'the second turn must not ping again');

  await stopA();
  const stopC = transport.startTyping('c1');
  assert.deepEqual(pings, ['c1'], 'the loop survives while any turn holds it');

  await stopB();
  await stopC();
  const stopD = transport.startTyping('c1');
  assert.deepEqual(pings, ['c1', 'c1'], 'a fresh loop pings once after the last stop');

  const stopOther = transport.startTyping('c2');
  assert.deepEqual(pings, ['c1', 'c1', 'c2'], 'channels are independent');

  transport.stopAllTyping();
  await stopD();
  await stopOther();
});