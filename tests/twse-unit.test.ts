import assert from 'node:assert/strict';
import test from 'node:test';
import { RunnerFailure } from '../src/failure.js';
import { RequestBudget, fetchBoundedJson, type FetchLike } from '../src/http.js';
import { aggregateTwseStatus, canonicalTwseReport, validateTwseReport } from '../src/twse-report.js';
import { TWSE_HTTP_LIMITS } from '../src/twse.js';
import {
  TWSE_REPORT_SCHEMA_VERSION, pendingTwseCapabilities, pendingTwseComparisons,
  type TwseCapabilityReport
} from '../src/twse-types.js';

function pendingReport(): TwseCapabilityReport {
  const capabilities = pendingTwseCapabilities();
  const comparisons = pendingTwseComparisons();
  return {
    report_schema_version: TWSE_REPORT_SCHEMA_VERSION,
    run_id: '2000-1',
    provider: 'twse',
    session_date: '2026-08-28',
    overall_status: aggregateTwseStatus(capabilities, comparisons),
    logical_operation_count: 0,
    http_attempt_count: 0,
    capabilities,
    comparisons,
    observed_at: '2026-09-04T08:00:00.000Z',
    runner_bundle_version: '0.2.0',
    source_commit_sha: 'e'.repeat(40)
  };
}

test('TWSE report is a separate exact ordered and bounded contract', () => {
  const report = pendingReport();
  validateTwseReport(report);
  const line = canonicalTwseReport(report);
  assert.ok(line.startsWith('STOCK_RADAR_TWSE_CAPABILITY_REPORT={"report_schema_version":"public-runner-twse-capability-v1"'));
  assert.ok(Buffer.byteLength(line) < 32 * 1024);
  assert.throws(() => validateTwseReport({ ...report, extra: true }), RunnerFailure);
  const { run_id: runId, ...rest } = report;
  assert.throws(() => validateTwseReport({ run_id: runId, ...rest }), RunnerFailure);
});

test('TWSE request budget is 3 logical operations, 6 attempts, 4 MiB, and 5,000 rows', async () => {
  assert.deepEqual({
    logicalOperations: TWSE_HTTP_LIMITS.logicalOperations,
    totalAttempts: TWSE_HTTP_LIMITS.totalAttempts,
    responseBytes: TWSE_HTTP_LIMITS.responseBytes,
    records: TWSE_HTTP_LIMITS.records
  }, { logicalOperations: 3, totalAttempts: 6, responseBytes: 4 * 1024 * 1024, records: 5_000 });
  const oversized: FetchLike = async () => new Response('{}', { headers: {
    'content-type': 'application/json', 'content-length': String(TWSE_HTTP_LIMITS.responseBytes + 1)
  } });
  await assert.rejects(fetchBoundedJson(new URL('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'), {}, {
    fetchImpl: oversized, budget: new RequestBudget(TWSE_HTTP_LIMITS), limits: TWSE_HTTP_LIMITS
  }), (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'response_too_large');

  let calls = 0;
  const unavailable: FetchLike = async () => { calls += 1; return new Response('', { status: 503 }); };
  const budget = new RequestBudget(TWSE_HTTP_LIMITS);
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(fetchBoundedJson(new URL('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'), {}, {
      fetchImpl: unavailable, budget, limits: TWSE_HTTP_LIMITS, wait: async () => undefined
    }), RunnerFailure);
  }
  await assert.rejects(fetchBoundedJson(new URL('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'), {}, {
    fetchImpl: unavailable, budget, limits: TWSE_HTTP_LIMITS
  }), RunnerFailure);
  assert.equal(calls, 6);
  assert.equal(budget.logicalOperationCount, 3);
  assert.equal(budget.httpAttemptCount, 6);
});
