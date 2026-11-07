const pluralRules = new Intl.PluralRules('en');

/** English cardinal agreement. Zero follows the plural form. */
export function englishPlural(count: string | number, singular: string, other = `${singular}s`): string {
  return pluralRules.select(Number(count)) === 'one' ? singular : other;
}

const irregularPlurals: Record<string, string> = { copy: 'copies', repository: 'repositories', entry: 'entries', alias: 'aliases' };
export function englishNoun(count: string | number, singular: string): string {
  return englishPlural(count, singular, irregularPlurals[singular] ?? `${singular}s`);
}
