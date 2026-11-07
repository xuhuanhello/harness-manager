import { describe, expect, it } from 'vitest';
import { fileManagerLabels } from '../src/renderer/file-manager';

describe('platform-aware reveal copy', () => {
  it.each(['darwin', 'win32', 'linux', 'freebsd'] as const)(
    'uses the same manager in buttons, accessible names and errors on %s',
    (platform) => {
      const manager = platform === 'darwin' ? '访达' : '文件管理器';
      const labels = fileManagerLabels(platform);
      expect(labels.open).toBe(`在${manager}中打开`);
      expect(labels.inspect).toBe(`在${manager}中检查`);
      expect(labels.skillLabel('helper')).toBe(`在${manager}中打开 helper`);
      expect(labels.skillError('原因')).toBe(`无法在${manager}中打开技能：原因`);
    },
  );
});
