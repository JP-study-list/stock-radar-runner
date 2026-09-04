import { appendFile } from 'node:fs/promises';
import { runFugleSmoke } from '../runner.js';
import { BUNDLE_VERSION } from '../types.js';

async function main(): Promise<void> {
  const result = await runFugleSmoke({
    apiKey: process.env.FUGLE_API_KEY ?? '',
    sessionDate: process.env.SESSION_DATE ?? '',
    runId: `${process.env.GITHUB_RUN_ID ?? ''}-${process.env.GITHUB_RUN_ATTEMPT ?? ''}`,
    sourceCommitSha: process.env.GITHUB_SHA ?? '',
    bundleVersion: BUNDLE_VERSION
  });
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) throw new Error('summary path unavailable');
  await appendFile(summaryPath, result.summary, { encoding: 'utf8' });
  process.stdout.write(result.line);
  if (result.report.overall_status !== 'pass') process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('runner failed closed without a capability report\n');
  process.exitCode = 1;
});
