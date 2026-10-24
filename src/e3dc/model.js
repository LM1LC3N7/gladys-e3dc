// -----------------------------------------------------------------------------
// The answers of the system -> values. Pure. The tags, units and meanings
// follow pye3dc (_e3dc.py poll, get_system_info, get_db_data, MIT, see
// THIRD_PARTY_NOTICES.md):
// - powers in W (Int32); the battery and the grid are SIGNED and their sign
//   is not confirmed on a real system (pye3dc: battery > 0 charging, grid > 0
//   taken from the grid; its README shows a grid of -4 W at full autarky),
//   so each is one signed value, published as it is read, never split into
//   charge / discharge nor import / export;
// - the additional source (EMS_POWER_ADD, an external inverter) as read
//   (pye3dc turns its sign over to show a production);
// - autarky and self-consumption in %, the state of charge in %;
// - the energies of the day from the database of the system, in Wh (pye3dc
//   calls them "power"; Home Assistant's E3/DC integration shows them in kWh
//   after a division by 1000), here in kWh. DB_GRID_POWER_IN is what was
//   sent into the grid, DB_GRID_POWER_OUT what was taken from it (pye3dc).
// Strict: a value is a finite number of a numeric RSCP type, in range, or it
// is left out. A text is checked by pattern before being shown.
// -----------------------------------------------------------------------------

import { DAY_ENERGY_MAX, POWER_MAX } from '../constants.js';
import { TAG, TYPE, find } from './rscp.js';

const NUMERIC = new Set([
  TYPE.CHAR8,
  TYPE.UCHAR8,
  TYPE.INT16,
  TYPE.UINT16,
  TYPE.INT32,
  TYPE.UINT32,
  TYPE.INT64,
  TYPE.UINT64,
  TYPE.FLOAT32,
  TYPE.DOUBLE64,
]);

/** The number of an RSCP item, else undefined (an error, a text, a bad size...). */
export function numberOf(item) {
  if (!item || item.bad || !NUMERIC.has(item.type)) return undefined;
  const v = item.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const textOf = (item) =>
  item && !item.bad && item.type === TYPE.CSTRING && typeof item.value === 'string'
    ? item.value
    : undefined;

const SERIAL = /^[A-Z0-9][A-Z0-9-]{2,39}$/;
const FIRMWARE = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/;

/**
 * The serial number of the system as its external id takes it (forever):
 * trimmed, upper-cased, letters, digits and dashes, 3 to 40 characters.
 * Undefined otherwise (the read then publishes nothing).
 */
export function serialOf(raw) {
  if (typeof raw !== 'string') return undefined;
  const serial = raw.trim().toUpperCase();
  return SERIAL.test(serial) ? serial : undefined;
}

/** The software release, when it looks like one. */
export function firmwareOf(raw) {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return FIRMWARE.test(text) ? text : undefined;
}

/** A signed power, |W| at most POWER_MAX. */
const signed = (v) => (v !== undefined && Math.abs(v) <= POWER_MAX ? v : undefined);
/** A power that is never negative: a small negative reading (stand-by) is 0. */
const positive = (v) => (v === undefined || v > POWER_MAX || v < -200 ? undefined : Math.max(0, v));
const percent = (v) => (v !== undefined && v >= 0 && v <= 100 ? v : undefined);
/** Wh of the day -> kWh, never negative nor absurd. */
const dayKwh = (v) =>
  v !== undefined && v >= 0 && v / 1000 <= DAY_ENERGY_MAX ? v / 1000 : undefined;

/** The values of the live answer (a list of RSCP items). */
export function parseLive(items) {
  const n = (tag) => numberOf(find(items, tag));
  return {
    serial: serialOf(textOf(find(items, TAG.INFO_SERIAL_NUMBER))),
    firmware: firmwareOf(textOf(find(items, TAG.INFO_SW_RELEASE))),
    pvPower: positive(n(TAG.EMS_POWER_PV)),
    batteryPower: signed(n(TAG.EMS_POWER_BAT)),
    housePower: positive(n(TAG.EMS_POWER_HOME)),
    gridPower: signed(n(TAG.EMS_POWER_GRID)),
    addPower: signed(n(TAG.EMS_POWER_ADD)),
    autarky: percent(n(TAG.EMS_AUTARKY)),
    selfConsumption: percent(n(TAG.EMS_SELF_CONSUMPTION)),
    soc: percent(n(TAG.EMS_BAT_SOC)),
    wallboxPower: positive(n(TAG.EMS_POWER_WB_ALL)),
    wallboxSolarPower: positive(n(TAG.EMS_POWER_WB_SOLAR)),
  };
}

/**
 * The energies of the day (kWh) from DB_HISTORY_DATA_DAY: its sum container
 * (pye3dc reads the first container of the answer). `{}` when absent.
 */
export function parseDay(day) {
  const list = Array.isArray(day?.value) ? day.value : [];
  const sum = find(list, TAG.DB_SUM_CONTAINER) ?? list.find((item) => item.type === TYPE.CONTAINER);
  if (!sum || !Array.isArray(sum.value)) return {};
  const n = (tag) => dayKwh(numberOf(find(sum.value, tag)));
  return {
    pvDay: n(TAG.DB_DC_POWER),
    batteryInDay: n(TAG.DB_BAT_POWER_IN),
    batteryOutDay: n(TAG.DB_BAT_POWER_OUT),
    gridExportDay: n(TAG.DB_GRID_POWER_IN),
    gridImportDay: n(TAG.DB_GRID_POWER_OUT),
    consumptionDay: n(TAG.DB_CONSUMPTION),
  };
}
