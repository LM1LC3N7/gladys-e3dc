# gladys-e3dc

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**E3/DC home storage systems** (S10 E, S10 X, S10 Mini, Quattroporte...). It
reads the system on your network through **RSCP**, its local protocol (no
cloud, the E3/DC portal is never contacted), every 30 seconds: state of
charge, battery, solar, house, grid and wallbox powers, autarky, the energies
of the day, and a solar production index for the Gladys energy monitoring.
**Read-only**: it never changes a setting of the system.

**Never tested with a real device.** Not affiliated with E3/DC.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Requirements: Gladys 5.2.0 or later, the system on the same network, an
  RSCP password set on its display, the user name and password of the E3/DC
  account.

## How it works

- One RSCP session per read, one at a time (TCP port 5033): the log-in, the
  live values (`EMS_REQ_*`, the serial number and software), the energies of
  the day from the database of the system (`DB_REQ_HISTORY_DATA_DAY`, from
  the local midnight). Ported to JavaScript from
  [pye3dc](https://github.com/fsantini/python-e3dc) (MIT), see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The frames are enciphered with Rijndael-256 (a 256-bit block, not AES:
  `node:crypto` does not have it), written in plain JavaScript in
  `src/e3dc/rijndael.js`, checked against vectors made with the reference
  library. No runtime dependency but the Gladys SDK.
- Frames bounded and checked (magic, format, length, CRC-32) before use, the
  values decoded in one linear pass with bounded depth and count.
- The solar production index is built from the counter of the day
  (`src/daily.js`, from gladys-imeon) and checked by the guard of
  gladys-p1-monitor (`src/guard.js`): never 0, a jump held until the "Accept
  the held index" button is clicked twice, a drop never accepted (it
  corrects itself). Battery and grid powers
  are plain signed sensors (their sign is not confirmed); the house
  consumption and the grid energies are plain sensors (the main meter
  already counts them).
- Never a read faster than the interval, across reconnections, saves and
  restarts (`/data`); a refused log-in stops the reads for good (kept in
  `/data`) until the form changes; no secret is ever logged or written.

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
npm run audit
node scripts/cover.mjs cover.png
```

The test vectors of the cipher come from the reference code:
`python3 -I test/fixtures/make-vectors.py <clone of pye3dc>` (with
py3rijndael installed in that interpreter).

See [CLAUDE.md](CLAUDE.md) for the project rules, [TODO.md](TODO.md) for the
decisions and what is left to check on a real system.

## License

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
