// -----------------------------------------------------------------------------
// The window of "today" asked to the database (src/window.js): from the local
// midnight of the time zone, 23, 24 or 25 h long.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWindow } from '../src/window.js';

const iso = (s) => new Date(s * 1000).toISOString();

test('a day in Berlin, summer and winter, and around midnight', () => {
  const summer = dayWindow(Date.UTC(2026, 6, 10, 12), 'Europe/Berlin');
  assert.equal(iso(summer.start), '2026-07-09T22:00:00.000Z');
  assert.equal(summer.span, 86_400);
  assert.equal(summer.date, '2026-07-10');
  const winter = dayWindow(Date.UTC(2026, 0, 10, 23, 30), 'Europe/Berlin');
  assert.equal(winter.date, '2026-01-11');
  assert.equal(iso(winter.start), '2026-01-10T23:00:00.000Z');
  const before = dayWindow(Date.UTC(2026, 0, 10, 22, 59, 59), 'Europe/Berlin');
  assert.equal(before.date, '2026-01-10');
});

test('the days the clocks change: 23 h and 25 h', () => {
  assert.equal(dayWindow(Date.UTC(2026, 2, 29, 12), 'Europe/Berlin').span, 23 * 3600);
  assert.equal(dayWindow(Date.UTC(2026, 9, 25, 12), 'Europe/Berlin').span, 25 * 3600);
});

test('other time zones', () => {
  assert.equal(iso(dayWindow(Date.UTC(2026, 9, 24, 3), 'UTC').start), '2026-10-24T00:00:00.000Z');
  const ny = dayWindow(Date.UTC(2026, 9, 24, 3), 'America/New_York');
  assert.equal(ny.date, '2026-10-23');
  assert.equal(iso(ny.start), '2026-10-23T04:00:00.000Z');
  assert.equal(dayWindow(Date.UTC(2026, 9, 24, 3), 'Asia/Kolkata').date, '2026-10-24');
});
