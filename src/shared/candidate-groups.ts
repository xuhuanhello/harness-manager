/** Directory categories are suggestions, not authoritative repository metadata. */
export function candidateGroup(path: string): string | null {
  const parts = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part && part !== '.');
  parts.pop(); // Skill directory itself is not a category.
  while (parts.length && ['skills', '.agents', '.claude', '.codex'].includes(parts[0].toLowerCase())) parts.shift();
  return parts.length ? parts.join(' / ') : null;
}
