import { RunnerFailure } from './failure.js';
import { parseFugleEvidence } from './fugle.js';
import type { BoundedJsonResult } from './http.js';
import { DATA_PROBES, type FailureClass, type ProbeDefinition } from './types.js';
import {
  COMPARISON_FIELDS, TWSE_SYMBOLS, emptyTwseCapabilityEvidence,
  type ComparisonField, type NormalizedDailyValues, type TwseCapabilityEvidence, type TwseSymbol
} from './twse-types.js';

export const TWSE_HTTP_LIMITS = {
  logicalOperations: 3,
  totalAttempts: 6,
  attemptsPerOperation: 2,
  responseBytes: 4 * 1024 * 1024,
  records: 5_000,
  requestTimeoutMs: 15_000,
  jobTimeoutMs: 180_000,
  pages: 1
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new RunnerFailure('missing_required_field');
  return value.trim();
}

function canonicalDecimal(value: unknown, allowCommas: boolean): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new RunnerFailure('schema_error');
  const raw = (typeof value === 'number' ? String(value) : value.trim());
  const normalized = allowCommas ? raw.replaceAll(',', '') : raw;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) throw new RunnerFailure('schema_error');
  const [whole, fraction = ''] = normalized.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed.length === 0 ? whole! : `${whole}.${trimmed}`;
}

function canonicalInteger(value: unknown, allowCommas: boolean): string {
  const normalized = canonicalDecimal(value, allowCommas);
  if (!/^\d+$/.test(normalized)) throw new RunnerFailure('schema_error');
  return normalized;
}

function rocDate(value: string): string {
  const match = /^(\d{3})(\d{2})(\d{2})$/.exec(value);
  if (!match) throw new RunnerFailure('schema_error');
  const iso = `${Number(match[1]) + 1911}-${match[2]}-${match[3]}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== iso) throw new RunnerFailure('schema_error');
  return iso;
}

function ohlcv(record: Record<string, unknown>, allowCommas: boolean): NormalizedDailyValues {
  const values = {
    open: canonicalDecimal(record.OpeningPrice ?? record.open, allowCommas),
    high: canonicalDecimal(record.HighestPrice ?? record.high, allowCommas),
    low: canonicalDecimal(record.LowestPrice ?? record.low, allowCommas),
    close: canonicalDecimal(record.ClosingPrice ?? record.close, allowCommas),
    volume: canonicalInteger(record.TradeVolume ?? record.volume, allowCommas)
  };
  const open = Number(values.open);
  const high = Number(values.high);
  const low = Number(values.low);
  const close = Number(values.close);
  if (low > high || open < low || open > high || close < low || close > high) throw new RunnerFailure('schema_error');
  return values;
}

function failedCapability(
  symbol: TwseSymbol,
  failureClass: FailureClass,
  result: BoundedJsonResult,
  targetPresent: boolean | null
): TwseCapabilityEvidence {
  const evidence = emptyTwseCapabilityEvidence();
  evidence.target_present = targetPresent;
  evidence.record_count = Array.isArray(result.body) ? result.body.length : null;
  evidence.response_bytes = result.responseBytes;
  evidence.http_attempts = result.attempts;
  return { capability: 'official_1d_raw', symbol, status: 'fail', evidence, failure_class: failureClass };
}

export type TwseParseResult = {
  capabilities: TwseCapabilityEvidence[];
  values: Map<TwseSymbol, NormalizedDailyValues>;
};

export function parseTwseDailyEvidence(result: BoundedJsonResult, sessionDate: string): TwseParseResult {
  if (!Array.isArray(result.body)) throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  const rows = result.body;
  if (rows.length === 0) throw new RunnerFailure('missing_required_field', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  if (rows.length > TWSE_HTTP_LIMITS.records) throw new RunnerFailure('record_limit_exceeded', { httpAttempts: result.attempts, responseBytes: result.responseBytes });

  const targets = new Map<TwseSymbol, Record<string, unknown>[]>();
  TWSE_SYMBOLS.forEach((symbol) => targets.set(symbol, []));
  for (const item of rows) {
    if (!isRecord(item)) throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
    const code = requiredString(item, 'Code');
    const symbol = `TW:${code}`;
    if (symbol === 'TW:2330' || symbol === 'TW:0050') targets.get(symbol)!.push(item);
  }

  const values = new Map<TwseSymbol, NormalizedDailyValues>();
  const capabilities = TWSE_SYMBOLS.map((symbol): TwseCapabilityEvidence => {
    const rows = targets.get(symbol)!;
    if (rows.length === 0) return failedCapability(symbol, 'not_found', result, false);
    if (rows.length !== 1) return failedCapability(symbol, 'schema_error', result, true);
    try {
      const row = rows[0]!;
      const date = rocDate(requiredString(row, 'Date'));
      if (date !== sessionDate) {
        const failed = failedCapability(symbol, 'stale_data', result, true);
        failed.evidence.session_date = date;
        failed.evidence.schema_valid = true;
        failed.evidence.timestamp_valid = true;
        failed.evidence.freshness = 'stale';
        failed.evidence.source_volume_unit = 'share';
        failed.evidence.source_volume_multiplier = '1';
        failed.evidence.adjustment = 'raw';
        return failed;
      }
      const parsed = ohlcv(row, true);
      values.set(symbol, parsed);
      return {
        capability: 'official_1d_raw', symbol, status: 'pass',
        evidence: {
          session_date: sessionDate,
          schema_valid: true,
          timestamp_valid: true,
          freshness: 'fresh',
          source_volume_unit: 'share',
          source_volume_multiplier: '1',
          adjustment: 'raw',
          target_present: true,
          record_count: rows.length,
          response_bytes: result.responseBytes,
          http_attempts: result.attempts
        },
        failure_class: null
      };
    } catch (error) {
      const failureClass = error instanceof RunnerFailure ? error.failureClass : 'unknown';
      return failedCapability(symbol, failureClass, result, true);
    }
  });
  return { capabilities, values };
}

function fugleProbe(symbol: TwseSymbol): ProbeDefinition {
  const index = symbol === 'TW:2330' ? 0 : 2;
  return DATA_PROBES[index]!;
}

export function parseFugleDailyComparator(
  result: BoundedJsonResult,
  symbol: TwseSymbol,
  sessionDate: string
): NormalizedDailyValues {
  const evidence = parseFugleEvidence(result, fugleProbe(symbol), sessionDate);
  if (evidence.status !== 'pass' || !isRecord(result.body) || !Array.isArray(result.body.data) || result.body.data.length !== 1) {
    throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  }
  const row = result.body.data[0];
  if (!isRecord(row)) throw new RunnerFailure('schema_error', { httpAttempts: result.attempts, responseBytes: result.responseBytes });
  return ohlcv(row, false);
}

export function compareDailyValues(
  official: NormalizedDailyValues,
  comparator: NormalizedDailyValues
): { matchedFields: ComparisonField[]; mismatchFields: ComparisonField[] } {
  const matchedFields: ComparisonField[] = [];
  const mismatchFields: ComparisonField[] = [];
  for (const field of COMPARISON_FIELDS) {
    (official[field] === comparator[field] ? matchedFields : mismatchFields).push(field);
  }
  return { matchedFields, mismatchFields };
}
