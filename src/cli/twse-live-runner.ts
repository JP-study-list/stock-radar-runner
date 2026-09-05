import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { completeTwseHandoff, fetchTwseHandoff, type TwseHandoff } from '../twse-runner.js';
import { BUNDLE_VERSION } from '../types.js';

function commonOptions() {
  return {
    sessionDate: process.env.SESSION_DATE ?? '',
    runId: `${process.env.GITHUB_RUN_ID ?? ''}-${process.env.GITHUB_RUN_ATTEMPT ?? ''}`,
    sourceCommitSha: process.env.GITHUB_SHA ?? '',
    bundleVersion: BUNDLE_VERSION
  };
}

function handoffPath(): string {
  const runnerTemp = process.env.RUNNER_TEMP ?? '';
  if (!isAbsolute(runnerTemp)) throw new Error('runner temp unavailable');
  return resolve(runnerTemp, 'stock-radar-twse-handoff.json');
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const path = handoffPath();
  if (mode === 'fetch') {
    const handoff = await fetchTwseHandoff(commonOptions());
    await writeFile(path, JSON.stringify(handoff), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return;
  }
  if (mode !== 'compare') throw new Error('invalid runner mode');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } finally {
    await unlink(path).catch(() => undefined);
  }
  const result = await completeTwseHandoff({
    ...commonOptions(), apiKey: process.env.FUGLE_API_KEY ?? ''
  }, JSON.parse(raw) as TwseHandoff);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) throw new Error('summary path unavailable');
  await appendFile(summaryPath, result.summary, { encoding: 'utf8' });
  process.stdout.write(result.line);
  if (result.report.overall_status !== 'pass') process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('runner failed closed without a TWSE capability report\n');
  process.exitCode = 1;
});
