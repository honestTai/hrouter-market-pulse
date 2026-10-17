// UI language: Chinese source strings, English from the dictionary. `t('今天新开 {n} 只', { n })`.
// Missing English entries fall back to the Chinese text (a test lists any that are missing).
import { EN } from './i18n-en'

export type Language = 'zh-CN' | 'en'

const read = (): Language => { try { return localStorage.getItem('hrouter.language') === 'en' ? 'en' : 'zh-CN' } catch { return 'zh-CN' } }
let current: Language = read()

export const language = () => current
export const locale = () => (current === 'en' ? 'en-US' : 'zh-CN')
export const isEnglish = () => current === 'en'

export function setLanguage(value: Language) {
  try { localStorage.setItem('hrouter.language', value) } catch { /* private mode */ }
  current = value
  // Every label is computed at render time from the current language; a reload re-renders all of them.
  if (typeof location !== 'undefined') location.reload()
}

export function t(zh: string, vars?: Record<string, string | number | null | undefined>): string {
  let text = current === 'en' ? (EN[zh] ?? zh) : zh
  if (vars) text = text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''))
  return text
}
