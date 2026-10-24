// -----------------------------------------------------------------------------
// The RSCP client against a fake E3/DC system on 127.0.0.1 (test/helpers):
// log-in, the live values, the energies of the day, the refusals, the bounds
// of the frames, one session at a time, read-only, no secret on the wire.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E3dcClient, LIVE_REQUESTS } from '../src/e3dc/client.js';
import { parseDay, parseLive } from '../src/e3dc/model.js';
import { TAG } from '../src/e3dc/rscp.js';
import { liveAnswer, startFakeE3dc } from './helpers/fakeE3dc.js';

const WINDOW = { start: 1_792_000_000, span: 86_400 };
const FAST = { connect: 1000, answer: 400, session: 3000 };
const client = () => new E3dcClient({ timeouts: FAST });

async function withFake(options, fn) {
  const fake = await startFakeE3dc(options);
  try {
    await fn(fake);
  } finally {
    await fake.close();
  }
}

const codeOf = async (promise) => {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return err.code;
  }
};

test('a read: log-in, live values, energies of the day, one connection, closed after', async () => {
  await withFake({}, async (fake) => {
    const answer = await client().read(fake.credentials(), WINDOW);
    const live = parseLive(answer.live);
    assert.equal(live.serial, 'S10-123456789012');
    assert.equal(live.firmware, 'S10_2026_041');
    assert.equal(live.pvPower, 4321);
    assert.equal(live.batteryPower, -1500);
    assert.equal(live.gridPower, -1234);
    assert.equal(live.soc, 77);
    assert.equal(live.autarky, 87.5);
    const day = parseDay(answer.day);
    assert.equal(day.pvDay, 12.3455);
    assert.equal(day.gridImportDay, 1.5);
    assert.equal(day.gridExportDay, 2.5);
    assert.equal(answer.dayFailed, undefined);
    assert.deepEqual(fake.record.windows, [WINDOW]);
    assert.equal(fake.record.connections, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fake.record.open, 0, 'the session is closed after the read');
  });
});

test('read-only: only the log-in and read requests ever reach the system', async () => {
  await withFake({}, async (fake) => {
    await client().read(fake.credentials(), WINDOW);
    const allowed = new Set([
      TAG.REQ_AUTHENTICATION,
      TAG.DB_REQ_HISTORY_DATA_DAY,
      ...LIVE_REQUESTS,
    ]);
    assert.ok(fake.record.tags.length > 0);
    for (const tag of fake.record.tags) {
      assert.ok(allowed.has(tag), `tag 0x${tag.toString(16)}`);
    }
  });
});

test('no secret in clear on the wire: the frames are enciphered', async () => {
  await withFake({ password: 'Visible-Pass-42', username: 'who@example.com' }, async (fake) => {
    await client().read(fake.credentials(), WINDOW);
    const wire = Buffer.concat(fake.record.raw);
    for (const secret of ['Visible-Pass-42', 'who@example.com', 'abc123']) {
      assert.equal(wire.indexOf(Buffer.from(secret)), -1, secret);
    }
  });
});

test('answers cut in pieces of 1 or 5 bytes are put back together', async () => {
  for (const chunk of [1, 5]) {
    await withFake({ chunk }, async (fake) => {
      const answer = await client().read(fake.credentials(), WINDOW);
      assert.equal(parseLive(answer.live).pvPower, 4321);
      assert.equal(parseDay(answer.day).pvDay, 12.3455);
    });
  }
});

test('a wrong account is refused; a level 0 too', async () => {
  await withFake({}, async (fake) => {
    assert.equal(
      await codeOf(client().read(fake.credentials({ password: 'nope' }), WINDOW)),
      'refused',
    );
  });
  await withFake({ onLogin: 'level0' }, async (fake) => {
    assert.equal(await codeOf(client().read(fake.credentials(), WINDOW)), 'refused');
  });
});

test('a wrong RSCP password: the system closes, the log-in is lost (never a value)', async () => {
  await withFake({}, async (fake) => {
    assert.equal(
      await codeOf(client().read(fake.credentials({ key: 'another' }), WINDOW)),
      'login_lost',
    );
    assert.equal(fake.record.logins, 0, 'the system could not read the log-in');
  });
  for (const onLogin of ['close', 'silent', 'garbage']) {
    await withFake({ onLogin }, async (fake) => {
      assert.equal(await codeOf(client().read(fake.credentials(), WINDOW)), 'login_lost', onLogin);
    });
  }
});

test('nothing listening: unreachable', async () => {
  const fake = await startFakeE3dc();
  const credentials = fake.credentials();
  await fake.close();
  assert.equal(await codeOf(client().read(credentials, WINDOW)), 'unreachable');
});

test('a bad CRC or bytes after the frame end the session', async () => {
  await withFake({ badCrc: true }, async (fake) => {
    // The log-in answer itself is broken: lost.
    assert.equal(await codeOf(client().read(fake.credentials(), WINDOW)), 'login_lost');
  });
  await withFake({ after: () => Buffer.from([0, 0, 0, 1]) }, async (fake) => {
    assert.equal(await codeOf(client().read(fake.credentials(), WINDOW)), 'protocol');
  });
  await withFake({ after: () => Buffer.alloc(40) }, async (fake) => {
    // More than the padding of one block, even zeros: not one frame.
    assert.equal(await codeOf(client().read(fake.credentials(), WINDOW)), 'protocol');
  });
});

test('the energies of the day are secondary: an error leaves only them out', async () => {
  for (const dayMode of ['error', 'close']) {
    await withFake({ dayMode }, async (fake) => {
      const answer = await client().read(fake.credentials(), WINDOW);
      assert.equal(parseLive(answer.live).pvPower, 4321);
      assert.equal(answer.day, undefined);
      assert.ok(answer.dayFailed, dayMode);
    });
  }
});

test('a live value the system refuses is left out, the others are read', async () => {
  await withFake({ live: () => liveAnswer({ pv: 'error', grid: 'error' }) }, async (fake) => {
    const live = parseLive((await client().read(fake.credentials(), WINDOW)).live);
    assert.equal(live.pvPower, undefined);
    assert.equal(live.gridPower, undefined);
    assert.equal(live.housePower, 820);
  });
});

test('one session at a time: a second read while one runs is refused, never opened', async () => {
  await withFake({ chunk: 3 }, async (fake) => {
    const c = client();
    const first = c.read(fake.credentials(), WINDOW);
    assert.equal(await codeOf(c.read(fake.credentials(), WINDOW)), 'busy');
    await first;
    assert.equal(fake.record.connections, 1);
    assert.equal(fake.record.maxOpen, 1);
  });
});

test('a session stopped between two requests (a new configuration) is aborted', async () => {
  await withFake({}, async (fake) => {
    let calls = 0;
    const alive = () => {
      calls += 1;
      return calls < 2;
    };
    assert.equal(await codeOf(client().read(fake.credentials(), WINDOW, alive)), 'aborted');
    assert.ok(!fake.record.tags.includes(TAG.DB_REQ_HISTORY_DATA_DAY));
  });
});
