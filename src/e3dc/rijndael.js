// -----------------------------------------------------------------------------
// Rijndael with a 256-bit block and a 256-bit key, in CBC, as RSCP uses it.
// Pure JavaScript, no dependency: `node:crypto` only has AES, whose block is
// 128 bits; Rijndael-256 is not AES and cannot be built from it.
//
// Written from the Rijndael specification (Daemen & Rijmen, "AES Proposal:
// Rijndael", the variant Nb = 8, Nk = 8, Nr = 14: row shifts 1, 3 and 4),
// checked against py3rijndael, the library pye3dc uses (test/rijndael.test.js,
// vectors made with the reference code). The RSCP use, after pye3dc
// (its cipher class, MIT, see THIRD_PARTY_NOTICES.md):
// - the key is the RSCP password set on the system, UTF-8, at most 32 bytes,
//   padded with 0xFF up to 32;
// - both directions start with an IV of 32 bytes 0xFF and go on as ONE CBC
//   stream each: the IV of the next message is the last cipher block sent
//   (or received);
// - every message we send is padded with zero bytes up to a multiple of 32.
//
// The key never leaves this object; nothing here logs anything.
// -----------------------------------------------------------------------------

export const BLOCK = 32;
const NB = 8;
const NK = 8;
const NR = 14;

// --- GF(2^8) tables, computed once -------------------------------------------------
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const xtime = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
function mul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
}
(() => {
  // The multiplicative inverse through the powers of the generator 3.
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x;
    log[x] = i;
    x = mul(x, 3);
  }
  for (let i = 0; i < 256; i += 1) {
    const inv = i === 0 ? 0 : exp[(255 - log[i]) % 255];
    let s = inv;
    let r = inv;
    for (let k = 0; k < 4; k += 1) {
      r = ((r << 1) | (r >> 7)) & 0xff;
      s ^= r;
    }
    s ^= 0x63;
    SBOX[i] = s;
    INV_SBOX[s] = i;
  }
})();
const M2 = new Uint8Array(256);
const M3 = new Uint8Array(256);
const M9 = new Uint8Array(256);
const M11 = new Uint8Array(256);
const M13 = new Uint8Array(256);
const M14 = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) {
  M2[i] = mul(i, 2);
  M3[i] = mul(i, 3);
  M9[i] = mul(i, 9);
  M11[i] = mul(i, 11);
  M13[i] = mul(i, 13);
  M14[i] = mul(i, 14);
}
/** Row shifts for a 256-bit block (Nb = 8). */
const SHIFT = [0, 1, 3, 4];

/** The round keys: (Nr + 1) × 32 bytes. */
function expandKey(key) {
  const words = NB * (NR + 1);
  const w = new Uint8Array(words * 4);
  w.set(key.subarray(0, NK * 4));
  let rcon = 1;
  const t = new Uint8Array(4);
  for (let i = NK; i < words; i += 1) {
    t.set(w.subarray((i - 1) * 4, i * 4));
    if (i % NK === 0) {
      const first = t[0];
      t[0] = SBOX[t[1]] ^ rcon;
      t[1] = SBOX[t[2]];
      t[2] = SBOX[t[3]];
      t[3] = SBOX[first];
      rcon = xtime(rcon);
    } else if (i % NK === 4) {
      for (let k = 0; k < 4; k += 1) t[k] = SBOX[t[k]];
    }
    for (let k = 0; k < 4; k += 1) w[i * 4 + k] = w[(i - NK) * 4 + k] ^ t[k];
  }
  return w;
}

/** The state is column-major (byte r of column c at 4c + r), as the input. */
function addRoundKey(s, w, round) {
  const base = round * BLOCK;
  for (let i = 0; i < BLOCK; i += 1) s[i] ^= w[base + i];
}

function shiftRows(s, tmp, inverse) {
  tmp.set(s);
  for (let r = 1; r < 4; r += 1) {
    for (let c = 0; c < NB; c += 1) {
      const from = inverse ? (c - SHIFT[r] + NB) % NB : (c + SHIFT[r]) % NB;
      s[4 * c + r] = tmp[4 * from + r];
    }
  }
}

function mixColumns(s) {
  for (let c = 0; c < NB; c += 1) {
    const i = 4 * c;
    const [a0, a1, a2, a3] = [s[i], s[i + 1], s[i + 2], s[i + 3]];
    s[i] = M2[a0] ^ M3[a1] ^ a2 ^ a3;
    s[i + 1] = a0 ^ M2[a1] ^ M3[a2] ^ a3;
    s[i + 2] = a0 ^ a1 ^ M2[a2] ^ M3[a3];
    s[i + 3] = M3[a0] ^ a1 ^ a2 ^ M2[a3];
  }
}

function invMixColumns(s) {
  for (let c = 0; c < NB; c += 1) {
    const i = 4 * c;
    const [a0, a1, a2, a3] = [s[i], s[i + 1], s[i + 2], s[i + 3]];
    s[i] = M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3];
    s[i + 1] = M9[a0] ^ M14[a1] ^ M11[a2] ^ M13[a3];
    s[i + 2] = M13[a0] ^ M9[a1] ^ M14[a2] ^ M11[a3];
    s[i + 3] = M11[a0] ^ M13[a1] ^ M9[a2] ^ M14[a3];
  }
}

/** One Rijndael-256 key: `encipherBlock` and `decipherBlock` on 32 bytes. */
export class Rijndael256 {
  /** `key`: exactly 32 bytes. */
  constructor(key) {
    if (!(key instanceof Uint8Array) || key.length !== 32) {
      throw new TypeError('Rijndael256 needs a key of 32 bytes');
    }
    this.w = expandKey(key);
    this.tmp = new Uint8Array(BLOCK);
  }

  /** Enciphers `input` (32 bytes) into `output` (32 bytes, may be the same). */
  encipherBlock(input, output = new Uint8Array(BLOCK)) {
    const s = output;
    if (s !== input) s.set(input.subarray(0, BLOCK));
    addRoundKey(s, this.w, 0);
    for (let round = 1; round < NR; round += 1) {
      for (let i = 0; i < BLOCK; i += 1) s[i] = SBOX[s[i]];
      shiftRows(s, this.tmp, false);
      mixColumns(s);
      addRoundKey(s, this.w, round);
    }
    for (let i = 0; i < BLOCK; i += 1) s[i] = SBOX[s[i]];
    shiftRows(s, this.tmp, false);
    addRoundKey(s, this.w, NR);
    return s;
  }

  /** Deciphers `input` (32 bytes) into `output` (32 bytes, may be the same). */
  decipherBlock(input, output = new Uint8Array(BLOCK)) {
    const s = output;
    if (s !== input) s.set(input.subarray(0, BLOCK));
    addRoundKey(s, this.w, NR);
    for (let round = NR - 1; round >= 1; round -= 1) {
      shiftRows(s, this.tmp, true);
      for (let i = 0; i < BLOCK; i += 1) s[i] = INV_SBOX[s[i]];
      addRoundKey(s, this.w, round);
      invMixColumns(s);
    }
    shiftRows(s, this.tmp, true);
    for (let i = 0; i < BLOCK; i += 1) s[i] = INV_SBOX[s[i]];
    addRoundKey(s, this.w, 0);
    return s;
  }
}

/** The RSCP password as a key: UTF-8, at most 32 bytes, padded with 0xFF (pye3dc). */
export function rscpKey(password) {
  const bytes = Buffer.from(String(password), 'utf8');
  if (bytes.length === 0 || bytes.length > 32) {
    throw new RangeError('the RSCP password takes 1 to 32 bytes');
  }
  const key = Buffer.alloc(32, 0xff);
  bytes.copy(key);
  bytes.fill(0);
  return key;
}

/**
 * The two CBC streams of one RSCP session. `encipher(plain)` pads with zeros
 * and chains on the last block sent; `decipher(chunk)` takes the bytes as they
 * come from the socket, keeps an incomplete block (at most 31 bytes) for the
 * next chunk and returns the plain bytes of the complete blocks.
 */
export class RscpCipher {
  constructor(password) {
    const key = rscpKey(password);
    this.cipher = new Rijndael256(key);
    key.fill(0);
    this.encIv = Buffer.alloc(BLOCK, 0xff);
    this.decIv = Buffer.alloc(BLOCK, 0xff);
    this.partial = Buffer.alloc(BLOCK);
    this.partialLength = 0;
  }

  encipher(plain) {
    const length = Math.max(BLOCK, Math.ceil(plain.length / BLOCK) * BLOCK);
    const out = Buffer.alloc(length);
    plain.copy(out);
    for (let at = 0; at < length; at += BLOCK) {
      const block = out.subarray(at, at + BLOCK);
      for (let i = 0; i < BLOCK; i += 1) block[i] ^= this.encIv[i];
      this.cipher.encipherBlock(block, block);
      this.encIv = block;
    }
    this.encIv = Buffer.from(this.encIv);
    return out;
  }

  /** The plain bytes of the complete blocks now known (maybe none). */
  decipher(chunk) {
    const total = this.partialLength + chunk.length;
    const whole = total - (total % BLOCK);
    const out = Buffer.alloc(whole);
    let produced = 0;
    let read = 0;
    const block = Buffer.alloc(BLOCK);
    const plain = Buffer.alloc(BLOCK);
    while (produced < whole) {
      // The next cipher block: the bytes kept, then the chunk.
      const fromPartial = Math.min(this.partialLength, BLOCK);
      this.partial.copy(block, 0, 0, fromPartial);
      chunk.copy(block, fromPartial, read, read + BLOCK - fromPartial);
      read += BLOCK - fromPartial;
      this.partialLength = 0;
      this.cipher.decipherBlock(block, plain);
      for (let i = 0; i < BLOCK; i += 1) out[produced + i] = plain[i] ^ this.decIv[i];
      block.copy(this.decIv);
      produced += BLOCK;
    }
    // What is left of the chunk: an incomplete block, kept for the next one.
    const rest = chunk.length - read;
    if (rest > 0) {
      chunk.copy(this.partial, this.partialLength, read);
      this.partialLength += rest;
    }
    return out;
  }
}
