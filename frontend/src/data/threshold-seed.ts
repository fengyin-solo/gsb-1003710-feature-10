import type { ThresholdConfig, ThresholdReview } from './threshold-types'

// 新版本化阈值的演示数据：围绕三个水位站点构造历史版本、排期版本与生效窗口重叠场景。
// 时间锚点为 2026-10-04，便于直接看到「当时门槛」「窗口切换」「重叠裁决」的效果。

type SeedPieces = {
  configs: ThresholdConfig[]
  reviews: ThresholdReview[]
  seqConfig: number
  seqReview: number
}

type Counter = { config: number; review: number }

export function makeThresholdSeed(startConfig: number, startReview: number): SeedPieces {
  const counter: Counter = { config: startConfig, review: startReview }
  const configs: ThresholdConfig[] = []
  const reviews: ThresholdReview[] = []

  function push(
    partial: Omit<ThresholdConfig, 'id'>,
    chain: Array<{
      action: string
      at: string
      operator: string
      role: string
      comment?: string
      fromStatus?: ThresholdConfig['status']
      toStatus?: ThresholdConfig['status']
    }>,
  ): ThresholdConfig {
    counter.config += 1
    const id = counter.config
    const config: ThresholdConfig = { id, ...partial }
    configs.push(config)
    for (const item of chain) {
      counter.review += 1
      const review: ThresholdReview = {
        id: counter.review,
        at: item.at,
        configId: id,
        configCode: config.code,
        station: config.station,
        monitorType: config.monitorType,
        version: config.version,
        action: item.action,
        fromStatus: item.fromStatus,
        toStatus: item.toStatus,
        operator: item.operator,
        role: item.role,
        comment: item.comment,
        windowStart: config.windowStart,
        windowEnd: config.windowEnd,
      }
      reviews.push(review)
    }
    return config
  }

  // WATE-0001：v1 已被新版替换而归档（窗口截至 9/30），v2 自 10/1 生效——窗口首尾相接，
  // 9 月份的历史水位继续引用 v1 门槛。
  push(
    {
      code: 'WARN-1001',
      station: 'WATE-0001',
      monitorType: '水位',
      seriesKey: 'WATE-0001#水位',
      version: 1,
      status: '已归档',
      values: { blue: 30, yellow: 35, orange: 38, red: 40 },
      windowStart: '2025-05-01',
      windowEnd: '2026-09-30',
      archiveReason: '新版 v2 于 2026-10-01 生效，本版按「被替换」归档',
      createdBy: '王观测',
      createdAt: '2025-04-20T02:10:00.000Z',
      submittedBy: '王观测',
      submittedAt: '2025-04-21T01:30:00.000Z',
      reviewedBy: '李复核',
      reviewedAt: '2025-04-22T03:00:00.000Z',
      effectiveAt: '2025-05-01',
      archivedAt: '2026-10-01T00:00:00.000Z',
    },
    [
      { action: '提交复核', at: '2025-04-21T01:30:00.000Z', operator: '王观测', role: '值班员', fromStatus: '草稿', toStatus: '待复核', comment: '汛期前下发门槛' },
      { action: '复核通过', at: '2025-04-22T03:00:00.000Z', operator: '李复核', role: '复核员', fromStatus: '待复核', toStatus: '已排期', comment: '等级递升，窗口合理，准予排期' },
      { action: '排期生效', at: '2025-05-01T00:00:00.000Z', operator: '赵调度', role: '调度主管', fromStatus: '已排期', toStatus: '已生效' },
      { action: '归档（被替换）', at: '2026-10-01T00:00:00.000Z', operator: '赵调度', role: '调度主管', fromStatus: '已生效', toStatus: '已归档', comment: 'v2 生效，自动归档并截断窗口' },
    ],
  )
  push(
    {
      code: 'WARN-1001',
      station: 'WATE-0001',
      monitorType: '水位',
      seriesKey: 'WATE-0001#水位',
      version: 2,
      status: '已生效',
      values: { blue: 32, yellow: 36, orange: 39, red: 41.5 },
      windowStart: '2026-10-01',
      windowEnd: null,
      createdBy: '王观测',
      createdAt: '2026-09-20T06:00:00.000Z',
      submittedBy: '王观测',
      submittedAt: '2026-09-21T02:00:00.000Z',
      reviewedBy: '李复核',
      reviewedAt: '2026-09-22T02:30:00.000Z',
      effectiveAt: '2026-10-01',
    },
    [
      { action: '提交复核', at: '2026-09-21T02:00:00.000Z', operator: '王观测', role: '值班员', fromStatus: '草稿', toStatus: '待复核', comment: '秋汛抬高蓝/黄阈值' },
      { action: '复核通过', at: '2026-09-22T02:30:00.000Z', operator: '李复核', role: '复核员', fromStatus: '待复核', toStatus: '已排期', comment: '与 v1 窗口首尾相接，无重叠' },
      { action: '排期生效', at: '2026-10-01T00:00:00.000Z', operator: '赵调度', role: '调度主管', fromStatus: '已排期', toStatus: '已生效' },
    ],
  )

  // WATE-0002：v1 长期生效中，v2 已排期到 10/10。
  push(
    {
      code: 'WARN-1002',
      station: 'WATE-0002',
      monitorType: '水位',
      seriesKey: 'WATE-0002#水位',
      version: 1,
      status: '已生效',
      values: { blue: 28, yellow: 33, orange: 36, red: 39 },
      windowStart: '2026-01-01',
      windowEnd: null,
      createdBy: '王观测',
      createdAt: '2025-12-25T01:00:00.000Z',
      submittedBy: '王观测',
      submittedAt: '2025-12-26T01:00:00.000Z',
      reviewedBy: '李复核',
      reviewedAt: '2025-12-27T01:00:00.000Z',
      effectiveAt: '2026-01-01',
    },
    [
      { action: '提交复核', at: '2025-12-26T01:00:00.000Z', operator: '王观测', role: '值班员', fromStatus: '草稿', toStatus: '待复核' },
      { action: '复核通过', at: '2025-12-27T01:00:00.000Z', operator: '李复核', role: '复核员', fromStatus: '待复核', toStatus: '已排期' },
      { action: '排期生效', at: '2026-01-01T00:00:00.000Z', operator: '赵调度', role: '调度主管', fromStatus: '已排期', toStatus: '已生效' },
    ],
  )
  push(
    {
      code: 'WARN-1002',
      station: 'WATE-0002',
      monitorType: '水位',
      seriesKey: 'WATE-0002#水位',
      version: 2,
      status: '已排期',
      values: { blue: 30, yellow: 34, orange: 37, red: 40 },
      windowStart: '2026-10-10',
      windowEnd: null,
      createdBy: '王观测',
      createdAt: '2026-09-25T07:00:00.000Z',
      submittedBy: '王观测',
      submittedAt: '2026-09-26T02:00:00.000Z',
      reviewedBy: '李复核',
      reviewedAt: '2026-09-27T02:00:00.000Z',
      effectiveAt: null,
    },
    [
      { action: '提交复核', at: '2026-09-26T02:00:00.000Z', operator: '王观测', role: '值班员', fromStatus: '草稿', toStatus: '待复核', comment: '10 月中旬切换' },
      { action: '复核通过', at: '2026-09-27T02:00:00.000Z', operator: '李复核', role: '复核员', fromStatus: '待复核', toStatus: '已排期', comment: '10/10 起生效，到期前继续沿用 v1' },
    ],
  )

  // WATE-0003：v1 汛后手动停用归档（窗口只到 8/31），v2 自 9/1 起生效。
  push(
    {
      code: 'WARN-1003',
      station: 'WATE-0003',
      monitorType: '水位',
      seriesKey: 'WATE-0003#水位',
      version: 1,
      status: '已归档',
      values: { blue: 25, yellow: 29, orange: 32, red: 35 },
      windowStart: '2026-01-01',
      windowEnd: '2026-08-31',
      archiveReason: '汛后手动停用',
      createdBy: '王观测',
      createdAt: '2025-12-20T01:00:00.000Z',
      submittedBy: '王观测',
      submittedAt: '2025-12-21T01:00:00.000Z',
      reviewedBy: '李复核',
      reviewedAt: '2025-12-22T01:00:00.000Z',
      effectiveAt: '2026-01-01',
      archivedAt: '2026-09-01T00:00:00.000Z',
    },
    [
      { action: '提交复核', at: '2025-12-21T01:00:00.000Z', operator: '王观测', role: '值班员', fromStatus: '草稿', toStatus: '待复核' },
      { action: '复核通过', at: '2025-12-22T01:00:00.000Z', operator: '李复核', role: '复核员', fromStatus: '待复核', toStatus: '已排期' },
      { action: '排期生效', at: '2026-01-01T00:00:00.000Z', operator: '赵调度', role: '调度主管', fromStatus: '已排期', toStatus: '已生效' },
      { action: '归档（手动停用）', at: '2026-09-01T00:00:00.000Z', operator: '赵调度', role: '调度主管', fromStatus: '已生效', toStatus: '已归档', comment: '汛后停用，窗口截至 8/31' },
    ],
  )
  push(
    {
      code: 'WARN-1003',
      station: 'WATE-0003',
      monitorType: '水位',
      seriesKey: 'WATE-0003#水位',
      version: 2,
      status: '已生效',
      values: { blue: 26, yellow: 30, orange: 33, red: 36 },
      windowStart: '2026-09-01',
      windowEnd: null,
      createdBy: '王观测',
      createdAt: '2026-08-25T02:00:00.000Z',
      submittedBy: '王观测',
      submittedAt: '2026-08-26T02:00:00.000Z',
      reviewedBy: '李复核',
      reviewedAt: '2026-08-27T02:00:00.000Z',
      effectiveAt: '2026-09-01',
    },
    [
      { action: '提交复核', at: '2026-08-26T02:00:00.000Z', operator: '王观测', role: '值班员', fromStatus: '草稿', toStatus: '待复核' },
      { action: '复核通过', at: '2026-08-27T02:00:00.000Z', operator: '李复核', role: '复核员', fromStatus: '待复核', toStatus: '已排期' },
      { action: '排期生效', at: '2026-09-01T00:00:00.000Z', operator: '赵调度', role: '调度主管', fromStatus: '已排期', toStatus: '已生效' },
    ],
  )

  return { configs, reviews, seqConfig: counter.config, seqReview: counter.review }
}
