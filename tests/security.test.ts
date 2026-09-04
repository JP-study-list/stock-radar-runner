import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { runFugleSmoke } from '../src/runner.js';
import type { FetchLike } from '../src/http.js';

test('auth failure does not retry or leak provider body, header, or secret', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return new Response('private-provider-body account=private', { status: 401 });
  };
  const secret = 'security-test-secret';
  const result = await runFugleSmoke({
    apiKey: secret,
    sessionDate: '2026-08-28',
    runId: '999-2',
    sourceCommitSha: 'c'.repeat(40),
    bundleVersion: '0.1.0',
    fetchImpl,
    now: () => new Date('2026-09-02T08:00:00.000Z'),
    wait: async () => undefined
  });
  assert.equal(calls, 1);
  assert.equal(result.report.overall_status, 'fail');
  assert.equal(result.report.capabilities[0]?.failure_class, 'auth_error');
  for (const output of [result.line, result.summary]) {
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes('private-provider-body'));
    assert.ok(!output.includes('account=private'));
    assert.ok(!output.includes('X-API-KEY'));
  }
});

test('workflow statically isolates trust, token, trigger, action, cache, and secret boundaries', async () => {
  const workflow = await readFile(resolve(process.cwd(), '.github/workflows/a0-manual-capability.yml'), 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s*(schedule|pull_request|pull_request_target|workflow_run|push):/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment:\n      name: live-capability/);
  assert.equal((workflow.match(/FUGLE_API_KEY:/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /upload-artifact|download-artifact|actions\/cache|GITHUB_ENV/);
  assert.equal((workflow.match(/npm ci --ignore-scripts --no-audit --no-fund/g) ?? []).length, 2);
  assert.match(workflow, /run: node dist\/src\/cli\/live-runner\.js/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('Fetch, parse, evaluate, redact, and report')), /run: npm run live/);
  for (const match of workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) assert.match(match[1]!, /^[a-f0-9]{40}$/);
});
