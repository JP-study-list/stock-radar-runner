import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { RunnerFailure } from '../src/failure.js';
import { compareDailyValues, parseTwseDailyEvidence } from '../src/twse.js';

async function fixture(): Promise<{ twse: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(resolve(process.cwd(), 'tests/fixtures/twse-synthetic-valid.json'), 'utf8')) as { twse: Array<Record<string, unknown>> };
}

function bounded(body: unknown) {
  return { body, responseBytes: 1_024, attempts: 1, rateLimitHeaderObserved: false };
}

test('TWSE fixture selects only 2330 and 0050 and normalizes ROC date, decimals, and share volume', async () => {
  const source = await fixture();
  const result = parseTwseDailyEvidence(bounded(source.twse), '2026-08-28');
  assert.deepEqual(result.capabilities.map((item) => [item.symbol, item.status]), [['TW:2330', 'pass'], ['TW:0050', 'pass']]);
  assert.deepEqual(result.values.get('TW:2330'), { open: '100', high: '102', low: '99', close: '101', volume: '30000000' });
  assert.equal(JSON.stringify(result.capabilities).includes('ClosingPrice'), false);
});

test('TWSE fixture fails closed for stale, missing, duplicate, and oversized target data', async () => {
  const source = await fixture();
  const stale = structuredClone(source.twse);
  stale[0]!.Date = '1150827';
  const staleEvidence = parseTwseDailyEvidence(bounded(stale), '2026-08-28').capabilities[0]!;
  assert.equal(staleEvidence.failure_class, 'stale_data');
  assert.equal(staleEvidence.evidence.freshness, 'stale');
  assert.equal(staleEvidence.evidence.session_date, '2026-08-27');

  const missing = source.twse.filter((row) => row.Code !== '0050');
  assert.equal(parseTwseDailyEvidence(bounded(missing), '2026-08-28').capabilities[1]?.failure_class, 'not_found');

  const duplicate = [...source.twse, structuredClone(source.twse[0]!)];
  assert.equal(parseTwseDailyEvidence(bounded(duplicate), '2026-08-28').capabilities[0]?.failure_class, 'schema_error');

  assert.throws(() => parseTwseDailyEvidence(bounded(Array.from({ length: 5_001 }, () => ({ Code: '9999' }))), '2026-08-28'),
    (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'record_limit_exceeded');
});

test('cross-source comparison reports only ordered field names and mismatch count', () => {
  const official = { open: '100', high: '102', low: '99', close: '101', volume: '30000000' };
  const same = compareDailyValues(official, { ...official });
  assert.deepEqual(same.matchedFields, ['open', 'high', 'low', 'close', 'volume']);
  assert.deepEqual(same.mismatchFields, []);
  const different = compareDailyValues(official, { ...official, close: '100', volume: '1' });
  assert.deepEqual(different.mismatchFields, ['close', 'volume']);
});
