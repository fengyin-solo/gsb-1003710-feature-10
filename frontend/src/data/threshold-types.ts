/** 预警阈值版本化配置的领域类型。
 * 一套配置按「站点 + 监测类型」归为一个系列（series），每次调整产生新版本；
 * 版本一经排期其门槛与生效窗口即冻结，历史水位永远引用得到当时那一版。 */

export const THRESHOLD_STATUS = ['草稿', '待复核', '已排期', '已生效', '已归档'] as const
export type ThresholdStatus = (typeof THRESHOLD_STATUS)[number]

export type ThresholdValues = {
  blue: number | string
  yellow: number | string
  orange: number | string
  red: number | string
}

export type ThresholdConfig = {
  id: number
  /** 配置编号，同系列各版本共用业务编号、以版本号区分 */
  code: string
  station: string
  monitorType: string
  /** 系列键：站点 + 监测类型 */
  seriesKey: string
  version: number
  status: ThresholdStatus
  values: ThresholdValues
  /** 生效窗口：起必选（排期时定型），止为空表示长期有效；日期按天、含端点 */
  windowStart: string | null
  windowEnd: string | null
  /** 草稿阶段的窗口草稿输入，提交复核时一并校验 */
  draftWindowStart?: string | null
  draftWindowEnd?: string | null
  archiveReason?: string
  createdBy: string
  createdAt: string
  submittedBy?: string
  submittedAt?: string
  reviewedBy?: string
  reviewedAt?: string
  effectiveAt?: string | null
  archivedAt?: string | null
  /** 旧配置迁移来源（老 EntryRow 的 id），有值表示这一版来自迁移 */
  migratedFromId?: number
}

export type ThresholdReview = {
  id: number
  at: string
  configId: number
  configCode: string
  station: string
  monitorType: string
  version: number
  action: string
  fromStatus?: ThresholdStatus
  toStatus?: ThresholdStatus
  operator: string
  role: string
  comment?: string
  windowStart?: string | null
  windowEnd?: string | null
}

export type ThresholdState = {
  schema: 1
  configs: ThresholdConfig[]
  reviews: ThresholdReview[]
  seqConfig: number
  seqReview: number
  migrated: boolean
}

export type ThresholdActor = {
  name: string
  role: ThresholdRole
}

export type ThresholdRole = '值班员' | '复核员' | '调度主管'

export type ThresholdMutation = ActionResult & {
  config?: ThresholdConfig
}

type ActionResult = {
  ok: boolean
  message: string
}
