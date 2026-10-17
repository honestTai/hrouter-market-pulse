import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { queryClient } from './lib/queries'
import { applyAppearance } from './lib/prefs'
import { isEnglish, t } from './lib/i18n'
import { router } from './router'
import './index.css'

applyAppearance()
document.title = t('HRouter 股票工作台')
document.documentElement.lang = isEnglish() ? 'en' : 'zh-CN'
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
