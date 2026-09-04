import assert from 'node:assert/strict';
import test from 'node:test';
import { RunnerFailure } from '../src/failure.js';
import { parseFugleEvidence } from '../src/fugle.js';
import { DATA_PROBES } from '../src/types.js';
import { fixtureMap } from './helpers.js';

test('synthetic fixtures cover TWSE, TPEx, ETF, 1d, 5m, raw, and adjusted evidence', async () => {
  const fixtures = await fixtureMap();
  const keys = ['2330-D-raw', '6488-D-raw', '0050-D-raw', '2330-5-raw', '6488-5-raw', '0050-5-raw', '2330-D-adjusted'];
  DATA_PROBES.forEach((probe, index) => {
    const body = fixtures[keys[index]!]!;
    const evidence = parseFugleEvidence({ body, responseBytes: 512, attempts: 1, rateLimitHeaderObserved: index === 0 }, probe, '2026-08-28');
    assert.equal(evidence.status, 'pass');
    assert.equal(evidence.evidence.source_volume_unit, probe.timeframe === 'D' ? 'share' : 'lot');
    assert.equal(evidence.evidence.adjustment, probe.adjustment);
  });
});

test('fixture parser degrades suspected gaps and rejects missing fields, invalid adjustment, and record overflow', async () => {
  const fixtures = await fixtureMap();
  const gap = structuredClone(fixtures['2330-5-raw']!);
  (gap.data as Array<Record<string, unknown>>)[1]!.date = '2026-08-28T09:15:00.000+08:00';
  const degraded = parseFugleEvidence({ body: gap, responseBytes: 512, attempts: 1, rateLimitHeaderObserved: false }, DATA_PROBES[3]!, '2026-08-28');
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.failure_class, 'data_gap');

  const missing = structuredClone(fixtures['2330-D-raw']!);
  delete (missing.data as Array<Record<string, unknown>>)[0]!.volume;
  assert.throws(() => parseFugleEvidence({ body: missing, responseBytes: 512, attempts: 1, rateLimitHeaderObserved: false }, DATA_PROBES[0]!, '2026-08-28'), RunnerFailure);

  assert.throws(() => parseFugleEvidence({ body: fixtures['2330-D-raw'], responseBytes: 512, attempts: 1, rateLimitHeaderObserved: false }, DATA_PROBES[6]!, '2026-08-28'),
    (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'schema_error');

  const overflow = structuredClone(fixtures['2330-D-raw']!);
  overflow.data = Array.from({ length: 101 }, () => (overflow.data as unknown[])[0]);
  assert.throws(() => parseFugleEvidence({ body: overflow, responseBytes: 1024, attempts: 1, rateLimitHeaderObserved: false }, DATA_PROBES[0]!, '2026-08-28'),
    (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'record_limit_exceeded');

  const offGrid = structuredClone(fixtures['2330-5-raw']!);
  (offGrid.data as Array<Record<string, unknown>>)[0]!.date = '2026-08-28T09:03:00.000+08:00';
  assert.throws(() => parseFugleEvidence({ body: offGrid, responseBytes: 512, attempts: 1, rateLimitHeaderObserved: false }, DATA_PROBES[3]!, '2026-08-28'),
    (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'schema_error');
});
