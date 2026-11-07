import { en } from './en';
import { zhCN } from './zh-CN';
import { englishNoun } from './grammar';

export type Locale = 'zh-CN' | 'en';
export type LocalePreference = 'system' | Locale;
export type Dictionary = {
  [N in keyof typeof zhCN]: {
    [K in keyof (typeof zhCN)[N]]: string | ((params: Record<Slots<(typeof zhCN)[N][K]>, string | number>) => string);
  };
};
export type MessageKey = { [N in keyof typeof zhCN]: `${N & string}.${keyof (typeof zhCN)[N] & string}` }[keyof typeof zhCN];
type Text<K extends MessageKey> = K extends `${infer N}.${infer P}`
  ? N extends keyof typeof zhCN
    ? P extends keyof (typeof zhCN)[N]
      ? (typeof zhCN)[N][P]
      : never
    : never
  : never;
export type Slots<S> = S extends `${string}{${infer P}}${infer Rest}` ? P | Slots<Rest> : never;
export type TranslationParams<K extends MessageKey> = Record<Slots<Text<K>>, string | number>;
export type TranslationArgs<K extends MessageKey> = [Slots<Text<K>>] extends [never]
  ? []
  : [params: Record<Slots<Text<K>>, string | number>];

export function resolveLocale(preference: LocalePreference | undefined, languages: readonly string[]): Locale {
  if (preference === 'zh-CN' || preference === 'en') return preference;
  return languages[0]?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

let localeResolver: () => Locale = () => 'en';
/** Each process installs its own resolver. Main reads saved settings at message creation time. */
export function setLocaleResolver(resolver: () => Locale): void {
  localeResolver = resolver;
}
export const currentLocale = (): Locale => localeResolver();
/** Function entries choose grammar, then return a template containing the same named slots. */
export function translationTemplate<K extends MessageKey>(locale: Locale, key: K, params: TranslationParams<K>): string {
  const [namespace, name] = key.split('.') as [keyof Dictionary, string];
  const dictionary: Dictionary = locale === 'zh-CN' ? zhCN : en;
  const entry = (dictionary[namespace] as Record<string, string | ((params: Record<string, string | number>) => string)>)[name];
  return typeof entry === 'function' ? entry(params) : entry;
}

export function interpolateParts<T>(
  template: string,
  params: Record<string, string | number>,
  render: (slot: string, value: string | number, offset: number) => T,
): (string | T)[] {
  const parts: (string | T)[] = [];
  let offset = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    parts.push(template.slice(offset, match.index));
    parts.push(render(match[1], params[match[1]] ?? match[0], match.index));
    offset = match.index + match[0].length;
  }
  parts.push(template.slice(offset));
  return parts;
}

export function translate<K extends MessageKey>(locale: Locale, key: K, ...args: TranslationArgs<K>): string {
  const params = (args[0] ?? {}) as TranslationParams<K>;
  return interpolateParts(translationTemplate(locale, key, params), params, (_slot, value) => String(value)).join('');
}
export function t<K extends MessageKey>(key: K, ...args: TranslationArgs<K>): string {
  return translate(currentLocale(), key, ...args);
}
export const createTranslator =
  (locale: Locale) =>
  <K extends MessageKey>(key: K, ...args: TranslationArgs<K>) =>
    translate(locale, key, ...args);
export const formatNumber = (value: number, options?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(currentLocale(), options).format(value);
export const formatDateTime = (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(currentLocale(), options).format(value);
export const formatRelativeTime = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
  new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' }).format(value, unit);
/** Stable sorting across language changes, independent of display formatting. */
const nameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const compareNames = (left: string, right: string) => nameCollator.compare(left, right);

export type CountNoun = keyof typeof zhCN.counts;
export function countUnit(count: number, noun: CountNoun): string {
  const singular = t(`counts.${noun}`);
  return currentLocale() === 'en' ? englishNoun(count, singular) : singular;
}
export function formatCount(count: number, noun: CountNoun = 'item'): string {
  return `${formatNumber(count)} ${countUnit(count, noun)}`;
}

const englishListFormatter = new Intl.ListFormat('en', { type: 'conjunction', style: 'long' });

/** Keep the established Chinese list punctuation, with locale-aware English separators. */
export function formatList(values: Iterable<string>): string {
  const items = [...values];
  return currentLocale() === 'zh-CN' ? items.join(t('common.listSeparator')) : englishListFormatter.format(items);
}
export function quote(value: string): string {
  return t('common.quoted', { value });
}
