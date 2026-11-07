import { createContext, useContext, useLayoutEffect, useMemo, useState, Fragment, type ReactNode } from 'react';
import {
  createTranslator,
  resolveLocale,
  setLocaleResolver,
  type Locale,
  type LocalePreference,
  translationTemplate,
  interpolateParts,
  type MessageKey,
  type TranslationParams,
} from '../shared/i18n';
export {
  t,
  formatNumber,
  formatDateTime,
  formatRelativeTime,
  compareNames,
  formatList,
  quote,
  formatCount,
  countUnit,
} from '../shared/i18n';

const I18nContext = createContext<Locale>('en');
const PreferenceContext = createContext<(locale: LocalePreference) => void>(() => {});
let displayLocale: Locale = resolveLocale('system', typeof navigator === 'undefined' ? [] : navigator.languages);
if (typeof document !== 'undefined') setLocaleResolver(() => displayLocale);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<LocalePreference>('system');
  const [systemLocale, setSystemLocale] = useState<Locale>(() =>
    resolveLocale('system', typeof navigator === 'undefined' ? [] : navigator.languages),
  );
  const locale = resolveLocale(preference, [systemLocale]);
  displayLocale = locale;
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <PreferenceContext.Provider value={setPreference}>
      <SystemLocaleContext.Provider value={setSystemLocale}>
        <I18nContext.Provider value={locale}>{children}</I18nContext.Provider>
      </SystemLocaleContext.Provider>
    </PreferenceContext.Provider>
  );
}
const SystemLocaleContext = createContext<(locale: Locale) => void>(() => {});
export const useLocalePreference = () => useContext(PreferenceContext);
export const useLocale = () => useContext(I18nContext);
export const useSystemLocale = () => useContext(SystemLocaleContext);
export function useT() {
  const locale = useContext(I18nContext);
  return useMemo(() => createTranslator(locale), [locale]);
}

/** Named slots keep styled content in the language's word order without parsing HTML. */
export function Trans<K extends MessageKey>({
  id,
  values,
  render = {},
}: {
  id: K;
  values: TranslationParams<K>;
  render?: Partial<Record<keyof TranslationParams<K>, (value: string | number) => ReactNode>>;
}) {
  const locale = useContext(I18nContext);
  const template = translationTemplate(locale, id, values);
  return (
    <>
      {interpolateParts(template, values, (slot, value, offset) => (
        <Fragment key={offset}>{render[slot as keyof TranslationParams<K>]?.(value) ?? value}</Fragment>
      ))}
    </>
  );
}
