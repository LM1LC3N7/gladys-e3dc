// -----------------------------------------------------------------------------
// What /data keeps (src/store.js): never a secret, a truncated fingerprint of
// a refused log-in only, everything checked when read back.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, readState } from '../src/store.js';

const NOW = Date.UTC(2026, 9, 24, 12);
const SALT = '0123456789abcdef0123456789abcdef';
const LOGIN = { username: 'me@example.com', password: 'secret-pass', key: 'abc123' };

test('the fingerprint is 8 bits: it cannot confirm a password (brute force finds many)', () => {
  const fp = fingerprint(SALT, 'h:5033', LOGIN);
  assert.match(fp, /^[0-9a-f]{2}$/);
  assert.equal(fingerprint(SALT, 'h:5033', LOGIN), fp, 'stable');
  // An attacker with /data tries 400 RSCP passwords: already several match
  // the fingerprint (1 in 256), the real one cannot be told from them.
  let matches = 0;
  for (let i = 0; i < 400; i += 1) {
    if (fingerprint(SALT, 'h:5033', { ...LOGIN, key: `guess-${i}` }) === fp) matches += 1;
  }
  assert.ok(matches >= 2, `${matches} other passwords share the fingerprint`);
  assert.notEqual(fingerprint('f'.repeat(32), 'h:5033', LOGIN).length, 0);
});

test('read back: odd fields dropped, the time of the last session never in the future', () => {
  const s = readState(
    {
      salt: SALT,
      address: 'h:5033',
      lastAttemptAt: NOW + 3_600_000,
      refusal: { code: 'refused', fp: 'ab' },
      lost: { count: 99, fp: 'cd' },
      info: { serial: 's10-12345', firmware: 'S10_1' },
      indexes: { a: { guard: {} } },
    },
    NOW,
  );
  assert.equal(s.lastAttemptAt, NOW);
  assert.deepEqual(s.refusal, { code: 'refused', fp: 'ab' });
  assert.deepEqual(s.lost, { count: 32, fp: 'cd' });
  assert.deepEqual(s.info, { serial: 'S10-12345', firmware: 'S10_1' });
  const odd = readState(
    {
      salt: 'x',
      address: 'h',
      refusal: { code: 'refused', fp: 'abcdef' },
      info: { serial: '<x>' },
      pvMode: 'x',
    },
    NOW,
  );
  assert.equal(odd.refusal, null);
  assert.equal(odd.info, null);
  assert.equal(odd.pvMode, null);
  assert.match(odd.salt, /^[0-9a-f]{32}$/);
  assert.equal(readState(null, NOW).address, null);
});

test('read back: the indexes have no prototype, only ids of an index feature', () => {
  const raw = JSON.parse(
    '{"address":"h:5033","indexes":{"__proto__":{"polluted":1},"x":{},' +
      '"ext:e3dc:system:S10-123:pv_energy":{"guard":{}}}}',
  );
  const s = readState(raw, NOW);
  assert.equal(Object.getPrototypeOf(s.indexes), null);
  assert.deepEqual(Object.keys(s.indexes), ['ext:e3dc:system:S10-123:pv_energy']);
  assert.equal({}.polluted, undefined);
});
