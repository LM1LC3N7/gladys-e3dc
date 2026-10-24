// -----------------------------------------------------------------------------
// The Gladys device of the E3/DC system and its states. Pure.
//
// External id (forever): system:<SERIAL> (src/constants.js, src/e3dc/model.js
// serialOf). Feature keys (forever): see FEATURE below.
//
// Energy rules of the Gladys core (server/utils/constants.js, the comments of
// DEVICE_FEATURE_TYPES, and the rules of this project):
// - the ONLY index is the solar production (`energy-production-sensor` /
//   `index`, with its `thirty-minutes-production` declared here, ids
//   computed (UUID v5) so that an "Update" in Discovery keeps the same rows;
//   the integration never publishes that one). The system gives its solar
//   energy as a counter of the day only (its database, the day asked from
//   the local midnight): the cumulative index is built from it by
//   src/daily.js (from gladys-imeon, as it is) and goes through the guard
//   (src/guard.js, from gladys-p1-monitor, as it is): never 0, a jump or a
//   drop held until the user accepts it. With the option "Sensor only" (an
//   inverter already sends its production to Gladys), chosen before the
//   device is created, the index is not declared; a device created with it
//   keeps that feature, which then gets no value;
// - NO `energy-sensor` / `index`, no `daily-consumption`, never
//   publishEnergyConsumption: the house consumption and what is taken from
//   the grid are already counted by the main meter of the home (Linky...);
//   counted twice, they would be billed twice. They are plain sensors, kWh
//   of the day in the name, never cumulated, never an index. What is sent
//   into the grid (export) is never in `energy-sensor` either;
// - the battery and grid powers are ONE signed plain sensor each (their sign
//   is not confirmed on a real system): never `grid-sensor` / `power`, never
//   split into charge and discharge;
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY): % for battery-storage, W and kWh for
//   energy-production-sensor, none for unknown (the unit is in the name).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  DAY_ENERGY_MAX,
  ENERGY_MAX,
  EXTERNAL_ID_TYPE,
  POWER_MAX,
  PV_ENERGY_MONITORING,
} from './constants.js';

/** Feature keys (forever). */
export const FEATURE = {
  SOC: 'soc',
  BATTERY_POWER: 'battery_power',
  PV_POWER: 'pv_power',
  PV_ENERGY: 'pv_energy',
  /** 30-minute production: fed by the Gladys core from the index, never by the integration. */
  PV_30MIN: 'pv_energy_production',
  PV_TODAY: 'pv_energy_today',
  HOUSE_POWER: 'house_power',
  GRID_POWER: 'grid_power',
  ADD_POWER: 'additional_power',
  AUTARKY: 'autarky',
  SELF_CONSUMPTION: 'self_consumption',
  WALLBOX_POWER: 'wallbox_power',
  WALLBOX_SOLAR_POWER: 'wallbox_solar_power',
  BATTERY_IN_TODAY: 'battery_charge_today',
  BATTERY_OUT_TODAY: 'battery_discharge_today',
  GRID_IMPORT_TODAY: 'grid_import_today',
  GRID_EXPORT_TODAY: 'grid_export_today',
  CONSUMPTION_TODAY: 'house_consumption_today',
};

/**
 * The guarded indexes: their feature, the counter of the day they are built
 * from (src/e3dc/model.js parseDay), their limits (INDEX_LIMITS) and their
 * name in the texts (src/i18n.js).
 */
export const INDEXES = [{ name: 'pv', key: FEATURE.PV_ENERGY, day: 'pvDay' }];

/** The external ids of the system of `serial`. */
export const ids = (gladys, serial) => gladys.externalIds(EXTERNAL_ID_TYPE, serial);

/** Namespace of the feature ids of this integration (random, fixed forever). */
const ID_NAMESPACE = Buffer.from('3c9e1f7a52d84b06a1e7c4d29b8f6053', 'hex');

/** A deterministic UUID (version 5, RFC 9562) of a name (as gladys-apsystems). */
export function uuidOf(name) {
  const hash = createHash('sha1').update(ID_NAMESPACE).update(String(name), 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- The catalog ------------------------------------------------------------------
//
// Each entry: the feature key, the value of src/e3dc/model.js it shows, its
// rounding, how it is declared, and `index` for the entries of the energy
// monitoring only (option `pv_index`).

const def = (key, value, digits, spec, index = false) => ({ key, value, digits, spec, index });

const measure = (name, category, type, extra = {}) => ({ name, category, type, ...extra });
/** A value shown, never summed nor billed: no energy category, no unit (it is in the name). */
const plain = (name, extra = {}) => measure(name, C.UNKNOWN, T.SENSOR.DECIMAL, extra);
const watts = (name) => plain(`${name} (W)`, { max: POWER_MAX });
const signedWatts = (name) => plain(`${name} (W, signed)`, { min: -POWER_MAX, max: POWER_MAX });
const today = (name) => plain(`${name} (kWh, today, not counted)`, { max: DAY_ENERGY_MAX });
const index = (name, type) =>
  measure(name, C.ENERGY_PRODUCTION_SENSOR, type, { unit: U.KILOWATT_HOUR, max: ENERGY_MAX });

export const CATALOG = [
  def(FEATURE.SOC, 'soc', 0, {
    ...measure('State of charge', C.BATTERY_STORAGE, T.BATTERY_STORAGE.BATTERY_LEVEL),
    unit: U.PERCENT,
    max: 100,
  }),
  def(FEATURE.BATTERY_POWER, 'batteryPower', 0, signedWatts('Battery power')),
  def(FEATURE.PV_POWER, 'pvPower', 0, {
    ...measure('Solar power', C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER),
    unit: U.WATT,
    max: POWER_MAX,
  }),
  def(
    FEATURE.PV_ENERGY,
    undefined,
    3,
    index('Solar production index', T.ENERGY_PRODUCTION_SENSOR.INDEX),
    true,
  ),
  // Declared only: the core computes it from the index.
  def(
    FEATURE.PV_30MIN,
    undefined,
    3,
    index(
      'Solar production index (30-minute production)',
      T.ENERGY_PRODUCTION_SENSOR.THIRTY_MINUTES_PRODUCTION,
    ),
    true,
  ),
  def(FEATURE.PV_TODAY, 'pvDay', 3, today('Solar production')),
  def(FEATURE.HOUSE_POWER, 'housePower', 0, watts('House consumption')),
  def(FEATURE.GRID_POWER, 'gridPower', 0, signedWatts('Grid power')),
  def(FEATURE.ADD_POWER, 'addPower', 0, signedWatts('Additional source power')),
  def(FEATURE.AUTARKY, 'autarky', 1, plain('Autarky (%)', { max: 100 })),
  def(FEATURE.SELF_CONSUMPTION, 'selfConsumption', 1, plain('Self-consumption (%)', { max: 100 })),
  def(FEATURE.WALLBOX_POWER, 'wallboxPower', 0, watts('Wallbox power')),
  def(FEATURE.WALLBOX_SOLAR_POWER, 'wallboxSolarPower', 0, watts('Wallbox solar power')),
  def(FEATURE.BATTERY_IN_TODAY, 'batteryInDay', 3, today('Battery charge')),
  def(FEATURE.BATTERY_OUT_TODAY, 'batteryOutDay', 3, today('Battery discharge')),
  def(FEATURE.GRID_IMPORT_TODAY, 'gridImportDay', 3, today('Taken from the grid')),
  def(FEATURE.GRID_EXPORT_TODAY, 'gridExportDay', 3, today('Sent into the grid')),
  def(FEATURE.CONSUMPTION_TODAY, 'consumptionDay', 3, today('House consumption')),
];

/** The feature keys of a created device (its features are fixed at its creation). */
export function keysOfDevice(device) {
  return new Set(
    (device?.features ?? []).map((f) =>
      String(f.external_id ?? '')
        .split(':')
        .at(-1),
    ),
  );
}

/**
 * The catalog entries of the device: the index only with the option of the
 * energy monitoring, plus every one the created device already has
 * (published again, a device never loses a feature: "Update" in Discovery
 * would drop its history).
 */
export function entriesFor(pvIndex = PV_ENERGY_MONITORING, createdKeys = new Set()) {
  return CATALOG.filter(
    (e) => !e.index || pvIndex === PV_ENERGY_MONITORING || createdKeys.has(e.key),
  );
}

/**
 * The device of the system. `info`: `{ serial, address, firmware }`;
 * `pvIndex`: the option; `created`: the device the user created, if any.
 */
export function buildDevice(gladys, info, { pvIndex, created } = {}) {
  const external = ids(gladys, info.serial);
  const pvIndexId = external.feature(FEATURE.PV_ENERGY);
  const features = entriesFor(pvIndex, keysOfDevice(created)).map(({ key, spec }) => {
    const feature = {
      min: 0,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      ...spec,
      external_id: external.feature(key),
    };
    if (key === FEATURE.PV_ENERGY) {
      feature.id = uuidOf(pvIndexId);
    } else if (key === FEATURE.PV_30MIN) {
      feature.id = uuidOf(external.feature(FEATURE.PV_30MIN));
      feature.energy_parent_id = uuidOf(pvIndexId);
    }
    return feature;
  });
  return {
    name: `E3/DC ${info.serial}`,
    external_id: external.device,
    features,
    params: [
      { name: 'E3DC_ADDRESS', value: info.address ?? '' },
      { name: 'E3DC_SERIAL', value: info.serial },
      { name: 'E3DC_FIRMWARE', value: info.firmware ?? '' },
    ],
  };
}

export const round = (value, digits) => {
  const r = Math.round(value * 10 ** digits) / 10 ** digits;
  return Object.is(r, -0) ? 0 : r;
};

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const INDEX_KEYS = new Set(INDEXES.map((i) => i.key));

/**
 * The states of a read. `values`: the live values and the energies of the
 * day (src/e3dc/model.js); `indexes`: by feature key, the values the daily
 * index and the guard let through (undefined: not published this time). An
 * index is never taken from `values` directly.
 */
export function readStates(external, values, indexes = {}) {
  const states = [];
  for (const { key, value, digits, spec } of CATALOG) {
    let v;
    if (INDEX_KEYS.has(key)) {
      // Never 0 (the guard never lets 0 through, checked again here).
      v = isNumber(indexes[key]) && indexes[key] > 0 ? indexes[key] : undefined;
    } else if (value !== undefined) {
      v = values[value];
    }
    if (!isNumber(v)) {
      continue;
    }
    const r = round(v, digits);
    const min = spec.min ?? 0;
    if (r < min || (spec.max !== undefined && r > spec.max)) {
      continue;
    }
    states.push({ device_feature_external_id: external.feature(key), state: r });
  }
  return states;
}
