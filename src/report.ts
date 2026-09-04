import { RunnerFailure } from './failure.js';
import {
  DATA_PROBES, FAILURE_CLASSES, REPORT_PREFIX, REPORT_SCHEMA_VERSION,
  emptyEvidence, type CapabilityEvidence, type CapabilityReport, type FailureClass, type OverallStatus
} from './types.js';

const TOP_KEYS = [
  'report_schema_version', 'run_id', 'provider', 'overall_status', 'logical_operation_count',
  'http_attempt_count', 'capabilities', 'observed_at', 'runner_bundle_version', 'source_commit_sha'
] as const;
const CAPABILITY_KEYS = ['capability', 'symbol', 'status', 'evidence', 'failure_class'] as const;
const EVIDENCE_KEYS = [
  'session_date', 'schema_valid', 'timestamp_valid', 'freshness', 'continuity', 'source_volume_unit',
  'source_volume_multiplier', 'adjustment', 'entitlement_observed', 'rate_limit_header_observed',
  'record_count', 'response_bytes', 'http_attempts', 'first_timestamp', 'last_timestamp'
] as const;
const EXPECTED_PAIRS = [
  ...DATA_PROBES.map((probe) => `${probe.capability}|${probe.symbol}`),
  'rate_limit_headers|null'
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactOrderedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function validUtcMilliseconds(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function validNullable(value: unknown, values: readonly unknown[]): boolean {
  return value === null || values.includes(value);
}

export function failureStatus(failureClass: FailureClass): 'fail' | 'unknown' {
  return ['rate_limited', 'network_error', 'server_error', 'timeout', 'unknown'].includes(failureClass) ? 'unknown' : 'fail';
}

export function failedCapability(
  capability: CapabilityEvidence['capability'],
  symbol: CapabilityEvidence['symbol'],
  failureClass: FailureClass,
  metrics: { httpAttempts?: number; responseBytes?: number } = {}
): CapabilityEvidence {
  const evidence = emptyEvidence();
  evidence.http_attempts = metrics.httpAttempts ?? 0;
  evidence.response_bytes = metrics.responseBytes !== undefined && metrics.responseBytes <= 524_288 ? metrics.responseBytes : null;
  return { capability, symbol, status: failureStatus(failureClass), evidence, failure_class: failureClass };
}

export function aggregateStatus(capabilities: readonly CapabilityEvidence[]): OverallStatus {
  if (capabilities.some((item) => item.failure_class === 'security_redaction_failure')) return 'fail';
  const mandatory = capabilities.slice(0, 7);
  const ancillary = capabilities[7];
  if (mandatory.some((item) => item.status === 'fail')) return 'fail';
  if (mandatory.some((item) => item.status === 'unknown' || item.status === 'pending')) return 'unknown';
  if (mandatory.some((item) => item.status === 'degraded') || ancillary?.status !== 'pass') return 'degraded';
  return 'pass';
}

function validateEvidence(value: unknown): boolean {
  if (!isRecord(value) || !exactOrderedKeys(value, EVIDENCE_KEYS)) return false;
  return (value.session_date === null || validDate(value.session_date))
    && validNullable(value.schema_valid, [true, false])
    && validNullable(value.timestamp_valid, [true, false])
    && validNullable(value.freshness, ['fresh', 'stale', 'unknown'])
    && validNullable(value.continuity, ['continuous', 'gap_suspected', 'gap_confirmed', 'no_trade', 'not_applicable', 'unknown'])
    && validNullable(value.source_volume_unit, ['share', 'lot', 'unknown'])
    && validNullable(value.source_volume_multiplier, ['1', '1000'])
    && validNullable(value.adjustment, ['raw', 'adjusted', 'unknown'])
    && validNullable(value.entitlement_observed, [true, false])
    && validNullable(value.rate_limit_header_observed, [true, false])
    && (value.record_count === null || validInteger(value.record_count, 0, 100))
    && (value.response_bytes === null || validInteger(value.response_bytes, 0, 524_288))
    && validInteger(value.http_attempts, 0, 2)
    && (value.first_timestamp === null || validUtcMilliseconds(value.first_timestamp))
    && (value.last_timestamp === null || validUtcMilliseconds(value.last_timestamp));
}

function validateCapability(value: unknown, expectedPair: string, index: number): value is CapabilityEvidence {
  if (!isRecord(value) || !exactOrderedKeys(value, CAPABILITY_KEYS) || !validateEvidence(value.evidence)) return false;
  const pair = `${String(value.capability)}|${String(value.symbol)}`;
  if (pair !== expectedPair || !['pass', 'fail', 'degraded', 'unknown', 'pending'].includes(String(value.status))) return false;
  if (value.failure_class !== null && !FAILURE_CLASSES.includes(value.failure_class as FailureClass)) return false;
  if (value.status === 'pass' && value.failure_class !== null) return false;
  if ((value.status === 'fail' || value.status === 'unknown') && value.failure_class === null) return false;
  if (value.status === 'pending' && value.failure_class !== null) return false;
  const evidence = value.evidence as Record<string, unknown>;
  if (index === DATA_PROBES.length) {
    const nonRateKeys = EVIDENCE_KEYS.filter((key) => key !== 'rate_limit_header_observed' && key !== 'http_attempts');
    if (evidence.http_attempts !== 0
      || ![true, false, null].includes(evidence.rate_limit_header_observed as boolean | null)
      || nonRateKeys.some((key) => evidence[key] !== null)) return false;
  }
  if (validUtcMilliseconds(evidence.first_timestamp) && validUtcMilliseconds(evidence.last_timestamp)
    && evidence.first_timestamp > evidence.last_timestamp) return false;
  if (value.status === 'pending' && EVIDENCE_KEYS.some((key) => key === 'http_attempts' ? evidence[key] !== 0 : evidence[key] !== null)) return false;
  if (value.status === 'pass') {
    if (value.capability === 'rate_limit_headers') return evidence.rate_limit_header_observed === true && evidence.http_attempts === 0;
    if (evidence.schema_valid !== true || evidence.timestamp_valid !== true || evidence.freshness !== 'fresh'
      || !['continuous', 'not_applicable', 'no_trade'].includes(String(evidence.continuity))
      || !['share', 'lot'].includes(String(evidence.source_volume_unit))
      || !['1', '1000'].includes(String(evidence.source_volume_multiplier))
      || !['raw', 'adjusted'].includes(String(evidence.adjustment))
      || evidence.entitlement_observed !== true
      || !validInteger(evidence.record_count, 1, 100)
      || !validInteger(evidence.response_bytes, 1, 524_288)
      || !validInteger(evidence.http_attempts, 1, 2)
      || !validUtcMilliseconds(evidence.first_timestamp)
      || !validUtcMilliseconds(evidence.last_timestamp)) return false;
  }
  if (index < DATA_PROBES.length && (value.status === 'pass' || value.status === 'degraded')) {
    const probe = DATA_PROBES[index]!;
    const expectedUnit = probe.timeframe === 'D' ? 'share' : 'lot';
    const expectedMultiplier = probe.timeframe === 'D' ? '1' : '1000';
    const expectedContinuity = probe.timeframe === 'D' ? 'not_applicable' : value.status === 'pass' ? 'continuous' : evidence.continuity;
    if (!validDate(evidence.session_date)
      || evidence.source_volume_unit !== expectedUnit
      || evidence.source_volume_multiplier !== expectedMultiplier
      || evidence.adjustment !== probe.adjustment
      || evidence.continuity !== expectedContinuity) return false;
  }
  return true;
}

export function validateReport(value: unknown): asserts value is CapabilityReport {
  if (!isRecord(value) || !exactOrderedKeys(value, TOP_KEYS)) throw new RunnerFailure('schema_error');
  if (value.report_schema_version !== REPORT_SCHEMA_VERSION || value.provider !== 'fugle') throw new RunnerFailure('schema_error');
  if (typeof value.run_id !== 'string' || value.run_id.length > 64 || !/^[0-9]+-[0-9]+$/.test(value.run_id)) throw new RunnerFailure('schema_error');
  if (!['pass', 'fail', 'degraded', 'unknown'].includes(String(value.overall_status))) throw new RunnerFailure('schema_error');
  if (!validInteger(value.logical_operation_count, 0, 7) || !validInteger(value.http_attempt_count, 0, 14)) throw new RunnerFailure('schema_error');
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== EXPECTED_PAIRS.length
    || !value.capabilities.every((item, index) => validateCapability(item, EXPECTED_PAIRS[index]!, index))) throw new RunnerFailure('schema_error');
  const capabilities = value.capabilities as CapabilityEvidence[];
  const evaluated = capabilities.slice(0, 7).filter((item) => item.status !== 'pending').length;
  const attempted = capabilities.slice(0, 7).filter((item) => item.evidence.http_attempts > 0).length;
  const attempts = capabilities.slice(0, 7).reduce((sum, item) => sum + item.evidence.http_attempts, 0);
  if (value.logical_operation_count < attempted || value.logical_operation_count > evaluated
    || value.http_attempt_count !== attempts) throw new RunnerFailure('schema_error');
  if (value.overall_status !== aggregateStatus(capabilities)) throw new RunnerFailure('schema_error');
  if (!validUtcMilliseconds(value.observed_at)) throw new RunnerFailure('schema_error');
  if (typeof value.runner_bundle_version !== 'string' || value.runner_bundle_version.length > 32
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value.runner_bundle_version)) throw new RunnerFailure('schema_error');
  if (typeof value.source_commit_sha !== 'string' || !/^[a-f0-9]{40}$/.test(value.source_commit_sha)) throw new RunnerFailure('schema_error');
}

export function canonicalReport(report: CapabilityReport): string {
  validateReport(report);
  const json = JSON.stringify(report);
  const line = `${REPORT_PREFIX}${json}\n`;
  if (Buffer.byteLength(line, 'utf8') > 32 * 1024) throw new RunnerFailure('schema_error');
  return line;
}

export type SummaryMetrics = {
  runner_started_at: string;
  fetch_duration_ms: number;
  runner_duration_ms: number;
  queue_start_delay_ms: null;
};

export function renderSummary(report: CapabilityReport, metrics: SummaryMetrics): string {
  validateReport(report);
  if (!validUtcMilliseconds(metrics.runner_started_at)
    || !validInteger(metrics.fetch_duration_ms, 0, 180_000)
    || !validInteger(metrics.runner_duration_ms, 0, 180_000)
    || metrics.fetch_duration_ms > metrics.runner_duration_ms
    || metrics.queue_start_delay_ms !== null) throw new RunnerFailure('schema_error');
  const rows = report.capabilities.map((item) => `| ${item.capability} | ${item.symbol ?? '—'} | ${item.status} | ${item.failure_class ?? '—'} | ${item.evidence.record_count ?? '—'} | ${item.evidence.response_bytes ?? '—'} | ${item.evidence.http_attempts} |`);
  const markdown = [
    '# Stock Radar A-0 Capability', '',
    `- Schema: \`${report.report_schema_version}\``,
    `- Run: \`${report.run_id}\``,
    `- Provider: \`${report.provider}\``,
    `- Overall: \`${report.overall_status}\``,
    `- Bundle: \`${report.runner_bundle_version}\``,
    `- Source commit: \`${report.source_commit_sha}\``,
    `- Observed at: \`${report.observed_at}\``,
    `- Logical operations / HTTP attempts: \`${report.logical_operation_count} / ${report.http_attempt_count}\``,
    `- Runner started at: \`${metrics.runner_started_at}\``,
    `- Queue/start delay: \`${metrics.queue_start_delay_ms === null ? 'not_observed' : metrics.queue_start_delay_ms}\``,
    `- Fetch duration (ms): \`${metrics.fetch_duration_ms}\``,
    `- Runner duration (ms): \`${metrics.runner_duration_ms}\``,
    '', '| Capability | Symbol | Status | Failure class | Records | Bytes | Attempts |',
    '|---|---|---|---|---:|---:|---:|', ...rows, '',
    '> 技術條件觀察，非投資建議；本 runner 不執行交易。', ''
  ].join('\n');
  if (Buffer.byteLength(markdown, 'utf8') > 32 * 1024) throw new RunnerFailure('schema_error');
  return markdown;
}
