// -----------------------------------------------------------------------------
// The answers -> values (src/e3dc/model.js): strict numbers, ranges, the
// serial number of the external id, the energies of the day in kWh.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firmwareOf, numberOf, parseDay, parseLive, serialOf } from '../src/e3dc/model.js';
import { TAG, TYPE, decodeItems } from '../src/e3dc/rscp.js';
import { dayAnswer, item, liveAnswer } from './helpers/fakeE3dc.js';

test('the live values, signed as read (battery and grid never split)', () => {
  const v = parseLive(decodeItems(liveAnswer()));
  assert.deepEqual(v, {
    serial: 'S10-123456789012',
    firmware: 'S10_2026_041',
    pvPower: 4321,
    batteryPower: -1500,
    housePower: 820,
    gridPower: -1234,
    addPower: 0,
    autarky: 87.5,
    selfConsumption: 64.25,
    soc: 77,
    wallboxPower: 0,
    wallboxSolarPower: 0,
  });
});

test('out of range or odd values are left out; a small negative stand-by is 0', () => {
  const v = parseLive(
    decodeItems(
      liveAnswer({ pv: -150, home: -5000, grid: 200_000, soc: 101, bat: 'error', wb: -10 }),
    ),
  );
  assert.equal(v.pvPower, 0);
  assert.equal(v.housePower, undefined);
  assert.equal(v.gridPower, undefined);
  assert.equal(v.soc, undefined);
  assert.equal(v.batteryPower, undefined);
  assert.equal(v.wallboxPower, 0);
});

test('a number is a number: an error, a text, NaN or a wrong size is not', () => {
  assert.equal(numberOf({ type: TYPE.ERROR, value: 6 }), undefined);
  assert.equal(numberOf({ type: TYPE.CSTRING, value: '5' }), undefined);
  assert.equal(numberOf({ type: TYPE.FLOAT32, value: NaN }), undefined);
  assert.equal(numberOf({ type: TYPE.INT32, bad: true }), undefined);
  assert.equal(numberOf({ type: TYPE.UCHAR8, value: 0 }), 0);
  assert.equal(numberOf(undefined), undefined);
});

test('the serial number of the external id: trimmed, upper-case, checked', () => {
  assert.equal(serialOf(' s10-1234567 '), 'S10-1234567');
  assert.equal(serialOf('721234567'), '721234567');
  for (const bad of ['', 'ab', 'S10:123', 'S10 123', 'x'.repeat(41), '../etc', 42, undefined]) {
    assert.equal(serialOf(bad), undefined, String(bad));
  }
  const v = parseLive(decodeItems(liveAnswer({ serial: 'S10\n<script>' })));
  assert.equal(v.serial, undefined);
  assert.equal(firmwareOf('S10_2026_041'), 'S10_2026_041');
  assert.equal(firmwareOf('<b>'), undefined);
});

test('the energies of the day: Wh -> kWh, the sum container (or the first one)', () => {
  const [day] = decodeItems(dayAnswer());
  assert.deepEqual(parseDay(day), {
    pvDay: 12.3455,
    batteryInDay: 4,
    batteryOutDay: 3,
    gridExportDay: 2.5,
    gridImportDay: 1.5,
    consumptionDay: 9,
  });
  // Without a sum container tag: the first container, as pye3dc reads it.
  const [other] = decodeItems(
    item(TAG.DB_HISTORY_DATA_DAY, TYPE.CONTAINER, [
      item(0x06800020, TYPE.CONTAINER, [item(TAG.DB_DC_POWER, TYPE.FLOAT32, 500)]),
    ]),
  );
  assert.equal(parseDay(other).pvDay, 0.5);
  assert.deepEqual(parseDay(undefined), {});
  const [negative] = decodeItems(dayAnswer({ pv: -1, consumption: 5e9 }));
  assert.equal(parseDay(negative).pvDay, undefined);
  assert.equal(parseDay(negative).consumptionDay, undefined);
});
