import { createHash } from 'node:crypto';
import { RunnerFailure } from './failure.js';

function encodings(secret: string): string[] {
  const utf8 = Buffer.from(secret, 'utf8');
  const derived = [
    encodeURIComponent(secret),
    utf8.toString('base64'),
    utf8.toString('base64url'),
    utf8.toString('hex'),
    createHash('sha256').update(secret).digest('hex')
  ].filter((value, index, values) => value.length >= 4 && values.indexOf(value) === index && value !== secret);
  return [secret, ...derived];
}

export function assertRedacted(output: string, secret: string): void {
  const lower = output.toLowerCase();
  const forbiddenPatterns = [
    /x-api-key/i,
    /authorization/i,
    /set-cookie/i,
    /cookie/i,
    /(?:api[_-]?key|token|secret|credential)\s*[:=]/i,
    /https?:\/\/[^\s]*[?&](?:api[_-]?key|token|secret)=/i
  ];
  if (forbiddenPatterns.some((pattern) => pattern.test(output))) throw new RunnerFailure('security_redaction_failure');
  if (secret.length > 0 && encodings(secret).some((value) => lower.includes(value.toLowerCase()))) {
    throw new RunnerFailure('security_redaction_failure');
  }
}
