// 快捷短语：引擎 /api/quick-phrases 的前端缓存。全站一份（多个聊天窗 + 设置页共用），
// 首次用到时拉一次；任何地方增删改后引擎广播 quick-phrases-changed，这里重拉、所有订阅者跟着刷新。
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { apiDelete, apiGet, apiPost } from './api'
import { useSseEvent } from '@/components/sse-provider'

export type QuickPhrase = {
  id: string
  label: string
  text: string
  /** 限定出现在哪些员工的聊天窗；空 = 全部员工 */
  employees: string[]
  createdAt?: string
  updatedAt?: string
}
export type QuickPhraseInput = Pick<QuickPhrase, 'label' | 'text' | 'employees'> & { id?: string }

let cache: QuickPhrase[] | null = null
let inflight: Promise<void> | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

export function reloadQuickPhrases(): Promise<void> {
  if (inflight) return inflight
  inflight = apiGet<{ phrases: QuickPhrase[] }>('/api/quick-phrases')
    .then((r) => {
      cache = r.phrases || []
      emit()
    })
    .catch(() => {
      // 拿不到就当没有：那排短语不显示，不影响聊天
      if (cache == null) {
        cache = []
        emit()
      }
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

function subscribe(f: () => void) {
  subs.add(f)
  return () => subs.delete(f)
}

/** 全部短语（null = 首次加载中）。传 employee 时只返回该员工聊天窗可见的。 */
export function useQuickPhrases(employee?: string): QuickPhrase[] | null {
  const all = useSyncExternalStore(subscribe, () => cache)
  useEffect(() => {
    if (cache == null) reloadQuickPhrases()
  }, [])
  useSseEvent('quick-phrases-changed', () => {
    reloadQuickPhrases()
  })
  return useMemo(() => {
    if (!all || !employee) return all
    return all.filter((p) => !p.employees.length || p.employees.includes(employee))
  }, [all, employee])
}

export async function saveQuickPhrase(input: QuickPhraseInput): Promise<QuickPhrase> {
  const r = await apiPost<{ phrase: QuickPhrase }>('/api/quick-phrases', input)
  await reloadQuickPhrases()
  return r.phrase
}

export async function deleteQuickPhrase(id: string): Promise<void> {
  await apiDelete(`/api/quick-phrases/${encodeURIComponent(id)}`)
  await reloadQuickPhrases()
}

export async function reorderQuickPhrases(ids: string[]): Promise<void> {
  await apiPost('/api/quick-phrases/reorder', { ids })
  await reloadQuickPhrases()
}
