// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/devices.js, the external id rule) is
// forever: never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', ACCEPT_HELD: 'accept_held_index' };

/**
 * The external id of the system: `system:<SERIAL>`, the serial number the
 * system gives over RSCP (INFO_SERIAL_NUMBER), trimmed and upper-cased
 * (src/e3dc/model.js serialOf). A read whose serial is missing or unreadable
 * publishes nothing.
 */
export const EXTERNAL_ID_TYPE = 'system';

// --- RSCP on the home network ---------------------------------------------------------
/** The RSCP port of an E3/DC system (pye3dc DEFAULT_PORT). */
export const DEFAULT_PORT = 5033;
/** Opening the TCP connection (pye3dc waits 5 s). */
export const CONNECT_TIMEOUT = 5_000;
/** Each answer frame (the system answers within a second on the home network). */
export const ANSWER_TIMEOUT = 8_000;
/** A whole session (connect, log in, two requests), whatever happens. */
export const SESSION_TIMEOUT = 25_000;
/**
 * The bytes kept for one answer, deciphered: a frame of the standard format
 * holds at most 65,535 bytes of data (its length is a Uint16) + 22 of header
 * and CRC, + 31 of padding. Our answers are a few hundred bytes.
 */
export const MAX_ANSWER_BYTES = 65_535 + 22 + 32;
/** The RSCP items decoded in one answer, at most, and their depth (containers). */
export const MAX_ITEMS = 2_000;
export const MAX_DEPTH = 8;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** The reading interval of the form (s): 30 s by default, 30 to 300. */
export const POLL_DEFAULT = 30;
export const POLL_MIN = 30;
export const POLL_MAX = 300;
/** How often the integration looks whether a read is due (never a read by itself). */
export const TICK = 5 * SECOND;
/**
 * The instant of the last session is written to /data at most once a minute:
 * after a restart, the first read waits this long on top of the interval, so
 * that a container restarting in a loop never reads faster than the interval.
 */
export const ATTEMPT_SAVE_EVERY = MINUTE;
/** The states sent in any 60 s, at most (the core refuses a whole batch beyond 300). */
export const STATES_PER_MINUTE = 270;
/** Unchanged values are sent again after this delay (publishChangedStates heartbeat). */
export const STATE_HEARTBEAT = 10 * MINUTE;
/** Unreachable: tried again after 1 min (never faster than a read), doubled up to 15 min. */
export const RETRY_MIN = MINUTE;
export const RETRY_MAX = 15 * MINUTE;
/**
 * The system closed the session (or did not answer) right after the log-in
 * frame: the RSCP password does not match (the system cannot read our frame).
 * The second time in a row is a refusal (a final stop), never a third try.
 */
export const LOGIN_LOST_LIMIT = 2;
/**
 * The second try after a lost log-in waits at least this long (review r1,
 * point 4): a system restarting (a software update) may accept and close the
 * port for a few minutes; two cases within a minute must not stop for good.
 */
export const LOGIN_LOST_RETRY = 15 * MINUTE;
/** The test button answers within this delay. */
export const TEST_ANSWER_WITHIN = 25 * SECOND;
/** The second click of "Accept the held index" counts from 3 s to 5 min after the first. */
export const ACCEPT_CONFIRM_AFTER = 3 * SECOND;
export const ACCEPT_CONFIRM_WITHIN = 5 * MINUTE;
/** Values older than this many intervals are no longer published as current. */
export const FRESH_INTERVALS = 2;

// --- Energy ---------------------------------------------------------------------------
/** The `pv_index` option: the solar index in the energy monitoring, or a plain sensor only. */
export const PV_ENERGY_MONITORING = 'energy_monitoring';
export const PV_SENSOR_ONLY = 'sensor_only';

/**
 * The local midnight of the energies of the day (the window asked to the
 * database of the system): the time zone of the form, else the one of the
 * systems' home market.
 */
export const DEFAULT_TIME_ZONE = 'Europe/Berlin';

/**
 * The margin of the solar production index, the same for the index built from
 * the counter of the day (src/daily.js) and for its guard (src/guard.js):
 * 30 kW covers the PV of a home system (an S10 E takes up to about 12 kWp,
 * an S10 X or a Quattroporte more), 0.5 kWh is always accepted on top.
 */
export const INDEX_LIMITS = { pv: { maxKw: 30, slackKwh: 0.5 } };

/** A power above this (W, either sign) is a glitch. */
export const POWER_MAX = 100_000;
/** An energy of the day above this (kWh) is a glitch. */
export const DAY_ENERGY_MAX = 2_000;
/** A built index above this (kWh) is a glitch. */
export const ENERGY_MAX = 10_000_000;
