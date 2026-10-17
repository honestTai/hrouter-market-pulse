import { useEffect } from 'react'
import { QueryClient, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { toast } from 'sonner'
import { get, post, qs, type AccountDetail, type EnvReport, type Job, type Leaderboard, type Library, type Pool, type Run, type RunEvent, type Schedules, type TraderSettings, type TraderStrategy, type Usage, type WorkbenchSettings } from './api'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 } },
})

const visible = () => typeof document === 'undefined' || !document.hidden

export const useLeaderboard = () => useQuery({ queryKey: ['leaderboard'], queryFn: ({ signal }) => get<Leaderboard>('/api/arena/leaderboard', signal), refetchInterval: () => (visible() ? 30_000 : false) })
export const useAccounts = () => {
  const board = useLeaderboard()
  return { ...board, accounts: board.data?.groups.flatMap((group) => group.accounts) ?? [] }
}
export const useAccount = (id: string | undefined) => useQuery({ queryKey: ['account', id], enabled: Boolean(id), queryFn: ({ signal }) => get<AccountDetail>(`/api/arena/accounts/${id}`, signal), refetchInterval: () => (visible() ? 30_000 : false) })
export const useSchedules = () => useQuery({ queryKey: ['schedules'], queryFn: ({ signal }) => get<Schedules>('/api/arena/schedules', signal), refetchInterval: () => (visible() ? 15_000 : false) })
export const useJob = (id: string | undefined) => {
  const schedules = useSchedules()
  return { ...schedules, job: schedules.data?.jobs.find((job) => job.accountId === id) as Job | undefined }
}
export const useRuns = (id: string | undefined, params: Record<string, string | number | undefined> = {}) => useQuery({
  queryKey: ['runs', id, params], enabled: Boolean(id), refetchInterval: () => (visible() ? 15_000 : false),
  queryFn: ({ signal }) => get<{ runs: Run[]; total: number }>(`/api/arena/runs/${id}${qs({ limit: 50, ...params })}`, signal),
})
export const useRunEvents = (runId: string | null | undefined, live = false) => useQuery({
  queryKey: ['run-events', runId], enabled: Boolean(runId), refetchInterval: () => (live && visible() ? 2_500 : false),
  queryFn: ({ signal }) => get<{ runId: string; running: boolean; events: RunEvent[] }>(`/api/arena/run-events/${runId}`, signal),
})
export const usePools = () => useQuery({ queryKey: ['pools'], queryFn: ({ signal }) => get<{ pools: Pool[] }>('/api/arena/pools', signal), refetchInterval: () => (visible() ? 30_000 : false) })
export const useUsage = () => useQuery({ queryKey: ['usage'], queryFn: ({ signal }) => get<Usage>('/api/arena/usage', signal), refetchInterval: () => (visible() ? 60_000 : false) })
export const useEnv = () => useQuery({ queryKey: ['env'], queryFn: ({ signal }) => get<EnvReport>('/api/env', signal), staleTime: 60_000 })
export const useWorkbench = () => useQuery({ queryKey: ['workbench'], queryFn: ({ signal }) => get<WorkbenchSettings>('/api/workbench/settings', signal) })
export const useLibrary = () => useQuery({ queryKey: ['library'], queryFn: ({ signal }) => get<Library>('/api/library', signal), staleTime: 300_000 })
export const useTraderSettings = (id: string | undefined) => useQuery({ queryKey: ['trader-settings', id], enabled: Boolean(id), queryFn: ({ signal }) => get<TraderSettings>(`/api/arena/accounts/${id}/settings`, signal) })
export const useTraderStrategy = (id: string | undefined, version?: number) => useQuery({ queryKey: ['trader-strategy', id, version], enabled: Boolean(id), queryFn: ({ signal }) => get<TraderStrategy>(`/api/arena/accounts/${id}/strategy${qs({ version })}`, signal) })

// A mutation that posts, toasts the outcome and refreshes the queries that depend on it.
export function useAction<TInput, TResult = unknown>(path: string | ((input: TInput) => string), { invalidate = [], success }: { invalidate?: QueryKey[]; success?: string | ((result: TResult) => string) } = {}) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: TInput) => post<TResult>(typeof path === 'function' ? path(input) : path, input),
    onSuccess: (result) => {
      for (const key of invalidate) client.invalidateQueries({ queryKey: key })
      const message = typeof success === 'function' ? success(result) : success
      if (message) toast.success(message)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  })
}

// Live run events from the service (SSE). Other dashboard processes fall back to polling.
export function useLiveEvents() {
  const client = useQueryClient()
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource('/api/events')
    const refresh = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        const accountId = data.run?.accountId ?? data.accountId
        if (data.type === 'run-event') { if (data.runId) client.invalidateQueries({ queryKey: ['run-events', data.runId] }); return }
        client.invalidateQueries({ queryKey: ['schedules'] })
        if (accountId) client.invalidateQueries({ queryKey: ['runs', accountId] })
        if (data.type === 'run-end' && accountId) { client.invalidateQueries({ queryKey: ['account', accountId] }); client.invalidateQueries({ queryKey: ['leaderboard'] }) }
        if (data.type === 'pool') client.invalidateQueries({ queryKey: ['pools'] })
      } catch { /* ignore malformed */ }
    }
    for (const type of ['run-start', 'run-event', 'run-end', 'pool']) source.addEventListener(type, refresh)
    return () => source.close()
  }, [client])
}
