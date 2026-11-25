/**
 * The weather outside a room and the height of the sun: worked out from the room's own seed and the clock, never stored and never asked of a server, the same
 * for every look at the same moment. A day may or may not have rain in it; nobody is ever owed any.
 */
export interface Weather {
  /** How hard it rains, 0..1. */
  rain: number;
  /** How much air moves outside, 0..1. */
  wind: number;
  /** 0 night .. 1 the middle of the day. */
  sun: number;
  /** Across the sky: 0 at dawn, 1 at dusk; outside that the sun is down. */
  arc: number;
}
const DAY = 86_400_000, HOUR = 3_600_000;
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const unit = (s: string) => hash(s) / 4294967296;
const ramp = (x: number, a: number, b: number) => Math.max(0, Math.min(1, (x - a) / (b - a)));

/** Local midnight of the day this instant is in, and the hour within it. */
export function localDay(ms: number) {
  const d = new Date(ms);
  return { key: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, hour: d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600, weekday: d.getDay() };
}
/** The showers of one day: at most two, each with its own hour and length. */
export function showers(seed: string, dayKey: string): { from: number; to: number; hard: number }[] {
  const out: { from: number; to: number; hard: number }[] = [];
  if (unit(`${seed}|${dayKey}|any`) < .38) {
    const from = 6 + unit(`${seed}|${dayKey}|a`) * 14, long = .7 + unit(`${seed}|${dayKey}|b`) * 2.4;
    out.push({ from, to: from + long, hard: .45 + unit(`${seed}|${dayKey}|c`) * .55 });
    if (unit(`${seed}|${dayKey}|two`) < .25) { const from2 = (from + 5 + unit(`${seed}|${dayKey}|d`) * 7) % 24; out.push({ from: from2, to: from2 + .6 + unit(`${seed}|${dayKey}|e`) * 1.2, hard: .3 + unit(`${seed}|${dayKey}|f`) * .5 }); }
  }
  return out;
}
export function weatherAt(seed: string, ms: number): Weather {
  const { key, hour } = localDay(ms);
  let rain = 0;
  for (const s of showers(seed, key)) rain = Math.max(rain, s.hard * Math.min(ramp(hour, s.from, s.from + .25), 1 - ramp(hour, s.to - .25, s.to)));
  const gust = unit(`${seed}|${key}|wind`);
  const wind = Math.min(1, .12 + gust * .3 + rain * .55 + Math.sin(ms / (HOUR * .37) + gust * 6) * .05);
  const arc = (hour - 6) / 12.4;
  const sun = arc > 0 && arc < 1 ? Math.pow(Math.sin(arc * Math.PI), .6) : 0;
  return { rain, wind: Math.max(0, wind), sun, arc };
}
/** Hours of rain expected from now on today: for a story that should only begin when there is time for it. */
export function nextDay(ms: number) { return ms + DAY; }
/** What a room's window shows decides whether weather reaches it at all: the sea floor and open space have no rain. */
export function hasWeather(view: string) { return view === 'live' || view === 'rain' || view === 'day' || view === 'sunset' || view === 'night' || view === 'magic'; }
/** A view that always rains (the rainy city): the sky's own rain, whatever the day says. */
export function viewRain(view: string, w: Weather) { return view === 'rain' ? Math.max(.55, w.rain) : hasWeather(view) ? w.rain : 0; }
