import { expect, it } from 'vitest';
import { contentId, recordId } from '../src/main/ids';

// Persisted IDs must never change format; these values were produced by the original implementations.
it('keeps persisted ID formats stable', () => {
  expect(recordId('target', '/tmp/skills')).toBe('target-dc54412dea2b45d37c6065a23707191e');
  expect(recordId('binding', 'user\0\0target-x\0codex')).toBe('binding-84ac26a9dd214bd0ff0970d038d2593b');
  expect(contentId('source', ['local', '/tmp/source', 'local'])).toBe(
    'source_c9dec1b39e0a8abe4b4698952ffd6c616a6b0ba39d249358b5c7b2e271ed2644',
  );
  expect(contentId('skill', ['source_abc', '.'])).toBe('skill_64b7e5105b01f72878096cd2add7fc437da860e51455d3f01d6509d611ad903e');
});
