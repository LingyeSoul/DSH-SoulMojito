/**
 * Time / date / duration formatting helpers.
 *
 * ST formats these with moment.js locale `en` (macros.js postEnvMacros):
 *   {{time}}  -> moment().format('LT')    -> "3:05 PM"   (h:mm A, no leading zero)
 *   {{date}}  -> moment().format('LL')    -> "August 14, 2026"
 *   {{weekday}} -> moment().format('dddd') -> "Friday"
 *   {{isotime}} -> moment().format('HH:mm')
 *   {{isodate}} -> moment().format('YYYY-MM-DD')
 *   {{idle_duration}} -> moment.duration(...).humanize()  -> "5 minutes" / "an hour" / ...
 *
 * Reimplemented without moment; fixed `en` locale for determinism.
 */

const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const WEEKDAYS_FULL = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** moment 'LT' (en): "1:05 PM" / "12:00 AM" — hour without leading zero. */
export function formatTime12(hours24: number, minutes: number): string {
  const h12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${h12}:${pad2(minutes)} ${hours24 < 12 ? 'AM' : 'PM'}`;
}

/** {{time}} — local clock. */
export function formatLocalTime(d: Date): string {
  return formatTime12(d.getHours(), d.getMinutes());
}

/**
 * {{time::UTC+N}} / {{time_UTC+N}} — moment().utc().utcOffset(N).format('LT'):
 * shift the instant by the offset, then read in UTC.
 */
export function formatTimeAtUtcOffset(d: Date, offsetHours: number): string {
  const shifted = new Date(d.getTime() + offsetHours * 3_600_000);
  return formatTime12(shifted.getUTCHours(), shifted.getUTCMinutes());
}

/** {{date}} — moment 'LL' (en): "August 14, 2026". */
export function formatLocalDateLong(d: Date): string {
  return `${MONTHS_FULL[d.getMonth()] ?? ''} ${d.getDate()}, ${d.getFullYear()}`;
}

/** {{weekday}} — moment 'dddd'. */
export function formatWeekday(d: Date): string {
  return WEEKDAYS_FULL[d.getDay()] ?? '';
}

/** {{isotime}} — moment 'HH:mm'. */
export function formatLocalIsoTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** {{isodate}} — moment 'YYYY-MM-DD'. */
export function formatLocalIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * {{datetimeformat::fmt}} — small token subset:
 *   yyyy|YYYY (4-digit year), MM (month), dd|DD (day),
 *   HH (24h hour), mm (minute), ss (second).
 * ST's regex is `{{datetimeformat <moment format>}}` (space separator, moment tokens);
 * we additionally accept the `::`/`:` separators and lowercase yyyy/dd spellings,
 * and pass any other character through literally.
 */
export function formatWithTokens(d: Date, fmt: string): string {
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const four = fmt.slice(i, i + 4);
    if (four === 'yyyy' || four === 'YYYY') {
      out += String(d.getFullYear()).padStart(4, '0');
      i += 4;
      continue;
    }
    const two = fmt.slice(i, i + 2);
    if (two === 'MM') { out += pad2(d.getMonth() + 1); i += 2; continue; }
    if (two === 'dd' || two === 'DD') { out += pad2(d.getDate()); i += 2; continue; }
    if (two === 'HH') { out += pad2(d.getHours()); i += 2; continue; }
    if (two === 'mm') { out += pad2(d.getMinutes()); i += 2; continue; }
    if (two === 'ss') { out += pad2(d.getSeconds()); i += 2; continue; }
    out += fmt.charAt(i);
    i += 1;
  }
  return out;
}

/**
 * {{idle_duration}} — moment duration.humanize() (en, no suffix) thresholds:
 *   <45s "a few seconds"; <90s "a minute"; <45m "N minutes"; <90m "an hour";
 *   <22h "N hours"; <36h "a day"; <26d "N days"; <45d "a month";
 *   <11 months "N months"; <18 months "a year"; else "N years".
 */
export function humanizeDuration(totalSeconds: number): string {
  const s = totalSeconds < 0 ? 0 : totalSeconds;
  if (s < 45) return 'a few seconds';
  if (s < 90) return 'a minute';
  const minutes = s / 60;
  if (minutes < 45) return `${Math.round(minutes)} minutes`;
  if (minutes < 90) return 'an hour';
  const hours = minutes / 60;
  if (hours < 22) return `${Math.round(hours)} hours`;
  if (hours < 36) return 'a day';
  const days = hours / 24;
  if (days < 26) return `${Math.round(days)} days`;
  if (days < 45) return 'a month';
  const months = days / 30;
  if (months < 11) return `${Math.round(months)} months`;
  if (months < 18) return 'a year';
  return `${Math.round(months / 12)} years`;
}
