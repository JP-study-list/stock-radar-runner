import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { assertRedacted } from '../src/redaction.js';
import { RunnerFailure } from '../src/failure.js';

test('redaction rejects raw, URL, base64, base64url, hex, and hashed secret transformations', () => {
  const secret = 'private-test-key/with+symbols';
  const variants = [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
    Buffer.from(secret).toString('base64url'),
    Buffer.from(secret).toString('hex'),
    createHash('sha256').update(secret).digest('hex')
  ];
  for (const variant of variants) {
    assert.throws(() => assertRedacted(`output=${variant}`, secret),
      (error: unknown) => error instanceof RunnerFailure && error.failureClass === 'security_redaction_failure');
  }
});

test('redaction rejects credential labels and permits closed evidence vocabulary', () => {
  for (const value of ['X-API-KEY: value', 'Authorization: Bearer value', 'cookie=value', 'token=value']) {
    assert.throws(() => assertRedacted(value, 'different-secret'), RunnerFailure);
  }
  assert.doesNotThrow(() => assertRedacted('STOCK_RADAR_CAPABILITY_REPORT={"provider":"fugle","status":"unknown"}', 'different-secret'));
  assert.throws(() => assertRedacted('x', 'x'), RunnerFailure);
});
