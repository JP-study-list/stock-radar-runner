import { RunnerFailure } from './failure.js';
import { failureStatus, type SummaryMetrics } from './report.js';
import { FAILURE_CLASSES, type FailureClass, type OverallStatus } from './types.js';
import {
  COMPARISON_FIELDS, TWSE_REPORT_PREFIX, TWSE_REPORT_SCHEMA_VERSION, TWSE_SYMBOLS,
  emptyTwseCapabilityEvidence,
  type ComparisonFailureClass, type TwseCapabilityEvidence, type TwseCapabilityReport,
  type TwseComparisonEvidence, type TwseSymbol
} from './twse-types.js';

const TOP_KEYS = [
  'report_schema_version', 'run_id', 'provider', 'session_date', 'overall_status',
  'logical_operation_count', 'http_attempt_count', 'capabilities', 'comparisons',
  'observed_at', 'runner_bundle_version', 'source_commit_sha'
] as const;
const CAPABILITY_KEYS = ['capability', 'symbol', 'status', 'evidence', 'failure_class'] as const;
const CAPABILITY_EVIDENCE_KEYS = [
  'session_date', 'schema_valid', 'timestamp_valid', 'freshness', 'source_volume_unit',
  'source_volume_multiplier', 'adjustment', 'target_present', 'record_count',
  'response_bytes', 'http_attempts'
] as const;
const COMPARISON_KEYS = CAPABILITY_KEYS;
const COMPARISON_EVIDENCE_KEYS = [
  'session_date', 'matched_fields', 'mismatch_fields', 'mismatch_count', 'http_attempts'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function orderedFields(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.some((item) => !COMPARISON_FIELDS.includes(item))) return false;
  return value.every((item, index) => COMPARISON_FIELDS.indexOf(item) > COMPARISON_FIELDS.indexOf(value[index - 1] as never));
}

export function failedTwseCapability(
  symbol: TwseSymbol,
  failureClass: FailureClass,
  metrics: { httpAttempts?: number; responseBytes?: number; recordCount?: number } = {}
): TwseCapabilityEvidence {
  const evidence = emptyTwseCapabilityEvidence();
  evidence.http_attempts = metrics.httpAttempts ?? 0;
  evidence.response_bytes = metrics.responseBytes !== undefined && metrics.responseBytes <= 4 * 1024 * 1024 ? metrics.responseBytes : null;
  evidence.record_count = metrics.recordCount !== undefined && metrics.recordCount <= 5_000 ? metrics.recordCount : null;
  return { capability: 'official_1d_raw', symbol, status: failureStatus(failureClass), evidence, failure_class: failureClass };
}

export function failedTwseComparison(
  symbol: TwseSymbol,
  failureClass: FailureClass,
  httpAttempts = 0
): TwseComparisonEvidence {
  return {
    capability: 'cross_source_1d_raw', symbol, status: failureStatus(failureClass),
    evidence: { session_date: null, matched_fields: [], mismatch_fields: [], mismatch_count: null, http_attempts: httpAttempts },
    failure_class: failureClass
  };
}

export function aggregateTwseStatus(
  capabilities: readonly TwseCapabilityEvidence[],
  comparisons: readonly TwseComparisonEvidence[]
): OverallStatus {
  const all = [...capabilities, ...comparisons];
  if (all.some((item) => item.failure_class === 'security_redaction_failure')) return 'fail';
  if (capabilities.some((item) => item.status === 'fail') || comparisons.some((item) => item.status === 'fail')) return 'fail';
  if (all.some((item) => item.status === 'unknown' || item.status === 'pending')) return 'unknown';
  if (all.some((item) => item.status === 'degraded')) return 'degraded';
  return 'pass';
}

function validCapability(value: unknown, symbol: TwseSymbol, sessionDate: string): value is TwseCapabilityEvidence {
  if (!isRecord(value) || !exactKeys(value, CAPABILITY_KEYS) || value.capability !== 'official_1d_raw' || value.symbol !== symbol
    || !isRecord(value.evidence) || !exactKeys(value.evidence, CAPABILITY_EVIDENCE_KEYS)) return false;
  const evidence = value.evidence;
  if (!['pass', 'fail', 'unknown', 'pending'].includes(String(value.status))
    || (value.failure_class !== null && !FAILURE_CLASSES.includes(value.failure_class as FailureClass))) return false;
  if (value.status === 'pass') {
    return value.failure_class === null && evidence.session_date === sessionDate && evidence.schema_valid === true
      && evidence.timestamp_valid === true && evidence.freshness === 'fresh' && evidence.source_volume_unit === 'share'
      && evidence.source_volume_multiplier === '1' && evidence.adjustment === 'raw' && evidence.target_present === true
      && validInteger(evidence.record_count, 1, 5_000) && validInteger(evidence.response_bytes, 1, 4 * 1024 * 1024)
      && validInteger(evidence.http_attempts, 1, 2);
  }
  if (value.status === 'pending') {
    return value.failure_class === null && CAPABILITY_EVIDENCE_KEYS.every((key) => key === 'http_attempts' ? evidence[key] === 0 : evidence[key] === null);
  }
  return value.failure_class !== null
    && (evidence.session_date === null || validDate(evidence.session_date))
    && [true, false, null].includes(evidence.schema_valid as boolean | null)
    && [true, false, null].includes(evidence.timestamp_valid as boolean | null)
    && [null, 'fresh', 'stale', 'unknown'].includes(evidence.freshness as string | null)
    && [null, 'share'].includes(evidence.source_volume_unit as string | null)
    && [null, '1'].includes(evidence.source_volume_multiplier as string | null)
    && [null, 'raw'].includes(evidence.adjustment as string | null)
    && [true, false, null].includes(evidence.target_present as boolean | null)
    && (evidence.record_count === null || validInteger(evidence.record_count, 0, 5_000))
    && (evidence.response_bytes === null || validInteger(evidence.response_bytes, 0, 4 * 1024 * 1024))
    && validInteger(evidence.http_attempts, 0, 2);
}

function validComparison(value: unknown, symbol: TwseSymbol, sessionDate: string): value is TwseComparisonEvidence {
  if (!isRecord(value) || !exactKeys(value, COMPARISON_KEYS) || value.capability !== 'cross_source_1d_raw' || value.symbol !== symbol
    || !isRecord(value.evidence) || !exactKeys(value.evidence, COMPARISON_EVIDENCE_KEYS)) return false;
  const evidence = value.evidence;
  if (!orderedFields(evidence.matched_fields) || !orderedFields(evidence.mismatch_fields)
    || !['pass', 'fail', 'degraded', 'unknown', 'pending'].includes(String(value.status))) return false;
  const allowedFailure = value.failure_class === null || value.failure_class === 'cross_source_mismatch'
    || FAILURE_CLASSES.includes(value.failure_class as FailureClass);
  if (!allowedFailure || !validInteger(evidence.http_attempts, 0, 2)) return false;
  if (value.status === 'pass' || value.status === 'degraded') {
    const combined = [...evidence.matched_fields as string[], ...evidence.mismatch_fields as string[]];
    if (new Set(combined).size !== COMPARISON_FIELDS.length || !COMPARISON_FIELDS.every((field) => combined.includes(field))
      || evidence.session_date !== sessionDate || !validInteger(evidence.mismatch_count, 0, COMPARISON_FIELDS.length)
      || evidence.mismatch_count !== (evidence.mismatch_fields as unknown[]).length || !validInteger(evidence.http_attempts, 1, 2)) return false;
    return value.status === 'pass'
      ? value.failure_class === null && evidence.mismatch_count === 0
      : value.failure_class === 'cross_source_mismatch' && (evidence.mismatch_count as number) > 0;
  }
  if (value.status === 'pending') {
    return value.failure_class === null && evidence.session_date === null && evidence.mismatch_count === null
      && (evidence.matched_fields as unknown[]).length === 0 && (evidence.mismatch_fields as unknown[]).length === 0 && evidence.http_attempts === 0;
  }
  return value.failure_class !== null && value.failure_class !== 'cross_source_mismatch'
    && evidence.session_date === null && evidence.mismatch_count === null
    && (evidence.matched_fields as unknown[]).length === 0 && (evidence.mismatch_fields as unknown[]).length === 0;
}

export function validateTwseReport(value: unknown): asserts value is TwseCapabilityReport {
  if (!isRecord(value) || !exactKeys(value, TOP_KEYS) || value.report_schema_version !== TWSE_REPORT_SCHEMA_VERSION
    || value.provider !== 'twse' || !validDate(value.session_date)) throw new RunnerFailure('schema_error');
  if (typeof value.run_id !== 'string' || value.run_id.length > 64 || !/^[0-9]+-[0-9]+$/.test(value.run_id)
    || !['pass', 'fail', 'degraded', 'unknown'].includes(String(value.overall_status))
    || !validInteger(value.logical_operation_count, 0, 3) || !validInteger(value.http_attempt_count, 0, 6)) throw new RunnerFailure('schema_error');
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== 2
    || !value.capabilities.every((item, index) => validCapability(item, TWSE_SYMBOLS[index]!, value.session_date as string))) throw new RunnerFailure('schema_error');
  if (!Array.isArray(value.comparisons) || value.comparisons.length !== 2
    || !value.comparisons.every((item, index) => validComparison(item, TWSE_SYMBOLS[index]!, value.session_date as string))) throw new RunnerFailure('schema_error');
  const capabilities = value.capabilities as TwseCapabilityEvidence[];
  const comparisons = value.comparisons as TwseComparisonEvidence[];
  const twseAttempts = Math.max(...capabilities.map((item) => item.evidence.http_attempts));
  const comparisonAttempts = comparisons.reduce((sum, item) => sum + item.evidence.http_attempts, 0);
  const attemptedOperations = (twseAttempts > 0 ? 1 : 0) + comparisons.filter((item) => item.evidence.http_attempts > 0).length;
  if (value.http_attempt_count !== twseAttempts + comparisonAttempts || value.logical_operation_count < attemptedOperations
    || value.overall_status !== aggregateTwseStatus(capabilities, comparisons)) throw new RunnerFailure('schema_error');
  if (!validUtc(value.observed_at) || typeof value.runner_bundle_version !== 'string'
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value.runner_bundle_version)
    || typeof value.source_commit_sha !== 'string' || !/^[a-f0-9]{40}$/.test(value.source_commit_sha)) throw new RunnerFailure('schema_error');
}

export function canonicalTwseReport(report: TwseCapabilityReport): string {
  validateTwseReport(report);
  const line = `${TWSE_REPORT_PREFIX}${JSON.stringify(report)}\n`;
  if (Buffer.byteLength(line, 'utf8') > 32 * 1024) throw new RunnerFailure('schema_error');
  return line;
}

export function renderTwseSummary(report: TwseCapabilityReport, metrics: SummaryMetrics): string {
  validateTwseReport(report);
  if (!validUtc(metrics.runner_started_at) || !validInteger(metrics.fetch_duration_ms, 0, 180_000)
    || !validInteger(metrics.runner_duration_ms, 0, 180_000) || metrics.fetch_duration_ms > metrics.runner_duration_ms
    || metrics.queue_start_delay_ms !== null) throw new RunnerFailure('schema_error');
  const capabilityRows = report.capabilities.map((item) =>
    `| ${item.capability} | ${item.symbol} | ${item.status} | ${item.failure_class ?? '—'} | ${item.evidence.record_count ?? '—'} | ${item.evidence.response_bytes ?? '—'} | ${item.evidence.http_attempts} |`);
  const comparisonRows = report.comparisons.map((item) =>
    `| ${item.symbol} | ${item.status} | ${item.failure_class ?? '—'} | ${item.evidence.mismatch_fields.join(',') || '—'} | ${item.evidence.mismatch_count ?? '—'} | ${item.evidence.http_attempts} |`);
  const markdown = [
    '# Stock Radar A-0 TWSE Capability', '',
    `- Schema: \`${report.report_schema_version}\``, `- Run: \`${report.run_id}\``,
    `- Session: \`${report.session_date}\``, `- Overall: \`${report.overall_status}\``,
    `- Bundle: \`${report.runner_bundle_version}\``, `- Source commit: \`${report.source_commit_sha}\``,
    `- Observed at: \`${report.observed_at}\``,
    `- Logical operations / HTTP attempts: \`${report.logical_operation_count} / ${report.http_attempt_count}\``,
    `- Runner started at: \`${metrics.runner_started_at}\``, `- Queue/start delay: \`not_observed\``,
    `- Fetch duration (ms): \`${metrics.fetch_duration_ms}\``, `- Runner duration (ms): \`${metrics.runner_duration_ms}\``,
    '', '| Capability | Symbol | Status | Failure class | Records | Bytes | Attempts |',
    '|---|---|---|---|---:|---:|---:|', ...capabilityRows,
    '', '| Comparison | Status | Failure class | Mismatch fields | Count | Fugle attempts |',
    '|---|---|---|---|---:|---:|', ...comparisonRows, '',
    '> 技術條件觀察，非投資建議；本 runner 不執行交易。', ''
  ].join('\n');
  if (Buffer.byteLength(markdown, 'utf8') > 32 * 1024) throw new RunnerFailure('schema_error');
  return markdown;
}
