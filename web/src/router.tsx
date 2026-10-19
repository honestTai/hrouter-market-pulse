import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router'
import { Toaster } from 'sonner'
import { AppShell } from './components/Shell'
import { Palette } from './components/Palette'
import { useLiveEvents } from './lib/queries'
import { HomePage } from './pages/Home'
import { TradersPage } from './pages/Traders'
import { TraderPage } from './pages/Trader'
import { ArenaPage } from './pages/Arena'
import { MarketPage } from './pages/Market'
import { RadarPage } from './pages/Radar'
import { ResearchPage } from './pages/Research'
import { ReportsPage } from './pages/Reports'
import { StrategiesPage } from './pages/Strategies'
import { SkillsPage } from './pages/Skills'
import { SchedulePage } from './pages/Schedule'
import { SettingsPage } from './pages/Settings'

function Root() {
  useLiveEvents()
  return (
    <AppShell>
      <Outlet />
      <Palette />
      <Toaster position="bottom-right" richColors closeButton />
    </AppShell>
  )
}

// Links from the old dashboard (?view=arena, …) keep working.
const LEGACY: Record<string, string> = { arena: '/arena', reports: '/reports', portfolio: '/traders', market: '/market', evidence: '/research', journal: '/research', paper: '/settings' }

const rootRoute = createRootRoute({ component: Root })
const home = createRoute({
  getParentRoute: () => rootRoute, path: '/', component: HomePage,
  beforeLoad: ({ location }) => {
    const view = new URLSearchParams(location.searchStr ?? '').get('view')
    if (view && LEGACY[view]) throw redirect({ to: LEGACY[view] })
  },
})
const traders = createRoute({ getParentRoute: () => rootRoute, path: '/traders', component: TradersPage })
const trader = createRoute({
  getParentRoute: () => rootRoute, path: '/traders/$id', component: TraderPage,
  validateSearch: (search: Record<string, unknown>) => ({ tab: typeof search.tab === 'string' ? search.tab : undefined }),
})
const arena = createRoute({ getParentRoute: () => rootRoute, path: '/arena', component: ArenaPage })
const market = createRoute({ getParentRoute: () => rootRoute, path: '/market', component: MarketPage })
const radar = createRoute({ getParentRoute: () => rootRoute, path: '/radar', component: RadarPage,
  validateSearch: (search: Record<string, unknown>) => ({ market: search.market === 'HK' || search.market === 'US' ? search.market as 'HK' | 'US' : undefined }) })
const research = createRoute({
  getParentRoute: () => rootRoute, path: '/research', component: ResearchPage,
  validateSearch: (search: Record<string, unknown>) => ({ new: typeof search.new === 'string' ? search.new : undefined, task: typeof search.task === 'string' ? search.task : undefined }),
})
const reports = createRoute({ getParentRoute: () => rootRoute, path: '/reports', component: ReportsPage })
const strategies = createRoute({ getParentRoute: () => rootRoute, path: '/strategies', component: StrategiesPage })
const skills = createRoute({ getParentRoute: () => rootRoute, path: '/skills', component: SkillsPage })
const schedule = createRoute({ getParentRoute: () => rootRoute, path: '/schedule', component: SchedulePage })
const settings = createRoute({
  getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage,
  validateSearch: (search: Record<string, unknown>) => ({ section: typeof search.section === 'string' ? search.section : undefined }),
})

export const router = createRouter({ routeTree: rootRoute.addChildren([home, traders, trader, arena, radar, market, research, reports, strategies, skills, schedule, settings]), defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
