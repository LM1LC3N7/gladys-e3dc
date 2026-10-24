// -----------------------------------------------------------------------------
// RSCP frames and values: the bytes we send are those of the reference
// (pye3dc, test/fixtures/vectors.json), the decoder is bounded and strict,
// and no tag that sets anything is known.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { MAX_DEPTH, MAX_ITEMS } from '../src/constants.js';
import { RscpSession, dayData, liveData } from '../src/e3dc/client.js';
import { RscpCipher } from '../src/e3dc/rijndael.js';
import {
  RscpFormatError,
  TAG,
  TYPE,
  buildFrame,
  crc32,
  decodeItems,
  encodeItem,
  readFrame,
} from '../src/e3dc/rscp.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/vectors.json', import.meta.url), 'utf8'));
const hex = (b) => Buffer.from(b).toString('hex');

test('the values we send: byte for byte those of pye3dc', () => {
  assert.equal(hex(encodeItem({ tag: TAG.EMS_REQ_POWER_PV, type: TYPE.NONE })), V.tlv.poll);
  assert.equal(hex(dayData({ start: 1_700_000_000, span: 86_400 })), V.tlv.db);
  const auth = encodeItem({
    tag: TAG.REQ_AUTHENTICATION,
    type: TYPE.CONTAINER,
    value: [
      { tag: TAG.AUTHENTICATION_USER, type: TYPE.CSTRING, value: 'user@example.com' },
      { tag: TAG.AUTHENTICATION_PASSWORD, type: TYPE.CSTRING, value: 'secret-pass' },
    ],
  });
  assert.equal(hex(auth), V.tlv.auth);
  // The frame, dated as pye3dc dates it (its clock fixed at 1700000000.25 s).
  assert.equal(hex(buildFrame(auth, 1_700_000_000_250)), V.frame_auth);
});

test('a frame of the reference is read back; its values decoded', () => {
  const frame = readFrame(Buffer.from(V.frame_answer, 'hex'));
  assert.equal(frame.size, V.frame_answer.length / 2);
  const items = decodeItems(frame.data);
  assert.deepEqual(
    items.map((i) => [i.tag, i.type]),
    [
      [TAG.AUTHENTICATION, TYPE.UCHAR8],
      [TAG.EMS_POWER_PV, TYPE.INT32],
      [TAG.EMS_POWER_GRID, TYPE.INT32],
      [TAG.EMS_BAT_SOC, TYPE.UCHAR8],
      [TAG.EMS_AUTARKY, TYPE.FLOAT32],
      [TAG.INFO_SERIAL_NUMBER, TYPE.CSTRING],
      [TAG.DB_HISTORY_DATA_DAY, TYPE.CONTAINER],
      [TAG.EMS_POWER_WB_ALL, TYPE.ERROR],
    ],
  );
  assert.equal(items[0].value, V.frame_answer_first[2]);
  assert.equal(items[2].value, -1234);
  assert.equal(items[5].value, 'S10-123456789012');
  assert.equal(items[6].value[0].value[0].value, 12345.5);
  assert.equal(items[7].value, 6, 'RSCP_ERR_NOT_AVAILABLE');
});

test('the CRC is the one of zlib', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('frames: incomplete waits, another magic, the compact format or a wrong CRC throw', () => {
  const frame = Buffer.from(V.frame_answer, 'hex');
  assert.deepEqual(readFrame(frame.subarray(0, 3)), { need: undefined });
  assert.deepEqual(readFrame(frame.subarray(0, 17)), { need: undefined });
  assert.deepEqual(readFrame(frame.subarray(0, 40)), { need: frame.length });
  // Only `length` bytes of a larger buffer count.
  assert.deepEqual(readFrame(frame, frame.length - 1), { need: frame.length });
  const other = Buffer.from(frame);
  other[0] = 0x00;
  assert.throws(() => readFrame(other), RscpFormatError);
  const compact = Buffer.from(frame);
  compact[3] = 0x13;
  assert.throws(() => readFrame(compact), RscpFormatError);
  const v2 = Buffer.from(frame);
  v2[3] = 0x12;
  assert.throws(() => readFrame(v2), RscpFormatError);
  const crc = Buffer.from(frame);
  crc[crc.length - 1] ^= 1;
  assert.throws(() => readFrame(crc), /wrong CRC/);
  const data = Buffer.from(frame);
  data[20] ^= 1;
  assert.throws(() => readFrame(data), /wrong CRC/);
});

const raw = (tag, type, body, length = body.length) => {
  const head = Buffer.alloc(7);
  head.writeUInt32LE(tag, 0);
  head.writeUInt8(type, 4);
  head.writeUInt16LE(length, 5);
  return Buffer.concat([head, body]);
};

test('values: a length past the end or a truncated header throw', () => {
  assert.throws(() => decodeItems(raw(1, TYPE.INT32, Buffer.alloc(4), 5)), RscpFormatError);
  assert.throws(() => decodeItems(Buffer.alloc(5)), /truncated/);
  const inner = raw(2, TYPE.INT32, Buffer.alloc(4));
  // A container whose content says more than the container holds.
  const lying = raw(1, TYPE.CONTAINER, Buffer.concat([inner.subarray(0, 7), Buffer.alloc(1)]));
  assert.throws(() => decodeItems(lying), RscpFormatError);
});

test('values: a fixed type of another size is left out, the walk goes on', () => {
  const items = decodeItems(
    Buffer.concat([
      raw(TAG.EMS_POWER_PV, TYPE.INT32, Buffer.alloc(2)),
      raw(TAG.EMS_POWER_BAT, TYPE.INT32, Buffer.from([1, 0, 0, 0])),
      raw(TAG.EMS_POWER_HOME, TYPE.ERROR, Buffer.alloc(6)),
    ]),
  );
  assert.equal(items[0].bad, true);
  assert.equal(items[0].value, undefined);
  assert.equal(items[1].value, 1);
  assert.equal(items[2].bad, true);
});

test('values: bounded depth and count', () => {
  let nested = raw(9, TYPE.INT32, Buffer.alloc(4));
  for (let i = 0; i <= MAX_DEPTH; i += 1) nested = raw(1, TYPE.CONTAINER, nested);
  assert.throws(() => decodeItems(nested), /too deep/);
  const many = Buffer.concat(
    Array.from({ length: MAX_ITEMS + 1 }, () => raw(1, TYPE.NONE, Buffer.alloc(0))),
  );
  assert.throws(() => decodeItems(many), /too many/);
  const enough = Buffer.concat(
    Array.from({ length: MAX_ITEMS }, () => raw(1, TYPE.NONE, Buffer.alloc(0))),
  );
  assert.equal(decodeItems(enough).length, MAX_ITEMS);
});

test('values: never a prototype key, never a value copied from an unused type', () => {
  const items = decodeItems(
    Buffer.concat([
      raw(1, TYPE.BYTEARRAY, Buffer.from('__proto__')),
      raw(2, TYPE.CSTRING, Buffer.from('__proto__')),
    ]),
  );
  assert.equal(items[0].value, undefined);
  assert.equal(items[1].value, '__proto__');
  assert.equal({}.polluted, undefined);
});

test('read-only: no known tag sets anything; only the read requests are built', () => {
  for (const name of Object.keys(TAG)) {
    assert.doesNotMatch(name, /SET|WRITE|_REQ_.*(START|STOP)_|CHARGE_ENABLED|IDLE/, name);
  }
  const tags = decodeItems(liveData()).map((i) => i.tag);
  assert.ok(
    tags.every((t) => (t & 0x00800000) === 0),
    'requests only',
  );
  assert.throws(
    () => encodeItem({ tag: 1, type: TYPE.INT32, value: 1 }),
    /never sent/,
    'no writable value type is ever encoded',
  );
});

/** A socket of the session (no network): what is written, what comes. */
function fakeSocket() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.destroyed = false;
  socket.write = (b) => socket.written.push(Buffer.from(b));
  socket.destroy = () => {
    socket.destroyed = true;
  };
  return socket;
}

test('session: bytes with no request waiting, or an answer too large, end it', async () => {
  const socket = fakeSocket();
  const session = new RscpSession(socket, new RscpCipher('abc123'));
  socket.emit('data', Buffer.alloc(32));
  assert.equal(session.dead?.code, 'protocol');
  assert.equal(socket.destroyed, true);
  await assert.rejects(session.request(liveData()), { code: 'protocol' });

  const big = fakeSocket();
  const s2 = new RscpSession(big, new RscpCipher('abc123'));
  const pending = s2.request(liveData());
  // An endless stream: never kept beyond one answer's bound.
  const device = new RscpCipher('abc123');
  const header = Buffer.from(V.frame_answer, 'hex').subarray(0, 18);
  header.writeUInt16LE(0xffff, 16);
  big.emit('data', device.encipher(header));
  for (let i = 0; i < 2100 && !s2.dead; i += 1) big.emit('data', device.encipher(Buffer.alloc(32)));
  await assert.rejects(pending, { code: 'protocol' });
});

test('session: the plain log-in frame is wiped once enciphered', async () => {
  const socket = fakeSocket();
  const session = new RscpSession(socket, new RscpCipher('abc123'), { answerTimeout: 10 });
  const data = encodeItem({
    tag: TAG.REQ_AUTHENTICATION,
    type: TYPE.CONTAINER,
    value: [{ tag: TAG.AUTHENTICATION_PASSWORD, type: TYPE.CSTRING, value: 'secret-pass' }],
  });
  const pending = session.request(data);
  assert.ok(data.every((b) => b === 0));
  assert.equal(socket.written.length, 1);
  assert.equal(socket.written[0].indexOf(Buffer.from('secret-pass')), -1);
  await assert.rejects(pending, { code: 'timeout' });
});
