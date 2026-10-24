// -----------------------------------------------------------------------------
// The window of "today" asked to the database of the system: from the local
// midnight of `timeZone` to the next one (23 or 25 h on the days the clocks
// change). Pure. pye3dc asks the local midnight of the computer it runs on
// and 24 h; a container runs in UTC, so the time zone comes from the form.
// -----------------------------------------------------------------------------

const formats = new Map();
function partsFormat(timeZone) {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formats.set(timeZone, format);
  }
  return format;
}

/** The offset of `timeZone` at `at` (ms, local - UTC). */
function offsetAt(at, timeZone) {
  const p = Object.fromEntries(
    partsFormat(timeZone)
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const local = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return local - Math.floor(at / 1000) * 1000;
}

/** The instant (ms) of the local midnight starting the local date y-m-d. */
function midnight(y, m, d, timeZone) {
  const guess = Date.UTC(y, m - 1, d);
  let at = guess - offsetAt(guess, timeZone);
  // Once more: the offset may differ at the midnight itself.
  at = guess - offsetAt(at, timeZone);
  return at;
}

/**
 * `{ start, span, date }`: `start` the local midnight of the day of `now`
 * (s, UTC), `span` the length of that day (s), `date` YYYY-MM-DD.
 */
export function dayWindow(now, timeZone) {
  const p = Object.fromEntries(
    partsFormat(timeZone)
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const [y, m, d] = [Number(p.year), Number(p.month), Number(p.day)];
  const start = midnight(y, m, d, timeZone);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const end = midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
  return {
    start: Math.round(start / 1000),
    span: Math.round((end - start) / 1000),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}
