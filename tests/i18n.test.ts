import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { Controller } from '../src/main/controller';
import { message } from '../src/main/messages';
import { harnessDisplayName } from '../src/shared/harness-registry';
import { en } from '../src/shared/i18n/en';
import {
  compareNames,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  resolveLocale,
  setLocaleResolver,
  translate,
  type Locale,
  type MessageKey,
  formatCount,
  countUnit,
  formatList,
  quote,
  interpolateParts,
  translationTemplate,
} from '../src/shared/i18n';
import { zhCN } from '../src/shared/i18n/zh-CN';

const placeholders = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
it('keeps every namespace, key, and placeholder identical in both dictionaries', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  for (const namespace of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
    expect(Object.keys(en[namespace]).sort(), namespace).toEqual(Object.keys(zhCN[namespace]).sort());
    for (const [key, value] of Object.entries(zhCN[namespace])) {
      const valueOrFunction = (en[namespace] as Record<string, string | ((params: Record<string, string>) => string)>)[key];
      const english =
        typeof valueOrFunction === 'function'
          ? valueOrFunction(new Proxy({}, { get: (_target, key) => `{${String(key)}}` }))
          : valueOrFunction;
      expect(english.trim(), `${namespace}.${key}`).not.toBe('');
      expect(placeholders(english), `${namespace}.${key}`).toEqual(placeholders(value));
    }
  }
});

it('uses the first preferred system language and explicit overrides', () => {
  expect(resolveLocale('system', ['zh-Hans-CN', 'en-US'])).toBe('zh-CN');
  expect(resolveLocale(undefined, ['zh-TW'])).toBe('zh-CN');
  expect(resolveLocale('system', ['en-US', 'zh-CN'])).toBe('en');
  expect(resolveLocale('system', [])).toBe('en');
  expect(resolveLocale('en', ['zh-CN'])).toBe('en');
  expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
});

it('interpolates values literally and formats numbers, dates, and relative time in the current language', () => {
  let locale: Locale = 'en';
  setLocaleResolver(() => locale);
  expect(translate('en', 'errors.HARNESS_NOT_FOUND', { id: '$& {name}' })).toBe('Harness $& {name} does not exist.');
  expect(translate('en', 'library.appliedDestinationCount', { count: 1 })).toBe('Applied to 1 destination');
  expect(translate('en', 'library.appliedDestinationCount', { count: 2 })).toBe('Applied to 2 destinations');
  expect(formatNumber(12345)).toBe(new Intl.NumberFormat('en').format(12345));
  expect(formatRelativeTime(-1, 'day')).toBe('yesterday');
  const date = new Date('2026-01-01T12:34:00Z');
  expect(formatDateTime(date, { month: 'long' })).toBe(new Intl.DateTimeFormat('en', { month: 'long' }).format(date));
  const ordering = compareNames('tool2', 'tool10');
  locale = 'zh-CN';
  expect(formatRelativeTime(-1, 'day')).toBe('昨天');
  expect(compareNames('tool2', 'tool10')).toBe(ordering);
});

it('resolves stale built-in names by ID while preserving custom user data', () => {
  setLocaleResolver(() => 'en');
  expect(harnessDisplayName({ id: 'universal', origin: 'builtin', name: '旧的中文名字' })).toBe('Universal Agents skills');
  expect(harnessDisplayName({ id: 'claude-code', origin: 'builtin', name: '旧的中文名字' })).toBe('Claude Code');
  expect(harnessDisplayName({ id: 'my-agent', origin: 'custom', name: '用户自己的名称' })).toBe('用户自己的名称');
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('defaults old settings to system, persists changes, and produces later main-process messages in the saved language', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-locale-'));
  roots.push(root);
  let app = new Controller(root, () => {}, { watch: false });
  setLocaleResolver(() => resolveLocale(app.store.get<{ locale?: 'system' | Locale }>('settings', 'ui')?.locale, ['zh-CN']));
  try {
    expect((await app.snapshot()).settings.locale).toBe('system');
    expect(message('UNKNOWN_ERROR')).toBe('未知错误');
    await app.invoke('saveSettings', { locale: 'en' });
    expect(message('UNKNOWN_ERROR')).toBe('Unknown error');
    await expect(app.invoke('saveSettings', { locale: 'fr' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const invalid = await app.invoke('saveSettings', { locale: 'fr' }).catch((error: Error) => error.message);
    expect(invalid).toMatch(/Invalid/);
    await app.close();
    app = new Controller(root, () => {}, { watch: false });
    expect((await app.snapshot()).settings.locale).toBe('en');
    expect(message('UNKNOWN_ERROR')).toBe('Unknown error');
    await app.invoke('saveSettings', { locale: 'system' });
    expect(message('UNKNOWN_ERROR')).toBe('未知错误');
  } finally {
    await app.close();
  }
});

// These expressions recognize unmodified external errors in either language. They are not UI copy.
const CJK_LITERAL_ALLOWLIST = [
  {
    file: 'src/renderer/components/MarketplaceCatalog.tsx',
    text: '/429|rate.?limit|too many|频繁|限流/i',
    reason: 'Recognizes upstream rate-limit errors.',
  },
  {
    file: 'src/renderer/components/MarketplaceCatalog.tsx',
    text: '/network|fetch|timeout|offline|econn|socket|connect|网络|连接/i',
    reason: 'Recognizes upstream network errors.',
  },
  {
    file: 'src/renderer/components/MigrationPanels.tsx',
    text: '/修复未|修复没有完成|repair failed|repair did not complete/.test(value)',
    reason: 'Recognizes external and historical repair failures.',
  },
];
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef\u201c\u201d]/u;
it('has no untranslated CJK literals in renderer or main outside the documented allowlist', async () => {
  const offenders: string[] = [];
  const used = new Set<string>();
  for (const directory of ['src/renderer', 'src/main']) {
    for (const name of await readdir(directory, { recursive: true })) {
      if (!/\.(?:tsx?|css|html)$/.test(name) || /(?:^|\/)i18n\/|\.test\./.test(name)) continue;
      const file = `${directory}/${name}`;
      const source = await readFile(file, 'utf8');
      if (/\.(?:css|html)$/.test(name)) {
        if (cjk.test(source.replace(/\/\*.*?\*\/|<!--.*?-->/gs, ''))) offenders.push(file);
        continue;
      }
      const ast = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      function visit(node: ts.Node) {
        if (
          ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node) ||
          ts.isJsxText(node) ||
          ts.isRegularExpressionLiteral(node)
        ) {
          const literal = node.getText(ast);
          if (cjk.test(literal)) {
            const allowed = CJK_LITERAL_ALLOWLIST.find((entry) => entry.file === file && entry.text.startsWith(literal));
            if (allowed) used.add(allowed.file + allowed.text);
            else offenders.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${literal}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  expect(offenders).toEqual([]);
  expect(used.size).toBe(CJK_LITERAL_ALLOWLIST.length);
});

it.each([0, 1, 2])('uses English singular/plural agreement for every count noun at %i', (count) => {
  setLocaleResolver(() => 'en');
  const nouns = ['item', 'skill', 'destination', 'source', 'group', 'installation', 'repository', 'update', 'copy', 'reference'] as const;
  const plurals = [
    'items',
    'skills',
    'destinations',
    'sources',
    'groups',
    'installations',
    'repositories',
    'updates',
    'copies',
    'references',
  ];
  for (const [index, noun] of nouns.entries()) {
    const expected = count === 1 ? noun : plurals[index];
    expect(countUnit(count, noun)).toBe(expected);
    expect(formatCount(count, noun)).toBe(`${count} ${expected}`);
  }
  expect(translate('en', 'dialogs.unapplySummary', { count, harnessName: 'Claude Code' })).toBe(
    `Unapply ${count} ${count === 1 ? 'skill' : 'skills'} from Claude Code`,
  );
  expect(translate('en', 'dialogs.unapplyCount', { count })).toBe(`Unapply ${count} ${count === 1 ? 'skill' : 'skills'}`);
  expect(translate('en', 'library.itemCount', { count })).toBe(`${count} ${count === 1 ? 'item' : 'items'}`);
});

it.each([0, 1, 2])('checks all function-based English count templates at %i', (count) => {
  let checked = 0;
  for (const [namespace, entries] of Object.entries(en)) {
    for (const [key, entry] of Object.entries(entries)) {
      if (typeof entry !== 'function') continue;
      const id = `${namespace}.${key}` as MessageKey;
      const source = (zhCN[namespace as keyof typeof zhCN] as Record<string, string>)[key];
      const params = Object.fromEntries(placeholders(source).map((name) => [name, count]));
      const render = translate as (locale: Locale, key: MessageKey, params: Record<string, number>) => string;
      const text = render('en', id, params);
      if (count === 1)
        expect(text, id).not.toMatch(
          /\b1 (?:[a-z-]+ )?(?:items|skills|destinations|sources|groups|installations|repositories|updates|copies|references|entries|aliases|minutes|changes|conflicts|stars)\b/,
        );
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(30);
});

it('formats display lists and quoted user names in either language', () => {
  setLocaleResolver(() => 'en');
  expect(formatList([])).toBe('');
  expect(formatList(['Alpha'])).toBe('Alpha');
  expect(formatList(['Alpha', 'Beta'])).toBe('Alpha and Beta');
  expect(formatList(['Alpha', 'Beta', 'Gamma'])).toBe('Alpha, Beta, and Gamma');
  expect(quote('My group')).toBe('"My group"');
  setLocaleResolver(() => 'zh-CN');
  expect(formatList(['Alpha', 'Beta', 'Gamma'])).toBe('Alpha、Beta、Gamma');
  expect(quote('My group')).toBe('“My group”');
  expect(formatCount(1, 'skill')).toBe('1 个技能');
  expect(formatCount(2, 'skill')).toBe('2 个技能');
});

it("keeps styled slots in the language's sentence order and separates selection sentences", () => {
  const values = { count: 2, harnessName: 'Claude Code' };
  const template = translationTemplate('en', 'library.harnessSelectionHint', values);
  const rich = interpolateParts(template, values, (slot, value) => (slot === 'count' ? `<strong>${value}</strong>` : String(value))).join(
    '',
  );
  expect(rich).toContain('Selected <strong>2</strong> items. Select a section');
  expect(rich).toContain('from Claude Code.');
  expect(translate('zh-CN', 'dialogs.unapplySummary', values)).toBe('从 Claude Code 取消应用 2 个技能');
});
