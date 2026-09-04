import { CALENDAR_SCHEMA_VERSION } from './types.js';
import { RunnerFailure } from './failure.js';

const EXACT_KEYS = [
  'calendar_schema_version', 'exchange', 'session_date', 'state', 'scheduled_open',
  'scheduled_close', 'session_exception_codes', 'official_source_url', 'retrieved_at', 'valid_through'
] as const;
const EXCEPTION_CODES = new Set(['delayed_open', 'delayed_close', 'suspended', 'resumed']);

export type CalendarEntry = {
  calendar_schema_version: typeof CALENDAR_SCHEMA_VERSION;
  exchange: 'TWSE' | 'TPEX';
  session_date: string;
  state: 'trading' | 'closed' | 'unknown';
  scheduled_open: string | null;
  scheduled_close: string | null;
  session_exception_codes: string[];
  official_source_url: string;
  retrieved_at: string;
  valid_through: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === EXACT_KEYS.length && EXACT_KEYS.every((key, index) => keys[index] === key);
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validUtcMilliseconds(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validSource(value: unknown, exchange: 'TWSE' | 'TPEX'): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const allowedHost = exchange === 'TWSE' ? /(^|\.)twse\.com\.tw$/ : /(^|\.)tpex\.org\.tw$/;
    return url.protocol === 'https:' && allowedHost.test(url.hostname);
  } catch {
    return false;
  }
}

export function parseCalendarSnapshot(value: unknown): CalendarEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 732) throw new RunnerFailure('calendar_unknown');
  const entries: CalendarEntry[] = [];
  const unique = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !exactKeys(item)) throw new RunnerFailure('calendar_unknown');
    const exchange = item.exchange;
    if (exchange !== 'TWSE' && exchange !== 'TPEX') throw new RunnerFailure('calendar_unknown');
    if (item.calendar_schema_version !== CALENDAR_SCHEMA_VERSION || !validDate(item.session_date)) throw new RunnerFailure('calendar_unknown');
    if (item.state !== 'trading' && item.state !== 'closed' && item.state !== 'unknown') throw new RunnerFailure('calendar_unknown');
    if (item.scheduled_open !== null && !validUtcMilliseconds(item.scheduled_open)) throw new RunnerFailure('calendar_unknown');
    if (item.scheduled_close !== null && !validUtcMilliseconds(item.scheduled_close)) throw new RunnerFailure('calendar_unknown');
    if (!Array.isArray(item.session_exception_codes)
      || item.session_exception_codes.some((code) => typeof code !== 'string' || !EXCEPTION_CODES.has(code))) {
      throw new RunnerFailure('calendar_unknown');
    }
    if (!validSource(item.official_source_url, exchange)
      || !validUtcMilliseconds(item.retrieved_at)
      || !validUtcMilliseconds(item.valid_through)
      || Date.parse(item.retrieved_at) > Date.parse(item.valid_through)) {
      throw new RunnerFailure('calendar_unknown');
    }
    const key = `${exchange}|${item.session_date}`;
    if (unique.has(key)) throw new RunnerFailure('calendar_unknown');
    unique.add(key);
    entries.push({
      calendar_schema_version: CALENDAR_SCHEMA_VERSION,
      exchange,
      session_date: item.session_date,
      state: item.state,
      scheduled_open: item.scheduled_open as string | null,
      scheduled_close: item.scheduled_close as string | null,
      session_exception_codes: [...item.session_exception_codes] as string[],
      official_source_url: item.official_source_url,
      retrieved_at: item.retrieved_at,
      valid_through: item.valid_through
    });
  }
  return entries;
}

function publishedAt(sessionDate: string): number {
  return Date.parse(`${sessionDate}T16:30:00.000+08:00`);
}

export function selectSession(entries: readonly CalendarEntry[], now: Date, requested?: string): string {
  if (Number.isNaN(now.valueOf())) throw new RunnerFailure('calendar_unknown');
  const nowMs = now.valueOf();
  const requestedDate = requested?.trim() || null;
  if (requestedDate !== null && !validDate(requestedDate)) throw new RunnerFailure('calendar_unknown');

  const byDate = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    if (Date.parse(entry.valid_through) < nowMs) continue;
    const items = byDate.get(entry.session_date) ?? [];
    items.push(entry);
    byDate.set(entry.session_date, items);
  }

  const candidates = [...byDate.entries()]
    .filter(([sessionDate, sessions]) => {
      if (requestedDate !== null && requestedDate !== sessionDate) return false;
      if (nowMs < publishedAt(sessionDate)) return false;
      if (sessions.length !== 2 || new Set(sessions.map((item) => item.exchange)).size !== 2) return false;
      if (new Set(sessions.map((item) => `${item.scheduled_open}|${item.scheduled_close}`)).size !== 1) return false;
      return sessions.every((item) => item.state === 'trading'
        && item.session_exception_codes.length === 0
        && item.scheduled_open === `${sessionDate}T01:00:00.000Z`
        && item.scheduled_close === `${sessionDate}T05:30:00.000Z`
        && Date.parse(item.retrieved_at) >= publishedAt(sessionDate)
        && Date.parse(item.retrieved_at) <= nowMs);
    })
    .map(([sessionDate]) => sessionDate)
    .sort();

  const selected = candidates.at(-1);
  if (!selected) throw new RunnerFailure('calendar_unknown');
  return selected;
}
