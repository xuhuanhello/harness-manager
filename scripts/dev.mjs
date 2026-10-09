import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
await import('./build-main.mjs');
const server = await createServer();
await server.listen();
const env = { ...process.env, HARNESS_DEV_URL: server.resolvedUrls.local[0] };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill());
