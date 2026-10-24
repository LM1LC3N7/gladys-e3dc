// -----------------------------------------------------------------------------
// The integration itself: the E3/DC system of the configuration (address,
// E3/DC account, RSCP password), read every 30 s by default in one RSCP
// session (log-in, live values, energies of the day), its device, the solar
// production index built from the counter of the day and checked by its
// guard, the refusal of the log-in kept in /data, the test and accept
// buttons. index.js only wires the SDK handlers to it.
//
// READ-ONLY: only the read requests of src/e3dc/client.js; nothing of the
// system is ever set (no onSetValue at all).
//
// Pace: nothing reads the system faster than the interval: not the timer,
// not the test button, not Discovery, not a (re)connection to Gladys, not a
// save of an unchanged configuration, not a restart of the container (the
// instant of the last session is kept in /data, written at most once a
// minute). A new address or new log-in fields may be read at once. One
// session at a time, whatever asks (a read running is never doubled).
//
// Log-in refused (access denied, or no readable answer to the log-in twice in
// a row): a FINAL stop kept in /data, never tried again by itself; only a
// change of the form, or a click on the test button (one try per click,
// never faster than the interval), tries again; the refusal is erased only
// by a successful log-in.
//
// A read belongs to its generation (each start/stop opens a new one): a read
// that ends after a restart or a new configuration publishes nothing and sets
// no status. Identity: every read asks the serial number in the session; the
// values only go to the device of that serial number (none readable: nothing
// published).
//
// Two clocks: `now` (wall clock) dates the index, the day and what /data
// keeps; `monotonic` paces the reads, so that a wall clock set back never
// stops them.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  ACCEPT_CONFIRM_AFTER,
  ACCEPT_CONFIRM_WITHIN,
  ATTEMPT_SAVE_EVERY,
  FRESH_INTERVALS,
  INDEX_LIMITS,
  LOGIN_LOST_LIMIT,
  PV_SENSOR_ONLY,
  RETRY_MAX,
  RETRY_MIN,
  STATE_HEARTBEAT,
  STATES_PER_MINUTE,
  TEST_ANSWER_WITHIN,
  TICK,
} from './constants.js';
import { DailyIndex } from './daily.js';
import { INDEXES, buildDevice, ids, readStates, round } from './devices.js';
import { E3dcClient } from './e3dc/client.js';
import { parseDay, parseLive } from './e3dc/model.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import { createFileStore, fingerprint, readState } from './store.js';
import { dayWindow } from './window.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

const MINUTE = 60_000;
/**
 * A counter of the day updated by steps (the database of the system may
 * count by intervals): the rise after equal reads may cover the time since
 * the counter last changed, at most this long (as gladys-imeon).
 */
export const STEP_COVER_MAX = 20 * MINUTE;
/** The power (kW) of that cover: 1.5 × the highest solar power read meanwhile, at least 2. */
const STEP_KW_MIN = 2;
const STEP_OUTLIER = 1.5;

/** The index Gladys already holds for a feature of the created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** A memory-only digest of the log-in fields (never written anywhere). */
const digestOf = ({ address, username, password, key }) =>
  createHash('sha256')
    .update([address, username, password, key].map(String).join('\u0000'))
    .digest('hex');

export class E3dcApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'e3dc' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    client,
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.client = client ?? new E3dcClient({ now });
    this.store = store;
    /** What /data keeps (src/store.js readState), read once. */
    this.kept = readState(store.load(), now());
    /** The instant of the last session as written in /data (written at most once a minute). */
    this.savedAttemptAt = this.kept.lastAttemptAt;
    /**
     * After a restart of the container: the first read waits the interval
     * and the minute the last session may have come after the one written.
     */
    this.restartedAt = this.kept.lastAttemptAt > 0 ? this.kept.lastAttemptAt : 0;
    this.savedKey = undefined;
    this.config = normalizeConfig();
    /** The digest of the log-in fields of the last start (memory only). */
    this.knownDigest = undefined;
    /** Monotonic time of the last session started, in this process. */
    this.lastAttemptMono = undefined;
    /** Unreachable / odd answer: failures in a row, the monotonic time of the next try. */
    this.failures = 0;
    this.retryAtMono = 0;
    this.lastError = undefined;
    /** The values of the last good read, its monotonic time. */
    this.values = undefined;
    this.valuesAt = undefined;
    this.readAt = undefined;
    this.dayFailed = undefined;
    this.noSerial = false;
    /** The names of the indexes not updated at the last read (their counter did not follow). */
    this.noIndex = [];
    /** A system read once (now or before the restart): its device is in Discovery. */
    this.known = Boolean(this.kept.info);
    /** By index feature external id: IndexGuard, DailyIndex. */
    this.guards = new Map();
    this.dailies = new Map();
    /** By index feature external id: the monotonic time of the last counter read. */
    this.counterReadAt = new Map();
    /** By index feature external id: `{ value, at, peakW }`, the counter's last change. */
    this.counterChange = new Map();
    /** The first click of "Accept the held index": `{ at, listedAt, list }`, in memory only. */
    this.pendingAccept = undefined;
    this.publishedDevices = undefined;
    /** The states sent in the last minute: `[{ at, count }]`, monotonic (STATES_PER_MINUTE). */
    this.sent = [];
    /** By index feature external id: the hold last logged (`direction:from`). */
    this.loggedHolds = new Map();
    this.timer = undefined;
    this.busy = undefined;
    this.firstRun = Promise.resolve();
    this.lastStatus = undefined;
    this.generation = 0;
    this.lifecycle = Promise.resolve();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** `fresh`: the user saved the form (not a reconnection). It accepts no index held back. */
  start(raw = {}, { fresh = false } = {}) {
    return this.serialize(() => this.doStart(raw, { fresh }));
  }

  stop() {
    return this.serialize(() => this.doStop());
  }

  /** Resolves once every queued start/stop and the read after it are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.firstRun;
    await this.busy;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /** The log-in fields of the configuration (with the address), or undefined. */
  credentials() {
    const { address, host, port, username, password, key, problem } = this.config;
    return problem ? undefined : { address, host, port, username, password, key };
  }

  async doStart(raw, { fresh = false } = {}) {
    await this.doStop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    const { address } = this.config;
    let changed = false;
    if (address && address !== this.kept.address) {
      // Another address: its pace and refusal start afresh (the device and
      // its index stay: they belong to the serial number of the system).
      Object.assign(this.kept, { address, lastAttemptAt: 0, refusal: null, lost: null });
      this.savedAttemptAt = 0;
      this.restartedAt = 0;
      this.forgetPace();
      this.values = undefined;
      changed = true;
    }
    const credentials = this.credentials();
    if (credentials) {
      const digest = digestOf(credentials);
      const fp = fingerprint(this.kept.salt, address, credentials);
      const stopFp = this.kept.refusal?.fp ?? this.kept.lost?.fp;
      const other =
        this.knownDigest !== undefined
          ? this.knownDigest !== digest
          : stopFp !== undefined && stopFp !== fp;
      this.knownDigest = digest;
      if (other) {
        // New log-in fields: tried at once, the refusal and the lost log-ins forgotten.
        this.kept.refusal = null;
        this.kept.lost = null;
        this.restartedAt = 0;
        this.forgetPace();
        changed = true;
      }
    }
    if (this.config.pvIndex !== this.kept.pvMode) {
      // Back from "Sensor only" to the energy monitoring: what was produced
      // meanwhile (already counted by another inverter) must not be counted
      // at once: the first value is held as a jump, for the two-click acceptance.
      if (this.kept.pvMode === PV_SENSOR_ONLY && this.indexMode()) {
        this.kept.pvResume = true;
      } else if (!this.indexMode()) {
        this.kept.pvResume = false;
      }
      this.kept.pvMode = this.config.pvIndex;
      changed = true;
    }
    // The daily indexes follow the time zone of the form: built again from
    // their own state (kept in /data) at each start.
    await this.saveState({ force: changed });
    this.guards.clear();
    this.dailies.clear();
    // The core keeps the connection status and the Discovery list in memory:
    // a restarted Gladys has lost them, so they are always sent again.
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    if (!fresh) {
      // A (re)connection: every value again at the next read.
      this.gladys.forgetPublishedStates?.();
    }
    await this.discover();
    await this.updateStatus({ starting: true });
    // Always armed, whatever the first read gives: never a dead integration.
    this.timer = this.timers.setInterval(() => this.run(generation, () => this.tick()), TICK);
    this.firstRun = this.run(generation, () => this.tick());
  }

  forgetPace() {
    this.lastAttemptMono = undefined;
    this.failures = 0;
    this.retryAtMono = 0;
    this.lastError = undefined;
  }

  async doStop() {
    this.generation += 1;
    if (this.timer !== undefined) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
    // /data written on a clean stop too (the last state of the indexes).
    await this.saveState();
  }

  /** Run a job of a generation: nothing after a restart. */
  async run(generation, job) {
    if (generation !== this.generation) {
      return undefined;
    }
    try {
      return await job();
    } catch (err) {
      this.logger.error(`E3/DC: unexpected error (${err?.name ?? 'Error'})`);
      return undefined;
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Device ---------------------------------------------------------------------

  /** The external ids of the system known (serial number), undefined before any read. */
  external() {
    const serial = this.kept.info?.serial;
    return serial ? ids(this.gladys, serial) : undefined;
  }

  /** The created Gladys device, undefined until the user creates it. */
  createdDevice() {
    const id = this.external()?.device;
    return id ? (this.gladys.devices ?? []).find((d) => d.external_id === id) : undefined;
  }

  info() {
    return {
      serial: this.kept.info?.serial,
      address: this.config.address ?? this.kept.address ?? undefined,
      firmware: this.kept.info?.firmware,
    };
  }

  async discover({ force = false } = {}) {
    const devices =
      this.known && this.kept.info?.serial && this.config.address
        ? [
            buildDevice(this.gladys, this.info(), {
              pvIndex: this.config.pvIndex,
              created: this.createdDevice(),
            }),
          ]
        : [];
    const json = JSON.stringify(devices);
    if (!force && json === this.publishedDevices) {
      return;
    }
    this.publishedDevices = json;
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`Publishing the E3/DC device failed: ${err.message}`));
  }

  /** The Discover tab: the device known, published again; never a request to the system. */
  async scan() {
    await this.discover({ force: true });
    await this.updateStatus();
  }

  isFresh() {
    return (
      this.values !== undefined &&
      this.monotonic() - this.valuesAt <= FRESH_INTERVALS * this.config.pollInterval * 1000
    );
  }

  /** The device just created: the values of the last read now (no new request). */
  async onDeviceCreated(device) {
    const external = this.external();
    if (!external || device?.external_id !== external.device) {
      return;
    }
    // A new device: no reference of its index yet (nor a state kept in /data
    // for a deleted device of the same id).
    for (const { key } of INDEXES) {
      const id = external.feature(key);
      this.guards.delete(id);
      this.dailies.delete(id);
      this.counterReadAt.delete(id);
      this.counterChange.delete(id);
      delete this.kept.indexes[id];
    }
    await this.saveState({ force: true });
    await this.publishLast();
  }

  async onDeviceUpdated(device) {
    const external = this.external();
    if (external && device?.external_id === external.device) {
      await this.publishLast();
    }
  }

  /** The values of the last read (if fresh and of the serial known), never a new request. */
  async publishLast() {
    const generation = this.generation;
    if (!this.isFresh() || this.values.serial !== this.kept.info?.serial) return;
    const prepared = this.prepare(this.values, { counters: false });
    await this.saveState();
    if (prepared && generation === this.generation) {
      await this.send(prepared);
      if (generation === this.generation) await this.updateStatus();
    }
  }

  // --- /data -------------------------------------------------------------------------

  /**
   * Keeps the state in /data when it changed. The instant of the last session
   * is written at most once a minute (the one already written otherwise).
   * An index not loaded in memory keeps what /data had (never overwritten by
   * a state not loaded yet).
   */
  async saveState({ force = false } = {}) {
    const indexes = { ...this.kept.indexes };
    for (const [id, guard] of this.guards) {
      indexes[id] = { guard: guard.state(), daily: this.dailies.get(id)?.state() ?? null };
    }
    this.kept.indexes = indexes;
    const now = this.now();
    const attempt =
      this.kept.lastAttemptAt !== this.savedAttemptAt &&
      (this.savedAttemptAt === 0 || now - this.savedAttemptAt >= ATTEMPT_SAVE_EVERY)
        ? this.kept.lastAttemptAt
        : this.savedAttemptAt;
    const state = {
      salt: this.kept.salt,
      address: this.kept.address,
      lastAttemptAt: attempt,
      refusal: this.kept.refusal,
      lost: this.kept.lost,
      info: this.kept.info,
      pvMode: this.kept.pvMode,
      pvResume: this.kept.pvResume,
      indexes,
    };
    const key = JSON.stringify(state);
    if (!force && key === this.savedKey) {
      return;
    }
    try {
      await this.store.save(state);
      this.savedKey = key;
      this.savedAttemptAt = attempt;
    } catch (err) {
      this.logger.warn(`Saving the E3/DC state in /data failed (${err?.code ?? 'error'})`);
    }
  }

  // --- Reads -------------------------------------------------------------------------

  intervalMs() {
    return this.config.pollInterval * 1000;
  }

  /** The wait after a failure: never faster than a read, doubled up to 15 min. */
  retryWait(failures) {
    const first = Math.max(RETRY_MIN, this.intervalMs());
    return Math.min(first * 2 ** failures, Math.max(RETRY_MAX, first));
  }

  /**
   * The earliest instant (wall clock) of the next read, whatever asks for it;
   * Infinity while the log-in is refused (only the test button tries then,
   * `manual`).
   */
  nextReadAt({ manual = false } = {}) {
    const now = this.now();
    const mono = this.monotonic();
    const at = [now];
    if (this.lastAttemptMono !== undefined) {
      // Never sooner than the interval (the timer looks every 5 s: 30 to 35 s at 30 s).
      at.push(now + this.lastAttemptMono + this.intervalMs() - mono);
    }
    if (!manual && this.retryAtMono > mono) at.push(now + this.retryAtMono - mono);
    if (this.restartedAt > 0) {
      at.push(this.restartedAt + ATTEMPT_SAVE_EVERY + this.intervalMs());
    }
    if (!manual && this.kept.refusal) at.push(Infinity);
    return Math.max(...at);
  }

  due(options) {
    return Boolean(this.credentials()) && this.nextReadAt(options) <= this.now();
  }

  /**
   * One look: a read when one is due. A read still running is never doubled,
   * whatever its generation (a reconnection during a read starts no other).
   */
  tick({ manual = false } = {}) {
    if (this.busy) {
      return this.busy;
    }
    if (!this.due({ manual })) {
      return undefined;
    }
    const generation = this.generation;
    this.busy = this.read(generation).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  async read(generation) {
    const credentials = this.credentials();
    const digest = digestOf(credentials);
    const alive = () => generation === this.generation;
    const now = this.now();
    // Recorded first: neither a reconnection, a save nor a restart reads sooner.
    this.lastAttemptMono = this.monotonic();
    this.restartedAt = 0;
    this.kept.lastAttemptAt = now;
    await this.saveState();
    const window = dayWindow(now, this.config.timeZone);
    let answer;
    try {
      answer = await this.client.read(credentials, window, alive);
    } catch (err) {
      await this.failed(err, { credentials, digest, alive });
      return;
    }
    if (!alive()) {
      // Late: an old configuration or a restart. Nothing published, no status.
      return;
    }
    this.failures = 0;
    this.retryAtMono = 0;
    this.lastError = undefined;
    // The fingerprint of a refused log-in goes with the first success.
    this.kept.refusal = null;
    this.kept.lost = null;
    const live = parseLive(answer.live);
    const day = parseDay(answer.day);
    this.dayFailed = answer.dayFailed;
    this.noSerial = live.serial === undefined;
    if (live.serial) {
      if (this.kept.info?.serial && this.kept.info.serial !== live.serial) {
        this.logger.warn(
          'E3/DC: another serial number answers at this address: its own device is in Discovery',
        );
      }
      this.kept.info = { serial: live.serial, firmware: live.firmware };
      this.known = true;
    }
    this.values = { ...live, ...day, dayKnown: answer.day !== undefined };
    this.valuesAt = this.monotonic();
    this.readAt = this.now();
    const prepared = live.serial ? this.prepare(this.values, { counters: true }) : undefined;
    // Saved BEFORE Gladys gets the values: a crash in between never sends an
    // index /data does not know.
    await this.saveState();
    if (!alive()) return;
    if (prepared) await this.send(prepared);
    if (!alive()) return;
    await this.discover();
    if (!alive()) return;
    await this.updateStatus();
  }

  async failed(err, { credentials, digest, alive }) {
    const code = err?.code ?? 'error';
    // A late failure of another configuration is dropped; a refusal of the
    // same address and log-in fields is still kept.
    const current = this.credentials();
    const same = current !== undefined && digestOf(current) === digest;
    if (!alive() && !same) return;
    if (code === 'aborted') return;
    // Our own words only (E3dcError codes): never a byte of the system, never a secret.
    this.logger.warn(`E3/DC read of ${credentials.address} failed: ${code}`);
    const fp = fingerprint(this.kept.salt, credentials.address, credentials);
    if (code === 'refused') {
      this.kept.refusal = { code: 'refused', fp };
      this.kept.lost = null;
    } else if (code === 'login_lost') {
      const count = this.kept.lost?.fp === fp ? this.kept.lost.count + 1 : 1;
      if (count >= LOGIN_LOST_LIMIT) {
        this.kept.refusal = { code: 'login_lost', fp };
        this.kept.lost = null;
      } else {
        this.kept.lost = { count, fp };
        this.retryAtMono = this.monotonic() + this.retryWait(this.failures);
        this.failures += 1;
      }
    } else {
      this.retryAtMono = this.monotonic() + this.retryWait(this.failures);
      this.failures += 1;
    }
    this.lastError = err;
    await this.saveState();
    if (alive()) {
      await this.updateStatus();
    }
  }

  /** The limits of the daily index of `name` in the time zone of the form. */
  dailyLimits(name) {
    const { maxKw, slackKwh } = INDEX_LIMITS[name];
    return { maxKw, slackKwh, resetMaxKwh: 36, timeZone: this.config.timeZone };
  }

  /** The guard (and daily index) of an index of the created device, from Gladys and /data. */
  guardOf(created, id, name) {
    if (!this.guards.has(id)) {
      const saved = this.kept.indexes[id];
      this.guards.set(
        id,
        new IndexGuard(lastValueOf(created, id), saved?.guard, this.now(), INDEX_LIMITS[name]),
      );
      this.dailies.set(id, new DailyIndex(saved?.daily, this.dailyLimits(name), this.now()));
    }
    return this.guards.get(id);
  }

  /**
   * The cumulative index of a counter of the day read now (src/daily.js), or
   * undefined. A counter updated by steps: after equal reads, a rise may
   * cover the time since its last change (STEP_COVER_MAX at most), at a
   * power bounded by the solar power read meanwhile (as gladys-imeon 0.1.2).
   */
  buildIndex(id, daily, today, known, pvPower) {
    const now = this.now();
    const mono = this.monotonic();
    const previous = this.counterReadAt.get(id);
    this.counterReadAt.set(id, mono);
    const ds = daily.state();
    const change = this.counterChange.get(id);
    const power = typeof pvPower === 'number' && pvPower > 0 ? pvPower : 0;
    const base = daily.limits.maxKw;
    if (
      ds &&
      change &&
      change.value === ds.today &&
      today > ds.today &&
      now - ds.readAt > 0 &&
      now - change.at > now - ds.readAt
    ) {
      const cover = Math.min(now - change.at, STEP_COVER_MAX);
      const kw = Math.min(
        base,
        Math.max(STEP_KW_MIN, (STEP_OUTLIER * Math.max(change.peakW, power)) / 1000),
      );
      daily.limits.maxKw = Math.max(base, (kw * cover) / (now - ds.readAt));
    }
    let built;
    try {
      built = daily.read(today, now, known, {
        elapsedMs: previous === undefined ? undefined : mono - previous,
      });
    } finally {
      daily.limits.maxKw = base;
    }
    if (!change || change.value !== today) {
      this.counterChange.set(id, { value: today, at: now, peakW: power });
    } else {
      change.peakW = Math.max(change.peakW, power);
    }
    return built === undefined ? undefined : round(built, 3);
  }

  /**
   * The states of a read, the index through its daily index and its guard
   * (not sent yet: `send` does it, after /data is saved). Undefined without a
   * created device. `counters`: a new read (the counter of the day is taken);
   * otherwise (a device just created) the last accepted index only.
   */
  prepare(values, { counters }) {
    const created = this.createdDevice();
    const external = this.external();
    if (!created || !external) {
      return undefined;
    }
    const now = this.now();
    const indexes = {};
    if (counters) this.noIndex = [];
    // "Sensor only": the index never gets a value (nor goes through its guard).
    for (const { name, key, day } of this.indexMode() ? INDEXES : []) {
      const id = external.feature(key);
      const guard = this.guardOf(created, id, name);
      const daily = this.dailies.get(id);
      const today = values[day] === undefined ? undefined : round(values[day], 3);
      if (!counters || today === undefined) {
        indexes[key] = guard.held ? guard.last?.value : undefined;
        continue;
      }
      const total = this.buildIndex(
        id,
        daily,
        today,
        guard.last ?? lastValueOf(created, id),
        values.pvPower,
      );
      if (total === undefined) {
        // A jump, a drop out of midnight, a clock set back: nothing counted (less, never more).
        this.noIndex.push(name);
        indexes[key] = guard.held ? guard.last?.value : undefined;
        continue;
      }
      if (this.kept.pvResume) {
        // The first value after a return from "Sensor only".
        this.kept.pvResume = false;
        const from = guard.last?.value;
        if (from !== undefined && total > from && !guard.held) {
          // Held as a jump (src/guard.js keeps it held at or above it, the
          // acceptance in two clicks takes it); never counted at once.
          guard.held = { direction: 'up', from, to: total, threshold: total, at: now };
        }
      }
      const plausible = guard.accept(total, now);
      const held = guard.held ? `${guard.held.direction}:${guard.held.from}` : undefined;
      if (held && this.loggedHolds.get(id) !== held) {
        this.logger.warn(
          `E3/DC ${name} index ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held index" button takes it`,
        );
      }
      if (held) this.loggedHolds.set(id, held);
      else this.loggedHolds.delete(id);
      // While a value is held, the last accepted one is sent again (no delta for the core).
      indexes[key] = plausible ? total : guard.held ? guard.last?.value : undefined;
    }
    const features = new Set((created.features ?? []).map((f) => f.external_id));
    const states = readStates(external, values, indexes).filter((s) =>
      features.has(s.device_feature_external_id),
    );
    return states.length > 0 ? states : undefined;
  }

  /**
   * The states, within STATES_PER_MINUTE over any 60 s: a batch that would go
   * beyond is not sent this time. The room is taken BEFORE the publication
   * (two publications at once never both pass).
   */
  async send(states) {
    const mono = this.monotonic();
    this.sent = this.sent.filter((s) => mono - s.at < MINUTE);
    const used = this.sent.reduce((sum, s) => sum + s.count, 0);
    if (used + states.length > STATES_PER_MINUTE) {
      this.logger.debug('E3/DC: values kept for the next read (states per minute)');
      return;
    }
    const entry = { at: mono, count: states.length };
    this.sent.push(entry);
    try {
      const result = await this.gladys.publishChangedStates(states, { heartbeat: STATE_HEARTBEAT });
      if (Number.isInteger(result?.count) && result.count >= 0 && result.count <= states.length) {
        entry.count = result.count;
      }
    } catch (err) {
      this.logger.warn(`Publishing the E3/DC values failed: ${err.message}`);
    }
  }

  // --- Status ------------------------------------------------------------------------

  /** Whether the solar production goes to the energy monitoring (option `pv_index`). */
  indexMode() {
    return this.config.pvIndex !== PV_SENSOR_ONLY;
  }

  /** Every index held back: `{ id, name, direction, from, to }`. */
  heldList() {
    const created = this.createdDevice();
    if (!created || !this.indexMode()) return [];
    const list = [];
    for (const { name, key } of INDEXES) {
      const id = this.external().feature(key);
      const held = this.guardOf(created, id, name).held;
      if (held) list.push({ id, name, ...held });
    }
    return list;
  }

  async updateStatus({ starting = false } = {}) {
    const { problem, address } = this.config;
    if (problem) {
      await this.setStatus(false, T.problem[problem]);
      return;
    }
    const now = this.now();
    const mono = this.monotonic();
    const { refusal } = this.kept;
    if (refusal) {
      await this.setStatus(false, T.refused(address, refusal.code));
      return;
    }
    if (this.lastError) {
      const wait = Math.max(0, this.retryAtMono - mono);
      await this.setStatus(false, T.failing(address, this.lastError, wait));
      return;
    }
    if (!this.values) {
      const at = this.nextReadAt();
      if (starting && at <= now) {
        await this.setStatus(false, T.connecting);
      } else {
        // After a restart, a system read before (no refusal, no error) is
        // shown connected until its next read.
        await this.setStatus(this.known, T.waiting(at));
      }
      return;
    }
    const notes = [];
    if (this.noSerial) notes.push(T.notes.noSerial);
    else if (!this.createdDevice()) notes.push(T.notes.noDevice);
    if (this.dayFailed) notes.push(T.notes.dayMissing);
    if (this.noIndex.length > 0 && this.indexMode()) notes.push(T.notes.noIndex(this.noIndex));
    if (this.config.timeZoneInvalid) notes.push(T.notes.timeZone(this.config.timeZone));
    const held = this.heldList();
    if (held.length > 0) notes.push(T.notes.held(held));
    await this.setStatus(true, T.ok(this.kept.info?.serial, this.kept.info?.firmware, notes));
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * "Accept the held index", in two clicks: the first lists every index held
   * (nothing is accepted), the second, from 3 s to 5 min later, accepts
   * exactly what the first listed, and only when it still shows that value
   * (or what may have come since, src/guard.js). A save of the form never accepts.
   */
  async acceptHeldIndex() {
    const list = this.heldList();
    const mono = this.monotonic();
    const now = this.now();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    const elapsed = pending ? mono - pending.at : undefined;
    if (!pending || elapsed > ACCEPT_CONFIRM_WITHIN || elapsed < ACCEPT_CONFIRM_AFTER) {
      if (list.length === 0) {
        return T.accept.nothing;
      }
      this.pendingAccept = { at: mono, listedAt: now, list };
      return T.accept.confirm(list, ACCEPT_CONFIRM_WITHIN);
    }
    const accepted = [];
    const changed = [];
    for (const entry of pending.list) {
      const guard = this.guards.get(entry.id);
      const held = guard?.held;
      const margin = guard ? guard.margin(pending.listedAt, now) : 0;
      const same =
        held &&
        held.direction === entry.direction &&
        held.from === entry.from &&
        (entry.direction === 'up'
          ? held.to >= entry.to && held.to - entry.to <= margin
          : Math.abs(held.to - entry.to) <= margin);
      if (same && guard.acceptHeld()) {
        accepted.push({ ...entry, to: held.to });
      } else if (held) {
        changed.push(entry);
      }
    }
    if (accepted.length === 0 && changed.length === 0) {
      return T.accept.nothing;
    }
    for (const { name, direction } of accepted) {
      this.logger.info(
        `E3/DC ${name} index ${direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
      );
    }
    await this.saveState();
    // Published at the next read (never a read sooner than the interval).
    return T.accept.done(accepted, changed);
  }

  /**
   * The test button: a read when one is due (the interval passed; a refused
   * log-in may be tried again then, once per click), else what is known and
   * when the next read can be. Never a session the pace forbids.
   */
  async testConnection() {
    const { problem, address } = this.config;
    if (problem) {
      return T.problem[problem];
    }
    const generation = this.generation;
    const job = this.busy ?? this.tick({ manual: true });
    if (job) {
      let timer;
      const late = new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve('late'), TEST_ANSWER_WITHIN);
      });
      try {
        if ((await Promise.race([job.then(() => 'done'), late])) === 'late') {
          return T.test.slow;
        }
      } finally {
        this.timers.clearTimeout(timer);
      }
    }
    if (generation !== this.generation) {
      return T.test.slow;
    }
    const lines = [];
    const fresh = this.isFresh();
    if (this.kept.refusal) {
      lines.push(T.test.failed(address, { code: this.kept.refusal.code }));
    } else if (this.lastError) {
      lines.push(T.test.failed(address, this.lastError));
    } else if (fresh) {
      lines.push(T.test.ok(address, this.kept.info?.serial, this.values, this.kept.info?.firmware));
    }
    if (fresh && this.readAt !== undefined) lines.push(T.test.lastRead(this.readAt));
    if (!job) lines.push(T.test.notNow(this.nextReadAt({ manual: true })));
    return T.test.lines(lines);
  }
}
