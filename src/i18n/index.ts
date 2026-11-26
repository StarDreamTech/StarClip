import { ref } from 'vue'

export type Locale = 'zh-CN' | 'en-US'
export type UILanguage = 'system' | Locale

const CACHE_KEY = 'starclip.ui-locale'
const INTL_CACHE_LIMIT = 64
export const locale = ref<Locale>('zh-CN')

const catalogVersion = ref(0)
let catalog: Record<string, string> = {}
let nativePatterns: ReadonlyArray<[RegExp, string]> = []
let enLoaded = false
let enLoadPromise: Promise<void> | null = null

const numberFormatters = new Map<string, Intl.NumberFormat>()
const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>()

function cachedFormatter<T>(cache: Map<string, T>, key: string, create: () => T): T {
  const existing = cache.get(key)
  if (existing) return existing
  if (cache.size >= INTL_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  const formatter = create()
  cache.set(key, formatter)
  return formatter
}

function optionsKey(lang: string, options?: object): string {
  if (!options) return lang
  const entries = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `${lang}|${JSON.stringify(entries)}`
}

export function ensureLocaleLoaded(target: Locale = locale.value): Promise<void> {
  if (target !== 'en-US' || enLoaded) return Promise.resolve()
  if (!enLoadPromise) {
    enLoadPromise = import('./en-bundle.ts')
      .then((bundle) => {
        catalog = bundle.enCatalog
        nativePatterns = bundle.backendPatterns
        enLoaded = true
        catalogVersion.value += 1
      })
      .catch((error) => {
        enLoadPromise = null
        throw error
      })
  }
  return enLoadPromise
}

function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return []
  const values = [navigator.language, ...(Array.isArray(navigator.languages) ? navigator.languages : [])]
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
}

export function systemLocale(): Locale {
  // Node-based component tests have no browser UI; keep their fixture text Chinese.
  if (typeof window === 'undefined' && typeof document === 'undefined') return 'zh-CN'
  if (typeof navigator === 'undefined' || /Node\.js/i.test(navigator.userAgent ?? '')) return 'zh-CN'
  return browserLanguages().some(value => /^zh\b/i.test(value)) ? 'zh-CN' : 'en-US'
}

export function resolveLocale(preference: UILanguage | string | undefined | null): Locale {
  return preference === 'zh-CN' || preference === 'en-US' ? preference : systemLocale()
}

export function cachedLocale(): Locale | null {
  try {
    const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(CACHE_KEY)
    return value === 'zh-CN' || value === 'en-US' ? value : null
  } catch { return null }
}

export function setLocale(next: Locale, cache = true): void {
  locale.value = next
  if (next === 'en-US' && !enLoaded) {
    void ensureLocaleLoaded('en-US')
  }
  if (cache) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(CACHE_KEY, next) } catch { /* storage can be unavailable */ }
  }
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next
      document.documentElement.dataset.locale = next === 'en-US' ? 'en' : 'zh'
    }
  } catch { /* non-browser fixtures */ }
}

export function applyLanguage(preference: UILanguage | string | undefined | null): Locale {
  const next = resolveLocale(preference)
  setLocale(next)
  return next
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  const lang = locale.value
  const formatter = cachedFormatter(numberFormatters, optionsKey(lang, options), () => new Intl.NumberFormat(lang, options))
  return formatter.format(value)
}

export function formatDate(value: number | Date, options: Intl.DateTimeFormatOptions): string {
  const lang = locale.value
  const formatter = cachedFormatter(dateFormatters, optionsKey(lang, options), () => new Intl.DateTimeFormat(lang, options))
  return formatter.format(value)
}

export function relativeTime(time: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - time) / 60000))
  if (minutes < 1) return t('刚刚')
  const lang = locale.value
  const formatter = cachedFormatter(relativeFormatters, `${lang}|auto`, () => new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }))
  if (minutes < 60) return formatter.format(-minutes, 'minute')
  if (minutes < 1440) return formatter.format(-Math.floor(minutes / 60), 'hour')
  if (minutes < 10080) return formatter.format(-Math.floor(minutes / 1440), 'day')
  return formatDate(time, { month: 'short', day: 'numeric' })
}

function lookup(source: string): string {
  void catalogVersion.value
  return catalog[source] ?? source
}

export function t(source: string, params?: Record<string, string | number>): string {
  let text = locale.value === 'zh-CN' ? source : lookup(source)
  if (params?.count !== undefined && text.includes('|')) {
    const [one, other] = text.split('|')
    text = (Number(params.count) === 1 ? one! : other!)
  }
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, key: string) => params[key] === undefined ? match : String(params[key]))
}

export function hasTranslation(source: string): boolean { return Object.prototype.hasOwnProperty.call(catalog, source) }

function translateNativePattern(raw: string, depth = 0): string | null {
  if (depth >= 4) return null
  const exact = catalog[raw]
  if (exact) return exact
  for (const [pattern, replacement] of nativePatterns) {
    const match = pattern.exec(raw)
    if (match) {
      return replacement.replace(/\$(\d+)/g, (_, index: string) => {
        const part = match[Number(index)] ?? ''
        return /[\u4e00-\u9fff]/.test(part) ? (translateNativePattern(part, depth + 1) ?? part) : part
      })
    }
  }
  return null
}

export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (locale.value === 'zh-CN') return raw
  void catalogVersion.value
  const translated = translateNativePattern(raw)
  if (translated !== null) return translated
  if (/[\u4e00-\u9fff]/.test(raw)) {
    // Native diagnostics are translated where they are common. For the long
    // tail, keep the English UI readable and leave the original for support.
    console.warn('[i18n] untranslated native message:', raw)
    return 'The operation could not be completed. Please try again.'
  }
  return raw
}

// Initial paint already uses the last explicit choice when storage is available.
setLocale(cachedLocale() ?? systemLocale(), false)
