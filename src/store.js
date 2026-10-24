// -----------------------------------------------------------------------------
// What must survive a restart of the container (a small JSON file under
// /data, the only writable place): the instant of the last session (written
// at most once a minute), a refusal of the log-in (a final stop), the log-ins
// lost in a row, the solar production index (its daily index and its guard),
// and what the Discovery list shows (serial number, software: nothing
// secret).
//
// No secret is ever written: neither the user name, the password nor the
// RSCP password. Only while a log-in is refused (or lost), the file keeps a
// TRUNCATED fingerprint of what was refused: 8 bits of a salted scrypt
// (random salt per file) of the address and the three fields, enough to see
// after a restart whether the form changed since (1 chance in 256 to take a
// new form for the refused one: the test button then tries it), far too
// little to confirm or find any password (lot 14, lesson 7). It is erased by
// the first successful log-in: nothing in the file can confirm a working
// password. (After gladys-sonnen and gladys-air-q.)
//
// Written through a temporary file and a rename, one write at a time; a
// failure is logged once, never fatal. Never any text of the system but its
// serial number and software release, checked by pattern.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { firmwareOf, serialOf } from './e3dc/model.js';

export const DEFAULT_STATE_FILE = '/data/e3dc-state.json';
const MAX_FILE = 64 * 1024;

/** A JSON file: `load()` (sync, `{}` when absent or odd) and `save(data)` (atomic). */
export function createFileStore(file = DEFAULT_STATE_FILE) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    load() {
      try {
        const text = readFileSync(file, 'utf8');
        if (text.length > MAX_FILE) return {};
        const data = JSON.parse(text);
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      } catch {
        return {};
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests). */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  let saves = 0;
  return {
    load: () => structuredClone(data),
    async save(next) {
      saves += 1;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
    get saves() {
      return saves;
    },
  };
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const FP = /^[0-9a-f]{2}$/;

/** A refusal read back: `{ code, fp }`, a final stop (no end). */
export function validRefusal(refusal) {
  if (
    !isObject(refusal) ||
    (refusal.code !== 'refused' && refusal.code !== 'login_lost') ||
    typeof refusal.fp !== 'string' ||
    !FP.test(refusal.fp)
  ) {
    return undefined;
  }
  return { code: refusal.code, fp: refusal.fp };
}

/** The log-ins lost in a row read back: `{ count, fp }`. */
export function validLost(lost) {
  if (
    !isObject(lost) ||
    !Number.isInteger(lost.count) ||
    lost.count < 1 ||
    typeof lost.fp !== 'string' ||
    !FP.test(lost.fp)
  ) {
    return undefined;
  }
  return { count: Math.min(lost.count, 32), fp: lost.fp };
}

/** The non-secret facts of the system read back from /data. */
export function validInfo(info) {
  if (!isObject(info)) return undefined;
  const serial = serialOf(info.serial);
  if (!serial) return undefined;
  return { serial, firmware: firmwareOf(info.firmware) };
}

/**
 * The persisted state, sanitized: the instant of the last session never "in
 * the future", every field checked, so a clock that jumped or a hand-edited
 * file never stops the reads for longer.
 */
export function readState(raw, now) {
  const data = isObject(raw) ? raw : {};
  const salt =
    typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)
      ? data.salt
      : randomBytes(16).toString('hex');
  const address =
    typeof data.address === 'string' && data.address.length <= 300 ? data.address : null;
  const indexes = {};
  if (isObject(data.indexes)) {
    for (const [id, state] of Object.entries(data.indexes).slice(0, 20)) {
      if (typeof id === 'string' && id.length <= 200 && isObject(state)) indexes[id] = state;
    }
  }
  return {
    salt,
    address,
    lastAttemptAt: Math.min(finite(data.lastAttemptAt) ?? 0, now),
    // Kept until a log-in succeeds, whatever the time: never tried again by itself.
    refusal: address ? (validRefusal(data.refusal) ?? null) : null,
    lost: address ? (validLost(data.lost) ?? null) : null,
    info: validInfo(data.info) ?? null,
    // The `pv_index` option of the last start, and whether the solar index
    // came back from "Sensor only" and its first value is still to be held.
    pvMode:
      data.pvMode === 'sensor_only' || data.pvMode === 'energy_monitoring' ? data.pvMode : null,
    pvResume: data.pvResume === true,
    indexes,
  };
}

/**
 * The truncated (8-bit) salted fingerprint of a REFUSED log-in for an
 * address: the address, user name, password and RSCP password (none holds a
 * control character, so the separators are unambiguous). Never a secret.
 */
export function fingerprint(salt, address, { username, password, key }) {
  const text = [address, username, password, key].map(String).join('\u0000');
  return scryptSync(text, salt, 16).subarray(0, 1).toString('hex');
}
