<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">
          维护水位记录，围绕记录编号、站点编号、观测时间、当前水位做登记、筛选与状态流转；
          每条记录快照观测时刻适用的阈值版本，阈值换版后历史记录仍引用当时的门槛。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水位记录</button>
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
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
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无水位监测数据，可先登记水位记录</td>
        </tr>
      </tbody>
    </table>

    <section class="review-section">
      <h3>水位阈值复核记录</h3>
      <p class="review-desc">预警阈值配置复核排期后同步到此处，供水位数据审核时对照门槛版本。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in reviewColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="review in reviews" :key="String(review.id)">
            <td v-for="column in reviewColumns" :key="column">{{ review[column] ?? '—' }}</td>
          </tr>
          <tr v-if="!reviews.length">
            <td :colspan="reviewColumns.length" class="empty-state">暂无水位阈值复核记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条水位监测记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <div v-if="createVisible" class="modal-mask" @click.self="createVisible = false">
      <form class="modal" @submit.prevent="submitCreate">
        <h3>登记水位记录</h3>
        <div class="form-grid">
          <label class="form-item">
            <span>站点编号</span>
            <input v-model="entry.站点编号" placeholder="如 STAT-0001" required />
          </label>
          <label class="form-item">
            <span>观测时间</span>
            <input v-model="entry.观测时间" type="date" required />
          </label>
          <label class="form-item">
            <span>当前水位</span>
            <input v-model="entry.当前水位" placeholder="数字，单位米" required />
          </label>
        </div>
        <p class="modal-tip">保存时自动快照观测时刻生效的阈值版本，写入「适用配置 / 适用阈值」。</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">保存记录</button>
          <button class="btn ghost" type="button" @click="createVisible = false">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { createWaterlevelEntry, listReviews } from '@/api/threshold-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('waterlevel')
const columns = meta.fields
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const reviewColumns = ["记录编号", "配置编号", "版本号", "站点编号", "复核人", "复核时间", "复核结论", "复核意见"]

const rows = ref<EntryRow[]>([])
const reviews = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const createVisible = ref(false)
const entry = ref({ 站点编号: '', 观测时间: '', 当前水位: '' })

const stats = computed(() => [
  { label: '今日采集数', value: rows.value.filter((row) => row.status === '已采集').length },
  { label: '待审核记录', value: rows.value.filter((row) => row.status === '待审核').length },
  { label: '复核记录数', value: reviews.value.length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

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
  entry.value = { 站点编号: '', 观测时间: '', 当前水位: '' }
  createVisible.value = true
}

function submitCreate() {
  const result = createWaterlevelEntry({ ...entry.value })
  if (result.ok) {
    createVisible.value = false
    reload()
  }
  notify(result)
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  if (result.ok) {
    reload()
  }
  notify(result)
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reviews.value = listReviews('水位')
  } catch (error) {
    notify({ ok: false, message: error instanceof Error ? error.message : '水位监测列表读取失败' })
  }
}

onMounted(reload)
</script>
