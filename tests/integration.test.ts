import assert from 'node:assert/strict';
import test from 'node:test';
import { runFugleSmoke } from '../src/runner.js';
import { RunnerFailure } from '../src/failure.js';
import { validateReport } from '../src/report.js';
import { fixtureFetch, fixtureMap } from './helpers.js';

test('manual session flows through exactly seven bounded fixture operations into canonical public evidence', async () => {
  const requests: URL[] = [];
  const result = await runFugleSmoke({
    apiKey: 'synthetic-test-key-never-publish',
    sessionDate: '2026-08-28',
    runId: '12345-1',
    sourceCommitSha: 'b'.repeat(40),
    bundleVersion: '0.1.0',
    fetchImpl: fixtureFetch(await fixtureMap(), requests),
    now: () => new Date('2026-09-02T08:00:00.000Z'),
    wait: async () => undefined
  });
  assert.equal(result.report.overall_status, 'pass');
  assert.equal(result.report.logical_operation_count, 7);
  assert.equal(result.report.http_attempt_count, 7);
  assert.equal(requests.length, 7);
  assert.deepEqual(new Set(requests.map((url) => url.searchParams.get('from'))), new Set(['2026-08-28']));
  assert.equal(requests.filter((url) => url.searchParams.get('adjusted') === 'true').length, 1);
  assert.ok(result.line.endsWith('\n'));
  assert.equal(result.line.split('\n').filter(Boolean).length, 1);
  assert.ok(!result.line.includes('synthetic-test-key-never-publish'));
  assert.ok(!result.summary.includes('synthetic-test-key-never-publish'));

  const tampered = structuredClone(result.report);
  tampered.capabilities[0]!.evidence.adjustment = 'adjusted';
  assert.throws(() => validateReport(tampered), RunnerFailure);
});
