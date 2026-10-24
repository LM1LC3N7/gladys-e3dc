// -----------------------------------------------------------------------------
// The only network access: RSCP over TCP to the E3/DC system on the home
// network (port 5033), after pye3dc (_e3dc_rscp_local.py, MIT, see
// THIRD_PARTY_NOTICES.md). Never the E3/DC portal.
//
// One session per read, and ONE at a time (a second one is refused, never
// opened): connect, log in (user name and password of the E3/DC account, the
// frames enciphered with the RSCP password), ask the live values, ask the
// energies of the day, close. One request and one answer frame at a time.
//
// READ-ONLY: the requests are built here from a fixed list of tags that only
// read (src/e3dc/rscp.js knows no tag that sets anything); nothing else can
// be sent.
//
// Bounded and linear: the deciphered bytes of one answer go into ONE buffer of
// MAX_ANSWER_BYTES (no buffer per chunk, no concatenation); the frame is
// checked (magic, format, length, CRC) as soon as it is complete; bytes with
// no request waiting, more than one frame, or anything but zero padding after
// it end the session. Every wait is bounded: the connection, each answer, the
// whole session.
//
// Secrets: the user name, the password and the RSCP password only go into
// the enciphered log-in frame to the configured address; the plain frame is
// wiped once enciphered. Errors carry our own codes, never a byte received,
// never a secret. Nothing here logs anything.
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import {
  ANSWER_TIMEOUT,
  CONNECT_TIMEOUT,
  MAX_ANSWER_BYTES,
  SESSION_TIMEOUT,
} from '../constants.js';
import { RscpCipher } from './rijndael.js';
import {
  RSCP_ERROR,
  TAG,
  TYPE,
  buildFrame,
  decodeItems,
  encodeItem,
  encodeItems,
  find,
  readFrame,
} from './rscp.js';

export class E3dcError extends Error {
  /**
   * @param {'unreachable'|'timeout'|'closed'|'protocol'|'refused'|'login_lost'|'aborted'|'busy'} code
   *   refused: the system said no to the user name or password (access
   *   denied, or user level 0); login_lost: the session closed, or no
   *   readable answer came, right after the log-in frame (the RSCP password
   *   most likely: the system cannot read our frame).
   */
  constructor(code) {
    super(code);
    this.name = 'E3dcError';
    this.code = code;
  }
}

/** The live values asked at each read (pye3dc poll + get_system_info). */
export const LIVE_REQUESTS = [
  TAG.INFO_REQ_SERIAL_NUMBER,
  TAG.INFO_REQ_SW_RELEASE,
  TAG.EMS_REQ_POWER_PV,
  TAG.EMS_REQ_POWER_BAT,
  TAG.EMS_REQ_POWER_HOME,
  TAG.EMS_REQ_POWER_GRID,
  TAG.EMS_REQ_POWER_ADD,
  TAG.EMS_REQ_AUTARKY,
  TAG.EMS_REQ_SELF_CONSUMPTION,
  TAG.EMS_REQ_BAT_SOC,
  TAG.EMS_REQ_POWER_WB_ALL,
  TAG.EMS_REQ_POWER_WB_SOLAR,
];

/** The data of the live request: every tag without a value, in one frame. */
export const liveData = () => encodeItems(LIVE_REQUESTS.map((tag) => ({ tag, type: TYPE.NONE })));

/**
 * The energies of one window of the database (pye3dc get_db_data_timestamp):
 * `start` (s, UTC) and `span` (s), one interval for the whole window.
 */
export const dayData = ({ start, span }) =>
  encodeItem({
    tag: TAG.DB_REQ_HISTORY_DATA_DAY,
    type: TYPE.CONTAINER,
    value: [
      { tag: TAG.DB_REQ_HISTORY_TIME_START, type: TYPE.UINT64, value: start },
      { tag: TAG.DB_REQ_HISTORY_TIME_INTERVAL, type: TYPE.UINT64, value: span },
      { tag: TAG.DB_REQ_HISTORY_TIME_SPAN, type: TYPE.UINT64, value: span },
    ],
  });

/** The default connector: a plain TCP socket. */
export function tcpConnect(host, port) {
  const socket = createConnection({ host, port });
  socket.setNoDelay?.(true);
  return socket;
}

/** One RSCP session on a connected socket. */
export class RscpSession {
  constructor(
    socket,
    cipher,
    { timers = globalThis, now = Date.now, answerTimeout = ANSWER_TIMEOUT } = {},
  ) {
    this.socket = socket;
    this.answerTimeout = answerTimeout;
    this.cipher = cipher;
    this.timers = timers;
    this.now = now;
    this.plain = Buffer.alloc(MAX_ANSWER_BYTES);
    this.length = 0;
    this.pending = undefined;
    this.dead = undefined;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.fail(new E3dcError('closed')));
    socket.on('close', () => this.fail(new E3dcError('closed')));
  }

  onData(chunk) {
    if (this.dead) return;
    if (!this.pending) {
      this.fail(new E3dcError('protocol'));
      return;
    }
    let plain;
    try {
      plain = this.cipher.decipher(chunk);
    } catch {
      this.fail(new E3dcError('protocol'));
      return;
    }
    if (this.length + plain.length > this.plain.length) {
      this.fail(new E3dcError('protocol'));
      return;
    }
    plain.copy(this.plain, this.length);
    this.length += plain.length;
    let frame;
    try {
      frame = readFrame(this.plain, this.length);
    } catch {
      this.fail(new E3dcError('protocol'));
      return;
    }
    if (!frame.data) {
      return;
    }
    // Only the zero padding of the last block may follow the frame.
    const rest = this.plain.subarray(frame.size, this.length);
    if (rest.length >= 32 || rest.some((b) => b !== 0) || this.cipher.partialLength > 0) {
      this.fail(new E3dcError('protocol'));
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    this.length = 0;
    this.timers.clearTimeout(pending.timer);
    pending.resolve(frame.data);
  }

  fail(err) {
    if (this.dead) return;
    this.dead = err;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      this.timers.clearTimeout(pending.timer);
      pending.reject(err);
    }
    try {
      this.socket.destroy();
    } catch {
      // Already closed.
    }
  }

  close() {
    this.fail(new E3dcError('aborted'));
  }

  /** Sends the frame of `data` and resolves with the data of the answer frame. */
  request(data, timeoutMs = this.answerTimeout) {
    return new Promise((resolve, reject) => {
      if (this.dead) {
        reject(this.dead);
        return;
      }
      if (this.pending) {
        reject(new E3dcError('protocol'));
        return;
      }
      const frame = buildFrame(data, this.now());
      const bytes = this.cipher.encipher(frame);
      // The plain frame may hold the password: wiped once enciphered.
      frame.fill(0);
      data.fill(0);
      this.length = 0;
      this.pending = {
        resolve,
        reject,
        timer: this.timers.setTimeout(() => this.fail(new E3dcError('timeout')), timeoutMs),
      };
      try {
        this.socket.write(bytes);
      } catch {
        this.fail(new E3dcError('closed'));
      }
    });
  }
}

/** Opens the TCP connection, bounded by CONNECT_TIMEOUT. */
function open(connect, host, port, timers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = connect(host, port);
    } catch {
      reject(new E3dcError('unreachable'));
      return;
    }
    const done = (err) => {
      timers.clearTimeout(timer);
      socket.off?.('connect', onConnect);
      socket.off?.('error', onError);
      if (err) {
        try {
          socket.destroy();
        } catch {
          // Already closed.
        }
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const onConnect = () => done();
    const onError = () => done(new E3dcError('unreachable'));
    const timer = timers.setTimeout(() => done(new E3dcError('timeout')), timeoutMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

/** The error code carried by an RSCP value of type ERROR, else undefined. */
export const errorOf = (item) => (item?.type === TYPE.ERROR ? item.value : undefined);

/**
 * The answer to the log-in: accepted (a user level above 0), refused (access
 * denied, or level 0), or not an answer to it (protocol).
 */
export function loginResult(items) {
  const auth = find(items, TAG.AUTHENTICATION) ?? find(items, TAG.GENERAL_ERROR);
  if (!auth) return 'protocol';
  const error = errorOf(auth);
  if (error !== undefined) {
    return error === RSCP_ERROR.ACCESS_DENIED ? 'refused' : 'protocol';
  }
  if (auth.type !== TYPE.UCHAR8 || auth.bad) return 'protocol';
  return auth.value > 0 ? 'ok' : 'refused';
}

export class E3dcClient {
  constructor({
    connect = tcpConnect,
    timers = globalThis,
    now = Date.now,
    timeouts: {
      connect: connectTimeout = CONNECT_TIMEOUT,
      answer: answerTimeout = ANSWER_TIMEOUT,
      session: sessionTimeout = SESSION_TIMEOUT,
    } = {},
  } = {}) {
    this.connect = connect;
    this.timers = timers;
    this.now = now;
    this.timeouts = { connectTimeout, answerTimeout, sessionTimeout };
    this.active = undefined;
  }

  /**
   * One read: `{ live, day, dayFailed }`, `live` the values of the live
   * request (a list of RSCP items), `day` those of the energies of `window`
   * (or undefined, `dayFailed` then says why). `credentials`: `{ host, port,
   * username, password, key }`. `alive()` false stops the session between
   * two requests (aborted).
   */
  async read(credentials, window, alive = () => true) {
    if (this.active) {
      throw new E3dcError('busy');
    }
    const job = this.session(credentials, window, alive);
    this.active = job;
    try {
      return await job;
    } finally {
      this.active = undefined;
    }
  }

  async session({ host, port, username, password, key }, window, alive) {
    let cipher;
    try {
      cipher = new RscpCipher(key);
    } catch {
      throw new E3dcError('refused');
    }
    const { connectTimeout, answerTimeout, sessionTimeout } = this.timeouts;
    const socket = await open(this.connect, host, port, this.timers, connectTimeout);
    const session = new RscpSession(socket, cipher, {
      timers: this.timers,
      now: this.now,
      answerTimeout,
    });
    const deadline = this.timers.setTimeout(
      () => session.fail(new E3dcError('timeout')),
      sessionTimeout,
    );
    try {
      let answer;
      try {
        answer = decodeItems(
          await session.request(
            encodeItem({
              tag: TAG.REQ_AUTHENTICATION,
              type: TYPE.CONTAINER,
              value: [
                { tag: TAG.AUTHENTICATION_USER, type: TYPE.CSTRING, value: username },
                { tag: TAG.AUTHENTICATION_PASSWORD, type: TYPE.CSTRING, value: password },
              ],
            }),
          ),
        );
      } catch {
        // Closed, no answer, or bytes that are no frame with our key, right
        // after the log-in: the system could not read it (pye3dc RSCPKeyError).
        throw new E3dcError('login_lost');
      }
      const login = loginResult(answer);
      if (login !== 'ok') {
        throw new E3dcError(login);
      }
      if (!alive()) throw new E3dcError('aborted');
      const live = decodeItems(await session.request(liveData()));
      if (!alive()) throw new E3dcError('aborted');
      let day;
      let dayFailed;
      try {
        const items = decodeItems(await session.request(dayData(window)));
        day = find(items, TAG.DB_HISTORY_DATA_DAY);
        if (!day) dayFailed = 'protocol';
        else if (errorOf(day) !== undefined) {
          dayFailed = 'refused_by_system';
          day = undefined;
        }
      } catch (err) {
        // The energies are secondary: the live values are kept.
        dayFailed = err instanceof E3dcError ? err.code : 'protocol';
      }
      return { live, day, dayFailed };
    } catch (err) {
      if (err instanceof E3dcError) throw err;
      throw new E3dcError('protocol');
    } finally {
      this.timers.clearTimeout(deadline);
      session.close();
    }
  }
}
