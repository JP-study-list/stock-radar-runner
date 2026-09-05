import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import type { FetchLike } from '../src/http.js';
import { runTwseSmoke } from '../src/twse-runner.js';
import { fixtureKey, fixtureMap } from './helpers.js';

async function twseFixture(): Promise<Array<Record<string, unknown>>> {
  const value = JSON.parse(await readFile(resolve(process.cwd(), 'tests/fixtures/twse-synthetic-valid.json'), 'utf8')) as { twse: Array<Record<string, unknown>> };
  return value.twse;
}

test('TWSE manual session uses exactly one official request and two same-session Fugle comparisons', async () => {
  const fugle = await fixtureMap();
  const twse = await twseFixture();
  const requests: URL[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requests.push(url);
    if (url.hostname === 'openapi.twse.com.tw') {
      assert.equal((init?.headers as Record<string, string>)['X-API-KEY'], undefined);
      return Response.json(twse);
    }
    assert.equal((init?.headers as Record<string, string>)['X-API-KEY'], 'synthetic-comparison-key');
    return Response.json(fugle[fixtureKey(url)]);
  };
  const result = await runTwseSmoke({
    apiKey: 'synthetic-comparison-key', sessionDate: '2026-08-28', runId: '3000-1',
    sourceCommitSha: 'f'.repeat(40), bundleVersion: '0.2.0', fetchImpl,
    now: () => new Date('2026-09-04T08:00:00.000Z'), wait: async () => undefined
  });
  assert.equal(result.report.overall_status, 'pass');
  assert.equal(result.report.logical_operation_count, 3);
  assert.equal(result.report.http_attempt_count, 3);
  assert.equal(requests.filter((url) => url.hostname === 'openapi.twse.com.tw').length, 1);
  assert.deepEqual(requests.filter((url) => url.hostname === 'api.fugle.tw').map((url) => url.pathname.split('/').at(-1)), ['2330', '0050']);
  assert.ok(result.report.comparisons.every((item) => item.status === 'pass' && item.evidence.mismatch_count === 0));
  for (const output of [result.line, result.summary]) {
    assert.ok(!output.includes('synthetic-comparison-key'));
    assert.ok(!output.includes('50.5000'));
    assert.ok(!output.includes('30,000,000'));
  }
});

test('TWSE comparison degrades with field names only and missing secret makes no Fugle request', async () => {
  const fugle = await fixtureMap();
  const twse = await twseFixture();
  const changed = structuredClone(fugle);
  ((changed['2330-D-raw']!.data as Array<Record<string, unknown>>)[0]!).close = 100;
  const mismatchFetch: FetchLike = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return url.hostname === 'openapi.twse.com.tw' ? Response.json(twse) : Response.json(changed[fixtureKey(url)]);
  };
  const degraded = await runTwseSmoke({
    apiKey: 'synthetic-comparison-key', sessionDate: '2026-08-28', runId: '3001-1',
    sourceCommitSha: 'f'.repeat(40), bundleVersion: '0.2.0', fetchImpl: mismatchFetch,
    now: () => new Date('2026-09-04T08:00:00.000Z')
  });
  assert.equal(degraded.report.overall_status, 'degraded');
  assert.deepEqual(degraded.report.comparisons[0]?.evidence.mismatch_fields, ['close']);
  assert.equal(degraded.report.comparisons[0]?.failure_class, 'cross_source_mismatch');

  let calls = 0;
  const noSecret = await runTwseSmoke({
    apiKey: '', sessionDate: '2026-08-28', runId: '3002-1', sourceCommitSha: 'f'.repeat(40),
    bundleVersion: '0.2.0', fetchImpl: async () => { calls += 1; return Response.json(twse); },
    now: () => new Date('2026-09-04T08:00:00.000Z')
  });
  assert.equal(calls, 1);
  assert.equal(noSecret.report.logical_operation_count, 1);
  assert.ok(noSecret.report.comparisons.every((item) => item.failure_class === 'auth_error'));
});
