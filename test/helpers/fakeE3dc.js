// -----------------------------------------------------------------------------
// A fake E3/DC system: a real TCP server on 127.0.0.1 (a free port), the RSCP
// of the reference (Rijndael-256 CBC streams, frames with a CRC). It deciphers
// with ITS key: a client with another key sends bytes it cannot read, and it
// closes the connection, as pye3dc expects (RSCPKeyError). Records the
// connections, the tags asked and the raw bytes received. Never leaves the
// loopback.
// -----------------------------------------------------------------------------

import { createServer } from 'node:net';
import { RscpCipher } from '../../src/e3dc/rijndael.js';
import { TAG, TYPE, buildFrame, decodeItems, readFrame } from '../../src/e3dc/rscp.js';

/** An RSCP value of any type, for the answers (`value` a number, string, list or error code). */
export function item(tag, type, value) {
  let body;
  switch (type) {
    case TYPE.NONE:
      body = Buffer.alloc(0);
      break;
    case TYPE.UCHAR8:
      body = Buffer.from([value]);
      break;
    case TYPE.INT32:
      body = Buffer.alloc(4);
      body.writeInt32LE(value);
      break;
    case TYPE.UINT32:
      body = Buffer.alloc(4);
      body.writeUInt32LE(value);
      break;
    case TYPE.FLOAT32:
      body = Buffer.alloc(4);
      body.writeFloatLE(value);
      break;
    case TYPE.DOUBLE64:
      body = Buffer.alloc(8);
      body.writeDoubleLE(value);
      break;
    case TYPE.CSTRING:
      body = Buffer.from(value, 'utf8');
      break;
    case TYPE.CONTAINER:
      body = Buffer.concat(value);
      break;
    case TYPE.ERROR:
      body = Buffer.alloc(4);
      body.writeUInt32LE(value);
      break;
    default:
      throw new Error(`type ${type} not in the fake`);
  }
  const head = Buffer.alloc(7);
  head.writeUInt32LE(tag >>> 0, 0);
  head.writeUInt8(type, 4);
  head.writeUInt16LE(body.length, 5);
  return Buffer.concat([head, body]);
}

/** The live answer of a system (the values of pye3dc's README, a few more). */
export function liveAnswer({
  serial = 'S10-123456789012',
  release = 'S10_2026_041',
  pv = 4321,
  bat = -1500,
  home = 820,
  grid = -1234,
  add = 0,
  autarky = 87.5,
  selfConsumption = 64.25,
  soc = 77,
  wb = 0,
  wbSolar = 0,
} = {}) {
  const parts = [];
  if (serial !== null) parts.push(item(TAG.INFO_SERIAL_NUMBER, TYPE.CSTRING, serial));
  if (release !== undefined) parts.push(item(TAG.INFO_SW_RELEASE, TYPE.CSTRING, release));
  const int = (tag, v) =>
    parts.push(v === 'error' ? item(tag, TYPE.ERROR, 6) : item(tag, TYPE.INT32, v));
  int(TAG.EMS_POWER_PV, pv);
  int(TAG.EMS_POWER_BAT, bat);
  int(TAG.EMS_POWER_HOME, home);
  int(TAG.EMS_POWER_GRID, grid);
  int(TAG.EMS_POWER_ADD, add);
  parts.push(item(TAG.EMS_AUTARKY, TYPE.FLOAT32, autarky));
  parts.push(item(TAG.EMS_SELF_CONSUMPTION, TYPE.FLOAT32, selfConsumption));
  parts.push(item(TAG.EMS_BAT_SOC, TYPE.UCHAR8, soc));
  int(TAG.EMS_POWER_WB_ALL, wb);
  int(TAG.EMS_POWER_WB_SOLAR, wbSolar);
  return Buffer.concat(parts);
}

/** The answer of the database for a day (Wh). */
export function dayAnswer({
  pv = 12345.5,
  batIn = 4000,
  batOut = 3000,
  gridIn = 2500,
  gridOut = 1500,
  consumption = 9000,
} = {}) {
  const f = (tag, v) => item(tag, TYPE.FLOAT32, v);
  return item(TAG.DB_HISTORY_DATA_DAY, TYPE.CONTAINER, [
    item(TAG.DB_SUM_CONTAINER, TYPE.CONTAINER, [
      f(TAG.DB_DC_POWER, pv),
      f(TAG.DB_BAT_POWER_IN, batIn),
      f(TAG.DB_BAT_POWER_OUT, batOut),
      f(TAG.DB_GRID_POWER_IN, gridIn),
      f(TAG.DB_GRID_POWER_OUT, gridOut),
      f(TAG.DB_CONSUMPTION, consumption),
    ]),
  ]);
}

/**
 * `options`: `key`, `username`, `password` (the account it accepts),
 * `level` (the user level of an accepted log-in), `live()` and `day()` (the
 * data of the answers), `onLogin`: 'close' | 'silent' | 'garbage' |
 * 'denied' | 'level0' to misbehave, `chunk` (bytes per write, to cut the
 * answers), `after(frameData)`: extra plain bytes appended after an answer
 * frame (inside the cipher), `extraCipher`: raw bytes sent after an
 * answer, `badCrc`, `dayMode`: 'error' | 'close'.
 */
export async function startFakeE3dc(options = {}) {
  const o = {
    key: 'abc123',
    username: 'user@example.com',
    password: 'secret-pass',
    level: 10,
    live: () => liveAnswer(),
    day: () => dayAnswer(),
    chunk: 0,
    ...options,
  };
  const record = {
    connections: 0,
    open: 0,
    maxOpen: 0,
    tags: [],
    raw: [],
    windows: [],
    logins: 0,
  };
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    record.connections += 1;
    record.open += 1;
    record.maxOpen = Math.max(record.maxOpen, record.open);
    socket.on('close', () => {
      record.open -= 1;
      sockets.delete(socket);
    });
    socket.on('error', () => {});
    const cipher = new RscpCipher(o.key);
    const out = new RscpCipher(o.key);
    let plain = Buffer.alloc(0);
    let requests = 0;
    const send = (data, { extra } = {}) => {
      const frame = buildFrame(data, Date.now());
      if (o.badCrc) frame[frame.length - 1] ^= 0xff;
      const body = extra ? Buffer.concat([frame, extra]) : frame;
      const bytes = out.encipher(body);
      if (o.chunk > 0) {
        for (let i = 0; i < bytes.length; i += o.chunk)
          socket.write(bytes.subarray(i, i + o.chunk));
      } else {
        socket.write(bytes);
      }
      if (o.extraCipher) socket.write(o.extraCipher);
    };
    socket.on('data', (chunk) => {
      record.raw.push(Buffer.from(chunk));
      plain = Buffer.concat([plain, cipher.decipher(chunk)]);
      let frame;
      try {
        frame = readFrame(plain);
      } catch {
        // Not readable with our key: the system closes.
        socket.destroy();
        return;
      }
      if (!frame.data) return;
      plain = Buffer.alloc(0);
      requests += 1;
      const items = decodeItems(frame.data);
      for (const it of items) record.tags.push(it.tag);
      if (requests === 1) {
        record.logins += 1;
        const auth = items[0];
        const user = auth?.value?.find((x) => x.tag === TAG.AUTHENTICATION_USER)?.value;
        const pass = auth?.value?.find((x) => x.tag === TAG.AUTHENTICATION_PASSWORD)?.value;
        if (o.onLogin === 'close') return socket.destroy();
        if (o.onLogin === 'silent') return;
        if (o.onLogin === 'garbage') return socket.write(Buffer.alloc(64, 0x5a));
        if (o.onLogin === 'denied' || user !== o.username || pass !== o.password) {
          return send(item(TAG.AUTHENTICATION, TYPE.ERROR, 2));
        }
        if (o.onLogin === 'level0') return send(item(TAG.AUTHENTICATION, TYPE.UCHAR8, 0));
        return send(item(TAG.AUTHENTICATION, TYPE.UCHAR8, o.level));
      }
      const first = items[0]?.tag;
      if (first === TAG.DB_REQ_HISTORY_DATA_DAY) {
        const w = items[0].value;
        record.windows.push({
          start: w.find((x) => x.tag === TAG.DB_REQ_HISTORY_TIME_START)?.value,
          span: w.find((x) => x.tag === TAG.DB_REQ_HISTORY_TIME_SPAN)?.value,
        });
        if (o.dayMode === 'close') return socket.destroy();
        if (o.dayMode === 'error') return send(item(TAG.DB_HISTORY_DATA_DAY, TYPE.ERROR, 0xff));
        return send(o.day());
      }
      return send(o.live(), { extra: o.after?.() });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    record,
    credentials: (extra = {}) => ({
      address: `127.0.0.1:${port}`,
      host: '127.0.0.1',
      port,
      username: o.username,
      password: o.password,
      key: o.key,
      ...extra,
    }),
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
