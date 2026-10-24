// -----------------------------------------------------------------------------
// RSCP, the "Remote Storage Control Protocol" of E3/DC: frames and their
// tagged values. Pure. Ported from pye3dc (_rscpLib.py, _rscpTags.py, MIT,
// see THIRD_PARTY_NOTICES.md), byte for byte for what we send
// (test/rscp.test.js compares with frames made by the reference code).
//
// A frame (the standard format, version 1, with a CRC):
//   magic E3 DC | ctrl 00 11 | seconds (8, LE) | nanoseconds (4, LE)
//   | length of the data (2, LE) | data | CRC-32 of all the above (4, LE)
// The data is a list of values: tag (4, LE) | type (1) | length (2, LE) |
// value; a container's value is a list of values again.
//
// Only the tags this read-only integration uses are listed: the log-in, the
// live values of the EMS, the serial and software of the system, and the
// energies of a day from its database. No tag that sets anything is known
// here, so none can be sent (test/rscp.test.js checks it).
//
// The decoder is bounded and linear: every length is checked against what is
// left before anything is read, a value of a fixed type must have exactly its
// size (else it is left out, the walk goes on by its length), at most
// MAX_ITEMS values and MAX_DEPTH levels of containers, and each byte is read
// once. Nothing decoded is ever logged.
// -----------------------------------------------------------------------------

import { MAX_DEPTH, MAX_ITEMS } from '../constants.js';

/** The RSCP data types (pye3dc RscpType). */
export const TYPE = {
  NONE: 0x00,
  BOOL: 0x01,
  CHAR8: 0x02,
  UCHAR8: 0x03,
  INT16: 0x04,
  UINT16: 0x05,
  INT32: 0x06,
  UINT32: 0x07,
  INT64: 0x08,
  UINT64: 0x09,
  FLOAT32: 0x0a,
  DOUBLE64: 0x0b,
  BITFIELD: 0x0c,
  CSTRING: 0x0d,
  CONTAINER: 0x0e,
  TIMESTAMP: 0x0f,
  BYTEARRAY: 0x10,
  ERROR: 0xff,
};

/** The size of each fixed-size type. */
const FIXED = new Map([
  [TYPE.NONE, 0],
  [TYPE.BOOL, 1],
  [TYPE.CHAR8, 1],
  [TYPE.UCHAR8, 1],
  [TYPE.INT16, 2],
  [TYPE.UINT16, 2],
  [TYPE.INT32, 4],
  [TYPE.UINT32, 4],
  [TYPE.INT64, 8],
  [TYPE.UINT64, 8],
  [TYPE.FLOAT32, 4],
  [TYPE.DOUBLE64, 8],
  [TYPE.TIMESTAMP, 12],
]);

/** The tags used (pye3dc RscpTag). An answer's tag is its request's | 0x00800000. */
export const TAG = {
  REQ_AUTHENTICATION: 0x00000001,
  AUTHENTICATION_USER: 0x00000002,
  AUTHENTICATION_PASSWORD: 0x00000003,
  AUTHENTICATION: 0x00800001,
  GENERAL_ERROR: 0x00ffffff,

  EMS_REQ_POWER_PV: 0x01000001,
  EMS_REQ_POWER_BAT: 0x01000002,
  EMS_REQ_POWER_HOME: 0x01000003,
  EMS_REQ_POWER_GRID: 0x01000004,
  EMS_REQ_POWER_ADD: 0x01000005,
  EMS_REQ_AUTARKY: 0x01000006,
  EMS_REQ_SELF_CONSUMPTION: 0x01000007,
  EMS_REQ_BAT_SOC: 0x01000008,
  EMS_REQ_POWER_WB_ALL: 0x0100001f,
  EMS_REQ_POWER_WB_SOLAR: 0x01000020,
  EMS_POWER_PV: 0x01800001,
  EMS_POWER_BAT: 0x01800002,
  EMS_POWER_HOME: 0x01800003,
  EMS_POWER_GRID: 0x01800004,
  EMS_POWER_ADD: 0x01800005,
  EMS_AUTARKY: 0x01800006,
  EMS_SELF_CONSUMPTION: 0x01800007,
  EMS_BAT_SOC: 0x01800008,
  EMS_POWER_WB_ALL: 0x0180001f,
  EMS_POWER_WB_SOLAR: 0x01800020,

  INFO_REQ_SERIAL_NUMBER: 0x0a000001,
  INFO_REQ_SW_RELEASE: 0x0a000019,
  INFO_SERIAL_NUMBER: 0x0a800001,
  INFO_SW_RELEASE: 0x0a800019,

  DB_REQ_HISTORY_DATA_DAY: 0x06000100,
  DB_REQ_HISTORY_TIME_START: 0x06000101,
  DB_REQ_HISTORY_TIME_INTERVAL: 0x06000102,
  DB_REQ_HISTORY_TIME_SPAN: 0x06000103,
  DB_HISTORY_DATA_DAY: 0x06800100,
  DB_SUM_CONTAINER: 0x06800010,
  DB_BAT_POWER_IN: 0x06800002,
  DB_BAT_POWER_OUT: 0x06800003,
  DB_DC_POWER: 0x06800004,
  DB_GRID_POWER_IN: 0x06800005,
  DB_GRID_POWER_OUT: 0x06800006,
  DB_CONSUMPTION: 0x06800007,
};

/** RSCP error codes (pye3dc RscpError). */
export const RSCP_ERROR = {
  NOT_HANDLED: 0x01,
  ACCESS_DENIED: 0x02,
  FORMAT: 0x03,
  AGAIN: 0x04,
  OUT_OF_BOUNDS: 0x05,
  NOT_AVAILABLE: 0x06,
  UNKNOWN_TAG: 0x07,
  ALREADY_IN_USE: 0x08,
};

export class RscpFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RscpFormatError';
  }
}

// --- Values ------------------------------------------------------------------------

const HEADER = 7;

/**
 * One value, encoded. `item`: `{ tag, type, value }`; value: undefined for
 * NONE, a number (or bigint for the 64-bit types), a string for CSTRING, a
 * list of items for CONTAINER. Only the types we send are written.
 */
export function encodeItem({ tag, type, value }) {
  let body;
  switch (type) {
    case TYPE.NONE:
      body = Buffer.alloc(0);
      break;
    case TYPE.UINT16:
      body = Buffer.alloc(2);
      body.writeUInt16LE(value);
      break;
    case TYPE.UINT64:
      body = Buffer.alloc(8);
      body.writeBigUInt64LE(BigInt(value));
      break;
    case TYPE.CSTRING:
      body = Buffer.from(String(value), 'utf8');
      break;
    case TYPE.CONTAINER:
      body = Buffer.concat(value.map(encodeItem));
      break;
    default:
      throw new TypeError(`type ${type} is never sent`);
  }
  if (body.length > 0xffff) {
    throw new RangeError('value too long for RSCP');
  }
  const head = Buffer.alloc(HEADER);
  head.writeUInt32LE(tag >>> 0, 0);
  head.writeUInt8(type, 4);
  head.writeUInt16LE(body.length, 5);
  return Buffer.concat([head, body]);
}

/** Several values one after the other (the data of one frame). */
export const encodeItems = (items) => Buffer.concat(items.map(encodeItem));

function leaf(type, buf, at, length) {
  const fixed = FIXED.get(type);
  if (fixed !== undefined && fixed !== length) {
    return { bad: true };
  }
  switch (type) {
    case TYPE.NONE:
      return { value: undefined };
    case TYPE.BOOL:
      return { value: buf[at] !== 0 };
    case TYPE.CHAR8:
      return { value: buf.readInt8(at) };
    case TYPE.UCHAR8:
      return { value: buf.readUInt8(at) };
    case TYPE.INT16:
      return { value: buf.readInt16LE(at) };
    case TYPE.UINT16:
      return { value: buf.readUInt16LE(at) };
    case TYPE.INT32:
      return { value: buf.readInt32LE(at) };
    case TYPE.UINT32:
      return { value: buf.readUInt32LE(at) };
    case TYPE.INT64:
      return { value: Number(buf.readBigInt64LE(at)) };
    case TYPE.UINT64:
      return { value: Number(buf.readBigUInt64LE(at)) };
    case TYPE.FLOAT32:
      return { value: buf.readFloatLE(at) };
    case TYPE.DOUBLE64:
      return { value: buf.readDoubleLE(at) };
    case TYPE.TIMESTAMP:
      // Seconds (Int64, LE) and nanoseconds (Int32): never used, kept as seconds.
      return { value: Number(buf.readBigInt64LE(at)) };
    case TYPE.CSTRING:
      // Bounded by the frame (at most 64 KiB); invalid UTF-8 becomes U+FFFD.
      return { value: buf.toString('utf8', at, at + length) };
    case TYPE.ERROR:
      // A code of 1 to 4 bytes, little-endian.
      if (length < 1 || length > 4) return { bad: true };
      return { value: buf.readUIntLE(at, length) };
    case TYPE.BITFIELD:
    case TYPE.BYTEARRAY:
      // Never used here: not copied.
      return { value: undefined };
    default:
      return { bad: true };
  }
}

/**
 * The values of the data of a frame: `[{ tag, type, value, bad? }]`, a
 * container's value being a list again. Throws RscpFormatError on a length
 * past the end, too many values or too deep.
 */
export function decodeItems(buf) {
  const budget = { items: 0 };
  return decodeRange(buf, 0, buf.length, 0, budget);
}

function decodeRange(buf, start, end, depth, budget) {
  if (depth > MAX_DEPTH) {
    throw new RscpFormatError('containers too deep');
  }
  const items = [];
  let at = start;
  while (at < end) {
    if (end - at < HEADER) {
      throw new RscpFormatError('truncated value header');
    }
    budget.items += 1;
    if (budget.items > MAX_ITEMS) {
      throw new RscpFormatError('too many values');
    }
    const tag = buf.readUInt32LE(at);
    const type = buf.readUInt8(at + 4);
    const length = buf.readUInt16LE(at + 5);
    const valueAt = at + HEADER;
    if (length > end - valueAt) {
      throw new RscpFormatError('value longer than its frame');
    }
    if (type === TYPE.CONTAINER) {
      items.push({
        tag,
        type,
        value: decodeRange(buf, valueAt, valueAt + length, depth + 1, budget),
      });
    } else {
      items.push({ tag, type, ...leaf(type, buf, valueAt, length) });
    }
    at = valueAt + length;
  }
  return items;
}

/** The first item of `tag` in `items` (not inside containers). */
export const find = (items, tag) =>
  Array.isArray(items) ? items.find((item) => item.tag === tag) : undefined;

// --- Frames ------------------------------------------------------------------------

const MAGIC = 0xe3dc;
const CTRL = 0x0011;
export const FRAME_HEADER = 18;
const CRC_SIZE = 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 of zlib (the one of RSCP frames). */
export function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A frame around `data`, dated `nowMs`. The time is written as pye3dc writes
 * it (the seconds rounded up, the milliseconds in the nanoseconds field): the
 * bytes the systems in the field already take.
 */
export function buildFrame(data, nowMs) {
  if (data.length > 0xffff) {
    throw new RangeError('frame data too long');
  }
  const t = nowMs / 1000;
  const frame = Buffer.alloc(FRAME_HEADER + data.length + CRC_SIZE);
  frame.writeUInt16BE(MAGIC, 0);
  frame.writeUInt16BE(CTRL, 2);
  frame.writeUInt32LE(Math.ceil(t) >>> 0, 4);
  frame.writeUInt32LE(0, 8);
  frame.writeUInt32LE(Math.round((t - Math.trunc(t)) * 1000) >>> 0, 12);
  frame.writeUInt16LE(data.length, 16);
  data.copy(frame, FRAME_HEADER);
  frame.writeUInt32LE(crc32(frame, 0, FRAME_HEADER + data.length), FRAME_HEADER + data.length);
  return frame;
}

/**
 * Looks for one frame at the start of `buf` (the deciphered bytes received,
 * `length` of them). Returns `{ need: n }` while incomplete (n: the total
 * size the frame needs, when known), `{ data, size }` when complete and
 * checked (`data` a copy). Throws RscpFormatError on another magic, any
 * control word but 0x0011 (version 1 with a CRC: never a frame without a
 * CRC, never the compact format), or a wrong CRC.
 */
export function readFrame(buf, length = buf.length) {
  if (length < 4) {
    return { need: undefined };
  }
  if (buf.readUInt16BE(0) !== MAGIC) {
    throw new RscpFormatError('not an RSCP frame');
  }
  // Only the form we send and pye3dc reads: version 1 WITH a CRC (the
  // cipher gives no integrity: the CRC is the only check of the bytes).
  if (buf.readUInt16BE(2) !== CTRL) {
    throw new RscpFormatError('unknown frame format');
  }
  if (length < FRAME_HEADER) {
    return { need: undefined };
  }
  const dataLength = buf.readUInt16LE(16);
  const size = FRAME_HEADER + dataLength + CRC_SIZE;
  if (length < size) {
    return { need: size };
  }
  const end = FRAME_HEADER + dataLength;
  if (crc32(buf, 0, end) !== buf.readUInt32LE(end)) {
    throw new RscpFormatError('wrong CRC');
  }
  return {
    data: Buffer.from(buf.subarray(FRAME_HEADER, FRAME_HEADER + dataLength)),
    size,
  };
}
