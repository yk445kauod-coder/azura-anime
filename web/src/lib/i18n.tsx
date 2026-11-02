/**
 * IGNIS localisation.
 *
 * The English string is the key. A component writes `t("Mission Control")` and
 * the runtime looks that exact literal up in the generated dictionary, so every
 * locale renders from the bundle with no request and no flash of English. The
 * worker endpoint is a fallback for strings added after the last i18n sync; a
 * string missing from both falls back to English rather than showing a key.
 *
 * Locale choice lives in localStorage and on <html> so direction (RTL for Arabic)
 * applies before React paints.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";

import { DICTIONARIES } from "./locales.generated";

export type LocaleInfo = { code: string; name: string; english: string; rtl?: boolean };

export const LOCALES: LocaleInfo[] = [
  { code: "en", name: "English", english: "English" },
  { code: "ar", name: "العربية", english: "Arabic", rtl: true },
  { code: "fr", name: "Français", english: "French" },
  { code: "es", name: "Español", english: "Spanish" },
  { code: "de", name: "Deutsch", english: "German" },
  { code: "pt", name: "Português", english: "Portuguese" },
  { code: "ru", name: "Русский", english: "Russian" },
  { code: "zh", name: "中文", english: "Chinese (Simplified)" },
  { code: "ja", name: "日本語", english: "Japanese" },
  { code: "hi", name: "हिन्दी", english: "Hindi" },
];

const STORAGE_KEY = "ignis.locale";

/** Locale from storage, else the browser's preference, else English. */
export function initialLocale(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LOCALES.some((l) => l.code === saved)) return saved;
    const nav = navigator.language?.slice(0, 2).toLowerCase();
    if (nav && LOCALES.some((l) => l.code === nav)) return nav;
  } catch { /* storage can be unavailable */ }
  return "en";
}

export function isRtl(code: string): boolean {
  return Boolean(LOCALES.find((l) => l.code === code)?.rtl);
}

/** Apply locale to the document so RTL and font stacks take effect. */
export function applyDocumentLocale(code: string): void {
  const root = document.documentElement;
  root.lang = code;
  root.dir = isRtl(code) ? "rtl" : "ltr";
}

type Ctx = {
  locale: string;
  setLocale: (code: string) => void;
  t: (english: string) => string;
  ready: boolean;
};

const I18nContext = createContext<Ctx>({
  locale: "en",
  setLocale: () => {},
  t: (s) => s,
  ready: true,
});

export const useI18n = () => useContext(I18nContext);

type Store = Map<string, string>;

/**
 * Locale stores, seeded from the generated dictionary.
 *
 * The bundle already contains every string the app asks for, so a locale switch
 * is synchronous and never flashes English. The API is only consulted for a
 * string that is not in the bundle, which happens when new UI text is added
 * before `npm run i18n:sync` is re-run.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<string>(() => initialLocale());
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(true);

  const stores = useRef(new Map<string, Store>()).current;
  const inflight = useRef(new Set<string>()).current;
  const queue = useRef(new Map<string, Set<string>>()).current;
  const timer = useRef<number | null>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const storeFor = useCallback((code: string): Store => {
    let store = stores.get(code);
    if (!store) {
      store = new Map(Object.entries(DICTIONARIES[code] ?? {}));
      stores.set(code, store);
    }
    return store;
  }, [stores]);

  const flush = useCallback(async () => {
    timer.current = null;
    const batches = [...queue.entries()];
    queue.clear();
    for (const [target, strings] of batches) {
      const list = [...strings];
      if (!list.length) continue;
      const store = storeFor(target);
      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locale: target, strings: list }),
        });
        const data = await res.json().catch(() => null);
        const translations: Record<string, string> = data?.translations ?? {};
        for (const s of list) store.set(s, translations[s] || s);
      } catch {
        // A failed translation must not break the page; English stands in.
        for (const s of list) store.set(s, s);
      }
      for (const s of list) inflight.delete(`${target}\u0000${s}`);
      if (target === localeRef.current) setVersion((v) => v + 1);
    }
  }, [queue, stores, inflight, storeFor]);

  const request = useCallback((english: string) => {
    const target = localeRef.current;
    if (target === "en") return;
    const key = `${target}\u0000${english}`;
    if (inflight.has(key) || storeFor(target).has(english)) return;
    inflight.add(key);
    let set = queue.get(target);
    if (!set) { set = new Set(); queue.set(target, set); }
    set.add(english);
    if (timer.current === null) {
      timer.current = window.setTimeout(() => { void flush(); }, 16);
    }
  }, [queue, stores, inflight, flush, storeFor]);

  const t = useCallback((english: string) => {
    if (!english || locale === "en") return english;
    const hit = storeFor(locale).get(english);
    if (hit) return hit;
    request(english);
    return english;
  }, [locale, stores, request, storeFor]);

  const setLocale = useCallback((code: string) => {
    if (!LOCALES.some((l) => l.code === code)) return;
    setLocaleState(code);
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
    applyDocumentLocale(code);
    setReady(code === "en" || storeFor(code).size > 0);
  }, [stores, storeFor]);

  useEffect(() => {
    applyDocumentLocale(locale);
    setVersion((v) => v + 1);
  }, [locale]);

  const value = useMemo(
    () => ({ locale, setLocale, t, ready }),
    // `version` is a dependency so a completed batch re-renders consumers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, setLocale, t, ready, version],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Language picker. Renders each language's native name so it reads in any locale. */
export function LocalePicker() {
  const { locale, setLocale } = useI18n();
  return (
    <select
      className="locale-picker"
      value={locale}
      onChange={(e) => setLocale(e.target.value)}
      title="Interface language"
      aria-label="Interface language"
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>{l.name}</option>
      ))}
    </select>
  );
}
