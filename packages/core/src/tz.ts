// Conversões de fuso sem dependências: janelas de envio são definidas no horário local do workspace.

const MINUTE = 60_000;
const DAY = 86_400_000;

function partsOf(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Diferença (ms) entre o horário local e UTC naquele instante. */
export function tzOffsetMs(date: Date, timeZone: string) {
  const p = partsOf(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / MINUTE) * MINUTE;
}

/** Data local YYYY-MM-DD. */
export function localDate(date: Date, timeZone: string) {
  const p = partsOf(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutos desde a meia-noite local. */
export function localMinutes(date: Date, timeZone: string) {
  const p = partsOf(date, timeZone);
  return p.hour * 60 + p.minute;
}

/** Instante UTC correspondente à meia-noite local do dia de `date`. */
export function localMidnight(date: Date, timeZone: string) {
  const p = partsOf(date, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day);
  return new Date(guess - tzOffsetMs(new Date(guess), timeZone));
}

export type Window = { start: number; end: number };

export function parseWindows(windows: string[]): Window[] {
  return windows
    .map((w) => {
      const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(w);
      if (!m) return null;
      return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
    })
    .filter((w): w is Window => w !== null && w.start !== w.end);
}

const inside = (m: number, w: Window) =>
  w.start < w.end ? m >= w.start && m < w.end : m >= w.start || m < w.end;

export function isWithinWindows(at: Date, windows: string[], timeZone: string) {
  const ws = parseWindows(windows);
  if (ws.length === 0) return true;
  const m = localMinutes(at, timeZone);
  return ws.some((w) => inside(m, w));
}

/** O próprio instante, se estiver dentro de uma janela; senão o início da próxima janela. */
export function nextAllowedTime(at: Date, windows: string[], timeZone: string): Date {
  const ws = parseWindows(windows);
  if (ws.length === 0 || isWithinWindows(at, windows, timeZone)) return at;
  const midnight = localMidnight(at, timeZone);
  let best: Date | null = null;
  for (const dayOffset of [0, 1, 2]) {
    for (const w of ws) {
      const candidate = new Date(midnight.getTime() + dayOffset * DAY + w.start * MINUTE);
      if (candidate > at && (!best || candidate < best)) best = candidate;
    }
    if (best) break;
  }
  return best ?? at;
}
