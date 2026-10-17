// Per-viewer display preferences kept in localStorage: theme and up/down colors.
const read = (key: string, fallback: string) => { try { return localStorage.getItem(`hrouter.${key}`) ?? fallback } catch { return fallback } }
const write = (key: string, value: string) => { try { localStorage.setItem(`hrouter.${key}`, value) } catch { /* private mode */ } }

export type Theme = 'system' | 'light' | 'dark'
export type Colors = 'red-up' | 'green-up'

export const prefs = {
  theme: () => read('theme', 'system') as Theme,
  colors: () => read('colors', 'red-up') as Colors,
  setTheme(value: Theme) { write('theme', value); applyAppearance() },
  setColors(value: Colors) { write('colors', value); applyAppearance() },
}

export function applyAppearance() {
  const root = document.documentElement
  const theme = prefs.theme()
  if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme
  root.classList.toggle('green-up', prefs.colors() === 'green-up')
  root.lang = 'zh-CN'
}

// The report the server embedded into the page (market workspace data), if any.
export function embeddedReport<T = Record<string, unknown>>(): T | null {
  try { return JSON.parse(document.getElementById('report-data')?.textContent ?? 'null') } catch { return null }
}
