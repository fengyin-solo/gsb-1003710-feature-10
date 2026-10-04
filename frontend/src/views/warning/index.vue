<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">
          阈值按「站点 + 监测类型」分版本管理：草稿校验后提交，状态沿
          草稿 → 待复核 → 已排期 → 已生效 → 已归档 单向推进，任何阶段都不退回草稿；
          每版带生效窗口，历史水位始终引用观测当时那一版门槛。
        </p>
      </div>
      <div class="page-actions">
        <label class="role-switch">
          当班角色
          <select v-model="role" @change="onRoleChange">
            <option v-for="item in roleOptions" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <button class="btn primary" type="button" @click="openCreate">登记阈值草稿</button>
        <button class="btn" type="button" @click="exportRows">导出版本清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>站点编号</span>
        <input v-model="stationFilter" placeholder="按站点编号检索" />
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option v-for="item in statuses" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>配置编号</th>
          <th>版本</th>
          <th>站点编号</th>
          <th>监测类型</th>
          <th>蓝/黄/橙/红阈值</th>
          <th>生效窗口</th>
          <th>当前状态</th>
          <th>登记/复核</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="row.id">
          <td>{{ row.code }}</td>
          <td>v{{ row.version }}</td>
          <td>{{ row.station }}</td>
          <td>{{ row.monitorType }}</td>
          <td class="threshold-cell">
            {{ row.values.blue }} / {{ row.values.yellow }} / {{ row.values.orange }} / {{ row.values.red }}
          </td>
          <td>
            <span v-if="row.status === '草稿'" class="muted">
              拟 {{ row.draftWindowStart || '—' }} ~ {{ row.draftWindowEnd || '长期' }}
            </span>
            <span v-else>{{ row.windowStart }} ~ {{ row.windowEnd || '长期' }}</span>
          </td>
          <td>
            <span :class="['status-badge', statusClass(row.status)]">{{ row.status }}</span>
            <div v-if="row.archiveReason" class="cell-note" :title="row.archiveReason">
              {{ row.archiveReason }}
            </div>
          </td>
          <td class="muted small">
            <div>{{ row.createdBy }}</div>
            <div v-if="row.reviewedBy">复核：{{ row.reviewedBy }}</div>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action.key"
              class="link"
              type="button"
              @click="onAction(action.key, row)"
            >
              {{ action.label }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="9" class="empty-state">暂无匹配的阈值版本，可先登记阈值草稿</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 个版本；窗口重叠时以生效开始更晚（同日则版本号更大）的一版为准</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 登记草稿 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <form class="modal" @submit.prevent="submitCreate">
        <h3>登记预警阈值草稿</h3>
        <p class="muted small">草稿保存前先做校验：阈值须为数字且 蓝 ≤ 黄 ≤ 橙 ≤ 红，窗口结束不得早于开始。</p>
        <div class="form-grid">
          <label>
            <span>站点编号</span>
            <input v-model="form.station" placeholder="如 WATE-0001" />
          </label>
          <label>
            <span>监测类型</span>
            <input v-model="form.monitorType" placeholder="如 水位" />
          </label>
          <label v-for="item in levelColumns" :key="item.field">
            <span>{{ item.name }}</span>
            <input v-model="form.values[item.field]" inputmode="decimal" />
          </label>
          <label>
            <span>生效开始</span>
            <input v-model="form.windowStart" type="date" />
          </label>
          <label>
            <span>生效结束（空为长期）</span>
            <input v-model="form.windowEnd" type="date" />
          </label>
        </div>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="creating = false">取消</button>
          <button class="btn primary" type="submit">校验并保存草稿</button>
        </div>
      </form>
    </div>

    <!-- 复核对话框 -->
    <div v-if="reviewing" class="modal-mask" @click.self="reviewing = null">
      <form class="modal" @submit.prevent="submitReview(true)">
        <h3>复核 {{ reviewing.code }} v{{ reviewing.version }}</h3>
        <p class="muted small">
          当前窗口 {{ reviewing.windowStart }} ~ {{ reviewing.windowEnd || '长期' }}；
          通过即进入已排期，驳回则直接归档，均不会退回草稿。
        </p>
        <div class="form-grid">
          <label>
            <span>复核确认生效开始</span>
            <input v-model="reviewForm.windowStart" type="date" />
          </label>
          <label>
            <span>复核确认生效结束</span>
            <input v-model="reviewForm.windowEnd" type="date" />
          </label>
        </div>
        <label class="comment-field">
          <span>复核意见（必填）</span>
          <textarea v-model="reviewForm.comment" rows="3" placeholder="通过或驳回都需写明依据"></textarea>
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="reviewing = null">取消</button>
          <button class="btn danger" type="button" @click="submitReview(false)">驳回并归档</button>
          <button class="btn primary" type="submit">复核通过并排期</button>
        </div>
      </form>
    </div>

    <!-- 通用原因对话框（归档 / 作废） -->
    <div v-if="reasonTarget" class="modal-mask" @click.self="reasonTarget = null">
      <form class="modal" @submit.prevent="submitReason">
        <h3>{{ reasonTarget.title }}</h3>
        <label class="comment-field">
          <span>原因（必填，写入复核记录）</span>
          <textarea v-model="reasonForm" rows="3"></textarea>
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="reasonTarget = null">取消</button>
          <button class="btn primary" type="submit">确认</button>
        </div>
      </form>
    </div>

    <!-- 版本流转记录 -->
    <div v-if="timeline" class="drawer-mask" @click.self="timeline = null">
      <aside class="drawer">
        <div class="drawer-head">
          <h3>{{ timeline.code }} 系列复核记录</h3>
          <button class="link" type="button" @click="timeline = null">关闭</button>
        </div>
        <p class="muted small">{{ timeline.station }} · {{ timeline.monitorType }}，共 {{ timelineVersions.length }} 个版本</p>
        <div v-for="version in timelineVersions" :key="version.id" class="timeline-version">
          <div class="timeline-version-head">
            <strong>v{{ version.version }}</strong>
            <span :class="['status-badge', statusClass(version.status)]">{{ version.status }}</span>
            <span class="muted small">{{ version.windowStart || '未排期' }} ~ {{ version.windowEnd || '长期' }}</span>
          </div>
          <ul class="timeline-list">
            <li v-for="item in reviewsByConfig.get(version.id) || []" :key="item.id">
              <div class="timeline-when">{{ item.at.replace('T', ' ').slice(0, 16) }} · {{ item.action }}</div>
              <div class="small">
                {{ item.operator }}（{{ item.role }}）
                <template v-if="item.fromStatus">：{{ item.fromStatus }} → {{ item.toStatus }}</template>
              </div>
              <div v-if="item.comment" class="small muted">{{ item.comment }}</div>
            </li>
            <li v-if="!(reviewsByConfig.get(version.id) || []).length" class="muted small">暂无记录</li>
          </ul>
        </div>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  activateConfig,
  adjustThreshold,
  archiveConfig,
  createDraft,
  discardDraft,
  exportThresholdsCsv,
  levelLabels,
  listConfigs,
  listReviews,
  reviewConfig,
  submitForReview,
  thresholdStats,
} from '@/api/threshold-service'
import type { ThresholdConfig } from '@/data/threshold-types'
import { ROLE_OPTIONS, useSessionStore } from '@/stores/session'

const store = useSessionStore()
const roleOptions = ROLE_OPTIONS

const statuses = ['草稿', '待复核', '已排期', '已生效', '已归档']
const levelColumns = levelLabels()

const rows = ref<ThresholdConfig[]>([])
const reviews = ref(listReviews())
const stats = ref(thresholdStats())
const message = ref('')
const messageOk = ref(false)

const stationFilter = ref('')
const statusFilter = ref('')
const role = ref(store.role)

const creating = ref(false)
const reviewing = ref<ThresholdConfig | null>(null)
const timeline = ref<ThresholdConfig | null>(null)
const reasonTarget = ref<{ id: number; kind: 'archive' | 'discard'; title: string } | null>(null)
const formError = ref('')

const form = reactive({
  station: '',
  monitorType: '水位',
  values: { blue: '', yellow: '', orange: '', red: '' },
  windowStart: '',
  windowEnd: '',
})

const reviewForm = reactive({ windowStart: '', windowEnd: '', comment: '' })
const reasonForm = ref('')

const filteredRows = computed(() =>
  rows.value.filter(
    (row) =>
      (!stationFilter.value.trim() || row.station.includes(stationFilter.value.trim())) &&
      (!statusFilter.value || row.status === statusFilter.value),
  ),
)

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

const reviewsByConfig = computed(() => {
  const map = new Map<number, ReturnType<typeof listReviews>>()
  for (const item of reviews.value) {
    const bucket = map.get(item.configId) ?? []
    bucket.push(item)
    map.set(item.configId, bucket)
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
  }
  return map
})

function flash(text: string, ok = false) {
  message.value = text
  messageOk.value = ok
}

function reload() {
  rows.value = listConfigs()
  reviews.value = listReviews()
  stats.value = thresholdStats()
}

function resetFilters() {
  stationFilter.value = ''
  statusFilter.value = ''
}

function onRoleChange() {
  store.setRole(role.value)
  flash(`已切换为 ${store.role}（${store.operator}）`, true)
}

function statusClass(status: string): string {
  return {
    草稿: 'st-draft',
    待复核: 'st-review',
    已排期: 'st-scheduled',
    已生效: 'st-active',
    已归档: 'st-archived',
  }[status] ?? ''
}

type AvailableAction = {
  key: 'submit' | 'review' | 'activate' | 'adjust' | 'archive' | 'discard' | 'timeline'
  label: string
}

function availableActions(row: ThresholdConfig): AvailableAction[] {
  const actions: AvailableAction[] = [{ key: 'timeline', label: '流转记录' }]
  const isManager = store.role === '调度主管'
  const isDuty = store.role === '值班员' || isManager
  const isReviewer = store.role === '复核员' || isManager

  if (row.status === '草稿') {
    if (isDuty && (row.createdBy === store.operator || isManager)) {
      actions.unshift({ key: 'submit', label: '提交复核' })
      actions.push({ key: 'discard', label: '作废' })
    }
  } else if (row.status === '待复核') {
    if (isReviewer && row.submittedBy !== store.operator) {
      actions.unshift({ key: 'review', label: '办理复核' })
    }
  } else if (row.status === '已排期') {
    if (isManager && (row.windowStart ?? '9999') <= new Date().toISOString().slice(0, 10)) {
      actions.unshift({ key: 'activate', label: '确认生效' })
    }
    if (isDuty) {
      actions.push({ key: 'adjust', label: '调整阈值' })
    }
    if (isManager) {
      actions.push({ key: 'archive', label: '撤销排期' })
    }
  } else if (row.status === '已生效') {
    if (isDuty) {
      actions.unshift({ key: 'adjust', label: '调整阈值' })
    }
    if (isManager) {
      actions.push({ key: 'archive', label: '停用归档' })
    }
  }
  return actions
}

function openCreate() {
  Object.assign(form, {
    station: '',
    monitorType: '水位',
    values: { blue: '', yellow: '', orange: '', red: '' },
    windowStart: new Date().toISOString().slice(0, 10),
    windowEnd: '',
  })
  formError.value = ''
  creating.value = true
}

function submitCreate() {
  formError.value = ''
  const result = createDraft(
    {
      station: form.station,
      monitorType: form.monitorType,
      values: { ...form.values },
      windowStart: form.windowStart,
      windowEnd: form.windowEnd,
    },
    store.actor,
  )
  if (!result.ok) {
    formError.value = result.message
    return
  }
  creating.value = false
  reload()
  flash(result.message, true)
}

function onAction(key: AvailableAction['key'], row: ThresholdConfig) {
  formError.value = ''
  if (key === 'timeline') {
    timeline.value = row
    return
  }
  if (key === 'submit') {
    handleResult(submitForReview(row.id, store.actor))
    return
  }
  if (key === 'activate') {
    handleResult(activateConfig(row.id, store.actor))
    return
  }
  if (key === 'adjust') {
    handleResult(adjustThreshold(row.id, store.actor))
    return
  }
  if (key === 'review') {
    reviewing.value = row
    reviewForm.windowStart = row.windowStart ?? ''
    reviewForm.windowEnd = row.windowEnd ?? ''
    reviewForm.comment = ''
    return
  }
  if (key === 'archive') {
    reasonTarget.value = {
      id: row.id,
      kind: 'archive',
      title: row.status === '已排期' ? `撤销排期 v${row.version}` : `停用归档 v${row.version}`,
    }
    reasonForm.value = ''
    return
  }
  if (key === 'discard') {
    reasonTarget.value = { id: row.id, kind: 'discard', title: `作废草稿 v${row.version}` }
    reasonForm.value = ''
  }
}

function submitReview(approve: boolean) {
  if (!reviewing.value) {
    return
  }
  formError.value = ''
  const result = reviewConfig(
    reviewing.value.id,
    {
      approve,
      comment: reviewForm.comment,
      windowStart: reviewForm.windowStart,
      windowEnd: reviewForm.windowEnd,
    },
    store.actor,
  )
  if (!result.ok) {
    formError.value = result.message
    return
  }
  reviewing.value = null
  handleResult(result)
}

function submitReason() {
  if (!reasonTarget.value) {
    return
  }
  formError.value = ''
  const { id, kind } = reasonTarget.value
  const result =
    kind === 'archive'
      ? archiveConfig(id, reasonForm.value, store.actor)
      : discardDraft(id, reasonForm.value, store.actor)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  reasonTarget.value = null
  handleResult(result)
}

function handleResult(result: { ok: boolean; message: string }) {
  if (!result.ok) {
    flash(result.message, false)
    return
  }
  reload()
  flash(result.message, true)
}

function exportRows() {
  // 阈值是版本化数据，走专门的导出。
  const { filename, content } = exportThresholdsCsv()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 时间线抽屉按系列展示全部版本（版本切换点一目了然）
const timelineVersions = computed(() =>
  timeline.value
    ? rows.value
        .filter((item) => item.seriesKey === timeline.value?.seriesKey)
        .sort((a, b) => b.version - a.version)
    : [],
)

onMounted(reload)
</script>

<style scoped>
.role-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
}
.role-switch select {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fff;
}
.threshold-cell {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 12px;
}
.cell-note {
  font-size: 12px;
  color: var(--muted);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ok-text {
  color: #067647;
}
.status-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
}
.st-draft { background: #eef2f7; color: #475569; }
.st-review { background: #fef3c7; color: #92400e; }
.st-scheduled { background: #dbeafe; color: #1e40af; }
.st-active { background: #dcfce7; color: #166534; }
.st-archived { background: #f1f5f9; color: #64748b; }
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  width: 560px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 60px);
  overflow: auto;
}
.modal h3 { margin: 0 0 8px; }
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
  margin: 12px 0;
}
.form-grid label span,
.comment-field span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 3px;
}
.form-grid input,
.comment-field textarea {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.comment-field { display: block; margin: 10px 0; }
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.btn.danger {
  border-color: #fda29b;
  color: #b42318;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.35);
  z-index: 40;
}
.drawer {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 440px;
  max-width: 92vw;
  background: #fff;
  padding: 18px;
  overflow: auto;
  box-shadow: -8px 0 24px rgba(15, 23, 42, 0.15);
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.drawer-head h3 { margin: 0; }
.timeline-version {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 10px 0;
}
.timeline-version-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.timeline-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  border-left: 2px solid #e2e8f0;
}
.timeline-list li {
  position: relative;
  padding: 4px 0 8px 14px;
}
.timeline-list li::before {
  content: '';
  position: absolute;
  left: -5px;
  top: 9px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--brand);
}
.timeline-when { font-size: 12px; font-weight: 600; }
</style>
