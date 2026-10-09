import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Controller } from '../src/main/controller';
import type { ApplyRequest, BatchResult, Harness, ScanResult } from '../src/shared/types';

/**
 * Times the main planning and write paths against a synthetic library.
 * Usage: npm run bench -- --skills=200 --harnesses=3
 */
function option(name: string, fallback: number): number {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  const parsed = match ? Number(match.split('=')[1]) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

async function timed<T>(results: Record<string, number>, label: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await run();
  results[label] = Math.round(performance.now() - started);
  return value;
}

async function main() {
  const skillCount = option('skills', 200);
  const harnessCount = option('harnesses', 3);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hm-bench-')));
  // Keep built-in Harness paths inside the sandbox instead of the developer's real home.
  process.env.HOME = path.join(root, 'home');
  await mkdir(process.env.HOME);
  const controller = new Controller(path.join(root, 'library'), () => {}, { watch: false });
  const results: Record<string, number> = {};
  try {
    await controller.initialize();
    const sourceRoot = path.join(root, 'source');
    for (let index = 0; index < skillCount; index += 1) {
      const name = `bench-skill-${index}`;
      const directory = path.join(sourceRoot, name);
      await mkdir(path.join(directory, 'references'), { recursive: true });
      await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Benchmark skill ${index}\n---\n# ${name}\n`);
      await writeFile(path.join(directory, 'references', 'notes.md'), `Reference material for ${name}.\n`.repeat(50));
    }
    const scan = (await controller.invoke('scan', { uri: sourceRoot })) as ScanResult;
    const installed = (await timed(results, 'install', () =>
      controller.invoke('install', { scanId: scan.id, candidateIds: scan.candidates.map((item) => item.id) }),
    )) as BatchResult;
    const harnessIds: string[] = [];
    for (let index = 0; index < harnessCount; index += 1) {
      const harness = (await controller.invoke('saveHarness', {
        name: `Bench Harness ${index}`,
        userSkillsPath: path.join(root, 'targets', `harness-${index}`),
        workspaceSkillsRelativePath: '',
      })) as Harness;
      harnessIds.push(harness.id);
    }
    const request: ApplyRequest = { skillIds: installed.skillIds ?? [], harnessIds, scope: 'user', strategy: 'symlink' };
    await timed(results, 'previewApply (fresh)', () => controller.invoke('previewApply', request));
    const applied = (await timed(results, 'apply (fresh)', () => controller.invoke('apply', request))) as BatchResult;
    if (applied.items.some((item) => item.status === 'error')) throw new Error('Benchmark apply reported errors.');
    await timed(results, 'previewApply (installed)', () => controller.invoke('previewApply', request));
    await timed(results, 'apply (installed)', () => controller.invoke('apply', request));
    await timed(results, 'snapshot', () => controller.snapshot());
    await timed(results, 'checkHealth', () => controller.invoke('checkHealth', undefined));
    console.log(
      JSON.stringify({ skills: skillCount, harnesses: harnessCount, distributions: skillCount * harnessCount, ms: results }, null, 2),
    );
  } finally {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
