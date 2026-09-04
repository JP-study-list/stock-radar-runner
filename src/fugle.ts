import { RunnerFailure } from './failure.js';
import type { BoundedJsonResult } from './http.js';
import type { CapabilityEvidence, Evidence, ProbeDefinition } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new RunnerFailure('missing_required_field');
  return value;
}

function decimal(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new RunnerFailure('schema_error');
}

function integer(value: unknown): number {
  const parsed = decimal(value);
  if (!Number.isInteger(parsed)) throw new RunnerFailure('schema_error');
  return parsed;
}

function taipeiDate(timestamp: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(timestamp);
}

function timestampFor(value: string, timeframe: 'D' | '5', sessionDate: string): string {
  if (timeframe === 'D') {
    if (value !== sessionDate) throw new RunnerFailure('schema_error');
    return new Date(`${value}T09:00:00.000+08:00`).toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || taipeiDate(parsed) !== sessionDate) throw new RunnerFailure('schema_error');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(parsed);
  const time = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(time.hour);
  const minute = Number(time.minute);
  if (time.second !== '00' || parsed.getUTCMilliseconds() !== 0 || minute % 5 !== 0
    || hour < 9 || hour > 13 || (hour === 13 && minute > 30)) throw new RunnerFailure('schema_error');
  return parsed.toISOString();
}

function continuity(timestamps: readonly string[], timeframe: 'D' | '5'): Evidence['continuity'] {
  if (timeframe === 'D') return 'not_applicable';
  const ordered = [...new Set(timestamps)].sort();
  if (ordered.length !== timestamps.length) throw new RunnerFailure('schema_error');
  if (ordered.length < 2) return 'unknown';
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = Date.parse(ordered[index - 1]!);
    const current = Date.parse(ordered[index]!);
    const closingAuctionBoundary = taipeiTime(ordered[index - 1]!) === '13:20'
      && taipeiTime(ordered[index]!) === '13:30';
    if (current - previous > 5 * 60_000 && !closingAuctionBoundary) return 'gap_suspected';
  }
  return 'continuous';
}

function taipeiTime(timestamp: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit'
  }).format(new Date(timestamp));
}

export function parseFugleEvidence(
  result: BoundedJsonResult,
  probe: ProbeDefinition,
  sessionDate: string
): CapabilityEvidence {
  if (!isRecord(result.body)) throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  const root = result.body;
  if (requiredString(root, 'symbol') !== probe.providerSymbol
    || requiredString(root, 'timeframe') !== probe.timeframe
    || requiredString(root, 'exchange') !== probe.exchange
    || requiredString(root, 'market') !== probe.market
    || !probe.instrumentTypes.includes(requiredString(root, 'type'))) {
    throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  }
  if (requiredString(root, 'sort') !== 'asc') throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  if (!Array.isArray(root.data)) throw new RunnerFailure('missing_required_field', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  if (root.data.length > 100) throw new RunnerFailure('record_limit_exceeded', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  if (root.data.length === 0) throw new RunnerFailure('missing_required_field', { httpAttempts: result.attempts, responseBytes: result.responseBytes });

  const adjusted = root.adjusted;
  if (adjusted !== undefined && typeof adjusted !== 'boolean') {
    throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  }
  if (probe.adjustment === 'adjusted' ? adjusted !== true : adjusted === true) {
    throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  }

  const timestamps: string[] = [];
  for (const item of root.data) {
    if (!isRecord(item)) throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
    const timestamp = timestampFor(requiredString(item, 'date'), probe.timeframe, sessionDate);
    const open = decimal(item.open);
    const high = decimal(item.high);
    const low = decimal(item.low);
    const close = decimal(item.close);
    integer(item.volume);
    if (low > high || open < low || open > high || close < low || close > high) {
      throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
    }
    timestamps.push(timestamp);
  }

  const ordered = [...timestamps].sort();
  const continuityValue = continuity(ordered, probe.timeframe);
  const degraded = continuityValue === 'gap_suspected' || continuityValue === 'unknown';
  const evidence: Evidence = {
    session_date: sessionDate,
    schema_valid: true,
    timestamp_valid: true,
    freshness: 'fresh',
    continuity: continuityValue,
    source_volume_unit: probe.timeframe === 'D' ? 'share' : 'lot',
    source_volume_multiplier: probe.timeframe === 'D' ? '1' : '1000',
    adjustment: probe.adjustment,
    entitlement_observed: true,
    rate_limit_header_observed: result.rateLimitHeaderObserved,
    record_count: root.data.length,
    response_bytes: result.responseBytes,
    http_attempts: result.attempts,
    first_timestamp: ordered[0] ?? null,
    last_timestamp: ordered.at(-1) ?? null
  };
  return {
    capability: probe.capability,
    symbol: probe.symbol,
    status: degraded ? 'degraded' : 'pass',
    evidence,
    failure_class: degraded ? 'data_gap' : null
  };
}
