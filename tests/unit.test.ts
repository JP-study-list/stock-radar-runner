import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseCalendarSnapshot, selectSession } from '../src/calendar.js';
import { RunnerFailure } from '../src/failure.js';
import { HTTP_LIMITS, RequestBudget, fetchBoundedJson, type FetchLike } from '../src/http.js';
import { aggregateStatus, canonicalReport, validateReport } from '../src/report.js';
import { runFugleSmoke } from '../src/runner.js';
import { REPORT_SCHEMA_VERSION, pendingCapabilities, type CapabilityEvidence, type CapabilityReport } from '../src/types.js';

async function calendar(): Promise<unknown> {
  return JSON.parse(await readFile(resolve(process.cwd(), 'calendar/tw-sessions-2026-09-v1.json'), 'utf8')) as unknown;
}

test('calendar uses paired official sessions and fails closed for expired or invalid input', async () => {
  const entries = parseCalendarSnapshot(await calendar());
  assert.equal(selectSession(entries, new Date('2026-09-02T08:00:00.000Z')), '2026-09-01');
  assert.equal(selectSession(entries, new Date('2026-09-02T08:00:00.000Z'), '2026-09-01'), '2026-09-01');
  assert.equal(selectSession(entries, new Date('2026-09-05T00:40:00.000Z')), '2026-09-04');
  assert.equal(selectSession(entries, new Date('2026-09-07T08:29:59.999Z'), '2026-09-04'), '2026-09-04');
  assert.throws(() => selectSession(entries, new Date('2026-09-07T08:30:00.000Z'), '2026-09-04'), RunnerFailure);
  assert.throws(() => selectSession(entries, new Date('2026-09-02T08:30:00.000Z')), (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'calendar_unknown');
  assert.throws(() => selectSession(entries.slice(0, 1), new Date('2026-09-02T08:00:00.000Z')), RunnerFailure);
  assert.throws(() => selectSession(entries, new Date('2026-09-01T08:29:59.999Z'), '2026-09-01'), RunnerFailure);
});

test('calendar schema rejects extra fields, non-official lineage, and unresolved exceptions', async () => {
  const source = await calendar() as Array<Record<string, unknown>>;
  assert.throws(() => parseCalendarSnapshot([{ ...source[0], extra: true }]), RunnerFailure);
  assert.throws(() => parseCalendarSnapshot([{ ...source[0], official_source_url: 'https://example.invalid' }]), RunnerFailure);
  assert.throws(() => selectSession(parseCalendarSnapshot([
    { ...source[0], session_exception_codes: ['suspended'] }, source[1]
  ]), new Date('2026-09-02T08:00:00.000Z')), RunnerFailure);
  assert.throws(() => selectSession(parseCalendarSnapshot([
    { ...source[0], scheduled_close: '2026-09-01T05:25:00.000Z' }, source[1]
  ]), new Date('2026-09-02T08:00:00.000Z')), RunnerFailure);
  assert.throws(() => selectSession(parseCalendarSnapshot([
    { ...source[0], retrieved_at: '2026-09-02T08:15:00.000Z' }, source[1]
  ]), new Date('2026-09-02T08:00:00.000Z')), RunnerFailure);
});

test('bounded HTTP retries only approved transient classes and accounts attempts', async () => {
  const responses = [new Response('', { status: 429, headers: { 'retry-after': '0' } }), Response.json({ ok: true })];
  const fetchImpl: FetchLike = async () => responses.shift()!;
  const budget = new RequestBudget();
  const result = await fetchBoundedJson(new URL('https://example.invalid'), {}, { fetchImpl, budget, wait: async () => undefined });
  assert.equal(result.attempts, 2);
  assert.equal(budget.logicalOperationCount, 1);
  assert.equal(budget.httpAttemptCount, 2);

  let calls = 0;
  const unauthorized: FetchLike = async () => { calls += 1; return new Response('private body', { status: 401 }); };
  await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, {
    fetchImpl: unauthorized, budget: new RequestBudget(), wait: async () => undefined
  }), (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'auth_error');
  assert.equal(calls, 1);

  for (const mode of ['network', 'server'] as const) {
    let transientCalls = 0;
    const transient: FetchLike = async () => {
      transientCalls += 1;
      if (mode === 'network') throw new Error('private network detail');
      return new Response('', { status: 503 });
    };
    await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, {
      fetchImpl: transient, budget: new RequestBudget(), wait: async () => undefined
    }), (error: unknown) => error instanceof RunnerFailure && error.failureClass === (mode === 'network' ? 'network_error' : 'server_error'));
    assert.equal(transientCalls, 2);
  }
});

test('HTTP 403 stays unknown without positive proof and supports explicit permission or entitlement evidence', async () => {
  const forbidden: FetchLike = async () => new Response('private body', { status: 403 });
  await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, { fetchImpl: forbidden, budget: new RequestBudget() }),
    (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'unknown');
  for (const expected of ['permission_error', 'entitlement_error'] as const) {
    await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, {
      fetchImpl: forbidden, budget: new RequestBudget(), classifyForbidden: () => expected
    }), (error: unknown) => error instanceof RunnerFailure && error.failureClass === expected);
  }
});

test('HTTP bytes and timeout fail closed without retry or body disclosure', async () => {
  const oversized: FetchLike = async () => new Response('{}', { headers: {
    'content-type': 'application/json', 'content-length': String(HTTP_LIMITS.responseBytes + 1)
  } });
  await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, { fetchImpl: oversized, budget: new RequestBudget() }),
    (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'response_too_large');
  let calls = 0;
  const timeout: FetchLike = async () => { calls += 1; throw new DOMException('private timeout detail', 'TimeoutError'); };
  await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, { fetchImpl: timeout, budget: new RequestBudget() }),
    (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'timeout');
  assert.equal(calls, 1);

  const streamTimeout: FetchLike = async () => new Response(new ReadableStream({
    start(controller) { controller.error(new DOMException('private stream timeout', 'AbortError')); }
  }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, {
    fetchImpl: streamTimeout, budget: new RequestBudget()
  }), (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'timeout');
});

test('HTTP rejects redirects and non-JSON response contracts without following or retrying', async () => {
  let redirectMode: RequestRedirect | undefined;
  let calls = 0;
  const redirect: FetchLike = async (_input, init) => {
    calls += 1;
    redirectMode = init?.redirect;
    return new Response('', { status: 302, headers: { location: 'https://attacker.invalid' } });
  };
  await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, {
    fetchImpl: redirect, budget: new RequestBudget()
  }), (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'invalid_response');
  assert.equal(redirectMode, 'manual');
  assert.equal(calls, 1);

  const html: FetchLike = async () => new Response('{"looks":"json"}', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, {
    fetchImpl: html, budget: new RequestBudget()
  }), (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'invalid_response');
});

test('global deadline and 7/14 counters reject work before an unbounded request', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => { calls += 1; return new Response('', { status: 503 }); };
  const budget = new RequestBudget();
  await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, {
    fetchImpl, budget, deadlineAt: 0, clock: () => 1
  }), (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'timeout');
  assert.equal(calls, 0);
  assert.equal(budget.logicalOperationCount, 1);
  assert.equal(budget.httpAttemptCount, 0);

  const fullBudget = new RequestBudget();
  for (let operation = 0; operation < HTTP_LIMITS.logicalOperations; operation += 1) {
    await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, {
      fetchImpl, budget: fullBudget, wait: async () => undefined
    }), RunnerFailure);
  }
  assert.equal(fullBudget.logicalOperationCount, 7);
  assert.equal(fullBudget.httpAttemptCount, 14);
  await assert.rejects(fetchBoundedJson(new URL('https://example.invalid'), {}, {
    fetchImpl, budget: fullBudget, wait: async () => undefined
  }), RunnerFailure);
  assert.equal(calls, 14);
});

test('closed report rejects extra properties, wrong order, and false aggregation', () => {
  const capabilities = pendingCapabilities();
  const report: CapabilityReport = {
    report_schema_version: REPORT_SCHEMA_VERSION,
    run_id: '123-1',
    provider: 'fugle',
    overall_status: aggregateStatus(capabilities),
    logical_operation_count: 0,
    http_attempt_count: 0,
    capabilities,
    observed_at: '2026-09-02T08:00:00.000Z',
    runner_bundle_version: '0.1.0',
    source_commit_sha: 'a'.repeat(40)
  };
  validateReport(report);
  const line = canonicalReport(report);
  assert.ok(line.startsWith('STOCK_RADAR_CAPABILITY_REPORT={"report_schema_version"'));
  assert.ok(Buffer.byteLength(line) < 32 * 1024);
  assert.throws(() => validateReport({ ...report, extra: true }), RunnerFailure);
  const { run_id: runId, ...rest } = report;
  assert.throws(() => validateReport({ run_id: runId, ...rest }), RunnerFailure);
  assert.throws(() => validateReport({ ...report, overall_status: 'pass' }), RunnerFailure);
});

test('overall aggregation follows security, fail, unknown, degraded, then pass priority', () => {
  const allPass: CapabilityEvidence[] = pendingCapabilities().map((item) => ({ ...item, status: 'pass' }));
  assert.equal(aggregateStatus(allPass), 'pass');
  const degraded = structuredClone(allPass);
  degraded[0]!.status = 'degraded';
  assert.equal(aggregateStatus(degraded), 'degraded');
  const unknown = structuredClone(degraded);
  unknown[1]!.status = 'pending';
  assert.equal(aggregateStatus(unknown), 'unknown');
  const failed = structuredClone(unknown);
  failed[2]!.status = 'fail';
  assert.equal(aggregateStatus(failed), 'fail');
  const security = structuredClone(allPass);
  security[7]!.failure_class = 'security_redaction_failure';
  assert.equal(aggregateStatus(security), 'fail');
});

test('missing secret produces no logical operation or HTTP attempt', async () => {
  const result = await runFugleSmoke({
    apiKey: '',
    sessionDate: '2026-08-28',
    runId: '1000-1',
    sourceCommitSha: 'd'.repeat(40),
    bundleVersion: '0.1.0',
    now: () => new Date('2026-09-02T08:00:00.000Z')
  });
  assert.equal(result.report.logical_operation_count, 0);
  assert.equal(result.report.http_attempt_count, 0);
  assert.equal(result.report.capabilities[0]?.failure_class, 'auth_error');
});
