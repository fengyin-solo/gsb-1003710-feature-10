import { listRows } from './local-store'
import { makeThresholdSeed } from './threshold-seed'
import type {
  ThresholdConfig,
  ThresholdReview,
  ThresholdState,
} from './threshold-types'

// 阈值版本配置独立存放，和老的 EntryRow 存储互不影响。
const STORAGE_KEY = 'hydrology-monitor-station:thresholds'
const SCHEMA = 1 as const

function nowText(): string {
  return new Date().toISOString()
}

function pad(num: number): string {
  return String(num).padStart(4, '0')
}

/** 旧配置迁移（幂等）：老的 warning EntryRow 每个系列只迁最新一条作为 v1。
 * - 草稿：仍是草稿，继续走新流程；
 * - 已生效：视作长期生效，窗口自 2000-01-01 起，历史水位都能解析到；
 * - 已调整 / 已停用：直接归档，保留迁移原因。
 * 迁移期间不做数值校验（老数据可能不是合法阈值），重新提交时才强制校验。 */
function migrateLegacy(): { configs: ThresholdConfig[]; reviews: ThresholdReview[]; seqConfig: number; seqReview: number } {
  const legacy = listRows('warning')
  const latestBySeries = new Map<string, (typeof legacy)[number]>()
  for (const row of legacy) {
    const station = String(row['站点编号'] ?? '')
    const monitorType = String(row['监测类型'] ?? '')
    const key = `${station}#${monitorType}`
    const prev = latestBySeries.get(key)
    if (!prev || Number(row.id) > Number(prev.id)) {
      latestBySeries.set(key, row)
    }
  }

  const configs: ThresholdConfig[] = []
  const reviews: ThresholdReview[] = []
  let seqConfig = 0
  let seqReview = 0
  for (const row of [...latestBySeries.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
    seqConfig += 1
    const station = String(row['站点编号'] ?? `LEGACY-${row.id}`)
    const monitorType = String(row['监测类型'] ?? '水位')
    const oldStatus = String(row.status)
    const config: ThresholdConfig = {
      id: seqConfig,
      code: String(row['配置编号'] ?? `WARN-M${pad(seqConfig)}`),
      station,
      monitorType,
      seriesKey: `${station}#${monitorType}`,
      version: 1,
      status: '草稿',
      values: {
        blue: String(row['蓝色阈值'] ?? ''),
        yellow: String(row['黄色阈值'] ?? ''),
        orange: String(row['橙色阈值'] ?? ''),
        red: String(row['红色阈值'] ?? ''),
      },
      windowStart: null,
      windowEnd: null,
      createdBy: '历史迁移',
      createdAt: nowText(),
      migratedFromId: Number(row.id),
    }
    if (oldStatus === '已生效') {
      config.status = '已生效'
      config.windowStart = '2000-01-01'
      config.submittedBy = '历史迁移'
      config.submittedAt = config.createdAt
      config.reviewedBy = '历史迁移'
      config.reviewedAt = config.createdAt
      config.effectiveAt = '2000-01-01'
    } else if (oldStatus === '草稿') {
      config.status = '草稿'
    } else {
      // 已调整 / 已停用 统一收敛到归档终态，流程里不允许再往回跳。
      config.status = '已归档'
      config.windowStart = '2000-01-01'
      config.windowEnd = '2026-10-03'
      config.archiveReason = `旧配置迁移：原状态「${oldStatus}」，按归档处理`
      config.submittedBy = '历史迁移'
      config.submittedAt = config.createdAt
      config.reviewedBy = '历史迁移'
      config.reviewedAt = config.createdAt
      config.effectiveAt = '2000-01-01'
      config.archivedAt = nowText()
    }
    configs.push(config)
    seqReview += 1
    reviews.push({
      id: seqReview,
      at: nowText(),
      configId: config.id,
      configCode: config.code,
      station: config.station,
      monitorType: config.monitorType,
      version: config.version,
      action: '迁移旧配置',
      toStatus: config.status,
      operator: '历史迁移',
      role: '调度主管',
      comment: `迁移自老配置 #${row.id}（原状态 ${oldStatus}）`,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
    })
  }
  return { configs, reviews, seqConfig, seqReview }
}

function readState(): ThresholdState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { schema: SCHEMA, configs: [], reviews: [], seqConfig: 0, seqReview: 0, migrated: false }
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ThresholdState
      if (parsed.schema === SCHEMA) {
        return parsed
      }
    } catch {
      // 落库内容损坏时重新迁移，宁可用旧配置也不丢数据。
    }
  }
  const migrated = migrateLegacy()
  // 迁移配置在前、演示版本在后，编号互不冲突；复核记录统一按时间倒序读取。
  const seed = makeThresholdSeed(migrated.seqConfig, migrated.seqReview)
  const state: ThresholdState = {
    schema: SCHEMA,
    configs: [...migrated.configs, ...seed.configs],
    reviews: [...migrated.reviews, ...seed.reviews],
    seqConfig: seed.seqConfig,
    seqReview: seed.seqReview,
    migrated: true,
  }
  writeState(state)
  return state
}

function writeState(state: ThresholdState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

let cache: ThresholdState | null = null

export function thresholdState(): ThresholdState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

/** 在深克隆上做改动，调用方全部校验通过后再 commit；worker 抛错则回滚到提交前快照，
 * 内存缓存与 localStorage 都恢复原样，保证失败时旧版本原封不动。 */
export function withThresholdDraft(worker: (draft: ThresholdState) => void): void {
  const snapshot = JSON.stringify(thresholdState())
  const draft = JSON.parse(snapshot) as ThresholdState
  try {
    worker(draft)
  } catch (error) {
    cache = JSON.parse(snapshot) as ThresholdState
    writeState(cache)
    throw error
  }
  cache = draft
  writeState(draft)
}

export function nextReviewId(draft: ThresholdState): number {
  draft.seqReview += 1
  return draft.seqReview
}

export function addReview(draft: ThresholdState, review: Omit<ThresholdReview, 'id'>): void {
  draft.reviews.unshift({ ...review, id: nextReviewId(draft) })
}

export function resetThresholds(): ThresholdState {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
  }
  cache = null
  return thresholdState()
}

export function thresholdStorageKey(): string {
  return STORAGE_KEY
}
