// -----------------------------------------------------------------------------
// Rijndael-256 and the CBC streams of RSCP, against vectors made with the
// reference code (test/fixtures/vectors.json): py3rijndael 0.3.3 (the
// dependency of pye3dc) for the blocks, the cipher class of pye3dc for the
// streams, run with `python3 -I` on pye3dc at commit 4253027 (2026-06-10).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Rijndael256, RscpCipher, rscpKey } from '../src/e3dc/rijndael.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/vectors.json', import.meta.url), 'utf8'));
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Buffer.from(h, 'hex');

test('Rijndael-256 blocks: the same as py3rijndael, both ways', () => {
  assert.ok(V.blocks.length >= 4);
  for (const { key, plain, cipher } of V.blocks) {
    const r = new Rijndael256(bytes(key));
    assert.equal(hex(r.encipherBlock(bytes(plain))), cipher);
    assert.equal(hex(r.decipherBlock(bytes(cipher))), plain);
  }
});

test('in place: the output may be the input', () => {
  const { key, plain, cipher } = V.blocks[3];
  const r = new Rijndael256(bytes(key));
  const block = bytes(plain);
  r.encipherBlock(block, block);
  assert.equal(hex(block), cipher);
  r.decipherBlock(block, block);
  assert.equal(hex(block), plain);
});

test('the key: 32 bytes only for the block cipher; the RSCP password padded with 0xFF', () => {
  assert.throws(() => new Rijndael256(Buffer.alloc(16)), TypeError);
  assert.equal(hex(rscpKey('abc123')), `616263313233${'ff'.repeat(26)}`);
  assert.equal(rscpKey('K'.repeat(32)).length, 32);
  assert.throws(() => rscpKey(''), RangeError);
  assert.throws(() => rscpKey('K'.repeat(33)), RangeError);
  assert.throws(() => rscpKey('é'.repeat(17)), RangeError, '34 bytes in UTF-8');
});

test('the stream we send: zero padding, the IV chained from one message to the next', () => {
  const s = new RscpCipher(V.cbc.key);
  assert.equal(hex(s.encipher(bytes(V.cbc.plain1))), V.cbc.cipher1);
  assert.equal(hex(s.encipher(bytes(V.cbc.plain2))), V.cbc.cipher2);
  const k = new RscpCipher(V.cbc32.key);
  assert.equal(hex(k.encipher(bytes(V.cbc32.plain))), V.cbc32.cipher);
});

test('the stream we receive: any cut of the bytes gives the same plain bytes', () => {
  const all = Buffer.concat([bytes(V.cbc.cipher1), bytes(V.cbc.cipher2)]);
  const expected = Buffer.concat([
    bytes(V.cbc.plain1),
    Buffer.alloc(bytes(V.cbc.cipher1).length - bytes(V.cbc.plain1).length),
    bytes(V.cbc.plain2),
  ]);
  for (const step of [1, 7, 31, 32, 33, 64, all.length]) {
    const d = new RscpCipher(V.cbc.key);
    const parts = [];
    for (let i = 0; i < all.length; i += step) parts.push(d.decipher(all.subarray(i, i + step)));
    const plain = Buffer.concat(parts);
    assert.equal(plain.length, all.length, `step ${step}`);
    assert.equal(hex(plain.subarray(0, expected.length)), hex(expected), `step ${step}`);
    assert.equal(d.partialLength, 0);
  }
});

test('an incomplete block is kept, never deciphered early (at most 31 bytes)', () => {
  const d = new RscpCipher(V.cbc.key);
  const c = bytes(V.cbc.cipher1);
  assert.equal(d.decipher(c.subarray(0, 31)).length, 0);
  assert.equal(d.partialLength, 31);
  assert.equal(d.decipher(c.subarray(31, 32)).length, 32);
  assert.equal(d.partialLength, 0);
});

test('another key gives other bytes (the frames are not readable without it)', () => {
  const d = new RscpCipher('another');
  const plain = d.decipher(bytes(V.cbc.cipher1));
  assert.notEqual(hex(plain.subarray(0, 2)), 'e3dc');
});
