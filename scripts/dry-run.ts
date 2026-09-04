import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const root = process.cwd();
const workflowPath = resolve(root, '.github/workflows/a0-manual-capability.yml');

function invariant(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`dry-run invariant failed: ${label}`);
}

async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['dist', 'node_modules', '.git'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`dry-run invariant failed: symbolic link is not publishable: ${entry.name}`);
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else output.push(relative(root, path).replaceAll('\\', '/'));
  }
  return output.sort();
}

async function main(): Promise<void> {
  const workflow = await readFile(workflowPath, 'utf8');
  invariant(/^on:\n  workflow_dispatch:/m.test(workflow), 'workflow_dispatch is the only trigger');
  invariant(!/^\s*(?:schedule|pull_request|pull_request_target|workflow_run|push):/m.test(workflow), 'no additional trigger');
  invariant(/^permissions:\n  contents: read$/m.test(workflow), 'token is contents read only');
  invariant(/group: stock-radar-a0-live-capability\n  cancel-in-progress: false/.test(workflow), 'bounded concurrency preserves running run');
  invariant(/if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' \}\}/.test(workflow), 'trusted main guard');
  invariant(/timeout-minutes: 3\n    environment:\n      name: live-capability/.test(workflow), 'live timeout and environment');
  invariant(!/uses: .*@(?![a-f0-9]{40}(?:\s|#|$))/.test(workflow), 'actions use full commit SHA');
  invariant((workflow.match(/uses: actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/g) ?? []).length === 2, 'reviewed checkout pin');
  invariant((workflow.match(/uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/g) ?? []).length === 2, 'reviewed setup-node pin');
  invariant((workflow.match(/persist-credentials: false/g) ?? []).length === 2, 'checkout credentials disabled');
  invariant((workflow.match(/package-manager-cache: false/g) ?? []).length === 2 && !/uses: actions\/cache@/.test(workflow), 'cache disabled');
  invariant((workflow.match(/npm ci --ignore-scripts --no-audit --no-fund/g) ?? []).length === 2, 'install scripts disabled');
  invariant(!/(?:upload-artifact|download-artifact|GITHUB_ENV)/.test(workflow), 'no artifact or persistent environment output');
  invariant(!/^env:/m.test(workflow) && !/^    env:/m.test(workflow), 'no workflow-level or job-level env');

  const secretMatches = [...workflow.matchAll(/FUGLE_API_KEY:/g)];
  invariant(secretMatches.length === 1, 'one secret injection');
  const liveSteps = workflow.slice(workflow.indexOf('  live:'));
  const secretStep = liveSteps.indexOf('      - name: Fetch, parse, evaluate, redact, and report');
  invariant(secretStep >= 0 && !/\n      - name:/.test(liveSteps.slice(secretStep + 8)), 'secret-bearing step is last');
  invariant(/run: node dist\/src\/cli\/live-runner\.js/.test(liveSteps.slice(secretStep)), 'secret step invokes Node entrypoint directly');

  const manifest = JSON.parse(await readFile(resolve(root, 'publication-allowlist.json'), 'utf8')) as unknown;
  invariant(Array.isArray(manifest) && manifest.every((item) => typeof item === 'string'), 'allowlist shape');
  const actual = await files(root);
  invariant(JSON.stringify(actual) === JSON.stringify([...manifest].sort()), 'publication allowlist exact match');
  invariant(!actual.some((path) => /(^|\/)LICENSE(?:\.|$)/i.test(path)), 'all rights reserved has no open-source license');

  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  invariant(!('dependencies' in packageJson), 'no runtime dependencies');
  invariant(!Object.keys((packageJson.scripts ?? {}) as Record<string, unknown>).some((name) => /^(?:pre|post)?install$/.test(name)), 'no install script');
  const bundleVersion = JSON.parse(await readFile(resolve(root, 'bundle-version.json'), 'utf8')) as Record<string, unknown>;
  invariant(bundleVersion.runner_bundle_version === packageJson.version, 'bundle and package versions match');
  invariant(bundleVersion.report_schema_version === 'public-runner-capability-v1', 'bundle report schema is reviewed');
  const typesSource = await readFile(resolve(root, 'src/types.ts'), 'utf8');
  invariant(typesSource.includes(`BUNDLE_VERSION = '${String(packageJson.version)}'`), 'runtime bundle version matches metadata');
  const lockfile = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { resolved?: unknown; integrity?: unknown }> };
  invariant(lockfile.packages !== undefined, 'lockfile package map');
  for (const [name, item] of Object.entries(lockfile.packages)) {
    if (name === '') continue;
    invariant(typeof item.resolved === 'string' && item.resolved.startsWith('https://registry.npmjs.org/'), `locked npm origin: ${name}`);
    invariant(typeof item.integrity === 'string' && item.integrity.startsWith('sha512-'), `locked integrity: ${name}`);
  }

  const sensitive = [
    new RegExp(`/${'Users'}/`),
    new RegExp(['private', 'stock', 'radar'].join('-')),
    /github\.com\/[A-Za-z0-9_.-]+\/stock-radar/i,
    /FUGLE_API_KEY\s*[=:]\s*["'][^"'$]/
  ];
  for (const path of actual) {
    const content = await readFile(resolve(root, path), 'utf8');
    invariant(!sensitive.some((pattern) => pattern.test(content)), `sensitive publication scan: ${path}`);
  }
  process.stdout.write('public-runner dry-run passed\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'dry-run failed'}\n`);
  process.exitCode = 1;
});
