// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// The password and the RSCP password are secrets, and the user name (an
// e-mail address) is personal: none is ever logged, shown, written to /data
// nor put in an error; they only go into the enciphered log-in frame of RSCP,
// to the configured address.
// -----------------------------------------------------------------------------

import {
  DEFAULT_PORT,
  DEFAULT_TIME_ZONE,
  POLL_DEFAULT,
  POLL_MAX,
  POLL_MIN,
  PV_ENERGY_MONITORING,
  PV_SENSOR_ONLY,
} from './constants.js';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * An address typed by the user: an IP address or a host name, with an
 * optional port (5033 when absent). A pasted URL is reduced to its host and
 * port. (The parser of gladys-p1-monitor.)
 * @returns {{ address: string, host: string, port: number } | { error: 'invalid' } | { empty: true }}
 *   `address` is always `host:port` (the host of an IPv6 address in brackets).
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return { empty: true };
  }
  if (text.length > 300) {
    return { error: 'invalid' };
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  // user:password@ never belongs in the address: refused rather than sent around.
  if (text.includes('@')) {
    return { error: 'invalid' };
  }
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  if (bracketed) {
    return withPort(bracketed[1].toLowerCase(), bracketed[2], true);
  }
  if (/^[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) ?? []).length >= 2) {
    return withPort(text.toLowerCase(), undefined, true);
  }
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(text);
  const host = match[1];
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) {
    return { error: 'invalid' };
  }
  return withPort(host.toLowerCase(), match[2], false);
}

function withPort(host, port, ipv6) {
  const number = port === undefined ? DEFAULT_PORT : Number(port);
  if (number < 1 || number > 65535) {
    return { error: 'invalid' };
  }
  return { address: `${ipv6 ? `[${host}]` : host}:${number}`, host, port: number };
}

/** Any C0 control character or DEL: never in a name nor a secret of the form. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A text of the form: a string, else ''. */
const textOf = (raw) => (typeof raw === 'string' ? raw : '');

/** The user name of the E3/DC account: trimmed, 1 to 256 characters, no control character. */
function usernameOf(raw) {
  const value = textOf(raw).trim();
  if (value === '') return { missing: true };
  return value.length <= 256 && !CONTROL.test(value) ? { value } : { invalid: true };
}

/** The password of the account: never trimmed (a space may be part of it). */
function passwordOf(raw) {
  const value = textOf(raw);
  if (value === '') return { missing: true };
  return value.length <= 256 && !CONTROL.test(value) ? { value } : { invalid: true };
}

/** The RSCP password (the key of the frames): 1 to 32 bytes in UTF-8, never trimmed. */
function keyOf(raw) {
  const value = textOf(raw);
  if (value === '') return { missing: true };
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes <= 32 && !CONTROL.test(value) ? { value } : { invalid: true };
}

/** The reading interval (s): a number from 30 to 300, else 30. */
function pollOf(raw) {
  const value = typeof raw === 'string' && /^\d{1,6}$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return POLL_DEFAULT;
  }
  return Math.min(POLL_MAX, Math.max(POLL_MIN, Math.round(value)));
}

/** An IANA time zone the runtime knows, else undefined. */
export function timeZoneOf(raw) {
  const value = textOf(raw).trim();
  if (value === '' || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * `{ address, host, port, username, password, key, pollInterval, pvIndex,
 * timeZone, timeZoneInvalid, problem }`. The secrets are undefined when the
 * form has a problem: 'address_missing', 'address_invalid',
 * 'username_missing', 'username_invalid', 'password_missing',
 * 'password_invalid', 'key_missing', 'key_invalid' or undefined.
 */
export function normalizeConfig(raw = {}) {
  const parsed = parseAddress(textOf(raw?.address));
  const username = usernameOf(raw?.username);
  const password = passwordOf(raw?.password);
  const key = keyOf(raw?.rscp_key);
  let problem;
  if (parsed.empty) problem = 'address_missing';
  else if (parsed.error) problem = 'address_invalid';
  else if (username.missing) problem = 'username_missing';
  else if (username.invalid) problem = 'username_invalid';
  else if (password.missing) problem = 'password_missing';
  else if (password.invalid) problem = 'password_invalid';
  else if (key.missing) problem = 'key_missing';
  else if (key.invalid) problem = 'key_invalid';
  const typedZone = textOf(raw?.time_zone).trim();
  const zone = timeZoneOf(typedZone);
  return {
    address: parsed.address,
    host: parsed.host,
    port: parsed.port,
    username: problem ? undefined : username.value,
    password: problem ? undefined : password.value,
    key: problem ? undefined : key.value,
    pollInterval: pollOf(raw?.poll_interval),
    // The solar production as an index of the energy monitoring (default), or
    // a plain sensor only (an inverter already sends it to Gladys).
    pvIndex: raw?.pv_index === PV_SENSOR_ONLY ? PV_SENSOR_ONLY : PV_ENERGY_MONITORING,
    timeZone: zone ?? DEFAULT_TIME_ZONE,
    timeZoneInvalid: typedZone !== '' && zone === undefined,
    problem,
  };
}
