import { addReview, thresholdState, withThresholdDraft } from '@/data/threshold-store'
import type {
  ThresholdActor,
  ThresholdConfig,
  ThresholdMutation,
  ThresholdReview,
  ThresholdStatus,
  ThresholdValues,
} from '@/data/threshold-types'

// 预警阈值版本化领域服务：草稿校验、状态单向推进、生效窗口、并发去重、越权拦截、
// 失败保留旧版本，以及沿水位数据流的「按观测时间解析当时门槛」。

const STATUS_ORDER: ThresholdStatus[] = ['草稿', '待复核', '已排期', '已生效', '已归档']
const LEVEL_FIELDS = ['blue', 'yellow', 'orange', 'red'] as const
const LEVEL_NAMES: Record<(typeof LEVEL_FIELDS)[number], string> = {
  blue: '蓝色',
  yellow: '黄色',
  orange: '橙色',
  red: '红色',
}

// 同一窗口并发提交：提交后短时间内同系列同内容再来一份，直接折叠掉。
const DEDUP_WINDOW_MS = 2000

export type ThresholdDraftInput = {
  station: string
  monitorType: string
  values: ThresholdValues
  windowStart: string
  windowEnd: string
}

export type ResolvedThreshold = {
  config: ThresholdConfig
  /** 该时刻最终采用的阈值（数值）；老迁移数据可能无法转成数字 */
  values: ThresholdValues
}

export type LevelResult = { level: string; levelIndex: number } | null

function fail(message: string): ThresholdMutation {
  return { ok: false, message }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowIso(): string {
  return new Date().toISOString()
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
}

/** 闭区间比较：日期粒度，含端点 */
function inWindow(config: ThresholdConfig, day: string): boolean {
  if (!config.windowStart) {
    return false
  }
  if (day < config.windowStart) {
    return false
  }
  if (config.windowEnd && day > config.windowEnd) {
    return false
  }
  return true
}

function overlap(aStart: string, aEnd: string | null, b: ThresholdConfig): boolean {
  if (!b.windowStart) {
    return false
  }
  const bEnd = b.windowEnd ?? '9999-12-31'
  return aStart <= bEnd && b.windowStart <= (aEnd || '9999-12-31')
}

function toNumber(value: number | string): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    return null
  }
  const num = Number(trimmed)
  return Number.isFinite(num) ? num : null
}

function validateDraft(input: ThresholdDraftInput): string | null {
  if (!input.station.trim()) {
    return '站点编号不能为空'
  }
  if (!input.monitorType.trim()) {
    return '监测类型不能为空'
  }
  if (!isDate(input.windowStart)) {
    return '生效开始日期格式应为 YYYY-MM-DD'
  }
  if (input.windowEnd.trim() && !isDate(input.windowEnd.trim())) {
    return '生效结束日期格式应为 YYYY-MM-DD'
  }
  if (input.windowEnd.trim() && input.windowEnd.trim() < input.windowStart) {
    return '生效结束日期不能早于开始日期'
  }
  const nums: number[] = []
  for (const field of LEVEL_FIELDS) {
    const num = toNumber(input.values[field])
    if (num === null) {
      return `${LEVEL_NAMES[field]}阈值必须是数字`
    }
    nums.push(num)
  }
  for (let i = 1; i < nums.length; i += 1) {
    if (nums[i] < nums[i - 1]) {
      return '阈值需满足 蓝 ≤ 黄 ≤ 橙 ≤ 红，不能出现高级阈值低于低级阈值'
    }
  }
  return null
}

function seriesKey(station: string, monitorType: string): string {
  return `${station.trim()}#${monitorType.trim()}`
}

function nextVersion(existing: ThresholdConfig[], key: string): number {
  const versions = existing.filter((item) => item.seriesKey === key).map((item) => item.version)
  return versions.length ? Math.max(...versions) + 1 : 1
}

function nextCode(existing: ThresholdConfig[], key: string): string {
  const same = existing.filter((item) => item.seriesKey === key)
  if (same[0]) {
    return same[0].code
  }
  const used = new Set(existing.map((item) => item.code))
  let seq = 1001
  while (used.has(`WARN-${seq}`)) {
    seq += 1
  }
  return `WARN-${seq}`
}

// 连点去重：内存级短指纹，跨标签页并发由后面的窗口重叠规则兜底。
const recentSubmissions = new Map<string, number>()

function dedupFingerprint(input: ThresholdDraftInput): string {
  return [
    input.station.trim(),
    input.monitorType.trim(),
    ...LEVEL_FIELDS.map((field) => String(input.values[field]).trim()),
    input.windowStart,
    input.windowEnd,
  ].join('|')
}

function shouldDedup(input: ThresholdDraftInput): boolean {
  const fingerprint = dedupFingerprint(input)
  const now = Date.now()
  const last = recentSubmissions.get(fingerprint)
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    return true
  }
  recentSubmissions.set(fingerprint, now)
  return false
}

function assertRole(actor: ThresholdActor, allowed: ThresholdActor['role'][], verb: string): string | null {
  if (!allowed.includes(actor.role)) {
    return `越权操作：「${actor.role}」无权${verb}，仅 ${allowed.join('、')} 可执行`
  }
  return null
}

function findConfig(draft: ReturnType<typeof thresholdState>, id: number): ThresholdConfig | undefined {
  return draft.configs.find((item) => item.id === id)
}

/** 登记草稿。值班员起草；同系列已有在途（草稿/待复核/已排期）且窗口重叠直接拒绝，
 * 同一窗口并发提交只留一份结果。 */
export function createDraft(input: ThresholdDraftInput, actor: ThresholdActor): ThresholdMutation {
  const roleError = assertRole(actor, ['值班员', '调度主管'], '登记阈值草稿')
  if (roleError) {
    return fail(roleError)
  }
  const validation = validateDraft(input)
  if (validation) {
    return fail(`草稿校验未通过：${validation}`)
  }
  if (shouldDedup(input)) {
    return fail('同一窗口的相同配置刚已提交，并发提交只保留一份结果')
  }

  const key = seriesKey(input.station, input.monitorType)
  // 先在快照上做全部检查，全部通过才落库，失败时旧版本原封不动。
  const state = thresholdState()
  const inflight = state.configs.find(
    (item) =>
      item.seriesKey === key &&
      (item.status === '草稿' || item.status === '待复核' || item.status === '已排期') &&
      overlap(input.windowStart, input.windowEnd || null, item),
  )
  if (inflight) {
    return fail(
      `与同系列 v${inflight.version}（${inflight.status}，窗口 ${inflight.windowStart ?? '—'} ~ ${
        inflight.windowEnd ?? '长期'
      }）生效窗口重叠，请调整窗口或等待该版处理完`,
    )
  }

  try {
    let created: ThresholdConfig | undefined
    withThresholdDraft((draft) => {
      const version = nextVersion(draft.configs, key)
      const config: ThresholdConfig = {
        id: draft.seqConfig + 1,
        code: nextCode(draft.configs, key),
        station: input.station.trim(),
        monitorType: input.monitorType.trim(),
        seriesKey: key,
        version,
        status: '草稿',
        values: {
          blue: toNumber(input.values.blue) as number,
          yellow: toNumber(input.values.yellow) as number,
          orange: toNumber(input.values.orange) as number,
          red: toNumber(input.values.red) as number,
        },
        windowStart: null,
        windowEnd: null,
        draftWindowStart: input.windowStart,
        draftWindowEnd: input.windowEnd || null,
        createdBy: actor.name,
        createdAt: nowIso(),
      }
      draft.seqConfig += 1
      draft.configs.push(config)
      addReview(draft, {
        at: nowIso(),
        configId: config.id,
        configCode: config.code,
        station: config.station,
        monitorType: config.monitorType,
        version: config.version,
        action: '登记草稿',
        toStatus: '草稿',
        operator: actor.name,
        role: actor.role,
        windowStart: null,
        windowEnd: null,
      })
      created = config
    })
    return { ok: true, message: `草稿已登记（v${created?.version}），校验通过，可提交复核`, config: created }
  } catch (error) {
    return fail(error instanceof Error ? `保存失败，已保留旧版本：${error.message}` : '保存失败，已保留旧版本')
  }
}

/** 草稿校验通过后提交复核，窗口随提交定型。任何状态都不能跳回草稿。 */
export function submitForReview(id: number, actor: ThresholdActor): ThresholdMutation {
  const roleError = assertRole(actor, ['值班员', '调度主管'], '提交复核')
  if (roleError) {
    return fail(roleError)
  }
  const state = thresholdState()
  const target = state.configs.find((item) => item.id === id)
  if (!target) {
    return fail('没有找到对应阈值版本')
  }
  if (target.status !== '草稿') {
    return fail(`当前状态为「${target.status}」，流程只进不退，不能再提交复核`)
  }
  if (target.createdBy !== actor.name && actor.role !== '调度主管') {
    return fail('越权操作：只能提交本人登记的草稿')
  }
  const windowStart = target.draftWindowStart ?? ''
  const windowEnd = target.draftWindowEnd ?? ''
  const validation = validateDraft({
    station: target.station,
    monitorType: target.monitorType,
    values: target.values,
    windowStart,
    windowEnd,
  })
  if (validation) {
    return fail(`草稿校验未通过：${validation}`)
  }
  const inflight = state.configs.find(
    (item) =>
      item.id !== id &&
      item.seriesKey === target.seriesKey &&
      (item.status === '草稿' || item.status === '待复核' || item.status === '已排期') &&
      overlap(windowStart, windowEnd || null, item),
  )
  if (inflight) {
    return fail(`生效窗口与同系列 v${inflight.version}（${inflight.status}）重叠，请调整窗口后再提交`)
  }

  try {
    let updated: ThresholdConfig | undefined
    withThresholdDraft((draft) => {
      const config = findConfig(draft, id)
      if (!config) {
        throw new Error('版本在处理过程中被删除')
      }
      config.windowStart = windowStart
      config.windowEnd = windowEnd || null
      config.draftWindowStart = null
      config.draftWindowEnd = null
      config.status = '待复核'
      config.submittedBy = actor.name
      config.submittedAt = nowIso()
      addReview(draft, {
        at: nowIso(),
        configId: id,
        configCode: config.code,
        station: config.station,
        monitorType: config.monitorType,
        version: config.version,
        action: '提交复核',
        fromStatus: '草稿',
        toStatus: '待复核',
        operator: actor.name,
        role: actor.role,
        windowStart: config.windowStart,
        windowEnd: config.windowEnd,
      })
      updated = config
    })
    return { ok: true, message: `v${target.version} 已提交复核，生效窗口 ${windowStart} ~ ${windowEnd || '长期'}`, config: updated }
  } catch (error) {
    return fail(error instanceof Error ? `提交失败，已保留旧版本：${error.message}` : '提交失败，已保留旧版本')
  }
}

export type ReviewDecision = {
  approve: boolean
  comment: string
  /** 复核时可校正窗口（审批方拍板） */
  windowStart?: string
  windowEnd?: string
}

/** 复核：通过进入已排期；驳回直接归档终态（不回草稿）。复核员不能复核本人提交件。 */
export function reviewConfig(id: number, decision: ReviewDecision, actor: ThresholdActor): ThresholdMutation {
  const roleError = assertRole(actor, ['复核员', '调度主管'], '复核阈值')
  if (roleError) {
    return fail(roleError)
  }
  const state = thresholdState()
  const target = state.configs.find((item) => item.id === id)
  if (!target) {
    return fail('没有找到对应阈值版本')
  }
  if (target.status !== '待复核') {
    return fail(`当前状态为「${target.status}」，只有待复核版本可以复核`)
  }
  if (target.submittedBy === actor.name) {
    return fail('越权操作：不能复核自己提交的阈值版本，请交由其他复核人员')
  }
  if (!decision.comment.trim()) {
    return fail('请填写复核意见，通过/驳回都要留痕')
  }
  if (decision.approve) {
    const windowStart = decision.windowStart ?? target.windowStart ?? ''
    const windowEnd = decision.windowEnd !== undefined ? decision.windowEnd : target.windowEnd ?? ''
    const validation = validateDraft({
      station: target.station,
      monitorType: target.monitorType,
      values: target.values,
      windowStart,
      windowEnd: windowEnd ?? '',
    })
    if (validation) {
      return fail(`复核未通过：${validation}`)
    }
    // 只拦截两个在途版本（待复核/已排期）的窗口冲突；与已生效版本重叠是正常的
    // 版本替换场景，生效时旧版会被原子归档并截断窗口。
    const inflight = state.configs.find(
      (item) =>
        item.id !== id &&
        item.seriesKey === target.seriesKey &&
        (item.status === '待复核' || item.status === '已排期') &&
        overlap(windowStart, windowEnd || null, item),
    )
    if (inflight) {
      return fail(`排期窗口与同系列 v${inflight.version}（${inflight.status}）重叠，请调整生效窗口`)
    }
  }

  try {
    let updated: ThresholdConfig | undefined
    withThresholdDraft((draft) => {
      const config = findConfig(draft, id)
      if (!config) {
        throw new Error('版本在处理过程中被删除')
      }
      if (decision.approve) {
        config.windowStart = decision.windowStart ?? config.windowStart
        config.windowEnd =
          decision.windowEnd !== undefined ? decision.windowEnd || null : config.windowEnd
        config.status = '已排期'
        config.reviewedBy = actor.name
        config.reviewedAt = nowIso()
        addReview(draft, {
          at: nowIso(),
          configId: id,
          configCode: config.code,
          station: config.station,
          monitorType: config.monitorType,
          version: config.version,
          action: '复核通过',
          fromStatus: '待复核',
          toStatus: '已排期',
          operator: actor.name,
          role: actor.role,
          comment: decision.comment,
          windowStart: config.windowStart,
          windowEnd: config.windowEnd,
        })
      } else {
        config.status = '已归档'
        config.archiveReason = `复核驳回：${decision.comment}`
        config.reviewedBy = actor.name
        config.reviewedAt = nowIso()
        config.archivedAt = nowIso()
        addReview(draft, {
          at: nowIso(),
          configId: id,
          configCode: config.code,
          station: config.station,
          monitorType: config.monitorType,
          version: config.version,
          action: '复核驳回',
          fromStatus: '待复核',
          toStatus: '已归档',
          operator: actor.name,
          role: actor.role,
          comment: decision.comment,
          windowStart: config.windowStart,
          windowEnd: config.windowEnd,
        })
      }
      updated = config
    })
    return {
      ok: true,
      message: decision.approve
        ? `v${target.version} 复核通过，已排期 ${target.windowStart ?? decision.windowStart} 起生效`
        : `v${target.version} 复核驳回，已归档（流程不回退到草稿）`,
      config: updated,
    }
  } catch (error) {
    return fail(error instanceof Error ? `复核失败，已保留旧版本：${error.message}` : '复核失败，已保留旧版本')
  }
}

/** 生效核心（不做角色判断、不触发扫描，供人工确认与定时扫描复用）。 */
function applyActivation(id: number, actor: ThresholdActor, day: string): ThresholdMutation {
  const target = thresholdState().configs.find((item) => item.id === id)
  if (!target) {
    return fail('没有找到对应阈值版本')
  }
  if (target.status !== '已排期') {
    return fail(`当前状态为「${target.status}」，只有已排期版本可以确认生效`)
  }
  if (!target.windowStart || target.windowStart > day) {
    return fail(`未到生效开始日（${target.windowStart ?? '未设定'}），不能提前生效`)
  }

  try {
    let updated: ThresholdConfig | undefined
    withThresholdDraft((draft) => {
      const config = findConfig(draft, id)
      if (!config) {
        throw new Error('版本在处理过程中被删除')
      }
      const start = config.windowStart as string
      config.status = '已生效'
      config.effectiveAt = start
      addReview(draft, {
        at: nowIso(),
        configId: id,
        configCode: config.code,
        station: config.station,
        monitorType: config.monitorType,
        version: config.version,
        action: '排期生效',
        fromStatus: '已排期',
        toStatus: '已生效',
        operator: actor.name,
        role: actor.role,
        windowStart: config.windowStart,
        windowEnd: config.windowEnd,
      })

      // 原子替换：同系列窗口与新版重叠的在效版本全部归档，窗口截断到新版生效前一天，
      // 历史水位仍可按观测时间解析到旧版门槛。
      for (const sibling of draft.configs) {
        if (
          sibling.seriesKey === config.seriesKey &&
          sibling.id !== config.id &&
          sibling.status === '已生效' &&
          inWindow(sibling, start)
        ) {
          const beforeStart = new Date(`${start}T00:00:00Z`)
          beforeStart.setUTCDate(beforeStart.getUTCDate() - 1)
          const cutEnd = beforeStart.toISOString().slice(0, 10)
          sibling.status = '已归档'
          sibling.archiveReason = `被 v${config.version}（${start} 起生效）替换，窗口截断至 ${cutEnd}`
          sibling.windowEnd = cutEnd
          sibling.archivedAt = nowIso()
          addReview(draft, {
            at: nowIso(),
            configId: sibling.id,
            configCode: sibling.code,
            station: sibling.station,
            monitorType: sibling.monitorType,
            version: sibling.version,
            action: '归档（被替换）',
            fromStatus: '已生效',
            toStatus: '已归档',
            operator: actor.name,
            role: actor.role,
            comment: sibling.archiveReason,
            windowStart: sibling.windowStart,
            windowEnd: sibling.windowEnd,
          })
        }
      }
      updated = config
    })
    return { ok: true, message: `v${target.version} 已生效，同系列旧版已归档并截断窗口`, config: updated }
  } catch (error) {
    return fail(error instanceof Error ? `生效失败，已保留旧版本：${error.message}` : '生效失败，已保留旧版本')
  }
}

/** 排期生效：调度主管确认；读侧会先自动推进到期版本，保证版本切换点落定。
 * 新版本生效时原子替换同系列旧版（旧版归档并截断窗口），任一时刻只留一份。 */
export function activateConfig(id: number, actor: ThresholdActor): ThresholdMutation {
  const roleError = assertRole(actor, ['调度主管'], '确认排期生效')
  if (roleError) {
    return fail(roleError)
  }
  return applyActivation(id, actor, today())
}

/** 手动归档（停用）。 */
export function archiveConfig(id: number, comment: string, actor: ThresholdActor): ThresholdMutation {
  const roleError = assertRole(actor, ['调度主管'], '归档/停用阈值')
  if (roleError) {
    return fail(roleError)
  }
  if (!comment.trim()) {
    return fail('请填写归档/停用原因')
  }
  const target = thresholdState().configs.find((item) => item.id === id)
  if (!target) {
    return fail('没有找到对应阈值版本')
  }
  if (target.status === '草稿') {
    return fail('草稿尚未生效，无需归档，请直接作废后重新登记')
  }
  if (target.status === '已归档') {
    return fail('该版本已归档')
  }

  try {
    let updated: ThresholdConfig | undefined
    withThresholdDraft((draft) => {
      const config = findConfig(draft, id)
      if (!config) {
        throw new Error('版本在处理过程中被删除')
      }
      const from = config.status
      config.status = '已归档'
      config.archiveReason = `手动归档：${comment}`
      config.archivedAt = nowIso()
      addReview(draft, {
        at: nowIso(),
        configId: id,
        configCode: config.code,
        station: config.station,
        monitorType: config.monitorType,
        version: config.version,
        action: '归档（手动停用）',
        fromStatus: from,
        toStatus: '已归档',
        operator: actor.name,
        role: actor.role,
        comment,
        windowStart: config.windowStart,
        windowEnd: config.windowEnd,
      })
      updated = config
    })
    return { ok: true, message: `v${target.version} 已归档`, config: updated }
  } catch (error) {
    return fail(error instanceof Error ? `归档失败，已保留旧版本：${error.message}` : '归档失败，已保留旧版本')
  }
}

/** 调整阈值：把已排期/已生效版本克隆成同系列下一版草稿，原版冻结。 */
export function adjustThreshold(id: number, actor: ThresholdActor): ThresholdMutation {
  const roleError = assertRole(actor, ['值班员', '调度主管'], '调整阈值')
  if (roleError) {
    return fail(roleError)
  }
  const target = thresholdState().configs.find((item) => item.id === id)
  if (!target) {
    return fail('没有找到对应阈值版本')
  }
  if (target.status !== '已排期' && target.status !== '已生效') {
    return fail(`当前状态为「${target.status}」，只能针对已排期或已生效版本发起调整`)
  }
  // 草稿窗口默认从明天开始，避免和旧版窗口重叠被拦。
  const tomorrow = new Date()
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const defaultStart = tomorrow.toISOString().slice(0, 10)

  try {
    let created: ThresholdConfig | undefined
    withThresholdDraft((draft) => {
      const source = findConfig(draft, id)
      if (!source) {
        throw new Error('版本在处理过程中被删除')
      }
      const version = nextVersion(draft.configs, source.seriesKey)
      const config: ThresholdConfig = {
        id: draft.seqConfig + 1,
        code: source.code,
        station: source.station,
        monitorType: source.monitorType,
        seriesKey: source.seriesKey,
        version,
        status: '草稿',
        values: { ...source.values },
        windowStart: null,
        windowEnd: null,
        draftWindowStart: defaultStart,
        draftWindowEnd: null,
        createdBy: actor.name,
        createdAt: nowIso(),
      }
      draft.seqConfig += 1
      draft.configs.push(config)
      addReview(draft, {
        at: nowIso(),
        configId: config.id,
        configCode: config.code,
        station: config.station,
        monitorType: config.monitorType,
        version: config.version,
        action: '调整阈值（克隆新版草稿）',
        toStatus: '草稿',
        operator: actor.name,
        role: actor.role,
        comment: `基于 v${source.version}（${source.status}）发起调整`,
        windowStart: null,
        windowEnd: null,
      })
      created = config
    })
    return { ok: true, message: `已基于 v${target.version} 生成下一版草稿 v${created?.version}`, config: created }
  } catch (error) {
    return fail(error instanceof Error ? `调整失败，已保留旧版本：${error.message}` : '调整失败，已保留旧版本')
  }
}

/** 草稿作废：直接归档终态，同样不允许退回后再走（记录删除但留痕）。 */
export function discardDraft(id: number, comment: string, actor: ThresholdActor): ThresholdMutation {
  const roleError = assertRole(actor, ['值班员', '调度主管'], '作废草稿')
  if (roleError) {
    return fail(roleError)
  }
  if (!comment.trim()) {
    return fail('请填写作废原因')
  }
  const target = thresholdState().configs.find((item) => item.id === id)
  if (!target) {
    return fail('没有找到对应阈值版本')
  }
  if (target.status !== '草稿') {
    return fail(`当前状态为「${target.status}」，只有草稿可以作废`)
  }
  if (target.createdBy !== actor.name && actor.role !== '调度主管') {
    return fail('越权操作：只能作废本人登记的草稿')
  }

  try {
    let updated: ThresholdConfig | undefined
    withThresholdDraft((draft) => {
      const config = findConfig(draft, id)
      if (!config) {
        throw new Error('版本在处理过程中被删除')
      }
      config.status = '已归档'
      config.archiveReason = `草稿作废：${comment}`
      config.archivedAt = nowIso()
      addReview(draft, {
        at: nowIso(),
        configId: id,
        configCode: config.code,
        station: config.station,
        monitorType: config.monitorType,
        version: config.version,
        action: '草稿作废',
        fromStatus: '草稿',
        toStatus: '已归档',
        operator: actor.name,
        role: actor.role,
        comment,
        windowStart: null,
        windowEnd: null,
      })
      updated = config
    })
    return { ok: true, message: `v${target.version} 草稿已作废归档`, config: updated }
  } catch (error) {
    return fail(error instanceof Error ? `作废失败，已保留旧版本：${error.message}` : '作废失败，已保留旧版本')
  }
}

/** 到期自动推进：已排期且到开始日 → 已生效并替换旧版；窗口到期 → 已归档。
 * 每次读数据时先调用，版本切换点 = windowStart。 */
export function sweepScheduled(): void {
  const day = today()
  // 到期排期按生效开始日、版本号顺序依次生效，避免同一批里的替换顺序不确定。
  const due = thresholdState()
    .configs.filter((item) => item.status === '已排期' && item.windowStart && item.windowStart <= day)
    .sort((a, b) => (a.windowStart as string).localeCompare(b.windowStart as string) || a.version - b.version)
  for (const config of due) {
    applyActivation(config.id, { name: '系统定时', role: '调度主管' }, day)
  }

  const expired = thresholdState().configs.filter(
    (item) => item.status === '已生效' && item.windowEnd && item.windowEnd < day,
  )
  for (const config of expired) {
    withThresholdDraft((draft) => {
      const target = findConfig(draft, config.id)
      if (!target || target.status !== '已生效') {
        return
      }
      target.status = '已归档'
      target.archiveReason = `生效窗口已于 ${target.windowEnd} 到期，自动归档`
      target.archivedAt = nowIso()
      addReview(draft, {
        at: nowIso(),
        configId: target.id,
        configCode: target.code,
        station: target.station,
        monitorType: target.monitorType,
        version: target.version,
        action: '归档（窗口到期）',
        fromStatus: '已生效',
        toStatus: '已归档',
        operator: '系统定时',
        role: '调度主管',
        comment: target.archiveReason,
        windowStart: target.windowStart,
        windowEnd: target.windowEnd,
      })
    })
  }
}

// ---- 查询 ----

export function listConfigs(): ThresholdConfig[] {
  sweepScheduled()
  return [...thresholdState().configs].sort(
    (a, b) =>
      a.station.localeCompare(b.station) ||
      a.monitorType.localeCompare(b.monitorType) ||
      b.version - a.version ||
      b.id - a.id,
  )
}

export function listReviews(station = ''): ThresholdReview[] {
  const rows = station.trim()
    ? thresholdState().reviews.filter((item) => item.station.includes(station.trim()))
    : thresholdState().reviews
  return [...rows].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
}

/** 沿水位数据流解析某站点、某监测类型、某观测时刻「当时」适用的门槛版本。
 * 版本切换点 = 新版本 windowStart；窗口重叠时：生效开始更晚者优先，同日版本号更大者优先。
 * 已归档版本的窗口已在替换时截断，因此历史观测解析到的永远是当时那一版。 */
export function resolveThresholdAt(
  station: string,
  monitorType: string,
  observedAt: string,
): ResolvedThreshold | null {
  const day = observedAt.slice(0, 10)
  const candidates = thresholdState().configs.filter(
    (item) =>
      item.station === station &&
      item.monitorType === monitorType &&
      (item.status === '已排期' || item.status === '已生效' || item.status === '已归档') &&
      inWindow(item, day),
  )
  if (!candidates.length) {
    return null
  }
  candidates.sort(
    (a, b) =>
      (b.windowStart as string).localeCompare(a.windowStart as string) || b.version - a.version,
  )
  const config = candidates[0]
  return { config, values: config.values }
}

/** 根据水位值和当时门槛判定预警等级；阈值非数字（老迁移数据）时返回 null。 */
export function judgeLevel(values: ThresholdValues, levelValue: string | number): LevelResult {
  const num = toNumber(levelValue)
  if (num === null) {
    return null
  }
  const thresholds = LEVEL_FIELDS.map((field) => toNumber(values[field]))
  const names = ['蓝色预警', '黄色预警', '橙色预警', '红色预警']
  let hit: LevelResult = null
  thresholds.forEach((threshold, index) => {
    if (threshold !== null && num >= threshold) {
      hit = { level: names[index], levelIndex: index }
    }
  })
  return hit
}

export function statusOrder(status: ThresholdStatus): number {
  return STATUS_ORDER.indexOf(status)
}

export function levelLabels(): { field: (typeof LEVEL_FIELDS)[number]; name: string }[] {
  return LEVEL_FIELDS.map((field) => ({ field, name: `${LEVEL_NAMES[field]}阈值` }))
}

export function thresholdStats(): { label: string; value: number }[] {
  const configs = listConfigs()
  const monthPrefix = today().slice(0, 7)
  return [
    { label: '版本总数', value: configs.length },
    { label: '生效中版本', value: configs.filter((item) => item.status === '已生效').length },
    { label: '待复核', value: configs.filter((item) => item.status === '待复核').length },
    { label: '已排期', value: configs.filter((item) => item.status === '已排期').length },
    {
      label: '本月调整草稿',
      value: configs.filter(
        (item) => item.status === '草稿' && item.createdAt.slice(0, 7) === monthPrefix,
      ).length,
    },
  ]
}

export function exportThresholdsCsv(): { filename: string; content: string } {
  const header = ['配置编号', '版本', '站点编号', '监测类型', '蓝色阈值', '黄色阈值', '橙色阈值', '红色阈值', '生效开始', '生效结束', '状态', '登记人', '提交人', '复核人']
  const lines = [header.join(',')]
  for (const item of listConfigs()) {
    lines.push(
      [
        item.code,
        `v${item.version}`,
        item.station,
        item.monitorType,
        item.values.blue,
        item.values.yellow,
        item.values.orange,
        item.values.red,
        item.windowStart ?? '',
        item.windowEnd ?? '长期',
        item.status,
        item.createdBy,
        item.submittedBy ?? '',
        item.reviewedBy ?? '',
      ].join(','),
    )
  }
  return { filename: '预警阈值-版本清单.csv', content: `\uFEFF${lines.join('\n')}` }
}
