# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the projects below, distributed under their own
licenses.

## pye3dc (fsantini/python-e3dc)

<https://github.com/fsantini/python-e3dc>, the Python library of E3/DC
systems (published on PyPI as `pye3dc`, used by the Home Assistant
integration hacs-e3dc). Version 0.10.0, branch `master` at commit 4253027
(2026-06-10). MIT License.

Ported to JavaScript in `src/e3dc/rscp.js`, `src/e3dc/rijndael.js`,
`src/e3dc/client.js` and `src/e3dc/model.js`: the RSCP frames (magic, control
word, time, length, CRC-32) and values (tag, type, length; the types and the
tags used, from `_rscpLib.py` and `_rscpTags.py`), the RSCP password as the
key of Rijndael-256 in CBC (padded with 0xFF, IV of 0xFF, zero padding, the
IV chained from one message to the next: its cipher class), the
log-in with the user name and password of the E3/DC account and its answers
(`_e3dc_rscp_local.py`), the live values of `poll()` and `get_system_info()`,
the energies of a day of `get_db_data()` (`_e3dc.py`). The test vectors of
`test/fixtures/vectors.json` were made with the library itself
(`test/fixtures/make-vectors.py`). Changed here: read-only (no request that
sets anything is ported), the connection to the E3/DC portal is not ported,
the development dependencies of the package (`docker`, `jsbeautifier`...)
are not used, one connection per read and one at a time, the frames are
bounded and checked (length, CRC) before being used, the time zone of the day
comes from the configuration, no secret is ever logged.

Its license notice, reproduced as it appears in its `LICENSE` file:

```
MIT License

Copyright (c) 2017 Francesco Santini <francesco.santini@gmail.com»

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## py3rijndael (meyt/py3rijndael)

<https://github.com/meyt/py3rijndael>, the Rijndael library pye3dc uses.
Nothing of its code is copied: `src/e3dc/rijndael.js` is written from the
Rijndael specification (Daemen and Rijmen, "AES Proposal: Rijndael", the
256-bit block); version 0.3.3 only made the test vectors of
`test/fixtures/vectors.json`.

## gladys-p1-monitor, gladys-imeon (same author as this integration)

`src/guard.js` (the guard of an energy index) is taken as it is from
gladys-p1-monitor (through gladys-sonnen, `maxKw` as a parameter), and
`src/daily.js` (the index built from a counter of the day) as it is from
gladys-imeon, both Apache-2.0.
