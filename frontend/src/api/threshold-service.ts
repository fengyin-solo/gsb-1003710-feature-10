import { listRows, saveRows, syncFromStorage } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 预警阈值生命周期服务：warning 模块的所有读写都走这里，通用 runAction 不再直接改它的状态。
//
// 状态机（只许前进，任何阶段都不能跳回草稿）：
//   草稿 --提交校验(校验通过)--> 待复核 --复核排期--> 已排期 --触发生效(到点)--> 已生效 --归档配置--> 已归档
//
// 生效窗口约定：
//   - 同一「站点编号+监测类型」下允许窗口重叠，重叠时段以生效起始较晚的版本为准；
//     新版本生效时，与其重叠的已生效旧版本自动归档，历史水位记录仍引用当时的门槛快照。
//   - 同一「站点+类型+生效窗口」的在途配置（待复核/已排期/已生效）只留一份，
//     并发提交时先落库的生效，后提交的被拒绝。

export const WARNING_KEY = 'warning'
export const REVIEW_KEY = 'warning-review'

export const THRESHOLD_STATUSES = ['草稿', '待复核', '已排期', '已生效', '已归档'] as const
export type ThresholdStatus = (typeof THRESHOLD_STATUSES)[number]

export const ROLES = ['值班员', '复核员', '系统管理员'] as const
export type Role = (typeof ROLES)[number]

export const THRESHOLD_ACTIONS = ['提交校验', '复核排期', '触发生效', '归档配置'] as const
export type ThresholdAction = (typeof THRESHOLD_ACTIONS)[number]

const TRANSITIONS: Record<ThresholdAction, { from: ThresholdStatus; to: ThresholdStatus }> = {
  提交校验: { from: '草稿', to: '待复核' },
  复核排期: { from: '待复核', to: '已排期' },
  触发生效: { from: '已排期', to: '已生效' },
  归档配置: { from: '已生效', to: '已归档' },
}

// 每个动作允许的角色：越权调整直接拒绝。
const ACTION_ROLES: Record<ThresholdAction, Role[]> = {
  提交校验: ['值班员', '复核员', '系统管理员'],
  复核排期: ['复核员', '系统管理员'],
  触发生效: ['复核员', '系统管理员'],
  归档配置: ['系统管理员'],
}

// 每个状态下页面可展示的动作。
export const ACTIONS_BY_STATUS: Record<ThresholdStatus, ThresholdAction[]> = {
  草稿: ['提交校验'],
  待复核: ['复核排期'],
  已排期: ['触发生效'],
  已生效: ['归档配置'],
  已归档: [],
}

const THRESHOLD_FIELDS = ['蓝色阈值', '黄色阈值', '橙色阈值', '红色阈值'] as const
const IN_FLIGHT: ThresholdStatus[] = ['待复核', '已排期', '已生效']

// 旧版状态 → 新状态机：已调整/已停用都归入已归档。
const LEGACY_STATUS_MAP: Record<string, ThresholdStatus> = {
  草稿: '草稿',
  待复核: '待复核',
  已排期: '已排期',
  已生效: '已生效',
  已归档: '已归档',
  已调整: '已归档',
  已停用: '已归档',
}

export type DraftInput = {
  站点编号: string
  监测类型: string
  蓝色阈值: string
  黄色阈值: string
  橙色阈值: string
  红色阈值: string
  生效起始: string
  生效截止: string
}

export type ReviewInput = {
  reviewer: string
  opinion: string
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function ok(message: string): ActionResult {
  return { ok: true, message }
}

function isThresholdStatus(status: string): status is ThresholdStatus {
  return (THRESHOLD_STATUSES as readonly string[]).includes(status)
}

function sameScope(a: EntryRow, b: EntryRow): boolean {
  return a['站点编号'] === b['站点编号'] && a['监测类型'] === b['监测类型']
}

function sameWindow(a: EntryRow, b: EntryRow): boolean {
  return sameScope(a, b) && a['生效起始'] === b['生效起始'] && a['生效截止'] === b['生效截止']
}

function windowsOverlap(a: EntryRow, b: EntryRow): boolean {
  return (
    sameScope(a, b) &&
    String(a['生效起始']) <= String(b['生效截止']) &&
    String(b['生效起始']) <= String(a['生效截止'])
  )
}

// 草稿校验：返回全部问题，空数组表示通过。校验不过就不进待复核。
export function validateDraft(row: EntryRow): string[] {
  const problems: string[] = []
  if (!String(row['站点编号'] ?? '').trim()) {
    problems.push('站点编号不能为空')
  }
  if (!String(row['监测类型'] ?? '').trim()) {
    problems.push('监测类型不能为空')
  }
  const levels = THRESHOLD_FIELDS.map((field) => ({ field, raw: row[field] }))
  const values = levels.map(({ raw }) => (typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''))))
  levels.forEach(({ field }, index) => {
    if (!Number.isFinite(values[index])) {
      problems.push(`${field}必须是数字`)
    }
  })
  if (values.every(Number.isFinite)) {
    for (let index = 1; index < values.length; index += 1) {
      if (values[index] <= values[index - 1]) {
        problems.push('蓝/黄/橙/红四级阈值必须逐级递增')
        break
      }
    }
  }
  const start = String(row['生效起始'] ?? '').trim()
  const end = String(row['生效截止'] ?? '').trim()
  if (!start || !end) {
    problems.push('生效窗口的起始与截止日期都要填')
  } else if (start >= end) {
    problems.push('生效起始必须早于生效截止')
  }
  return problems
}

// 旧配置迁移：老数据没有生效窗口、版本号，状态也是旧值，读取时升级一次并写回。
// 阈值不是数字的旧配置无法确认门槛，降级为草稿待人工修正（迁移修正，不算状态回跳）。
export function migrateWarningRows(): boolean {
  syncFromStorage()
  const rows = listRows(WARNING_KEY)
  const versionCounters = new Map<string, number>()
  let changed = false
  const next = rows.map((row) => {
    const scopeKey = `${row['站点编号']}::${row['监测类型']}`
    const version = versionCounters.get(scopeKey) ?? 0
    versionCounters.set(scopeKey, version + 1)
    const legacy = !isThresholdStatus(String(row.status)) || row['生效起始'] === undefined || row['版本号'] === undefined
    if (!legacy) {
      versionCounters.set(scopeKey, Math.max(version + 1, Number(row['版本号']) || 0))
      return row
    }
    changed = true
    const status = LEGACY_STATUS_MAP[String(row.status)] ?? '草稿'
    const thresholdsValid = THRESHOLD_FIELDS.every((field) => Number.isFinite(Number.parseFloat(String(row[field] ?? ''))))
    const migrated: EntryRow = {
      ...row,
      status: thresholdsValid ? status : '草稿',
      pending: status !== '已生效' && status !== '已归档',
      abnormal: false,
      生效起始: row['生效起始'] ?? (status === '已归档' ? '2026-01-01' : status === '已生效' ? '2026-01-01' : ''),
      生效截止: row['生效截止'] ?? (status === '已归档' ? '2026-06-30' : status === '已生效' ? '9999-12-31' : ''),
      版本号: Number(row['版本号']) || version + 1,
    }
    return migrated
  })
  if (changed) {
    saveRows(WARNING_KEY, next)
  }
  return changed
}

let migrated = false

function ensureMigrated(): void {
  if (!migrated) {
    migrateWarningRows()
    migrated = true
  }
}

export function listWarnings(filters: Record<string, string> = {}): EntryRow[] {
  ensureMigrated()
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const rows = listRows(WARNING_KEY)
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listReviews(monitorType = ''): EntryRow[] {
  ensureMigrated()
  const rows = listRows(REVIEW_KEY)
  if (!monitorType.trim()) {
    return rows
  }
  return rows.filter((row) => String(row['监测类型'] ?? '') === monitorType.trim())
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(prefix: string, rows: EntryRow[], field: string): string {
  const max = rows.reduce((acc, row) => {
    const matched = /^[A-Z]+-(\d+)$/.exec(String(row[field] ?? ''))
    return matched ? Math.max(acc, Number(matched[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

// 提交前重读存储并整体替换；任何一步失败都不写库，旧版本原样保留。
function commit(key: string, next: EntryRow[]): ActionResult | null {
  const before = listRows(key)
  try {
    saveRows(key, next)
    return null
  } catch {
    try {
      saveRows(key, before)
    } catch {
      // 回滚也失败时只能保持现状，错误信息照样返回。
    }
    return fail('保存失败，已保留旧版本配置')
  }
}

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function guardRole(action: ThresholdAction, role: Role): ActionResult | null {
  if (!ACTION_ROLES[action].includes(role)) {
    return fail(`「${action}」需要${ACTION_ROLES[action].join('或')}角色，当前角色「${role}」无权操作`)
  }
  return null
}

// 登记草稿：只做必填检查，完整校验留到提交校验时做。
export function createDraft(input: DraftInput, role: Role): ActionResult & { id?: number } {
  const denied = guardRole('提交校验', role)
  if (denied) {
    return denied
  }
  if (!input.站点编号.trim() || !input.监测类型.trim()) {
    return fail('站点编号与监测类型不能为空')
  }
  ensureMigrated()
  syncFromStorage()
  const rows = listRows(WARNING_KEY)
  const scopeRows = rows.filter(
    (row) => row['站点编号'] === input.站点编号.trim() && row['监测类型'] === input.监测类型.trim(),
  )
  const version = scopeRows.reduce((max, row) => Math.max(max, Number(row['版本号']) || 0), 0) + 1
  const draft: EntryRow = {
    id: nextId(rows),
    status: '草稿',
    pending: true,
    abnormal: false,
    配置编号: nextCode('WARN', rows, '配置编号'),
    站点编号: input.站点编号.trim(),
    监测类型: input.监测类型.trim(),
    蓝色阈值: input.蓝色阈值.trim(),
    黄色阈值: input.黄色阈值.trim(),
    橙色阈值: input.橙色阈值.trim(),
    红色阈值: input.红色阈值.trim(),
    生效起始: input.生效起始,
    生效截止: input.生效截止,
    版本号: version,
  }
  const failure = commit(WARNING_KEY, [...rows, draft])
  if (failure) {
    return failure
  }
  return { ok: true, message: `已登记草稿「${draft['配置编号']}」（v${version}），校验通过后方可提交`, id: Number(draft.id) }
}

// 基于已生效版本新建调整草稿：版本号 +1，旧版本原样保留，失败时不落库。
export function adjustVersion(id: number, role: Role): ActionResult {
  const denied = guardRole('提交校验', role)
  if (denied) {
    return denied
  }
  ensureMigrated()
  syncFromStorage()
  const rows = listRows(WARNING_KEY)
  const source = findRow(rows, id)
  if (!source) {
    return fail(`没有找到编号为 ${id} 的预警阈值配置`)
  }
  if (source.status !== '已生效') {
    return fail('只有「已生效」的配置才能发起调整')
  }
  const draft: EntryRow = {
    ...source,
    id: nextId(rows),
    status: '草稿',
    pending: true,
    abnormal: false,
    配置编号: nextCode('WARN', rows, '配置编号'),
    版本号: (Number(source['版本号']) || 0) + 1,
    生效起始: '',
    生效截止: '',
  }
  const failure = commit(WARNING_KEY, [...rows, draft])
  if (failure) {
    return failure
  }
  return ok(`已基于「${source['配置编号']}」v${source['版本号']} 新建调整草稿「${draft['配置编号']}」，原版本继续生效`)
}

export function runThresholdAction(
  id: number,
  action: ThresholdAction,
  role: Role,
  review: ReviewInput = { reviewer: '', opinion: '' },
): ActionResult {
  const denied = guardRole(action, role)
  if (denied) {
    return denied
  }
  ensureMigrated()
  syncFromStorage()
  const rows = listRows(WARNING_KEY)
  const row = findRow(rows, id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的预警阈值配置`)
  }
  const { from, to } = TRANSITIONS[action]
  if (row.status === to) {
    return fail(`配置已经是「${to}」，不用重复操作`)
  }
  if (row.status !== from) {
    return fail(`「${action}」只能从「${from}」推进，当前状态「${row.status}」不能跳变`)
  }

  if (action === '提交校验') {
    const problems = validateDraft(row)
    if (problems.length > 0) {
      return fail(`校验未通过：${problems.join('；')}`)
    }
    // 同一窗口的在途配置只留一份：并发提交时先落库的算数。
    const duplicated = rows.some((other) => other.id !== row.id && sameWindow(other, row) && IN_FLIGHT.includes(other.status as ThresholdStatus))
    if (duplicated) {
      return fail('同一站点、同一监测类型、同一生效窗口已存在在途配置，本次提交被合并拒绝')
    }
  }

  if (action === '触发生效') {
    const date = today()
    if (date < String(row['生效起始'])) {
      return fail(`未到生效起始日（${row['生效起始']}），不能提前生效`)
    }
  }

  const next = rows.map((other) => {
    if (other.id === row.id) {
      return { ...other, status: to, pending: to !== '已生效' && to !== '已归档', abnormal: false }
    }
    // 版本切换点：新版本生效时，窗口重叠的已生效旧版本自动归档。
    if (action === '触发生效' && other.status === '已生效' && windowsOverlap(other, row)) {
      return { ...other, status: '已归档', pending: false }
    }
    return other
  })
  const failure = commit(WARNING_KEY, next)
  if (failure) {
    return failure
  }

  if (action === '复核排期') {
    appendReview(row, review)
  }
  return ok(`「${row['配置编号']}」已${action}，当前状态「${to}」`)
}

function appendReview(row: EntryRow, review: ReviewInput): void {
  syncFromStorage()
  const reviews = listRows(REVIEW_KEY)
  const record: EntryRow = {
    id: nextId(reviews),
    status: '复核通过',
    pending: false,
    abnormal: false,
    记录编号: nextCode('REV', reviews, '记录编号'),
    配置编号: row['配置编号'],
    版本号: row['版本号'],
    站点编号: row['站点编号'],
    监测类型: row['监测类型'],
    复核人: review.reviewer || '未署名',
    复核时间: today(),
    复核结论: '通过',
    复核意见: review.opinion.trim() || '同意排期',
  }
  saveRows(REVIEW_KEY, [...reviews, record])
}

// 顺着阈值数据流定位某个观测时刻适用的门槛版本：
// 命中窗口的版本里，生效起始较晚者优先；再平手则版本号大者优先。
// 已归档版本也参与匹配，历史水位因此继续引用当时的门槛。
export function resolveThreshold(station: string, monitorType: string, observeTime: string): EntryRow | null {
  ensureMigrated()
  const candidates = listRows(WARNING_KEY).filter(
    (row) =>
      (row.status === '已生效' || row.status === '已归档') &&
      row['站点编号'] === station &&
      row['监测类型'] === monitorType &&
      String(row['生效起始']) <= observeTime &&
      observeTime <= String(row['生效截止']),
  )
  if (candidates.length === 0) {
    return null
  }
  return candidates.reduce((winner, row) => {
    const startDiff = String(row['生效起始']).localeCompare(String(winner['生效起始']))
    if (startDiff > 0) {
      return row
    }
    if (startDiff === 0 && (Number(row['版本号']) || 0) > (Number(winner['版本号']) || 0)) {
      return row
    }
    return winner
  })
}

export function thresholdSnapshot(row: EntryRow): string {
  return `蓝${row['蓝色阈值']}/黄${row['黄色阈值']}/橙${row['橙色阈值']}/红${row['红色阈值']}`
}

export function versionLabel(row: EntryRow): string {
  return `${row['配置编号']} · v${row['版本号']}`
}

// 登记水位记录：快照观测时刻适用的阈值版本，之后阈值换版也不影响这条历史记录。
export function createWaterlevelEntry(input: {
  站点编号: string
  观测时间: string
  当前水位: string
}): ActionResult {
  if (!input.站点编号.trim() || !input.观测时间) {
    return fail('站点编号与观测时间不能为空')
  }
  const level = Number.parseFloat(input.当前水位)
  if (!Number.isFinite(level)) {
    return fail('当前水位必须是数字')
  }
  syncFromStorage()
  const matched = resolveThreshold(input.站点编号.trim(), '水位', input.观测时间)
  const rows = listRows('waterlevel')
  const entry: EntryRow = {
    id: nextId(rows),
    status: '已采集',
    pending: true,
    abnormal: false,
    记录编号: nextCode('WATE', rows, '记录编号'),
    站点编号: input.站点编号.trim(),
    观测时间: input.观测时间,
    当前水位: level,
    警戒水位: matched ? matched['黄色阈值'] : '',
    保证水位: matched ? matched['红色阈值'] : '',
    水位变幅: '—',
    适用配置: matched ? versionLabel(matched) : '无生效配置',
    适用阈值: matched ? thresholdSnapshot(matched) : '—',
    记录状态: '已采集',
  }
  const failure = commit('waterlevel', [...rows, entry])
  if (failure) {
    return failure
  }
  return ok(
    matched
      ? `已登记水位记录「${entry['记录编号']}」，适用${versionLabel(matched)}门槛`
      : `已登记水位记录「${entry['记录编号']}」，该观测时刻没有生效中的阈值配置`,
  )
}
