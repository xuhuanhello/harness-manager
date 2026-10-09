import { mkdtemp, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store';
import { LibraryService } from '../src/main/library';
async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hm-github-smoke-'));
  const store = new Store(await realpath(directory));
  try {
    const library = new LibraryService(store);
    const scan = await library.scan({ uri: process.argv[2] || 'vercel-labs/agent-skills' });
    const candidate = scan.candidates.find((item) => item.issues.length === 0);
    if (!candidate) throw new Error('No installable skill candidates found.');
    const installed = await library.install({ scanId: scan.id, candidateIds: [candidate.id] });
    if (installed.items.some((item) => item.status === 'error')) throw new Error(JSON.stringify(installed));
    console.log(
      JSON.stringify(
        {
          source: scan.source.label,
          commit: scan.source.commit,
          candidates: scan.candidates.length,
          installed: candidate.name,
          result: installed.items[0].status,
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
