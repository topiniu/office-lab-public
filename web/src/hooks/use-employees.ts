import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react'
import { usePoll } from './use-poll'
import type { EmployeeMap } from '@/lib/types'

type Ctx = { employees: EmployeeMap; loading: boolean }
const EmployeesContext = createContext<Ctx>({ employees: {}, loading: true })

// 花名册变动极少 —— 全站拉一次、共享读取。
export function EmployeesProvider({ children }: { children: ReactNode }) {
  const { data, loading } = usePoll<EmployeeMap>('/api/employees')
  // 必须 useMemo：value 每次渲染新建对象的话，轮询每跳（哪怕花名册一个字没变）都会把全站
  // 每个 useEmployees() 消费者（含看板每行头像）重渲染一遍。
  const value = useMemo(() => ({ employees: data ?? {}, loading }), [data, loading])
  return createElement(EmployeesContext.Provider, { value }, children)
}

export function useEmployees() {
  return useContext(EmployeesContext)
}

export function employeeName(map: EmployeeMap, key: string): string {
  return map[key]?.displayName ?? key
}
