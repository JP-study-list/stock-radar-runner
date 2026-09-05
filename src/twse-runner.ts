import { RunnerFailure, asRunnerFailure } from './failure.js';
import { HTTP_LIMITS, RequestBudget, fetchBoundedJson, type FetchLike } from './http.js';
import { assertRedacted } from './redaction.js';
import type { SummaryMetrics } from './report.js';
import { type FailureClass } from './types.js';
import {
  aggregateTwseStatus, canonicalTwseReport, failedTwseCapability, failedTwseComparison,
  renderTwseSummary, validateTwseReport
} from './twse-report.js';
import {
  TWSE_HTTP_LIMITS, compareDailyValues, parseFugleDailyComparator, parseTwseDailyEvidence
} from './twse.js';
import {
  TWSE_REPORT_SCHEMA_VERSION, TWSE_SYMBOLS, pendingTwseCapabilities, pendingTwseComparisons,
  type NormalizedDailyValues, type TwseCapabilityEvidence, type TwseCapabilityReport,
  type TwseComparisonEvidence, type TwseSymbol
} from './twse-types.js';

export type TwseRunOptions = {
  apiKey: string;
  sessionDate: string;
  runId: string;
  sourceCommitSha: string;
  bundleVersion: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  monotonicNow?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
};

export type TwseRunResult = {
  report: TwseCapabilityReport;
  line: string;
  summary: string;
  metrics: SummaryMetrics;
};

export type TwseHandoff = {
  handoff_schema_version: 'twse-capability-handoff-v1';
  report: TwseCapabilityReport;
  official_values: Array<{ symbol: TwseSymbol; values: NormalizedDailyValues }>;
  runner_started_at: string;
  fetch_duration_ms: number;
};

const TWSE_URL = new URL('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');

function fugleDailyUrl(symbol: TwseSymbol, sessionDate: string): URL {
  const providerSymbol = symbol.slice(3);
  const url = new URL(`https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${providerSymbol}`);
  url.searchParams.set('from', sessionDate);
  url.searchParams.set('to', sessionDate);
  url.searchParams.set('timeframe', 'D');
  url.searchParams.set('fields', 'open,high,low,close,volume');
  url.searchParams.set('sort', 'asc');
  return url;
}

function reportFor(
  options: Pick<TwseRunOptions, 'sessionDate' | 'runId' | 'sourceCommitSha' | 'bundleVersion'>,
  capabilities: TwseCapabilityEvidence[],
  comparisons: TwseComparisonEvidence[],
  observedAt: string,
  budget: RequestBudget
): TwseCapabilityReport {
  return {
    report_schema_version: TWSE_REPORT_SCHEMA_VERSION,
    run_id: options.runId,
    provider: 'twse',
    session_date: options.sessionDate,
    overall_status: aggregateTwseStatus(capabilities, comparisons),
    logical_operation_count: budget.logicalOperationCount,
    http_attempt_count: budget.httpAttemptCount,
    capabilities,
    comparisons,
    observed_at: observedAt,
    runner_bundle_version: options.bundleVersion,
    source_commit_sha: options.sourceCommitSha
  };
}

function safeOutputs(report: TwseCapabilityReport, metrics: SummaryMetrics, secret: string): { line: string; summary: string } {
  const line = canonicalTwseReport(report);
  const summary = renderTwseSummary(report, metrics);
  assertRedacted(line, secret);
  assertRedacted(summary, secret);
  return { line, summary };
}

function securityFailure(report: TwseCapabilityReport): TwseCapabilityReport {
  const capabilities = report.capabilities.map((item, index) => index === 0
    ? { ...item, status: 'fail' as const, failure_class: 'security_redaction_failure' as const }
    : item);
  return { ...report, overall_status: 'fail', capabilities };
}

function fugleLimits() {
  return { ...TWSE_HTTP_LIMITS, responseBytes: HTTP_LIMITS.responseBytes, records: HTTP_LIMITS.records };
}

function failureAttempts(failureClass: FailureClass, attempts: number): number {
  return failureClass === 'timeout' && attempts === 0 ? 0 : Math.min(HTTP_LIMITS.attemptsPerOperation, attempts);
}

function restoreBudget(report: TwseCapabilityReport): RequestBudget {
  const budget = new RequestBudget(TWSE_HTTP_LIMITS);
  for (let index = 0; index < report.logical_operation_count; index += 1) budget.beginOperation();
  for (let index = 0; index < report.http_attempt_count; index += 1) budget.beginAttempt();
  return budget;
}

function validateHandoff(value: TwseHandoff, options: Omit<TwseRunOptions, 'apiKey'>): void {
  if (value.handoff_schema_version !== 'twse-capability-handoff-v1'
    || value.report.run_id !== options.runId || value.report.session_date !== options.sessionDate
    || value.report.source_commit_sha !== options.sourceCommitSha || value.report.runner_bundle_version !== options.bundleVersion
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.runner_started_at)
    || !Number.isInteger(value.fetch_duration_ms) || value.fetch_duration_ms < 0 || value.fetch_duration_ms > 180_000
    || value.official_values.length > TWSE_SYMBOLS.length) throw new RunnerFailure('schema_error');
  validateTwseReport(value.report);
  const symbols = new Set<TwseSymbol>();
  for (const item of value.official_values) {
    if (!TWSE_SYMBOLS.includes(item.symbol) || symbols.has(item.symbol)
      || Object.keys(item.values).join(',') !== 'open,high,low,close,volume'
      || Object.values(item.values).some((field) => !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(field))) {
      throw new RunnerFailure('schema_error');
    }
    symbols.add(item.symbol);
  }
  for (const [index, symbol] of TWSE_SYMBOLS.entries()) {
    if ((value.report.capabilities[index]?.status === 'pass') !== symbols.has(symbol)) throw new RunnerFailure('schema_error');
  }
}

export async function fetchTwseHandoff(options: Omit<TwseRunOptions, 'apiKey'>): Promise<TwseHandoff> {
  const wallClock = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAtMs = monotonicNow();
  const runnerStartedAt = wallClock().toISOString();
  const deadlineAt = startedAtMs + TWSE_HTTP_LIMITS.jobTimeoutMs - 5_000;
  const budget = new RequestBudget(TWSE_HTTP_LIMITS);
  let capabilities = pendingTwseCapabilities();
  const comparisons = pendingTwseComparisons();
  let fetchDurationMs = 0;
  let officialValues = new Map<TwseSymbol, NormalizedDailyValues>();

  const twseStarted = monotonicNow();
  try {
    const result = await fetchBoundedJson(TWSE_URL, { method: 'GET', headers: { Accept: 'application/json' } }, {
      fetchImpl, budget, limits: TWSE_HTTP_LIMITS, deadlineAt, clock: monotonicNow,
      ...(options.wait ? { wait: options.wait } : {})
    });
    const parsed = parseTwseDailyEvidence(result, options.sessionDate);
    capabilities = parsed.capabilities;
    officialValues = parsed.values;
  } catch (error) {
    const failure = asRunnerFailure(error);
    const attempts = failure.metrics.httpAttempts ?? Math.min(TWSE_HTTP_LIMITS.attemptsPerOperation, budget.httpAttemptCount);
    capabilities = TWSE_SYMBOLS.map((symbol) => failedTwseCapability(symbol, failure.failureClass, {
      httpAttempts: attempts,
      ...(failure.metrics.responseBytes === undefined ? {} : { responseBytes: failure.metrics.responseBytes })
    }));
  } finally {
    fetchDurationMs += Math.max(0, monotonicNow() - twseStarted);
  }

  const report = reportFor(options, capabilities, comparisons, wallClock().toISOString(), budget);
  validateTwseReport(report);
  const handoff: TwseHandoff = {
    handoff_schema_version: 'twse-capability-handoff-v1',
    report,
    official_values: TWSE_SYMBOLS.flatMap((symbol) => {
      const values = officialValues.get(symbol);
      return values ? [{ symbol, values }] : [];
    }),
    runner_started_at: runnerStartedAt,
    fetch_duration_ms: Math.round(fetchDurationMs)
  };
  validateHandoff(handoff, options);
  return handoff;
}

export async function completeTwseHandoff(options: TwseRunOptions, handoff: TwseHandoff): Promise<TwseRunResult> {
  validateHandoff(handoff, options);
  const wallClock = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAtMs = monotonicNow();
  const deadlineAt = startedAtMs + TWSE_HTTP_LIMITS.jobTimeoutMs - 5_000;
  const budget = restoreBudget(handoff.report);
  const capabilities = structuredClone(handoff.report.capabilities);
  const comparisons = pendingTwseComparisons();
  let fetchDurationMs = handoff.fetch_duration_ms;
  const officialValues = new Map(handoff.official_values.map((item) => [item.symbol, item.values]));

  for (let index = 0; index < TWSE_SYMBOLS.length; index += 1) {
    const symbol = TWSE_SYMBOLS[index]!;
    const official = officialValues.get(symbol);
    if (!official) {
      comparisons[index] = failedTwseComparison(symbol, capabilities[index]?.failure_class ?? 'unknown');
      continue;
    }
    if (options.apiKey.length === 0) {
      comparisons[index] = failedTwseComparison(symbol, 'auth_error');
      continue;
    }
    const probeStarted = monotonicNow();
    const attemptsBefore = budget.httpAttemptCount;
    try {
      const result = await fetchBoundedJson(fugleDailyUrl(symbol, options.sessionDate), {
        method: 'GET', headers: { 'X-API-KEY': options.apiKey, Accept: 'application/json' }
      }, {
        fetchImpl, budget, limits: fugleLimits(), deadlineAt, clock: monotonicNow,
        ...(options.wait ? { wait: options.wait } : {})
      });
      const comparator = parseFugleDailyComparator(result, symbol, options.sessionDate);
      const difference = compareDailyValues(official, comparator);
      const mismatch = difference.mismatchFields.length;
      comparisons[index] = {
        capability: 'cross_source_1d_raw', symbol,
        status: mismatch === 0 ? 'pass' : 'degraded',
        evidence: {
          session_date: options.sessionDate,
          matched_fields: difference.matchedFields,
          mismatch_fields: difference.mismatchFields,
          mismatch_count: mismatch,
          http_attempts: result.attempts
        },
        failure_class: mismatch === 0 ? null : 'cross_source_mismatch'
      };
    } catch (error) {
      const failure = asRunnerFailure(error);
      comparisons[index] = failedTwseComparison(symbol, failure.failureClass,
        failureAttempts(failure.failureClass, failure.metrics.httpAttempts ?? budget.httpAttemptCount - attemptsBefore));
      if (['auth_error', 'rate_limited', 'security_redaction_failure'].includes(failure.failureClass)) break;
    } finally {
      fetchDurationMs += Math.max(0, monotonicNow() - probeStarted);
    }
  }

  const metrics: SummaryMetrics = {
    runner_started_at: handoff.runner_started_at,
    fetch_duration_ms: Math.round(fetchDurationMs),
    runner_duration_ms: Math.round(handoff.fetch_duration_ms + Math.max(0, monotonicNow() - startedAtMs)),
    queue_start_delay_ms: null
  };
  let report = reportFor(options, capabilities, comparisons, wallClock().toISOString(), budget);
  validateTwseReport(report);
  try {
    return { report, ...safeOutputs(report, metrics, options.apiKey), metrics };
  } catch (error) {
    if (!(error instanceof RunnerFailure) || error.failureClass !== 'security_redaction_failure') throw error;
    report = securityFailure(report);
    validateTwseReport(report);
    return { report, ...safeOutputs(report, metrics, options.apiKey), metrics };
  }
}

export async function runTwseSmoke(options: TwseRunOptions): Promise<TwseRunResult> {
  const handoff = await fetchTwseHandoff(options);
  return completeTwseHandoff(options, handoff);
}
