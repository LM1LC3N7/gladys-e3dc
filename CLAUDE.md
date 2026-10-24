# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads an **E3/DC home storage system** (S10, Quattroporte) through RSCP,
its local protocol (TCP 5033): log-in with the E3/DC account, frames
enciphered with the RSCP password set on the system (Rijndael-256 CBC), the
live values (`EMS_REQ_*`, `INFO_REQ_*`) and the energies of the day
(`DB_REQ_HISTORY_DATA_DAY`). Ported from
[pye3dc](https://github.com/fsantini/python-e3dc) (MIT, see
`THIRD_PARTY_NOTICES.md`). The E3/DC portal is never contacted. Unofficial:
not affiliated with E3/DC. **Read-only**: never `onSetValue`, never a request
that sets anything. Siblings: `gladys-sonnen` (structure, app, store),
`gladys-imeon` (`src/daily.js`), `gladys-p1-monitor` (`src/guard.js`).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/client.test.js           # one file (a fake system on 127.0.0.1)
node --test --test-name-pattern "index"   # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
node scripts/cover.mjs cover.png          # the store cover (800×534)
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        E3dcApp: pace, reads, identity, index, refusal, buttons
src/e3dc/client.js                the only network access: one RSCP session at a time
src/e3dc/rscp.js                  frames (CRC-32) and values, bounded decoder, the tags used
src/e3dc/rijndael.js              Rijndael-256 and the CBC streams of RSCP (plain JS)
src/e3dc/model.js                 the answers -> values (pure)
src/daily.js                      the index built from a counter of the day (gladys-imeon, as it is)
src/guard.js                      plausibility of an energy index (gladys-p1-monitor, as it is)
src/window.js                     the window of "today" (local midnight of the time zone)
src/store.js                      what /data keeps across restarts
src/devices.js                    the device, feature keys, catalog, states (pure)
src/config.js                     the form, normalized
src/constants.js                  timings, bounds, limits, manifest keys
src/i18n.js                       runtime texts (en/fr)
gladys-assistant-integration.json manifest: name, config_schema, actions...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
test/fixtures/vectors.json        vectors made with the reference code (make-vectors.py)
scripts/cover.mjs                 the cover, plain Node
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **Read-only.** No `onSetValue`; `src/e3dc/rscp.js` lists no tag that sets
  anything and encodes only the types of our requests (`test/rscp.test.js`).
  A command, if one is ever added, is a `button` disabled by default behind
  an option, never a `switch`.
- **Secrets**: the user name, the password and the RSCP password are never
  logged, shown, written to `/data` nor put in an error; they only go into
  the enciphered log-in frame to the configured address. `/data` keeps only
  an 8-bit fingerprint of a REFUSED log-in, erased by the first success.
  Secret fields are described as "kept by Gladys in its database, never
  shown again", never with the forbidden word (`test/encoding.test.js`).
- **Refusal**: access denied, a user level 0, or no readable answer to the
  log-in twice in a row: a final stop in `/data`, never tried again by
  itself; only new fields or the test button (one try per click) try again.
- **Pace**: never a read faster than the interval, whatever asks (test
  button, Discovery, connection, save, restart: `/data` keeps the last
  session, written at most once a minute). One session at a time. A read of
  an old generation publishes nothing and sets no status.
- **Frames**: bounded (one frame, 64 KiB), checked (magic, format, length,
  CRC) before use, decoded linearly with bounded depth and count; nothing
  received is ever logged.
- **Energy monitoring**: the solar production index is the only index
  (`INDEXES` in `src/devices.js`), built by `DailyIndex` and checked by
  `IndexGuard`, both taken as they are: never 0, a jump never confirmed by
  time, only by the `accept_held_index` action clicked twice; a drop of
  the built index is never accepted (it corrects itself). Everything
  else (house, grid, battery, energies of the day) is a plain sensor: no
  `energy-sensor`, no `daily-consumption`, never `publishEnergyConsumption`.
  Battery and grid powers: one signed plain sensor each (sign unconfirmed).
- **External ids are forever**: `system:<SERIAL>`, the `FEATURE` keys of
  `src/devices.js`, the manifest keys. The device published again never loses
  a feature.
- **Units**: only those of `DEVICE_FEATURE_UNITS_BY_CATEGORY` in the core
  (`test/manifest.test.js`).
- **The container rootfs is read-only.** Write only under `/data`:
  `src/store.js` keeps `/data/e3dc-state.json`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language. Never a
  `default` on a secret field.
- **User-facing text** is bilingual (English and French), kept in sync. Files
  are UTF-8 without BOM nor control byte (`test/encoding.test.js`, sources
  included).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave the machine (the fake system listens on
  127.0.0.1).
