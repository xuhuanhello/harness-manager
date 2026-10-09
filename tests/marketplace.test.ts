import { describe, it, expect } from 'vitest';
import { parseMarketplaceSource } from '../src/shared/marketplace';

describe('marketplace source input', () => {
  it('turns detail pages into repository and candidate name without running CLI commands', () => {
    expect(parseMarketplaceSource('https://skills.sh/mattpocock/skills/code-review')).toEqual({
      uri: 'mattpocock/skills',
      skillName: 'code-review',
    });
    expect(parseMarketplaceSource('https://www.skills.sh/vercel-labs/agent-skills/vercel-react-best-practices')).toEqual({
      uri: 'vercel-labs/agent-skills',
      skillName: 'vercel-react-best-practices',
    });
    expect(parseMarketplaceSource('https://github.com/anthropics/skills.git')).toEqual({ uri: 'anthropics/skills' });
    expect(parseMarketplaceSource('skills.sh/mattpocock/skills/code-review')).toEqual({
      uri: 'mattpocock/skills',
      skillName: 'code-review',
    });
    expect(parseMarketplaceSource('anthropics/skills')).toEqual({ uri: 'anthropics/skills' });
  });
  it('rejects unrelated URLs, credentials, escaped paths and executable command text', () => {
    for (const value of [
      'https://evil.example/a/b/c',
      'https://skills.sh@evil.example/a/b/c',
      'https://user@skills.sh/a/b/c',
      'javascript:alert(1)',
      'npx skills add a/b',
      'https://skills.sh/a/b/%2fetc',
      'https://skills.sh/',
      'https://skills.sh/a/b/c/d',
      'https://skills.sh:444/a/b/c',
    ]) {
      expect(() => parseMarketplaceSource(value)).toThrow();
    }
  });
});
