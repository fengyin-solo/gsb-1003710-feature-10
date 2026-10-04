import { defineStore } from 'pinia'

import type { ThresholdActor, ThresholdRole } from '@/data/threshold-types'

// 阈值审批流涉及三类角色，演示时可直接切换；真实系统应由登录态注入。
export const ROLE_OPTIONS: ThresholdRole[] = ['值班员', '复核员', '调度主管']

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '王观测',
    role: '值班员' as ThresholdRole,
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    actor: (state): ThresholdActor => ({ name: state.operator, role: state.role }),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: ThresholdRole) {
      this.role = role
      const nameByRole: Record<ThresholdRole, string> = {
        值班员: '王观测',
        复核员: '李复核',
        调度主管: '赵调度',
      }
      this.operator = nameByRole[role]
    },
  },
})
