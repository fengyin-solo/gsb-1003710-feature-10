import { defineStore } from 'pinia'

import { ROLES, type Role } from '@/api/threshold-service'

export { ROLES }

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
    // 当前值班角色：阈值配置的复核、排期、归档按角色放行，越权操作会被拒绝。
    role: '值班员' as Role,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: Role) {
      this.role = role
    },
  },
})
