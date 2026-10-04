<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">
          维护水位记录，并沿阈值数据流按「观测时间」解析当时生效的门槛版本：历史水位继续引用当时阈值，
          窗口重叠时以生效开始更晚（同日则版本号更大）的一版为准。下方同步展示阈值版本的复核记录。
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
          <th>当时门槛版本</th>
          <th>预警判定</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <template v-if="resolve(row) as Resolved">
              <div class="ver-cell">
                {{ resolve(row)!.config.code }} v{{ resolve(row)!.config.version }}
                <span :class="['status-badge', statusClass(resolve(row)!.config.status)]">
                  {{ resolve(row)!.config.status }}
                </span>
              </div>
              <div class="small muted">
                门槛 {{ resolve(row)!.config.values.blue }}/{{ resolve(row)!.config.values.yellow }}/{{
                  resolve(row)!.config.values.orange
                }}/{{ resolve(row)!.config.values.red }}
              </div>
              <div class="small muted">窗口 {{ resolve(row)!.config.windowStart }} ~ {{ resolve(row)!.config.windowEnd || '长期' }}</div>
            </template>
            <span v-else class="muted">该观测时刻无生效门槛</span>
          </td>
          <td>
            <span v-if="judge(row)" :class="['level-badge', `level-${judge(row)!.levelIndex}`]">
              {{ judge(row)!.level }}
            </span>
            <span v-else class="muted">—</span>
          </td>
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
          <td :colspan="columns.length + 4" class="empty-state">暂无水位监测数据，可先登记水位记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水位记录；历史记录引用的是观测当时的门槛版本，不随后续调整改变</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 阈值版本时间穿越查询：定位版本切换点 -->
    <section class="probe-panel">
      <h3>门槛版本切换点查询</h3>
      <p class="small muted">选择站点和观测日期，查看那一刻适用的阈值版本与预警判定。</p>
      <form class="filter-bar" @submit.prevent="runProbe">
        <label class="filter-item">
          <span>站点编号</span>
          <input v-model="probe.station" placeholder="如 WATE-0001" />
        </label>
        <label class="filter-item">
          <span>监测类型</span>
          <input v-model="probe.type" />
        </label>
        <label class="filter-item">
          <span>观测日期</span>
          <input v-model="probe.date" type="date" />
        </label>
        <label class="filter-item">
          <span>水位值</span>
          <input v-model="probe.value" inputmode="decimal" />
        </label>
        <button class="btn primary" type="submit">解析当时门槛</button>
      </form>
      <div v-if="probeResult" class="probe-result">
        <template v-if="probeResult.config">
          <div>
            适用版本：<strong>{{ probeResult.config.code }} v{{ probeResult.config.version }}</strong>
            （{{ probeResult.config.status }}，窗口 {{ probeResult.config.windowStart }} ~
            {{ probeResult.config.windowEnd || '长期' }}）
          </div>
          <div>
            蓝/黄/橙/红：{{ probeResult.config.values.blue }} / {{ probeResult.config.values.yellow }} /
            {{ probeResult.config.values.orange }} / {{ probeResult.config.values.red }}
          </div>
          <div v-if="probeResult.level">
            水位 {{ probe.value }} 判定为
            <span :class="['level-badge', `level-${probeResult.level.levelIndex}`]">{{ probeResult.level.level }}</span>
          </div>
          <div v-else class="muted">水位 {{ probe.value }} 未达蓝色阈值或无法解析数值</div>
        </template>
        <span v-else class="error-text">该站点、该观测时刻没有任何生效窗口覆盖（无适用门槛版本）</span>
      </div>
    </section>

    <!-- 同步的阈值复核记录 -->
    <section class="review-panel">
      <div class="review-head">
        <h3>阈值复核记录（与预警阈值页同步）</h3>
        <div class="review-tools">
          <input v-model="reviewStationFilter" placeholder="按站点编号过滤" @input="reloadReviews" />
          <button class="btn" type="button" @click="reloadReviews">刷新记录</button>
        </div>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>配置</th>
            <th>站点/类型</th>
            <th>版本</th>
            <th>动作</th>
            <th>状态流转</th>
            <th>操作人</th>
            <th>生效窗口</th>
            <th>意见</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reviewRows" :key="item.id">
            <td class="small">{{ item.at.replace('T', ' ').slice(0, 16) }}</td>
            <td>{{ item.configCode }}</td>
            <td>{{ item.station }} / {{ item.monitorType }}</td>
            <td>v{{ item.version }}</td>
            <td>{{ item.action }}</td>
            <td class="small">
              <template v-if="item.fromStatus">{{ item.fromStatus }} → {{ item.toStatus }}</template>
              <template v-else>→ {{ item.toStatus }}</template>
            </td>
            <td class="small">{{ item.operator }}（{{ item.role }}）</td>
            <td class="small">{{ item.windowStart || '—' }} ~ {{ item.windowEnd || '长期' }}</td>
            <td class="small muted">{{ item.comment || '—' }}</td>
          </tr>
          <tr v-if="!reviewRows.length">
            <td colspan="9" class="empty-state">暂无复核记录</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  judgeLevel,
  listReviews,
  resolveThresholdAt,
  sweepScheduled,
} from '@/api/threshold-service'
import type { EntryRow } from '@/data/types'
import type { ThresholdReview } from '@/data/threshold-types'
import type { ResolvedThreshold } from '@/api/threshold-service'

type Resolved = ResolvedThreshold

const meta = moduleMeta('waterlevel')
const columns = ['记录编号', '站点编号', '观测时间', '当前水位', '警戒水位', '保证水位', '水位变幅', '记录状态']
const actions = ['提交审核', '确认通过', '标记异常']
const statuses = ['已采集', '待审核', '已通过', '异常值']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '今日采集数', value: rows.value.length },
  { label: '触发预警站次', value: rows.value.filter((row) => Boolean(judge(row))).length },
  { label: '待审核记录', value: rows.value.filter((row) => row.status === '待审核').length },
])

// 复核记录与阈值页读同一份数据源
const reviewRows = ref<ThresholdReview[]>([])
const reviewStationFilter = ref('')

const probe = reactive({ station: 'WATE-0001', type: '水位', date: '2026-09-15', value: '33.2' })
const probeResult = ref<(ResolvedThreshold & { level: ReturnType<typeof judgeLevel> }) | null>(null)

function resolve(row: EntryRow): ResolvedThreshold | null {
  // 版本切换点：观测时间落到哪个版本的生效窗口，就用哪个版本的门槛。
  return resolveThresholdAt(String(row['站点编号'] ?? ''), '水位', String(row['观测时间'] ?? ''))
}

function judge(row: EntryRow) {
  const resolved = resolve(row)
  if (!resolved) {
    return null
  }
  return judgeLevel(resolved.values, String(row['当前水位'] ?? ''))
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

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '水位记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 读之前先推进到期排期，保证版本切换点已落账。
    sweepScheduled()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水位监测列表读取失败'
  }
}

function reloadReviews() {
  reviewRows.value = listReviews(reviewStationFilter.value)
}

function runProbe() {
  sweepScheduled()
  const resolved = resolveThresholdAt(probe.station.trim(), probe.type.trim(), probe.date)
  if (!resolved) {
    probeResult.value = null
    return
  }
  probeResult.value = { ...resolved, level: judgeLevel(resolved.values, probe.value) }
}

onMounted(() => {
  reload()
  reloadReviews()
  runProbe()
})
</script>

<style scoped>
.small {
  font-size: 12px;
}
.muted {
  color: var(--muted);
}
.ver-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.status-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
}
.st-draft { background: #eef2f7; color: #475569; }
.st-review { background: #fef3c7; color: #92400e; }
.st-scheduled { background: #dbeafe; color: #1e40af; }
.st-active { background: #dcfce7; color: #166534; }
.st-archived { background: #f1f5f9; color: #64748b; }
.level-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.level-0 { background: #dbeafe; color: #1e40af; }
.level-1 { background: #fef3c7; color: #92400e; }
.level-2 { background: #ffedd5; color: #c2410c; }
.level-3 { background: #fee2e2; color: #b42318; }
.probe-panel,
.review-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.probe-panel h3,
.review-panel h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.probe-result {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.review-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.review-tools {
  display: flex;
  gap: 8px;
}
.review-tools input {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
</style>
