// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake RSCP client (the
// client itself is tested against a fake system on 127.0.0.1 in
// test/client.test.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { E3dcApp } from '../src/app.js';
import { ACTIONS, RETRY_MIN } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';
import { E3dcError } from '../src/e3dc/client.js';
import { decodeItems } from '../src/e3dc/rscp.js';
import { createMemoryStore } from '../src/store.js';
import { dayAnswer, liveAnswer } from './helpers/fakeE3dc.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const SELECTOR = 'e3dc';
const SERIAL = 'S10-123456789012';
const DEVICE = `ext:${SELECTOR}:system:${SERIAL}`;
const F = (key) => `${DEVICE}:${key}`;
const SECRETS = { username: 'me@example.com', password: 'S3cret-Pass!', key: 'K3y-Xyz-9' };
const CONFIG = {
  address: '192.168.1.50',
  username: SECRETS.username,
  password: SECRETS.password,
  rscp_key: SECRETS.key,
};
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const POLL = 30 * SECOND;
/** 2026-10-24 10:00 in Berlin (CEST, UTC+2). */
const NOW = Date.UTC(2026, 9, 24, 8, 0);

function createLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
}

/** A fake client: `script` gives each answer (or throws an E3dcError). */
function createClient(script) {
  const calls = [];
  return {
    calls,
    async read(credentials, window, alive) {
      calls.push({ credentials, window });
      return script(calls.length, { credentials, window, alive });
    },
  };
}

/** The answer of a read: live values and the energies of the day (Wh). */
const answer = ({ live = {}, day = {}, dayFailed } = {}) => {
  const [dayItem] = decodeItems(dayAnswer(day));
  return {
    live: decodeItems(liveAnswer(live)),
    day: dayFailed ? undefined : dayItem,
    dayFailed,
  };
};

/** The device as the user created it from the discovered one. */
function created({ index, pvIndex } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const device = buildDevice(gladys, { serial: SERIAL, address: 'x' }, { pvIndex });
  if (index) {
    const feature = device.features.find((f) => f.external_id === F('pv_energy'));
    feature.last_value = index.value;
    feature.last_value_changed = new Date(index.at).toISOString();
  }
  return device;
}

async function setup({
  config = CONFIG,
  script = () => answer(),
  devices = [],
  store = createMemoryStore(),
  clock = { now: NOW },
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const timers = createFakeTimers();
  const logger = createLogger();
  const client = createClient((n, call) => script(n, call, clock));
  const app = new E3dcApp({
    gladys,
    logger,
    now: () => clock.now,
    monotonic: () => clock.now,
    timers,
    store,
    client,
  });
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.ACCEPT_HELD, () => app.acceptHeldIndex());
  gladys.onScanRequest(() => app.scan());
  /** `ms` later, the timer looks whether a read is due. */
  const tick = async (ms = POLL) => {
    clock.now += ms;
    await timers.runIntervals();
    await app.idle();
  };
  return { app, gladys, timers, clock, logger, client, tick, store };
}

const status = (gladys) => gladys.fake.connectionStatus;
const last = (gladys, key) => gladys.fake.lastState(F(key));
const text = (message) => `${message.en} ${message.fr}`;

test('nothing configured, or a field invalid: the status says so, nothing is read', async () => {
  for (const [config, words] of [
    [{}, /adresse IP du système E3\/DC/],
    [{ ...CONFIG, rscp_key: '' }, /mot de passe RSCP/],
    [{ ...CONFIG, rscp_key: 'k'.repeat(40) }, /trop long/],
    [{ ...CONFIG, address: 'u:p@x' }, /adresse n’est pas valide/],
  ]) {
    const { app, gladys, client } = await setup({ config });
    await app.start(config);
    await app.idle();
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, words);
    assert.equal(client.calls.length, 0);
    assert.match(String((await gladys.fake.action(ACTIONS.TEST)).data.message.fr), words);
  }
});

test('the first read: the device of the serial number in Discovery, no value before it is created', async () => {
  const { app, gladys, client } = await setup();
  await app.start(CONFIG);
  await app.idle();
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, `E3/DC ${SERIAL}`);
  assert.deepEqual(
    device.params.find((p) => p.name === 'E3DC_FIRMWARE'),
    { name: 'E3DC_FIRMWARE', value: 'S10_2026_041' },
  );
  assert.ok(device.features.every((f) => f.read_only));
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /Découverte/);
  // The window of today: from the midnight of Berlin.
  assert.deepEqual(client.calls[0].window, {
    start: Date.UTC(2026, 9, 23, 22) / 1000,
    span: 86_400,
    date: '2026-10-24',
  });
  assert.equal(client.calls[0].credentials.host, '192.168.1.50');
  assert.equal(client.calls[0].credentials.port, 5033);
});

test('a created system gets its values: signed powers as read, energies of the day, the index', async () => {
  const { app, gladys } = await setup({ devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'soc'), 77);
  assert.equal(last(gladys, 'pv_power'), 4321);
  assert.equal(last(gladys, 'battery_power'), -1500);
  assert.equal(last(gladys, 'grid_power'), -1234);
  assert.equal(last(gladys, 'house_power'), 820);
  assert.equal(last(gladys, 'autarky'), 87.5);
  assert.equal(last(gladys, 'pv_energy_today'), 12.346);
  assert.equal(last(gladys, 'grid_import_today'), 1.5);
  assert.equal(last(gladys, 'grid_export_today'), 2.5);
  assert.equal(last(gladys, 'pv_energy'), 12.346, 'the index starts from the counter of the day');
  assert.equal(last(gladys, 'pv_energy_production'), undefined, 'computed by the core');
  assert.equal(gladys.fake.publishedEnergyConsumption.length, 0);
  assert.match(status(gladys).message.en, /E3\/DC system S10-123456789012 answering/);
});

test('pace: never a read faster than the interval, not even a reconnection or a restart', async () => {
  const store = createMemoryStore();
  const { app, client, tick, clock } = await setup({ store });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(client.calls.length, 1);
  await tick(10 * SECOND);
  await app.start(CONFIG);
  await app.idle();
  assert.equal(client.calls.length, 1, 'a reconnection reads nothing sooner');
  await tick(25 * SECOND);
  assert.equal(client.calls.length, 2);
  // A restart of the container: the first read waits the minute + the interval.
  const again = await setup({ store, clock });
  await again.app.start(CONFIG);
  await again.app.idle();
  assert.equal(again.client.calls.length, 0);
  // The last session written: NOW (written at most once a minute); now NOW + 35 s.
  await again.tick(POLL);
  assert.equal(again.client.calls.length, 0, 'NOW + 65 s');
  await again.tick(POLL);
  assert.equal(again.client.calls.length, 1, 'NOW + 95 s: the minute and the interval passed');
});

test('log-in refused: a final stop kept in /data, never tried again by itself', async () => {
  const store = createMemoryStore();
  let refuse = true;
  const script = () => {
    if (refuse) throw new E3dcError('refused');
    return answer();
  };
  const { app, gladys, client, tick, clock } = await setup({ store, script });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(client.calls.length, 1);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /refuse la connexion/);
  assert.deepEqual(Object.keys(store.data.refusal), ['code', 'fp']);
  for (let i = 0; i < 24; i += 1) await tick(HOUR);
  assert.equal(client.calls.length, 1, 'no automatic retry, even a day later');
  // A restart: still stopped (the same fields).
  const again = await setup({ store, clock, script });
  await again.app.start(CONFIG);
  await again.app.idle();
  await again.tick(HOUR);
  assert.equal(again.client.calls.length, 0);
  // The test button tries once (the interval passed), still refused.
  const first = await gladys.fake.action(ACTIONS.TEST);
  assert.match(text(first.data.message), /refused|refus/);
  // New fields saved: tried at once; a success erases the refusal.
  refuse = false;
  await again.app.start({ ...CONFIG, password: 'other-pass' }, { fresh: true });
  await again.app.idle();
  assert.equal(again.client.calls.length, 1);
  assert.equal(store.data.refusal, null);
  assert.equal(status(again.gladys).connected, true);
});

test('the same refused fields saved again are not tried again; the test button tries once', async () => {
  const { app, client, gladys, tick } = await setup({
    script: () => {
      throw new E3dcError('refused');
    },
  });
  await app.start(CONFIG);
  await app.idle();
  await app.start(CONFIG, { fresh: true });
  await app.idle();
  assert.equal(client.calls.length, 1);
  await gladys.fake.action(ACTIONS.TEST);
  assert.equal(client.calls.length, 1, 'never faster than the interval, even by the button');
  await tick(POLL);
  await gladys.fake.action(ACTIONS.TEST);
  assert.equal(client.calls.length, 2, 'one try per click');
  await tick(POLL);
  assert.equal(client.calls.length, 2);
});

test('no readable answer to the log-in: tried again once 15 min later, the second in a row is a final stop', async () => {
  const { app, gladys, client, tick } = await setup({
    script: () => {
      throw new E3dcError('login_lost');
    },
  });
  await app.start(CONFIG);
  await app.idle();
  assert.match(status(gladys).message.fr, /pas de réponse lisible.*système en redémarrage/);
  // The second try waits 15 min (a system restarting must not stop for good).
  await tick(RETRY_MIN);
  await tick(13 * MINUTE);
  assert.equal(client.calls.length, 1);
  await tick(MINUTE + 5 * SECOND);
  assert.equal(client.calls.length, 2);
  assert.match(status(gladys).message.fr, /deux fois de suite.*mot de passe RSCP/);
  for (let i = 0; i < 12; i += 1) await tick(HOUR);
  assert.equal(client.calls.length, 2);
});

test('unreachable: tried again after 1 min, doubled, never a stop', async () => {
  let fail = true;
  const { app, gladys, client, tick } = await setup({
    script: () => {
      if (fail) throw new E3dcError('unreachable');
      return answer();
    },
  });
  await app.start(CONFIG);
  await app.idle();
  await tick(POLL);
  assert.equal(client.calls.length, 1);
  await tick(POLL);
  assert.equal(client.calls.length, 2);
  await tick(MINUTE);
  assert.equal(client.calls.length, 2, 'doubled: 2 min');
  fail = false;
  await tick(MINUTE);
  assert.equal(client.calls.length, 3);
  assert.equal(status(gladys).connected, true);
});

test('no secret in the logs, /data, the statuses, Discovery or the test answers', async () => {
  const store = createMemoryStore();
  let mode = 'refused';
  const script = () => {
    if (mode !== 'ok') throw new E3dcError(mode);
    return answer();
  };
  const { app, gladys, logger, tick } = await setup({ store, script, devices: [created()] });
  const seen = [];
  await app.start(CONFIG);
  await app.idle();
  seen.push(JSON.stringify(await gladys.fake.action(ACTIONS.TEST)));
  for (mode of ['login_lost', 'unreachable', 'ok']) {
    await app.start({ ...CONFIG, password: `${SECRETS.password}${mode}` }, { fresh: true });
    await app.idle();
    await tick(10 * MINUTE);
    seen.push(JSON.stringify(await gladys.fake.action(ACTIONS.TEST)));
  }
  const all = [
    ...logger.lines,
    JSON.stringify(store.data),
    JSON.stringify(gladys.fake.connectionStatuses),
    JSON.stringify(gladys.fake.discoveredDevices),
    JSON.stringify(gladys.fake.states),
    ...seen,
  ].join('\n');
  for (const secret of Object.values(SECRETS)) {
    assert.ok(!all.includes(secret), `a secret leaked: ${secret.slice(0, 2)}…`);
  }
  assert.ok(!all.includes('example.com'));
});

test('a serial number missing: nothing published, the status says why', async () => {
  const { app, gladys } = await setup({
    devices: [created()],
    script: () => answer({ live: { serial: null } }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(gladys.fake.states.length, 0);
  assert.match(status(gladys).message.fr, /numéro de série lisible/);
});

test('another serial number at the address: its own device, the values never go to the old one', async () => {
  let serial = SERIAL;
  const { app, gladys, tick } = await setup({
    devices: [created()],
    script: () => answer({ live: { serial } }),
  });
  await app.start(CONFIG);
  await app.idle();
  const before = gladys.fake.states.length;
  serial = 'S10-999999999999';
  await tick(POLL);
  assert.equal(gladys.fake.states.length, before, 'nothing to the device of the other serial');
  assert.equal(gladys.fake.discoveredDevices[0].external_id, `ext:${SELECTOR}:system:${serial}`);
});

test('the energies of the day missing: only them, the status says so', async () => {
  const { app, gladys } = await setup({
    devices: [created()],
    script: () => answer({ dayFailed: 'timeout' }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'pv_power'), 4321);
  assert.equal(last(gladys, 'pv_energy_today'), undefined);
  assert.equal(last(gladys, 'pv_energy'), undefined);
  assert.match(status(gladys).message.fr, /énergies du jour/);
});

/** Every rise of the published index, as the core counts it. */
const counted = (gladys) => {
  const values = gladys.fake.states
    .filter((s) => s.device_feature_external_id === F('pv_energy'))
    .map((s) => s.state);
  let sum = 0;
  for (let i = 1; i < values.length; i += 1) sum += Math.max(0, values[i] - values[i - 1]);
  return { values, sum: Math.round(sum * 1000) / 1000 };
};

test('the index across midnight: the counter of the day starts again, the index goes on', async () => {
  // 23:50 in Berlin, 20 kWh today; after midnight the new day counts from 0.
  const clock = { now: Date.UTC(2026, 9, 24, 21, 50) };
  let pv = 20000;
  const { app, gladys, tick } = await setup({
    clock,
    devices: [created({ index: { value: 1000, at: clock.now - HOUR } })],
    script: () => answer({ day: { pv }, live: { pv: 0 } }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'pv_energy'), 1000, 'goes on from the index Gladys holds');
  pv = 20000;
  await tick(5 * MINUTE);
  pv = 0;
  await tick(10 * MINUTE); // 00:05: a new day
  pv = 1500;
  await tick(10 * HOUR);
  pv = 1700;
  await tick(POLL);
  const { values, sum } = counted(gladys);
  assert.ok(
    values.every((v, i) => i === 0 || v >= values[i - 1]),
    'never down',
  );
  // Counted: what the new day produced from its first read (0) to 1.7 kWh,
  // the 1.5 kWh after a 10 h gap being within the margin.
  assert.equal(sum, 1.7);
  assert.equal(gladys.fake.publishedEnergyConsumption.length, 0);
});

test('a counter of the day by steps: a step after equal reads is taken, a jump is not', async () => {
  let pv = 10000;
  const { app, gladys, tick } = await setup({
    devices: [created({ index: { value: 500, at: NOW - MINUTE } })],
    script: () => answer({ day: { pv }, live: { pv: 8000 } }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'pv_energy'), 500);
  // 15 minutes of equal reads, then a step of 2 kWh (8 kW × 15 min).
  for (let i = 0; i < 30; i += 1) await tick(POLL);
  pv = 12000;
  await tick(POLL);
  assert.equal(last(gladys, 'pv_energy'), 502);
  // A jump of 50 kWh in 30 s: never taken (nor confirmed by time), the status says so.
  pv = 62000;
  await tick(POLL);
  await tick(POLL);
  assert.equal(last(gladys, 'pv_energy'), 502);
  assert.equal(counted(gladys).sum, 2);
  assert.match(status(gladys).message.fr, /index de production solaire n’a pas été mis à jour/);
});

test('a drop of the built index is never accepted: it corrects itself, counted once (E1b)', async () => {
  // 23:29 in Berlin: the database answers 20 kWh, then 0 by mistake (taken
  // as the new day), then 0.3 kWh (published: 0.3 kWh counted), then 20.1
  // kWh 4 min later (the new day undone: the built index drops to 1000.1).
  const clock = { now: Date.UTC(2026, 9, 24, 21, 29) };
  let pv = 20000;
  const { app, gladys, tick } = await setup({
    clock,
    devices: [created({ index: { value: 1000, at: clock.now - HOUR } })],
    script: () => answer({ day: { pv }, live: { pv: 500 } }),
  });
  await app.start(CONFIG);
  await app.idle();
  pv = 0;
  await tick(POLL);
  pv = 300;
  await tick(POLL);
  assert.equal(last(gladys, 'pv_energy'), 1000.3);
  pv = 20100;
  await tick(4 * MINUTE);
  assert.equal(last(gladys, 'pv_energy'), 1000.3, 'the drop is held');
  assert.match(status(gladys).message.fr, /baisse de 1000\.3 à 1000\.1 kWh.*jamais acceptée/);
  assert.doesNotMatch(status(gladys).message.fr, /cliquez deux fois/);
  // Two clicks accept nothing.
  const one = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(one.data.message.fr, /est une baisse : elle n’est jamais acceptée/);
  await tick(5 * SECOND);
  const two = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.doesNotMatch(two.data.message.fr, /Accepté/);
  // The climb back: only the energy above 1000.3 is counted.
  for (const v of [20200, 20300, 20500]) {
    pv = v;
    await tick(POLL);
  }
  const { values, sum } = counted(gladys);
  assert.ok(!values.includes(1000.1), '1000.1 never published');
  assert.ok(
    values.every((v, k) => k === 0 || v >= values[k - 1]),
    'never down',
  );
  assert.equal(last(gladys, 'pv_energy'), 1000.5);
  // 0.3 counted too early, then only 1000.3 -> 1000.5: 0.5 kWh, the real 20 -> 20.5.
  assert.equal(sum, 0.5);
});

test('the step cover never widens the daily margin beyond the guard margin', async () => {
  for (const [power, plateau] of [
    [500, 5],
    [8000, 15],
    [30000, 20],
    [30000, 40],
    [0, 30],
  ]) {
    let pv = 10000;
    const { app, gladys, tick } = await setup({
      devices: [created({ index: { value: 500, at: NOW - MINUTE } })],
      script: () => answer({ day: { pv }, live: { pv: power } }),
    });
    await app.start(CONFIG);
    await app.idle();
    const id = F('pv_energy');
    const daily = app.dailies.get(id);
    const guard = app.guards.get(id);
    const seen = [];
    const read = daily.read.bind(daily);
    daily.read = (today, at, known, options) => {
      const s = daily.state();
      const margin = (daily.limits.maxKw * (at - s.readAt)) / HOUR + daily.limits.slackKwh;
      seen.push({ margin, guard: guard.margin(guard.last.at, at) });
      return read(today, at, known, options);
    };
    for (let k = 0; k < plateau * 2; k += 1) await tick(POLL);
    pv = 10000 + 50_000;
    await tick(POLL);
    assert.ok(seen.length > 0);
    for (const { margin, guard: g } of seen) {
      assert.ok(margin <= g + 1e-9, `${power} W, ${plateau} min: ${margin} > ${g}`);
    }
    assert.ok(gladys.fake.states.length > 0);
  }
});

test('the days the clocks change (25 h and 23 h): the window, and the index counts the real energy', async () => {
  for (const [start, span] of [
    [Date.UTC(2026, 9, 24, 22), 25 * 3600], // 2026-10-25 in Berlin
    [Date.UTC(2026, 2, 28, 23), 23 * 3600], // 2026-03-29 in Berlin
  ]) {
    // Read from 01:00 local; 0.5 kWh per hour all day long, and the next day.
    const clock = { now: start + HOUR };
    const end = start + span * 1000;
    // The counter of the day of the window asked (Wh): 0.5 kWh per hour.
    const counter = (window, at) => {
      const from = window.start * 1000;
      const to = Math.min(at, from === start ? end : at);
      return Math.max(0, (to - from) / HOUR) * 500;
    };
    const { app, gladys, client, tick } = await setup({
      clock,
      devices: [created({ index: { value: 100, at: start } })],
      script: (n, { window }, c) =>
        answer({ day: { pv: counter(window, c.now) }, live: { pv: 500 } }),
    });
    await app.start(CONFIG);
    await app.idle();
    assert.equal(client.calls[0].window.span, span);
    assert.equal(client.calls[0].window.start * 1000, start);
    // Every 10 min across the end of the day and two hours after.
    while (clock.now < end + 2 * HOUR) await tick(10 * MINUTE);
    const { values, sum } = counted(gladys);
    assert.ok(
      values.every((v, k) => k === 0 || v >= values[k - 1]),
      'never down',
    );
    // Real: from 01:00 to the end of the day, then two hours: never more,
    // less by at most the last 10 min before midnight.
    const produced = (span / 3600 - 1) * 0.5 + 1;
    assert.ok(sum <= produced + 1e-6, `${sum} > ${produced}`);
    assert.ok(sum >= produced - 0.1, `${sum} < ${produced} - 0.1`);
  }
});

test('/data cannot be written: the index is not sent, the other values are', async () => {
  const store = createMemoryStore();
  store.save = async () => {
    const err = new Error('read-only');
    err.code = 'EROFS';
    throw err;
  };
  const { app, gladys, logger } = await setup({ store, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'pv_power'), 4321);
  assert.equal(last(gladys, 'pv_energy_today'), 12.346);
  assert.equal(last(gladys, 'pv_energy'), undefined);
  assert.ok(logger.lines.some((l) => /EROFS/.test(l)));
});

test('back from "Sensor only": the first value is held, two clicks accept exactly it', async () => {
  const store = createMemoryStore();
  let pv = 10000;
  const { app, gladys, tick } = await setup({
    store,
    devices: [created({ index: { value: 500, at: NOW - MINUTE } })],
    script: () => answer({ day: { pv } }),
  });
  await app.start(CONFIG);
  await app.idle();
  await app.start({ ...CONFIG, pv_index: 'sensor_only' }, { fresh: true });
  await tick(POLL);
  pv = 11000;
  await tick(10 * MINUTE);
  await app.start(CONFIG, { fresh: true });
  await tick(POLL);
  assert.equal(last(gladys, 'pv_energy'), 500);
  assert.match(status(gladys).message.fr, /saut de 500 à 501 kWh, retenu/);
  const nothing = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(nothing.data.message.fr, /Un second clic/);
  await tick(5 * SECOND);
  const done = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(done.data.message.fr, /Accepté : index de production solaire 501 kWh/);
  await tick(POLL);
  assert.equal(last(gladys, 'pv_energy'), 501);
});

test('"Sensor only": no index declared nor published; a created index keeps its feature', async () => {
  const config = { ...CONFIG, pv_index: 'sensor_only' };
  const { app, gladys } = await setup({ config, devices: [created({ pvIndex: 'sensor_only' })] });
  await app.start(config);
  await app.idle();
  const keys = gladys.fake.discoveredDevices[0].features.map((f) => f.external_id);
  assert.ok(!keys.includes(F('pv_energy')));
  assert.equal(last(gladys, 'pv_energy_today'), 12.346);
  assert.equal(last(gladys, 'pv_energy'), undefined);
  const withIndex = await setup({ config, devices: [created()] });
  await withIndex.app.start(config);
  await withIndex.app.idle();
  const kept = withIndex.gladys.fake.discoveredDevices[0].features.map((f) => f.external_id);
  assert.ok(kept.includes(F('pv_energy')) && kept.includes(F('pv_energy_production')));
  assert.equal(withIndex.gladys.fake.lastState(F('pv_energy')), undefined);
});

test('a read that ends after a new configuration publishes nothing and sets no status', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { app, gladys, client } = await setup({
    devices: [created()],
    script: async (n) => {
      if (n === 1) await gate;
      return answer();
    },
  });
  await app.start(CONFIG);
  const statuses = gladys.fake.connectionStatuses.length;
  const restart = app.start({ ...CONFIG, address: '192.168.1.51' }, { fresh: true });
  release();
  await restart;
  await app.idle();
  // The second start read at once (a new address); the late first read published nothing.
  assert.equal(client.calls.length, 2);
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  const pv = gladys.fake.states.filter((s) => s.device_feature_external_id === F('pv_power'));
  assert.equal(pv.length, 1);
});

test('read-only: no command handler; the test button never reads faster than the pace', async () => {
  const { app, gladys, client } = await setup();
  await app.start(CONFIG);
  await app.idle();
  const result = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(client.calls.length, 1);
  assert.match(result.data.message.fr, /prochaine lecture possible/);
  assert.match(result.data.message.fr, /connexion acceptée/);
});
