<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">
          阈值配置按「草稿 → 待复核 → 已排期 → 已生效 → 已归档」推进，草稿先通过校验才能提交复核；
          同一站点同一监测类型允许窗口重叠，生效起始较晚的版本优先，历史水位仍引用当时的门槛。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记预警阈值配置</button>
        <button class="btn" type="button" @click="exportRows">导出预警阈值清单</button>
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
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button
              v-if="row.status === '已生效'"
              class="link"
              type="button"
              @click="adjust(row)"
            >
              调整阈值
            </button>
            <span v-if="!actionsFor(row).length && row.status !== '已生效'" class="muted-text">无</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无预警阈值数据，可先登记预警阈值配置</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警阈值记录 · 当前角色「{{ store.role }}」</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <div v-if="createVisible" class="modal-mask" @click.self="createVisible = false">
      <form class="modal" @submit.prevent="submitCreate">
        <h3>登记预警阈值配置（草稿）</h3>
        <div class="form-grid">
          <label class="form-item">
            <span>站点编号</span>
            <input v-model="draft.站点编号" placeholder="如 STAT-0001" required />
          </label>
          <label class="form-item">
            <span>监测类型</span>
            <select v-model="draft.监测类型">
              <option v-for="kind in monitorTypes" :key="kind" :value="kind">{{ kind }}</option>
            </select>
          </label>
          <label v-for="field in thresholdFields" :key="field" class="form-item">
            <span>{{ field }}</span>
            <input v-model="draft[field]" placeholder="数字，四级逐级递增" required />
          </label>
          <label class="form-item">
            <span>生效起始</span>
            <input v-model="draft.生效起始" type="date" required />
          </label>
          <label class="form-item">
            <span>生效截止</span>
            <input v-model="draft.生效截止" type="date" required />
          </label>
        </div>
        <p class="modal-tip">保存为草稿；提交复核时会先做完整校验，同一窗口的在途配置只保留一份。</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">保存草稿</button>
          <button class="btn ghost" type="button" @click="createVisible = false">取消</button>
        </div>
      </form>
    </div>

    <div v-if="reviewTarget" class="modal-mask" @click.self="reviewTarget = null">
      <form class="modal" @submit.prevent="submitReview">
        <h3>复核排期 · {{ reviewTarget['配置编号'] }}（v{{ reviewTarget['版本号'] }}）</h3>
        <label class="form-item">
          <span>复核意见</span>
          <textarea v-model="reviewOpinion" rows="3" placeholder="填写复核意见，将同步到水位监测页面"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn primary" type="submit">复核通过并排期</button>
          <button class="btn ghost" type="button" @click="reviewTarget = null">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  ACTIONS_BY_STATUS,
  adjustVersion,
  createDraft,
  listWarnings,
  runThresholdAction,
  type ThresholdAction,
  type ThresholdStatus,
} from '@/api/threshold-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('warning')
const store = useSessionStore()
const columns = meta.fields
const statuses = meta.statuses
const thresholdFields = ['蓝色阈值', '黄色阈值', '橙色阈值', '红色阈值'] as const
const monitorTypes = ['水位', '流量', '雨量']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const createVisible = ref(false)
const reviewTarget = ref<EntryRow | null>(null)
const reviewOpinion = ref('')
const draft = ref({
  站点编号: '',
  监测类型: '水位',
  蓝色阈值: '',
  黄色阈值: '',
  橙色阈值: '',
  红色阈值: '',
  生效起始: '',
  生效截止: '',
})

const stats = computed(() => [
  { label: '配置总数', value: rows.value.length },
  { label: '已生效数', value: rows.value.filter((row) => row.status === '已生效').length },
  { label: '待复核数', value: rows.value.filter((row) => row.status === '待复核').length },
  { label: '已排期数', value: rows.value.filter((row) => row.status === '已排期').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function actionsFor(row: EntryRow): ThresholdAction[] {
  return ACTIONS_BY_STATUS[row.status as ThresholdStatus] ?? []
}

function notify(result: { ok: boolean; message: string }) {
  message.value = result.message
  messageOk.value = result.ok
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  draft.value = {
    站点编号: '',
    监测类型: '水位',
    蓝色阈值: '',
    黄色阈值: '',
    橙色阈值: '',
    红色阈值: '',
    生效起始: '',
    生效截止: '',
  }
  createVisible.value = true
}

function submitCreate() {
  const result = createDraft({ ...draft.value }, store.role)
  if (result.ok) {
    createVisible.value = false
    reload()
  }
  notify(result)
}

function runAction(action: ThresholdAction, row: EntryRow) {
  if (action === '复核排期') {
    reviewTarget.value = row
    reviewOpinion.value = ''
    return
  }
  const result = runThresholdAction(Number(row.id), action, store.role)
  if (result.ok) {
    reload()
  }
  notify(result)
}

function submitReview() {
  if (!reviewTarget.value) {
    return
  }
  const result = runThresholdAction(Number(reviewTarget.value.id), '复核排期', store.role, {
    reviewer: store.operator,
    opinion: reviewOpinion.value,
  })
  if (result.ok) {
    reviewTarget.value = null
    reload()
  }
  notify(result)
}

function adjust(row: EntryRow) {
  const result = adjustVersion(Number(row.id), store.role)
  if (result.ok) {
    reload()
  }
  notify(result)
}

function reload() {
  try {
    rows.value = listWarnings(filters.value)
    total.value = rows.value.length
  } catch (error) {
    notify({ ok: false, message: error instanceof Error ? error.message : '预警阈值列表读取失败' })
  }
}

onMounted(reload)
</script>
