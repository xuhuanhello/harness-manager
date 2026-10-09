import { execFile } from 'node:child_process';
import path from 'node:path';
import spawn from 'cross-spawn';
import type { ExecuteFileOptions } from './harness-installation';
import { appError } from './messages';

/** Windows environment keys are case insensitive; duplicate PATH spellings confuse child processes. */
export function windowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase() && env[key] !== undefined);
  return key ? env[key] : undefined;
}

export function windowsPathEntries(value: string, env: NodeJS.ProcessEnv): string[] {
  return value
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
    .map((entry) => entry.replace(/%([A-Za-z0-9_]+)%/g, (original, name: string) => windowsEnv(env, name) ?? original));
}

export function windowsBinaryDirectories(home: string, env: NodeJS.ProcessEnv): string[] {
  const local = windowsEnv(env, 'LOCALAPPDATA') || path.join(home, 'AppData', 'Local');
  const roaming = windowsEnv(env, 'APPDATA') || path.join(home, 'AppData', 'Roaming');
  const programFiles = windowsEnv(env, 'ProgramFiles') || 'C:\\Program Files';
  const directories = [
    path.join(home, '.local', 'bin'),
    path.join(local, 'Programs', 'claude'),
    path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'),
    path.join(roaming, 'npm'),
    path.join(home, '.npm-global'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.grok', 'bin'),
    path.join(home, 'scoop', 'shims'),
    path.join(local, 'pnpm'),
    path.join(local, 'Volta', 'bin'),
    path.join(local, 'Yarn', 'bin'),
    path.join(programFiles, 'nodejs'),
  ];
  for (const variable of ['PNPM_HOME', 'NVM_SYMLINK', 'NPM_CONFIG_PREFIX', 'UV_TOOL_BIN_DIR', 'CODEX_INSTALL_DIR']) {
    const value = windowsEnv(env, variable);
    if (value) directories.push(value);
  }
  for (const [variable, child] of [
    ['VOLTA_HOME', 'bin'],
    ['SCOOP', 'shims'],
    ['SCOOP_GLOBAL', 'shims'],
  ] as const) {
    const value = windowsEnv(env, variable);
    if (value) directories.push(path.join(value, child));
  }
  return directories;
}

/** npm's .cmd launchers need cmd.exe. cross-spawn handles its quoting, with bounded output and tree cleanup. */
export function runWindowsBatch(file: string, args: string[], options: ExecuteFileOptions): Promise<{ stdout: string; stderr: string }> {
  // cmd.exe does not accept the verbatim prefixes returned by some Windows file pickers/canonicalizers.
  if (file.startsWith('\\\\?\\UNC\\')) file = `\\\\${file.slice(8)}`;
  else if (file.startsWith('\\\\?\\')) file = file.slice(4);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    let terminationError: Error | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (error) reject(Object.assign(error, output));
      else resolve(output);
    };
    const stop = (code: 'INSTALLATION_COMMAND_TIMEOUT' | 'INSTALLATION_COMMAND_OUTPUT_LIMIT') => {
      if (settled || terminationError) return;
      terminationError = Object.assign(appError(code), { killed: true });
      clearTimeout(timer);
      if (child.pid) {
        const system = windowsEnv(options.env, 'SystemRoot') || 'C:\\Windows';
        execFile(
          path.join(system, 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          {
            windowsHide: true,
            timeout: 1000,
          },
          () => {
            child.kill();
            finish(terminationError);
          },
        );
      } else {
        child.kill();
        finish(terminationError);
      }
    };
    const timer = setTimeout(() => stop('INSTALLATION_COMMAND_TIMEOUT'), options.timeout);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || terminationError) return;
      stdoutSize += chunk.length;
      if (stdoutSize > options.maxBuffer) stop('INSTALLATION_COMMAND_OUTPUT_LIMIT');
      else stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled || terminationError) return;
      stderrSize += chunk.length;
      if (stderrSize > options.maxBuffer) stop('INSTALLATION_COMMAND_OUTPUT_LIMIT');
      else stderr.push(chunk);
    });
    child.on('error', finish);
    child.on('close', (code) =>
      finish(terminationError ?? (code === 0 ? undefined : Object.assign(appError('INSTALLATION_COMMAND_FAILED'), { exitCode: code }))),
    );
  });
}
