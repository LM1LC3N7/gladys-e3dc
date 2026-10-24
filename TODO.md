# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real E3/DC system (ideally an S10 E
      and an S10 Mini or a Quattroporte): log-in, test button, device
      creation, the solar index in the energy monitoring across a midnight.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).

## To confirm on a real system (built without one)

- [ ] The sign of `EMS_POWER_BAT` (pye3dc: > 0 charging) and of
      `EMS_POWER_GRID` (pye3dc: > 0 taken from the grid). Until then both
      are plain signed sensors; once confirmed, they could also be published
      as charge / discharge and `grid-sensor` / `power`, on new feature keys.
- [ ] The unit of the energies of the database (Wh is assumed: pye3dc calls
      them "power", Home Assistant's E3/DC integration divides them by 1000),
      and which of `DB_GRID_POWER_IN` / `DB_GRID_POWER_OUT` is the export.
- [ ] Whether the energies of the day follow the day in real time or by
      steps (15 min?): the daily index takes a step after equal reads (cover
      up to 20 min at 1.5 × the solar power read meanwhile).
- [ ] What a wrong RSCP password really does (pye3dc: the system closes the
      connection) and what a wrong account answers (access denied, or a user
      level 0).
- [ ] That one connection per read (log-in each time) every 30 s is fine for
      the system (pye3dc keeps one open in Home Assistant).
- [ ] The answer of the database right after midnight (an empty day may give
      an error: then the energies are only left out).
- [ ] `DB_REQ_ENERGY_COUNTERS` (0x06000105): maybe lifetime counters, which
      would give an index without a counter of the day. Unknown format, not
      used.

## Decisions

- **Versions**: 0.1.0 set once by hand when leaving the template (package,
  lock file, manifest, image tag `ghcr.io/lm1lc3n7/gladys-e3dc:0.1.0`), as
  for the sibling integrations; the Release workflow owns them from now on
  (the first patch release gives 0.1.1).
- **Reused project**: pye3dc (fsantini/python-e3dc, MIT, 0.10.0, `master` at
  commit 4253027 of 2026-06-10, LICENSE checked: MIT, "Copyright (c) 2017
  Francesco Santini"), cloned read-only in `~/code/ref/lot15/pye3dc`, ported
  to JavaScript: frames, values, tags, the cipher of RSCP, the log-in, the
  live values, the energies of a day. Not ported: the connection to the E3/DC
  portal (web), every request that sets something, its development
  dependencies (`docker`, `jsbeautifier`, `black`...). The SDK stays the only
  runtime dependency. Structure and app from gladys-sonnen (a home battery,
  read-only), the daily index from gladys-imeon. The template's demo files
  were removed (`git rm`).
- **Rijndael-256 in plain JavaScript** (`src/e3dc/rijndael.js`): `node:crypto`
  only has AES (128-bit block). Written from the specification (Nb = Nk = 8,
  Nr = 14, row shifts 1, 3, 4), byte by byte with lookup tables (not
  constant-time: acceptable for a client on the home network). Tested against vectors made with
  py3rijndael 0.3.3 and pye3dc themselves (`test/fixtures/vectors.json`,
  `make-vectors.py`, run with `python3 -I` in a venv): four raw blocks, the
  two CBC streams of a session, a 32-byte key, any cut of the received bytes.
- **Frames as the reference writes them**: the time of a frame we send is
  written as pye3dc writes it (seconds rounded up, milliseconds in the
  nanoseconds field), byte for byte the frames the systems in the field
  already take (tested). Only the standard format, version 1 WITH a CRC
  (control word 0x0011, review r1) is read: no frame without a CRC (the
  cipher gives no integrity), no compact format (protocol 2).
- **Bounds**: one answer is at most one frame of the standard format (64 KiB
  of data), kept deciphered in ONE buffer; only zero padding may follow it;
  bytes with no request waiting end the session; 2,000 values and 8 levels of
  containers at most; a value of a fixed type with another size is left out.
  Connection 5 s, each answer 8 s, the whole session 25 s.
- **One connection at a time**: the client refuses a second session while one
  runs (`busy`, never opened), and the app never starts a read while one
  runs, whatever its generation. Each read opens, logs in, asks, closes.
- **Read-only**: `src/e3dc/rscp.js` knows no tag that sets anything and can
  only encode the types of our requests (tested); no `onSetValue`.
- **Identity**: the external id is `system:<serial>` (INFO_SERIAL_NUMBER,
  trimmed, upper-cased, letters, digits and dashes, 3 to 40 characters),
  fixed forever. The serial is asked in every session: the values only go to
  the device of the serial read in the same session; no readable serial,
  nothing published (status note); another serial at the address gets its
  own device in Discovery (the old one keeps its history, no value).
- **Energy**: the system gives its solar energy as a counter of the day only
  (the database, the window asked from the local midnight of the time zone
  of the form, Europe/Berlin by default, 23 or 25 h on the days the clocks
  change). The index is built by `src/daily.js` (gladys-imeon, as it is:
  every doubt counts less) and checked by `src/guard.js` (gladys-p1-monitor,
  as it is, `maxKw` as a parameter): 30 kW and 0.5 kWh. A counter by steps
  (the database may count by intervals): after equal reads, a rise may cover
  the time since the counter last changed (20 min at most) at 1.5 × the
  highest solar power read meanwhile (2 kW at least, 30 kW at most), as the
  step cover of gladys-imeon 0.1.2 (the guard needs nothing: an equal value
  never moves its date). `src/dayBefore.js` of gladys-imeon is not taken:
  the window of the day is ours, the counter of the day before cannot come
  back after our midnight. A jump of the counter of the day gives no index
  (status note), never confirmed by time. The other energies of the day
  (battery, grid, house) are plain sensors, kWh of the day in the name: never
  an index, never `energy-sensor`, never `daily-consumption`, never
  `publishEnergyConsumption` (the main meter counts the house; the export is
  never a consumption).
- **A drop is never accepted** (review r1, as gladys-imeon 0.1.2 and
  gladys-zeversolar): the built index only drops when the daily index takes
  back values already published (a new day undone) or when /data is older
  than Gladys; never a new meter. Held, it corrects itself (only the energy
  above the last accepted value is counted); the button only accepts jumps.
  The index is only sent once /data holds it (a failed write sends the other
  values only). `indexes` in /data: no prototype, only ids of an index
  feature.
- **Signed powers**: battery, grid and additional source are each one plain
  signed sensor, as read (their sign is not confirmed on a real system:
  lesson of Zinvolt), never split nor `grid-sensor`.
- **Solar production option** (`pv_index`): "Energy monitoring" (default) or
  "Sensor only" (another integration already counts the production); a
  created device never loses a feature; back from "Sensor only", the first
  value is held (two clicks), as in gladys-sonnen.
- **Pace (lots 11 and 12)**: 30 s by default (30-300 s); the timer looks
  every 5 s whether a read is due; nothing reads sooner than the last session
  - the interval (monotonic clock): not the test button, not Discovery, not
    a (re)connection, not a save of an unchanged form, not a restart (the last
    session is written to `/data` BEFORE it starts, at most once a minute, so
    after a restart the first read waits that instant + one minute + the
    interval). A new address or new log-in fields are read at once. A read of
    an old generation publishes nothing and sets no status.
- **Log-in refused (lots 12 and 13)**: access denied or a user level 0: a
  final stop `{ code, fp }` in `/data`, never tried again by itself; no
  readable answer to the log-in (closed, nothing, or bytes that are no frame
  with our key, the RSCP password most likely) is tried once more, at least
  15 min later (review r1: a system restarting may close the port for a
  while), and the second in a row is the same final stop (lot 14, lesson
  13). The test button
  tries once per click when the interval passed; new fields saved are tried
  at once; the stop is erased only by a successful log-in.
- **Fingerprint (lot 14, lesson 7)**: the RSCP password may be short, so the
  fingerprint of a refused log-in is truncated to 8 bits (salted scrypt of
  the address and the three fields): 1 chance in 256 to take a new form for
  the refused one (the test button then tries it), and a brute force finds
  hundreds of candidates (tested). Erased by the first successful log-in.
  In memory only, a SHA-256 of the fields tells a new form at once.
- **Secrets**: the user name (an e-mail address), the password and the RSCP
  password never go to the logs, `/data`, a status, an error, Discovery or a
  test answer (tested end to end, and on the wire: no secret in clear). The
  plain log-in frame is wiped once enciphered. Control characters refused in
  the three fields.
- **Unreachable / odd answers**: the interval (1 min at least), doubled up
  to 15 min (or the interval, if longer). The energies of the day failing only leave them out (status
  note).
- **States per minute**: a sliding budget of 270 states over 60 s.
- **No custom identity**: no User-Agent (not HTTP), no imitation of the E3/DC
  app; the log-in is the one RSCP defines. No Bluetooth, no network discovery.
- **Gladys version**: `>=5.2.0`, like the other energy integrations.

## Ideas

- Several systems (one address each) if users ask.
- The wallboxes one by one (`WB_REQ_DATA`), the battery modules (`BAT_REQ_*`),
  the PV strings (`PVI_REQ_*`), the emergency power state, read-only.
- Keep the RSCP session open between reads (as pye3dc in Home Assistant), if
  a real system dislikes a log-in every 30 s.
