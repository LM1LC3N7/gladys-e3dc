// -----------------------------------------------------------------------------
// The configuration of the form, normalized (src/config.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress, timeZoneOf } from '../src/config.js';

const FULL = {
  address: '192.168.1.50',
  username: 'me@example.com',
  password: ' pass with spaces ',
  rscp_key: 'abc123',
};

test('addresses: port 5033 by default, a URL reduced, user:password@ refused', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), {
    address: '192.168.1.50:5033',
    host: '192.168.1.50',
    port: 5033,
  });
  assert.equal(parseAddress('http://S10.local:5034/x').address, 's10.local:5034');
  assert.deepEqual(parseAddress('[fe80::1]:5033'), {
    address: '[fe80::1]:5033',
    host: 'fe80::1',
    port: 5033,
  });
  assert.deepEqual(parseAddress('u:p@host'), { error: 'invalid' });
  assert.deepEqual(parseAddress('host:0'), { error: 'invalid' });
  assert.deepEqual(parseAddress(''), { empty: true });
});

test('a complete form; the password is never trimmed', () => {
  const c = normalizeConfig(FULL);
  assert.equal(c.problem, undefined);
  assert.equal(c.password, ' pass with spaces ');
  assert.equal(c.key, 'abc123');
  assert.equal(c.username, 'me@example.com');
  assert.equal(c.pollInterval, 30);
  assert.equal(c.pvIndex, 'energy_monitoring');
  assert.equal(c.timeZone, 'Europe/Berlin');
});

test('each missing or invalid field is named, and no secret is kept then', () => {
  const cases = [
    [{}, 'address_missing'],
    [{ ...FULL, address: 'a b' }, 'address_invalid'],
    [{ ...FULL, username: ' ' }, 'username_missing'],
    [{ ...FULL, username: 'a\nb' }, 'username_invalid'],
    [{ ...FULL, password: '' }, 'password_missing'],
    [{ ...FULL, password: 'x'.repeat(257) }, 'password_invalid'],
    [{ ...FULL, rscp_key: '' }, 'key_missing'],
    [{ ...FULL, rscp_key: 'k'.repeat(33) }, 'key_invalid'],
    [{ ...FULL, rscp_key: 'é'.repeat(17) }, 'key_invalid'],
    [{ ...FULL, rscp_key: 'ab\u0000' }, 'key_invalid'],
  ];
  for (const [raw, problem] of cases) {
    const c = normalizeConfig(raw);
    assert.equal(c.problem, problem, JSON.stringify(raw).slice(0, 60));
    assert.equal(c.password, undefined);
    assert.equal(c.key, undefined);
  }
});

test('interval, option and time zone', () => {
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: '120' }).pollInterval, 120);
  assert.equal(normalizeConfig({ poll_interval: 9999 }).pollInterval, 300);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 30);
  assert.equal(normalizeConfig({ pv_index: 'sensor_only' }).pvIndex, 'sensor_only');
  assert.equal(normalizeConfig({ pv_index: 'x' }).pvIndex, 'energy_monitoring');
  assert.equal(normalizeConfig({ time_zone: 'Europe/Vienna' }).timeZone, 'Europe/Vienna');
  const bad = normalizeConfig({ time_zone: 'Mars/Olympus' });
  assert.equal(bad.timeZone, 'Europe/Berlin');
  assert.equal(bad.timeZoneInvalid, true);
  assert.equal(timeZoneOf('../x'), undefined);
});
