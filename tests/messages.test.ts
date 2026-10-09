import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { appError, type MessageCode, message } from '../src/main/messages';
import { AppError } from '../src/shared/errors';

const CJK = /[㐀-鿿]/;
const STANDALONE_TEMPLATES: MessageCode[] = [
  'INSTALL_CANDIDATE_INVALID',
  'ENTRY_NOT_OWNED',
  'APPLY_TARGET_CONFLICT',
  'MIGRATION_SOURCE_INVALID',
];

it('renders every message in Chinese', async () => {
  const source = await readFile(path.join('src', 'main', 'messages.ts'), 'utf8');
  const codes = [...source.matchAll(/^ {2}([A-Z][A-Z0-9_]+): /gm)].map((match) => match[1] as MessageCode);
  expect(codes.length).toBeGreaterThan(300);
  const sample = new Proxy({}, { get: (_target, key) => (key === 'reason' ? '原因' : `${String(key)}`) }) as never;
  for (const code of codes) {
    if (STANDALONE_TEMPLATES.includes(code)) continue; // Pass-through wrappers around an already-translated reason.
    const text = (message as (code: MessageCode, params: never) => string)(code, sample);
    expect(text, code).toMatch(CJK);
  }
});

it('creates coded application errors', () => {
  const error = appError('SCAN_EXPIRED');
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code: 'SCAN_EXPIRED', message: '扫描结果已过期，请重新扫描来源后再导入。' });
});

it('throws only coded errors from the main process', async () => {
  const directory = path.join('src', 'main');
  const offenders: string[] = [];
  for (const name of await readdir(directory)) {
    // The preload rethrows an already-coded error received over IPC.
    if (!name.endsWith('.ts') || name === 'preload.ts') continue;
    const text = await readFile(path.join(directory, name), 'utf8');
    if (/new Error\(/.test(text)) offenders.push(name);
  }
  expect(offenders).toEqual([]);
});
