import { queryOptions } from '@tanstack/react-query';
import type { ArenaLayoutsResponse } from './arena/types';

export async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  return response.json();
}

export const metricsQuery = () => queryOptions({
  queryKey: ['metrics'],
  queryFn: ({ signal }) => fetchJson<any[]>('/metrics', signal),
  staleTime: 15_000,
});

export const overviewQuery = () => queryOptions({
  queryKey: ['overview'],
  queryFn: ({ signal }) => fetchJson<any>('/overview', signal),
  staleTime: 15_000,
});

export const presentationTeamsQuery = () => queryOptions({
  queryKey: ['presentation-teams'],
  queryFn: ({ signal }) => fetchJson<any>('/presentation-teams', signal),
  staleTime: 5_000,
});

interface HistoryParams { page?: number; search?: string; status?: string; group?: string }
const historySearchParams = (params: HistoryParams) => new URLSearchParams({
  page: String(params.page || 1),
  pageSize: '50',
  search: params.search || '',
  status: params.status || 'all',
  ...(params.group ? { group: params.group } : {}),
}).toString();

export const printQuery = (params: HistoryParams = {}) => queryOptions({
  queryKey: ['tasks', historySearchParams(params)],
  queryFn: ({ signal }) => fetchJson<any>(`/print?${historySearchParams(params)}`, signal),
  staleTime: 5_000,
});

export const balloonQuery = () => queryOptions({
  queryKey: ['balloons'],
  queryFn: ({ signal }) => fetchJson<any>('/balloon', signal),
  staleTime: 30_000,
});

export const monitorQuery = () => queryOptions({
  queryKey: ['monitor'],
  queryFn: ({ signal }) => fetchJson<any>('/monitor', signal),
  staleTime: 10_000,
});

export const commandsQuery = (params: HistoryParams = {}) => queryOptions({
  queryKey: ['commands', 'list', historySearchParams(params)],
  queryFn: ({ signal }) => fetchJson<any>(`/commands?${historySearchParams(params)}`, signal),
  staleTime: 5_000,
});

export const commandDetailQuery = (id: string, page = 1) => queryOptions({
  queryKey: ['commands', 'detail', id, page],
  queryFn: ({ signal }) => fetchJson<any>(`/commands?id=${encodeURIComponent(id)}&page=${page}&pageSize=10`, signal),
  staleTime: 1_000,
});

export const clientStatusQuery = () => queryOptions({
  queryKey: ['client-status'],
  queryFn: ({ signal }) => fetchJson<any>('/api/status', signal),
  staleTime: 1_000,
});

export const arenaLayoutsQuery = () => queryOptions({
  queryKey: ['arena-layouts'],
  queryFn: ({ signal }) => fetchJson<ArenaLayoutsResponse>('/arena-layouts', signal),
  staleTime: 30_000,
});

export const queriesForPath = (path: string) => {
  switch (path) {
    case '/': return [overviewQuery(), metricsQuery()];
    case '/presentation-teams': return [presentationTeamsQuery()];
    case '/print': return [printQuery()];
    case '/balloon': return [balloonQuery()];
    case '/monitor': return [monitorQuery()];
    case '/commands': return [commandsQuery()];
    default: return [];
  }
};
