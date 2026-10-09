import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { Skill, Source } from '../shared/types';
import { parseMarketplaceSource } from '../shared/marketplace';
import type { Store } from './store';
import { appError } from './messages';

/** Resolve IDs to recorded destinations; renderer never supplies a URL or filesystem path. */
export class SkillLocationService {
  constructor(private readonly store: Store) {}

  sourceUrl(skillId: string): string {
    const skill = this.skill(skillId);
    const source = this.store.get<Source>('sources', skill.sourceId);
    if (source?.type !== 'github') throw appError('LOCATION_NO_WEB_SOURCE');
    const { uri } = parseMarketplaceSource(source.uri);
    const repository = uri.replace(/\.git$/i, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw appError('LOCATION_REPOSITORY_INVALID');
    const parts = skill.sourcePath === '.' ? [] : skill.sourcePath.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) throw appError('LOCATION_SOURCE_PATH_INVALID');
    const commit = skill.resolvedCommit || source.commit;
    const ref = /^[0-9a-f]{40,64}$/i.test(commit) ? commit : source.ref || 'HEAD';
    return `https://github.com/${repository}/tree/${encodeURIComponent(ref)}${parts.length ? `/${parts.map(encodeURIComponent).join('/')}` : ''}`;
  }

  async directory(skillId: string): Promise<string> {
    const skill = this.skill(skillId);
    if ([skill.id, skill.name].some((value) => !value || value === '.' || value === '..' || /[/\\\0]/.test(value)))
      throw appError('LOCATION_RECORD_INVALID');
    const expected = path.join(this.store.root, 'skills', skill.id, skill.name);
    if (path.resolve(skill.directory) !== expected) throw appError('LOCATION_RECORD_INVALID');
    let actual: string;
    try {
      const entry = await lstat(expected);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw appError('LOCATION_DIRECTORY_REPLACED');
      actual = await realpath(expected);
    } catch {
      throw appError('LOCATION_DIRECTORY_MISSING');
    }
    if (actual !== expected) throw appError('LOCATION_DIRECTORY_REDIRECTED');
    return actual;
  }

  private skill(id: string): Skill {
    const skill = this.store.get<Skill>('skills', id);
    if (!skill) throw appError('LOCATION_SKILL_NOT_FOUND');
    return skill;
  }
}
