import type { Harness, Scope } from './types';
export function harnessReadPaths(harness: Harness, scope: Scope): Array<{ path: string; inheritedFrom?: string }> {
  const universal = scope === 'user' ? '~/.agents/skills' : '.agents/skills';
  const primary = scope === 'user' ? harness.userSkillsPath : harness.workspaceSkillsRelativePath;
  const extra = scope === 'user' ? harness.extraUserSkillsPaths : harness.extraWorkspaceSkillsRelativePaths;
  const readsAgents = scope === 'user' ? harness.readsUserAgents : harness.readsWorkspaceAgents;
  const paths = [...new Set([primary, ...(extra ?? []), ...(readsAgents ? [universal] : [])].filter(Boolean))];
  return paths.map((value) => ({
    path: value,
    ...(harness.id !== 'universal' && (value === universal || value !== primary) ? { inheritedFrom: value } : {}),
  }));
}
