import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSelectedSession } from '../runner.js';

async function main(): Promise<void> {
  const selected = await loadSelectedSession(
    resolve(process.cwd(), 'calendar/tw-sessions-2026-09-v1.json'),
    new Date(),
    process.env.SESSION_DATE
  );
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is unavailable');
  await appendFile(output, `session_date=${selected}\n`, { encoding: 'utf8' });
}

main().catch(() => {
  process.stderr.write('calendar gate failed closed\n');
  process.exitCode = 1;
});
