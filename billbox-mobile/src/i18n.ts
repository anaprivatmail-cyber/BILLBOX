import AsyncStorage from '@react-native-async-storage/async-storage'

const en = require('./i18n/en.json') as Record<string, string>
const sl = require('./i18n/sl.json') as Record<string, string>
const hr = require('./i18n/hr.json') as Record<string, string>
const it = require('./i18n/it.json') as Record<string, string>
const de = require('./i18n/de.json') as Record<string, string>

export type Lang = 'en' | 'sl' | 'hr' | 'it' | 'de'

const LANG_STORAGE_KEY = 'billbox.mobile.lang'

let currentLang: Lang = 'en'

const resources: Record<Lang, Record<string, string>> = {
  en,
  sl,
  hr,
  it,
  de,
}

function isLang(value: string | null | undefined): value is Lang {
  return value === 'en' || value === 'sl' || value === 'hr' || value === 'it' || value === 'de'
}

export async function loadLang(): Promise<Lang> {
  try {
    const stored = await AsyncStorage.getItem(LANG_STORAGE_KEY)
    if (isLang(stored)) {
      currentLang = stored
      return stored
    }
  } catch {}
  currentLang = 'en'
  return 'en'
}

export async function saveLang(lang: Lang): Promise<void> {
  try {
    currentLang = lang
    await AsyncStorage.setItem(LANG_STORAGE_KEY, lang)
  } catch {}
}

function lookup(lang: Lang, key: string): string {
  const table = resources[lang] || en
  const value = table[key]
  if (value != null) return value

  // DEV guard: if any translation is missing, make it obvious during testing.
  // In production, fall back to English to avoid breaking UX.
  const fallback = en[key]
  if (typeof __DEV__ !== 'undefined' && __DEV__) return `⛔MISSING:${key}`
  return fallback ?? key
}

export function t(lang: Lang, key: string): string
export function t(key: string): string
export function t(arg1: Lang | string, arg2?: string): string {
  if (typeof arg2 === 'string') return lookup(arg1 as Lang, arg2)
  return lookup(currentLang, arg1 as string)
}
