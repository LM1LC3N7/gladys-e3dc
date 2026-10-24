// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. And the device
// only uses the units the core accepts for its categories.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  ACTIONS,
  POLL_DEFAULT,
  POLL_MAX,
  POLL_MIN,
  PV_ENERGY_MONITORING,
  PV_SENSOR_ONLY,
} from '../src/constants.js';
import { CATALOG, INDEXES, buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics; the same version everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  // Owned by the Release workflow (0.1.0 by hand, then each release).
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-e3dc:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-e3dc');
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.equal(manifest.network_discovery, undefined, 'no network scan');
  assert.match(manifest.gladys_version, />=\s*5\.2\.0/);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the docs say it was never tested with a real device', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+testé\s+avec\s+un\s+vrai\s+appareil/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) {
      assert.equal(typeof field.placeholder, 'object', `${field.key}.placeholder`);
    }
  }
});

test('the configuration matches the code; the secrets are described as kept, never shown', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'address',
    'username',
    'password',
    'rscp_key',
    'pv_index',
    'time_zone',
    'poll_interval',
  ]);
  assert.deepEqual(
    fields.pv_index.options.map((o) => o.value),
    [PV_ENERGY_MONITORING, PV_SENSOR_ONLY],
  );
  assert.equal(fields.pv_index.default, PV_ENERGY_MONITORING);
  assert.match(fields.pv_index.description.en, /counted twice.*before creating the device/);
  assert.equal(fields.address.type, 'string');
  assert.equal(fields.username.type, 'string');
  for (const key of ['password', 'rscp_key']) {
    assert.equal(fields[key].type, 'secret');
    assert.equal(fields[key].default, undefined, `${key}: never a default on a secret`);
    assert.match(fields[key].description.en, /Kept by Gladys in its database, never shown again/);
    assert.match(fields[key].description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
  }
  for (const field of manifest.config_schema) {
    if (field.type === 'secret') assert.equal('default' in field, false, field.key);
  }
  assert.equal(fields.time_zone.type, 'string');
  assert.equal(fields.time_zone.default, undefined, 'Europe/Berlin in the code when empty');
  assert.equal(fields.poll_interval.type, 'number');
  assert.equal(fields.poll_interval.default, POLL_DEFAULT);
  assert.equal(fields.poll_interval.min, POLL_MIN);
  assert.equal(fields.poll_interval.max, POLL_MAX);
  for (const link of fields.intro.links) {
    assert.match(link.url, /^https:\/\//);
  }
  assert.match(fields.intro.description.en, /Never tested with a real device/);
  assert.match(fields.intro.description.en, /portal is never contacted/);
});

test('the actions of the manifest are the handlers of the code; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes('onAction(ACTIONS.ACCEPT_HELD'));
  assert.ok(index.includes('onDeviceCreated'));
  assert.ok(index.includes('onScanRequest'));
  assert.ok(index.includes("on('connected'"));
  assert.ok(!index.includes('onSetValue'), 'no command: read-only');
  assert.match(manifest.actions[1].description.en, /First click: lists.*Second click/);
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /pye3dc/);
  assert.match(notices, /Copyright \(c\) 2017 Francesco Santini/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
});

test('the code never feeds the energy consumption endpoint, nor publishes a scene event', () => {
  for (const file of ['index.js', 'src/app.js', 'src/devices.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(|publishSceneEvent\(/, file);
  }
});

// The units the core accepts per category (server/utils/constants.js
// DEVICE_FEATURE_UNITS_BY_CATEGORY), for the categories used here.
const UNITS_BY_CATEGORY = {
  [C.BATTERY_STORAGE]: [U.PERCENT, U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.ENERGY_PRODUCTION_SENSOR]: [U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.GRID_SENSOR]: [U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.ENERGY_SENSOR]: [U.AMPERE, U.VOLT, U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.DEVICE_TEMPERATURE_SENSOR]: [U.CELSIUS, U.FAHRENHEIT],
  [C.UNKNOWN]: [],
};

test('every feature uses a unit the core accepts for its category; keys unique', () => {
  const gladys = createFakeGladys({ selector: 'e3dc' });
  const info = { serial: 'S10-1234567', address: 'x:5033' };
  const index = buildDevice(gladys, info);
  const sensor = buildDevice(gladys, info, { pvIndex: PV_SENSOR_ONLY });
  const ext = (d) => d.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(ext(index).includes('pv_energy') && ext(index).includes('pv_energy_production'));
  assert.ok(!ext(sensor).includes('pv_energy') && ext(sensor).includes('pv_energy_today'));
  // A device created with the index keeps it under "Sensor only" (no feature lost).
  const kept = buildDevice(gladys, info, { pvIndex: PV_SENSOR_ONLY, created: index });
  assert.ok(ext(kept).includes('pv_energy') && ext(kept).includes('pv_energy_production'));
  assert.equal(index.external_id, 'ext:e3dc:system:S10-1234567');
  const keys = new Set();
  for (const f of index.features) {
    assert.ok(f.category in UNITS_BY_CATEGORY, `${f.external_id}: ${f.category}`);
    if (f.unit !== undefined) {
      assert.ok(UNITS_BY_CATEGORY[f.category].includes(f.unit), `${f.external_id}: ${f.unit}`);
    } else {
      assert.equal(f.category, C.UNKNOWN, `${f.external_id}: a unit for its category`);
    }
    assert.equal(f.read_only, true, f.external_id);
    assert.ok(!keys.has(f.external_id));
    keys.add(f.external_id);
  }
});

test('no double count with the main meter: the solar index is the only index', () => {
  const indexTypes = new Set([
    TYPES.ENERGY_SENSOR.INDEX,
    TYPES.ENERGY_PRODUCTION_SENSOR.INDEX,
    TYPES.GRID_SENSOR.INPUT_INDEX,
    TYPES.GRID_SENSOR.OUTPUT_INDEX,
    TYPES.HOME_OUTPUT_SENSOR.INDEX,
    TYPES.BATTERY_STORAGE.CHARGE_INDEX,
    TYPES.BATTERY_STORAGE.DISCHARGE_INDEX,
  ]);
  const indexes = CATALOG.filter(
    (e) => e.spec.category !== C.UNKNOWN && indexTypes.has(e.spec.type),
  );
  assert.deepEqual(
    indexes.map((e) => e.key),
    INDEXES.map((i) => i.key),
  );
  assert.equal(indexes[0].spec.category, C.ENERGY_PRODUCTION_SENSOR);
  // The energies of the day, the grid and the battery: plain sensors, never counted.
  for (const key of [
    'house_consumption_today',
    'grid_import_today',
    'grid_export_today',
    'battery_power',
    'grid_power',
  ]) {
    assert.equal(CATALOG.find((e) => e.key === key).spec.category, C.UNKNOWN, key);
  }
  assert.ok(!CATALOG.some((e) => e.spec.category === C.ENERGY_SENSOR));
  assert.ok(!CATALOG.some((e) => e.spec.category === C.GRID_SENSOR));
  assert.ok(!CATALOG.some((e) => /daily/.test(e.spec.type)));
});
