import { readFile } from 'node:fs/promises';
import { parseCalendarSnapshot, selectSession } from './calendar.js';
import { RunnerFailure, asRunnerFailure } from './failure.js';
import { parseFugleEvidence } from './fugle.js';
import { HTTP_LIMITS, RequestBudget, fetchBoundedJson, type FetchLike } from './http.js';
import { assertRedacted } from './redaction.js';
import {
  aggregateStatus, canonicalReport, failedCapability, renderSummary, validateReport,
  type SummaryMetrics
} from './report.js';
import {
  DATA_PROBES, REPORT_SCHEMA_VERSION, emptyEvidence, pendingCapabilities,
  type CapabilityEvidence, type CapabilityReport, type FailureClass
} from './types.js';

export type RunOptions = {
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

export type RunResult = {
  report: CapabilityReport;
  line: string;
  summary: string;
  metrics: SummaryMetrics;
};

function fugleUrl(probe: typeof DATA_PROBES[number], sessionDate: string): URL {
  const url = new URL(`https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${probe.providerSymbol}`);
  url.searchParams.set('from', sessionDate);
  url.searchParams.set('to', sessionDate);
  url.searchParams.set('timeframe', probe.timeframe);
  url.searchParams.set('fields', 'open,high,low,close,volume');
  url.searchParams.set('sort', 'asc');
  if (probe.adjustment === 'adjusted') url.searchParams.set('adjusted', 'true');
  return url;
}

function shouldStop(failureClass: FailureClass): boolean {
  return ['auth_error', 'rate_limited', 'security_redaction_failure'].includes(failureClass);
}

function createReport(
  options: RunOptions,
  capabilities: CapabilityEvidence[],
  observedAt: string,
  budget: RequestBudget
): CapabilityReport {
  return {
    report_schema_version: REPORT_SCHEMA_VERSION,
    run_id: options.runId,
    provider: 'fugle',
    overall_status: aggregateStatus(capabilities),
    logical_operation_count: budget.logicalOperationCount,
    http_attempt_count: budget.httpAttemptCount,
    capabilities,
    observed_at: observedAt,
    runner_bundle_version: options.bundleVersion,
    source_commit_sha: options.sourceCommitSha
  };
}

function safeOutputs(report: CapabilityReport, metrics: SummaryMetrics, secret: string): { line: string; summary: string } {
  const line = canonicalReport(report);
  const summary = renderSummary(report, metrics);
  assertRedacted(line, secret);
  assertRedacted(summary, secret);
  return { line, summary };
}

function securityFailureReport(report: CapabilityReport): CapabilityReport {
  const capabilities = report.capabilities.map((item, index) => index === 0
    ? { ...item, status: 'fail' as const, failure_class: 'security_redaction_failure' as const }
    : item);
  return { ...report, overall_status: 'fail', capabilities };
}

export async function runFugleSmoke(options: RunOptions): Promise<RunResult> {
  const wallClock = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAtMs = monotonicNow();
  const runnerStartedAt = wallClock().toISOString();
  const deadlineAt = startedAtMs + HTTP_LIMITS.jobTimeoutMs - 5_000;
  const capabilities = pendingCapabilities();
  const budget = new RequestBudget();
  let anyRateLimitHeader = false;
  let fetchDurationMs = 0;

  if (options.apiKey.length === 0) {
    capabilities[0] = failedCapability(DATA_PROBES[0]!.capability, DATA_PROBES[0]!.symbol, 'auth_error');
  } else {
    for (let index = 0; index < DATA_PROBES.length; index += 1) {
      const probe = DATA_PROBES[index]!;
      const probeStarted = monotonicNow();
      try {
        const result = await fetchBoundedJson(fugleUrl(probe, options.sessionDate), {
          method: 'GET',
          headers: { 'X-API-KEY': options.apiKey, Accept: 'application/json' }
        }, {
          fetchImpl,
          budget,
          deadlineAt,
          clock: monotonicNow,
          ...(options.wait ? { wait: options.wait } : {})
        });
        anyRateLimitHeader ||= result.rateLimitHeaderObserved;
        capabilities[index] = parseFugleEvidence(result, probe, options.sessionDate);
      } catch (error) {
        const failure = asRunnerFailure(error);
        capabilities[index] = failedCapability(probe.capability, probe.symbol, failure.failureClass, {
          httpAttempts: failure.metrics.httpAttempts ?? Math.min(HTTP_LIMITS.attemptsPerOperation, budget.httpAttemptCount - capabilities.slice(0, index).reduce((sum, item) => sum + item.evidence.http_attempts, 0)),
          ...(failure.metrics.responseBytes === undefined ? {} : { responseBytes: failure.metrics.responseBytes })
        });
        if (shouldStop(failure.failureClass)) break;
      } finally {
        fetchDurationMs += Math.max(0, monotonicNow() - probeStarted);
      }
    }
  }

  const rateEvidence = emptyEvidence();
  rateEvidence.rate_limit_header_observed = anyRateLimitHeader;
  capabilities[7] = anyRateLimitHeader
    ? { capability: 'rate_limit_headers', symbol: null, status: 'pass', evidence: rateEvidence, failure_class: null }
    : { capability: 'rate_limit_headers', symbol: null, status: 'unknown', evidence: rateEvidence, failure_class: 'unknown' };

  const observedAt = wallClock().toISOString();
  const metrics: SummaryMetrics = {
    runner_started_at: runnerStartedAt,
    fetch_duration_ms: Math.round(fetchDurationMs),
    runner_duration_ms: Math.round(Math.max(0, monotonicNow() - startedAtMs)),
    queue_start_delay_ms: null
  };
  let report = createReport(options, capabilities, observedAt, budget);
  validateReport(report);
  try {
    const outputs = safeOutputs(report, metrics, options.apiKey);
    return { report, ...outputs, metrics };
  } catch (error) {
    if (!(error instanceof RunnerFailure) || error.failureClass !== 'security_redaction_failure') throw error;
    report = securityFailureReport(report);
    validateReport(report);
    const outputs = safeOutputs(report, metrics, options.apiKey);
    return { report, ...outputs, metrics };
  }
}

export async function loadSelectedSession(snapshotPath: string, now: Date, requested?: string): Promise<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;
  } catch {
    throw new RunnerFailure('calendar_unknown');
  }
  return selectSession(parseCalendarSnapshot(raw), now, requested);
}
