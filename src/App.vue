<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import axios from 'axios'

const STORAGE_KEY = 'focuscoach_v3_dread_only_ai'

const tasks = ref([])
const contexts = ref(['Computer', 'Phone', 'Home', 'Errands', 'Work', 'Waiting'])
const newContext = ref('')

const form = ref({
  title: '',
  priority: 'must',
  dread: 'medium',
  minutes: 15,
  context: 'Computer',
})

const selectedTaskId = ref(null)

// “What should I do now?” modal state
const nowModalOpen = ref(false)
const now = ref({
  minutes: 15,
  useCustomMinutes: false,
  customMinutes: '',
  context: 'Computer',
  maxDread: 'medium',
})

const PRIORITY = [
  { key: 'must', label: 'Must Do', classes: 'bg-red-100 hover:bg-red-200 text-red-900' },
  { key: 'should', label: 'Should Do', classes: 'bg-yellow-100 hover:bg-yellow-200 text-yellow-900' },
  { key: 'could', label: 'Could Do', classes: 'bg-green-100 hover:bg-green-200 text-green-900' },
]

const DREAD = [
  { key: 'light', label: 'Light', classes: 'bg-green-100 hover:bg-green-200 text-green-900' },
  { key: 'medium', label: 'Medium', classes: 'bg-yellow-100 hover:bg-yellow-200 text-yellow-900' },
  { key: 'heavy', label: 'Heavy', classes: 'bg-red-100 hover:bg-red-200 text-red-900' },
]

const TIME_PRESETS = [5, 10, 15, 25, 30, 45, 60, 90]

// AI state
const aiLoading = ref(false)
const aiError = ref('')

// Prevent auto-breakdown spam when clicking same task repeatedly
const lastAutoBreakdownTaskId = ref(null)

// ---------- Helpers ----------
function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
function priorityRank(p) {
  return p === 'must' ? 3 : p === 'should' ? 2 : 1
}
function dreadRank(d) {
  return d === 'heavy' ? 3 : d === 'medium' ? 2 : 1
}
function clampInt(val, fallback) {
  const n = Number.parseInt(String(val), 10)
  if (Number.isNaN(n) || n <= 0) return fallback
  return n
}
function chipClass(active, activeClasses) {
  return active ? `${activeClasses} border-transparent` : 'bg-white hover:bg-gray-50 border-gray-200'
}

function save() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ tasks: tasks.value, contexts: contexts.value })
  )
}
function load() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.tasks)) tasks.value = parsed.tasks
    if (Array.isArray(parsed.contexts)) contexts.value = parsed.contexts
  } catch {}
}

onMounted(() => {
  load()
  if (!contexts.value.includes(form.value.context)) form.value.context = contexts.value[0] || 'Computer'
  if (!contexts.value.includes(now.value.context)) now.value.context = contexts.value[0] || 'Computer'
})

watch([tasks, contexts], () => save(), { deep: true })

const selectedTask = computed(() => tasks.value.find(t => t.id === selectedTaskId.value) || null)
const hasTasks = computed(() => tasks.value.length > 0)
const hasOpenTasks = computed(() => tasks.value.some(t => !t.done))
const openTasks = computed(() => tasks.value.filter(t => !t.done))

const sortedTasks = computed(() => {
  return [...tasks.value].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    const pr = priorityRank(b.priority) - priorityRank(a.priority)
    if (pr !== 0) return pr
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
})

// ---------- Form actions ----------
function setPriority(p) { form.value.priority = p }
function setDread(d) { form.value.dread = d }
function setMinutes(m) { form.value.minutes = m }
function setContext(c) { form.value.context = c }

function addContext() {
  const val = newContext.value.trim()
  if (!val) return
  if (!contexts.value.includes(val)) contexts.value.push(val)
  form.value.context = val
  now.value.context = val
  newContext.value = ''
}

function addTask() {
  const title = form.value.title.trim()
  if (!title) return

  const task = {
    id: uid(),
    title,
    priority: form.value.priority,
    dread: form.value.dread,
    minutes: clampInt(form.value.minutes, 15),
    context: form.value.context,
    breakdown: [], // read-only display list
    done: false,
    createdAt: Date.now(),
  }

  tasks.value.unshift(task)
  form.value.title = ''
  selectedTaskId.value = task.id
  aiError.value = ''

  // Optional: uncomment if you also want auto-breakdown immediately after adding:
  // lastAutoBreakdownTaskId.value = null
  // generateBreakdownForSelected()
}

function removeTask(id) {
  if (selectedTaskId.value === id) selectedTaskId.value = null
  tasks.value = tasks.value.filter(t => t.id !== id)
}
function toggleDone(id) {
  const t = tasks.value.find(x => x.id === id)
  if (!t) return
  t.done = !t.done
}

// ✅ UPDATED: Select task + auto-breakdown if no steps yet
function selectTask(id) {
  selectedTaskId.value = id
  aiError.value = ''

  const t = tasks.value.find(x => x.id === id)
  if (!t) return

  const hasSteps = Array.isArray(t.breakdown) && t.breakdown.length > 0
  if (hasSteps) return
  if (aiLoading.value) return

  // Prevent re-running if you click the same task repeatedly
  if (lastAutoBreakdownTaskId.value === id) return
  lastAutoBreakdownTaskId.value = id

  generateBreakdownForSelected()
}

function clearDone() {
  tasks.value = tasks.value.filter(t => !t.done)
  if (selectedTaskId.value && !tasks.value.find(t => t.id === selectedTaskId.value)) {
    selectedTaskId.value = null
  }
}

// ---------- Pickers ----------
function pickRecommend() {
  const candidates = openTasks.value
  if (candidates.length === 0) return null

  const score = (t) => {
    const p = priorityRank(t.priority) * 100
    const d = dreadRank(t.dread)
    const m = clampInt(t.minutes, 15)
    const shortBonus = Math.max(0, 60 - Math.min(m, 60))
    const heavyPenalty = t.dread === 'heavy' && t.priority !== 'must' ? 120 : 0
    const dreadPenalty = d * 25
    const shortHeavyRelief = (t.dread === 'heavy' && m <= 10) ? 40 : 0
    return p + shortBonus - dreadPenalty - heavyPenalty + shortHeavyRelief
  }

  return [...candidates].sort((a, b) => score(b) - score(a))[0] || null
}

function pickWin() {
  const candidates = openTasks.value
  if (candidates.length === 0) return null
  const score = (t) => {
    const p = priorityRank(t.priority) * 50
    const d = dreadRank(t.dread)
    const m = clampInt(t.minutes, 15)
    const shortBonus = (120 - Math.min(m, 120)) * 2
    const dreadBonus = (4 - d) * 80
    return p + shortBonus + dreadBonus
  }
  return [...candidates].sort((a, b) => score(b) - score(a))[0] || null
}

function pickHardest() {
  const candidates = openTasks.value
  if (candidates.length === 0) return null
  const score = (t) => {
    const p = priorityRank(t.priority) * 120
    const d = dreadRank(t.dread) * 80
    const m = clampInt(t.minutes, 15)
    return p + d + Math.min(m, 120)
  }
  return [...candidates].sort((a, b) => score(b) - score(a))[0] || null
}

// ---------- NOW modal ----------
function openNowModal() {
  if (!hasOpenTasks.value) return
  now.value.minutes = clampInt(form.value.minutes, 15)
  now.value.context = form.value.context
  now.value.maxDread = form.value.dread
  now.value.useCustomMinutes = false
  now.value.customMinutes = ''
  nowModalOpen.value = true
}
function closeNowModal() { nowModalOpen.value = false }
function setNowMinutes(m) {
  now.value.minutes = m
  now.value.useCustomMinutes = false
  now.value.customMinutes = ''
}
function toggleCustomMinutes() {
  now.value.useCustomMinutes = !now.value.useCustomMinutes
  if (!now.value.useCustomMinutes) now.value.customMinutes = ''
}
function effectiveNowMinutes() {
  return now.value.useCustomMinutes
    ? clampInt(now.value.customMinutes, now.value.minutes)
    : clampInt(now.value.minutes, 15)
}

function pickNow() {
  const minutesAvail = effectiveNowMinutes()
  const maxD = dreadRank(now.value.maxDread)
  const ctx = now.value.context

  const strict = openTasks.value.filter(t => t.context === ctx && clampInt(t.minutes, 15) <= minutesAvail && dreadRank(t.dread) <= maxD)
  const relax1 = openTasks.value.filter(t => clampInt(t.minutes, 15) <= minutesAvail && dreadRank(t.dread) <= maxD)
  const relax2 = openTasks.value.filter(t => t.context === ctx && dreadRank(t.dread) <= maxD)
  const relax3 = openTasks.value.filter(t => t.context === ctx && clampInt(t.minutes, 15) <= minutesAvail)

  const pool = strict.length ? strict : relax1.length ? relax1 : relax2.length ? relax2 : relax3.length ? relax3 : openTasks.value

  const score = (t) => {
    const p = priorityRank(t.priority) * 120
    const d = dreadRank(t.dread) * 40
    const m = clampInt(t.minutes, 15)
    const shortBonus = (90 - Math.min(m, 90)) * 2
    return p + shortBonus - d
  }

  return [...pool].sort((a, b) => score(b) - score(a))[0] || null
}

function runNowPick() {
  const picked = pickNow()
  if (!picked) return
  selectedTaskId.value = picked.id
  nowModalOpen.value = false
  aiError.value = ''
}

// Quick actions
function runRecommend() {
  const picked = pickRecommend()
  if (picked) selectedTaskId.value = picked.id
  aiError.value = ''
}
function runWin() {
  const picked = pickWin()
  if (picked) selectedTaskId.value = picked.id
  aiError.value = ''
}
function runHardest() {
  const picked = pickHardest()
  if (picked) selectedTaskId.value = picked.id
  aiError.value = ''
}

// ---------- REAL AI: Breakdown ----------
async function generateBreakdownForSelected() {
  if (!selectedTask.value) return
  aiLoading.value = true
  aiError.value = ''

  try {
    const t = selectedTask.value
    const resp = await axios.post('/api/breakdown', {
      title: t.title,
      minutes: t.minutes,
      priority: t.priority,
      dread: t.dread,
      context: t.context,
    })

    const steps = resp?.data?.steps
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('No steps returned')
    }

    // Read-only: set steps (no editing UI)
    t.breakdown = steps.map(s => String(s).trim()).filter(Boolean).slice(0, 8)
  } catch (e) {
    console.error('AI breakdown error:', e)
    aiError.value =
      e?.response?.data?.error ||
      e?.response?.data?.message ||
      e?.message ||
      'Could not generate steps.'
  } finally {
    aiLoading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-gray-100">
    <header class="bg-white shadow-sm">
      <div class="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="h-10 w-10 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold">FC</div>
          <div>
            <h1 class="text-xl font-bold leading-tight">FocusCoach</h1>
            <p class="text-sm text-gray-500">Pick the next doable thing.</p>
          </div>
        </div>

        <button
          class="px-3 py-2 rounded-lg bg-white border hover:bg-gray-50 text-sm disabled:opacity-50"
          :disabled="!hasTasks"
          @click="clearDone"
        >
          Clear Done
        </button>
      </div>
    </header>

    <main class="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Left -->
      <section class="bg-white rounded-xl shadow p-6 space-y-6">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">Add Task</h2>
          <span class="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-600">Dread-only + Real AI</span>
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium text-gray-700">Task</label>
          <input
            v-model="form.title"
            type="text"
            placeholder="What needs to get done?"
            class="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            @keydown.enter.prevent="addTask"
          />
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium text-gray-700">Priority</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="p in PRIORITY"
              :key="p.key"
              type="button"
              class="px-4 py-2 rounded-lg text-sm font-medium border"
              :class="chipClass(form.priority === p.key, p.classes)"
              @click="setPriority(p.key)"
            >
              {{ p.label }}
            </button>
          </div>
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium text-gray-700">Dread</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="d in DREAD"
              :key="d.key"
              type="button"
              class="px-4 py-2 rounded-lg text-sm font-medium border"
              :class="chipClass(form.dread === d.key, d.classes)"
              @click="setDread(d.key)"
            >
              {{ d.label }}
            </button>
          </div>
          <p class="text-xs text-gray-500">Dread = avoidance. This is the ADHD blocker.</p>
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium text-gray-700">Time</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="m in TIME_PRESETS"
              :key="m"
              type="button"
              class="px-3 py-2 rounded-lg text-sm font-medium border"
              :class="form.minutes === m ? 'bg-blue-600 text-white border-transparent' : 'bg-white hover:bg-gray-50 border-gray-200'"
              @click="setMinutes(m)"
            >
              {{ m }}m
            </button>
          </div>
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium text-gray-700">Context (GTD)</label>

          <div class="flex flex-wrap gap-2">
            <button
              v-for="c in contexts"
              :key="c"
              type="button"
              class="px-3 py-2 rounded-lg text-sm font-medium border"
              :class="form.context === c ? 'bg-gray-900 text-white border-transparent' : 'bg-white hover:bg-gray-50 border-gray-200'"
              @click="setContext(c)"
            >
              {{ c }}
            </button>
          </div>

          <div class="flex gap-2">
            <input
              v-model="newContext"
              type="text"
              placeholder="Add new context (e.g., Email, Office, Car)"
              class="flex-1 border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              @keydown.enter.prevent="addContext"
            />
            <button
              type="button"
              class="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50 text-sm font-medium"
              @click="addContext"
            >
              Add
            </button>
          </div>
        </div>

        <button
          type="button"
          class="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 font-semibold disabled:opacity-50"
          :disabled="!form.title.trim()"
          @click="addTask"
        >
          Add Task
        </button>

        <div class="pt-2 border-t space-y-3">
          <h3 class="text-sm font-semibold text-gray-700">Quick Pick</h3>

          <div class="grid grid-cols-2 gap-2">
            <button class="px-3 py-2 rounded-lg bg-white border hover:bg-gray-50 text-sm font-medium disabled:opacity-50" :disabled="!hasOpenTasks" @click="openNowModal">
              What should I do now?
            </button>
            <button class="px-3 py-2 rounded-lg bg-white border hover:bg-gray-50 text-sm font-medium disabled:opacity-50" :disabled="!hasOpenTasks" @click="runRecommend">
              Recommend
            </button>
            <button class="px-3 py-2 rounded-lg bg-white border hover:bg-gray-50 text-sm font-medium disabled:opacity-50" :disabled="!hasOpenTasks" @click="runWin">
              I need a win
            </button>
            <button class="px-3 py-2 rounded-lg bg-white border hover:bg-gray-50 text-sm font-medium disabled:opacity-50" :disabled="!hasOpenTasks" @click="runHardest">
              Hardest thing
            </button>
          </div>
        </div>
      </section>

      <!-- Right -->
      <section class="space-y-6">
        <div class="bg-white rounded-xl shadow p-6">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-semibold">Tasks</h2>
            <div class="text-sm text-gray-500">{{ tasks.filter(t => !t.done).length }} open / {{ tasks.length }} total</div>
          </div>

          <div v-if="!hasTasks" class="mt-6 text-sm text-gray-500">
            Add a task on the left. Use “What should I do now?” when you feel stuck.
          </div>

          <div v-else class="mt-4 space-y-2">
            <button
              v-for="t in sortedTasks"
              :key="t.id"
              class="w-full text-left rounded-xl border p-4 hover:bg-gray-50 transition"
              :class="selectedTaskId === t.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'"
              @click="selectTask(t.id)"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs font-semibold px-2 py-1 rounded-full"
                      :class="t.priority === 'must' ? 'bg-red-100 text-red-900' : t.priority === 'should' ? 'bg-yellow-100 text-yellow-900' : 'bg-green-100 text-green-900'">
                      {{ t.priority.toUpperCase() }}
                    </span>
                    <span class="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700">{{ t.context }}</span>
                    <span class="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700">{{ t.minutes }}m</span>
                    <span class="text-xs font-semibold px-2 py-1 rounded-full"
                      :class="t.dread === 'light' ? 'bg-green-100 text-green-900' : t.dread === 'medium' ? 'bg-yellow-100 text-yellow-900' : 'bg-red-100 text-red-900'">
                      DREAD: {{ t.dread }}
                    </span>
                  </div>

                  <p class="mt-2 font-semibold text-gray-900 truncate" :class="t.done ? 'line-through text-gray-400' : ''">
                    {{ t.title }}
                  </p>
                </div>

                <div class="flex items-center gap-2 shrink-0">
                  <button type="button" class="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50 text-sm" @click.stop="toggleDone(t.id)">
                    {{ t.done ? 'Undo' : 'Done' }}
                  </button>
                  <button type="button" class="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50 text-sm text-red-600" @click.stop="removeTask(t.id)">
                    Remove
                  </button>
                </div>
              </div>
            </button>
          </div>
        </div>

        <div class="bg-white rounded-xl shadow p-6">
          <h2 class="text-lg font-semibold">Selected Task</h2>

          <div v-if="!selectedTask" class="mt-4 text-sm text-gray-500">
            Click a task to view details and steps.
          </div>

          <div v-else class="mt-4 space-y-4">
            <div>
              <div class="text-sm text-gray-500">Title</div>
              <div class="text-lg font-semibold text-gray-900">{{ selectedTask.title }}</div>
              <div class="mt-2 text-sm text-gray-600">
                {{ selectedTask.minutes }}m • {{ selectedTask.context }} • {{ selectedTask.priority }} • dread: {{ selectedTask.dread }}
              </div>
            </div>

            <div class="flex flex-wrap gap-2 items-center">
              <button
                type="button"
                class="px-3 py-2 rounded-lg bg-white border hover:bg-gray-50 text-sm font-medium disabled:opacity-50"
                :disabled="aiLoading"
                @click="generateBreakdownForSelected"
              >
                {{ aiLoading ? 'Generating…' : (selectedTask.breakdown.length ? 'Regenerate Steps' : 'AI Breakdown') }}
              </button>

              <span v-if="aiError" class="text-sm text-red-600">{{ aiError }}</span>
            </div>

            <div class="space-y-2">
              <div class="text-sm font-semibold text-gray-700">Steps</div>

              <div v-if="selectedTask.breakdown.length === 0" class="text-sm text-gray-500">
                No steps yet. Tap “AI Breakdown” to generate them.
              </div>

              <ol v-else class="list-decimal pl-5 space-y-2">
                <li v-for="(step, idx) in selectedTask.breakdown" :key="idx" class="text-sm text-gray-800">
                  {{ step }}
                </li>
              </ol>
            </div>
          </div>
        </div>
      </section>
    </main>

    <!-- NOW MODAL -->
    <div v-if="nowModalOpen" class="fixed inset-0 z-50 flex items-center justify-center" aria-modal="true" role="dialog">
      <button class="absolute inset-0 bg-black/40" @click="closeNowModal" aria-label="Close"></button>

      <div class="relative w-full max-w-xl mx-4 bg-white rounded-2xl shadow-xl p-6 space-y-5">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 class="text-lg font-semibold">What should I do now?</h3>
            <p class="text-sm text-gray-500">Tell me your constraints. I’ll pick the most doable task.</p>
          </div>
          <button class="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50 text-sm" @click="closeNowModal">Close</button>
        </div>

        <div class="space-y-2">
          <div class="text-sm font-semibold text-gray-700">Time available</div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="m in TIME_PRESETS"
              :key="m"
              type="button"
              class="px-3 py-2 rounded-lg text-sm font-medium border"
              :class="(!now.useCustomMinutes && now.minutes === m) ? 'bg-blue-600 text-white border-transparent' : 'bg-white hover:bg-gray-50 border-gray-200'"
              @click="setNowMinutes(m)"
            >
              {{ m }}m
            </button>

            <button
              type="button"
              class="px-3 py-2 rounded-lg text-sm font-medium border"
              :class="now.useCustomMinutes ? 'bg-blue-600 text-white border-transparent' : 'bg-white hover:bg-gray-50 border-gray-200'"
              @click="toggleCustomMinutes"
            >
              Custom
            </button>
          </div>

          <div v-if="now.useCustomMinutes" class="flex gap-2 items-center">
            <input
              v-model="now.customMinutes"
              inputmode="numeric"
              type="number"
              min="1"
              placeholder="Minutes"
              class="w-32 border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div class="text-xs text-gray-500">If unsure, use a preset.</div>
          </div>
        </div>

        <div class="space-y-2">
          <div class="text-sm font-semibold text-gray-700">Context</div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="c in contexts"
              :key="c"
              type="button"
              class="px-3 py-2 rounded-lg text-sm font-medium border"
              :class="now.context === c ? 'bg-gray-900 text-white border-transparent' : 'bg-white hover:bg-gray-50 border-gray-200'"
              @click="now.context = c"
            >
              {{ c }}
            </button>
          </div>
        </div>

        <div class="space-y-2">
          <div class="text-sm font-semibold text-gray-700">Max dread you can tolerate right now</div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="d in DREAD"
              :key="d.key"
              type="button"
              class="px-4 py-2 rounded-lg text-sm font-medium border"
              :class="chipClass(now.maxDread === d.key, d.classes)"
              @click="now.maxDread = d.key"
            >
              {{ d.label }}
            </button>
          </div>
        </div>

        <div class="pt-2 border-t flex flex-col sm:flex-row gap-2 sm:justify-end">
          <button class="px-4 py-2 rounded-lg bg-white border hover:bg-gray-50 text-sm font-medium" @click="closeNowModal">Cancel</button>
          <button class="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-semibold disabled:opacity-50" :disabled="!hasOpenTasks" @click="runNowPick">
            Pick for me
          </button>
        </div>
      </div>
    </div>
  </div>
</template>