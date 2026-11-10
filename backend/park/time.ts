// Tijd-hulpjes: 2Park werkt met Nederlandse kloktijd "dd-MM-yyyy HH:mm:ss".
export const TZ = "Europe/Amsterdam";

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function parts(d: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of partsFmt.formatToParts(d)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Verschil (ms) tussen NL-kloktijd en UTC op dit moment. */
function offsetMs(d: Date): number {
  const p = parts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

const two = (n: number) => String(n).padStart(2, "0");

export function fmtLocal(d: Date): string {
  const p = parts(d);
  return `${two(p.day)}-${two(p.month)}-${p.year} ${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
}

export function hhmm(d: Date): string {
  const p = parts(d);
  return `${two(p.hour)}:${two(p.minute)}`;
}

export function parseLocal(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const guess = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] ?? 0));
  let t = guess - offsetMs(new Date(guess));
  t = guess - offsetMs(new Date(t)); // tweede ronde vangt zomer/wintertijd-wissel
  return new Date(t);
}
