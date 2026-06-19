<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { version as pkgVersion, name as appName, displayName as appDisplayName } from '../package.json'

type ActivityStatus = 'initial' | 'pending' | 'complete'

interface TrackPoint {
  ts: number
  lat: number
  lon: number
  alt: number | null
  spd: number | null
  acc: number | null
}

interface ActivityMetadata {
  startedAt?: string
  endedAt?: string
  sampleIntervalSeconds?: number
  maxDurationHours?: number
  stopReason?: string
  durationMs?: number
  initialStatus?: ActivityStatus
  [key: string]: unknown
}

interface Activity {
  activityId: string
  status: ActivityStatus
  metadata: ActivityMetadata
  points: TrackPoint[]
}

interface ActivitySummary {
  activityId: string
  status: ActivityStatus
  pointsCount: number
  startedAt: string
  endedAt: string
}

const DB_NAME = 'zoneTrackerDb'
const DB_VERSION = 1
const ACTIVE_POINTS_STORE = 'active_points'
const COMPLETED_ACTIVITIES_STORE = 'completed_activities'

const sampleIntervalSeconds = ref(5)
const maxDurationHours = ref(10)
const tracking = ref(false)
const activityId = ref('')
const startedAtMs = ref<number | null>(null)
const elapsedSeconds = ref(0)
const pointsCaptured = ref(0)
const permissionState = ref<'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown'>('unknown')
const statusMessage = ref('Ready to track.')
const summaries = ref<ActivitySummary[]>([])
const activities = ref<Activity[]>([])
const selectedActivityId = ref('')

const lastPoint = ref<TrackPoint | null>(null)

const selectedActivity = computed(() => {
  if (!selectedActivityId.value) {
    return null
  }

  return activities.value.find((item) => item.activityId === selectedActivityId.value) ?? null
})

const selectedPointsPreview = computed(() => {
  const points = selectedActivity.value?.points ?? []
  return points.slice(0, 50)
})

let sampleTimerId: number | null = null
let maxDurationTimerId: number | null = null
let watchId: number | null = null
let latestPosition: GeolocationPosition | null = null
let currentDraft: { activityId: string; status: 'initial'; metadata: ActivityMetadata } | null = null
let stopping = false

const maxDurationMs = computed(() => Math.max(1, maxDurationHours.value) * 60 * 60 * 1000)

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(ACTIVE_POINTS_STORE)) {
        db.createObjectStore(ACTIVE_POINTS_STORE, { keyPath: 'ts' })
      }

      if (!db.objectStoreNames.contains(COMPLETED_ACTIVITIES_STORE)) {
        db.createObjectStore(COMPLETED_ACTIVITIES_STORE, { keyPath: 'activityId' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'))
  })
}

function runStoreOperation<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let settled = false

        const closeDb = () => {
          try {
            db.close()
          } catch {
            // Ignore close errors to preserve original operation outcome.
          }
        }

        const resolveOnce = (value: T) => {
          if (settled) {
            return
          }

          settled = true
          resolve(value)
        }

        const rejectOnce = (reason?: unknown) => {
          if (settled) {
            return
          }

          settled = true
          reject(reason)
        }

        let tx: IDBTransaction
        let store: IDBObjectStore

        try {
          tx = db.transaction(storeName, mode)
          store = tx.objectStore(storeName)
        } catch (error) {
          closeDb()
          rejectOnce(error)
          return
        }

        tx.oncomplete = () => closeDb()
        tx.onabort = () => {
          closeDb()
          rejectOnce(tx.error ?? new Error('IndexedDB transaction aborted.'))
        }
        tx.onerror = () => {
          closeDb()
          rejectOnce(tx.error ?? new Error('IndexedDB transaction failed.'))
        }

        operation(store, resolveOnce, rejectOnce)
      }),
  )
}

function clearActivePoints(): Promise<void> {
  return runStoreOperation<void>(ACTIVE_POINTS_STORE, 'readwrite', (store, resolve, reject) => {
    const request = store.clear()
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function putActivePoint(point: TrackPoint): Promise<void> {
  return runStoreOperation<void>(ACTIVE_POINTS_STORE, 'readwrite', (store, resolve, reject) => {
    const request = store.put(point)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function getAllActivePoints(): Promise<TrackPoint[]> {
  return runStoreOperation<TrackPoint[]>(ACTIVE_POINTS_STORE, 'readonly', (store, resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => {
      const points = (request.result as TrackPoint[]).sort((a, b) => a.ts - b.ts)
      resolve(points)
    }
    request.onerror = () => reject(request.error)
  })
}

function putCompletedActivity(activity: Activity): Promise<void> {
  return runStoreOperation<void>(COMPLETED_ACTIVITIES_STORE, 'readwrite', (store, resolve, reject) => {
    const request = store.put(activity)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function getCompletedActivities(): Promise<Activity[]> {
  return runStoreOperation<Activity[]>(COMPLETED_ACTIVITIES_STORE, 'readonly', (store, resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result as Activity[])
    request.onerror = () => reject(request.error)
  })
}

function toActivityId(date: Date): string {
  const isoNoMillis = date.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `act_${isoNoMillis}`
}

function mapPositionToPoint(position: GeolocationPosition): TrackPoint {
  const { latitude, longitude, altitude, speed, accuracy } = position.coords

  return {
    ts: Date.now(),
    lat: latitude,
    lon: longitude,
    alt: Number.isFinite(altitude) ? altitude : null,
    spd: Number.isFinite(speed) ? speed : null,
    acc: Number.isFinite(accuracy) ? accuracy : null,
  }
}

function getCurrentPosition(timeoutMs = 10_000): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: timeoutMs,
      maximumAge: 0,
    })
  })
}

async function ensurePermissionState(): Promise<void> {
  if (!('permissions' in navigator)) {
    permissionState.value = 'unsupported'
    return
  }

  try {
    const result = await navigator.permissions.query({ name: 'geolocation' })
    permissionState.value = result.state
    result.onchange = () => {
      permissionState.value = result.state
    }
  } catch {
    permissionState.value = 'unknown'
  }
}

async function requestLocationPermission(): Promise<boolean> {
  if (!('geolocation' in navigator)) {
    statusMessage.value = 'Geolocation is not supported on this device/browser.'
    return false
  }

  await ensurePermissionState()

  if (permissionState.value === 'denied') {
    statusMessage.value = 'Location permission is denied. Enable it in browser settings.'
    return false
  }

  try {
    const position = await getCurrentPosition(12_000)
    latestPosition = position
    statusMessage.value = 'Location access is enabled.'
    await ensurePermissionState()
    return true
  } catch {
    statusMessage.value = 'Unable to acquire location. Please allow access and try again.'
    await ensurePermissionState()
    return false
  }
}

function startPositionWatch(): void {
  if (!('geolocation' in navigator)) {
    return
  }

  stopPositionWatch()

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      latestPosition = position
    },
    () => {
      // Sampling falls back to getCurrentPosition if watch updates fail.
    },
    {
      enableHighAccuracy: true,
      maximumAge: 2_000,
      timeout: 15_000,
    },
  )
}

function stopPositionWatch(): void {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId)
    watchId = null
  }
}

async function captureSample(): Promise<void> {
  if (!tracking.value) {
    return
  }

  try {
    let position = latestPosition

    if (!position || Date.now() - position.timestamp > sampleIntervalSeconds.value * 2_000) {
      position = await getCurrentPosition(10_000)
      latestPosition = position
    }

    const point = mapPositionToPoint(position)
    await putActivePoint(point)
    lastPoint.value = point
    pointsCaptured.value += 1
    statusMessage.value = 'Tracking in progress.'
  } catch {
    statusMessage.value = 'Tracking is active, but location sampling failed on the last attempt.'
  }
}

async function refreshSummaries(): Promise<void> {
  const loadedActivities = await getCompletedActivities()
  activities.value = loadedActivities.sort((a, b) => {
    const aStartedAt = String(a.metadata?.startedAt ?? '')
    const bStartedAt = String(b.metadata?.startedAt ?? '')
    return aStartedAt < bStartedAt ? 1 : -1
  })

  summaries.value = activities.value
    .map((activity) => {
      const metadata = activity.metadata ?? {}

      return {
        activityId: activity.activityId,
        status: activity.status,
        pointsCount: activity.points.length,
        startedAt: String(metadata.startedAt ?? ''),
        endedAt: String(metadata.endedAt ?? ''),
      }
    })

  if (selectedActivityId.value && !activities.value.some((item) => item.activityId === selectedActivityId.value)) {
    selectedActivityId.value = ''
  }

  if (!selectedActivityId.value && activities.value.length > 0) {
    const firstActivity = activities.value[0]
    if (firstActivity) {
      selectedActivityId.value = firstActivity.activityId
    }
  }
}

function selectActivity(activityIdValue: string): void {
  selectedActivityId.value = activityIdValue
}

function clearTimers(): void {
  if (sampleTimerId !== null) {
    window.clearInterval(sampleTimerId)
    sampleTimerId = null
  }

  if (maxDurationTimerId !== null) {
    window.clearInterval(maxDurationTimerId)
    maxDurationTimerId = null
  }
}

async function startTracking(): Promise<void> {
  if (tracking.value) {
    return
  }

  if (sampleIntervalSeconds.value < 1) {
    statusMessage.value = 'Sample interval must be at least 1 second.'
    return
  }

  if (maxDurationHours.value <= 0) {
    statusMessage.value = 'Maximum duration must be greater than 0 hours.'
    return
  }

  const permitted = await requestLocationPermission()
  if (!permitted) {
    return
  }

  const startDate = new Date()
  const newActivityId = toActivityId(startDate)

  try {
    await clearActivePoints()

    activityId.value = newActivityId
    startedAtMs.value = startDate.getTime()
    elapsedSeconds.value = 0
    pointsCaptured.value = 0
    lastPoint.value = null
    tracking.value = true
    currentDraft = {
      activityId: newActivityId,
      status: 'initial',
      metadata: {
        startedAt: startDate.toISOString(),
        sampleIntervalSeconds: sampleIntervalSeconds.value,
        maxDurationHours: maxDurationHours.value,
      },
    }

    await putCompletedActivity({
      activityId: currentDraft.activityId,
      status: currentDraft.status,
      metadata: { ...currentDraft.metadata },
      points: [],
    })
    await refreshSummaries()

    startPositionWatch()
    await captureSample()

    sampleTimerId = window.setInterval(() => {
      void captureSample()
    }, sampleIntervalSeconds.value * 1_000)

    maxDurationTimerId = window.setInterval(() => {
      if (!tracking.value || !startedAtMs.value) {
        return
      }

      elapsedSeconds.value = Math.floor((Date.now() - startedAtMs.value) / 1000)

      if (Date.now() - startedAtMs.value >= maxDurationMs.value) {
        void stopTracking('max_duration_reached')
      }
    }, 1_000)

    statusMessage.value = 'Tracking started.'
  } catch {
    statusMessage.value = 'Failed to start tracking due to local storage error.'
    clearTimers()
    stopPositionWatch()
    tracking.value = false
  }
}

async function stopTracking(reason = 'user_stopped'): Promise<void> {
  if ((!tracking.value && !currentDraft) || stopping) {
    return
  }

  stopping = true
  clearTimers()
  stopPositionWatch()

  try {
    const points = await getAllActivePoints()
    const endedAt = new Date().toISOString()
    const startedAtIso = currentDraft?.metadata.startedAt ?? new Date().toISOString()

    if (currentDraft) {
      const completedActivity: Activity = {
        activityId: currentDraft.activityId,
        status: 'pending',
        metadata: {
          ...currentDraft.metadata,
          endedAt,
          stopReason: reason,
          durationMs:
            startedAtMs.value !== null ? Math.max(0, Date.now() - startedAtMs.value) : undefined,
          initialStatus: currentDraft.status,
        },
        points,
      }

      completedActivity.metadata.startedAt = startedAtIso
      await putCompletedActivity(completedActivity)
    }

    await clearActivePoints()

    tracking.value = false
    currentDraft = null
    startedAtMs.value = null
    elapsedSeconds.value = 0
    activityId.value = ''
    latestPosition = null
    await refreshSummaries()

    statusMessage.value =
      reason === 'max_duration_reached'
        ? 'Tracking stopped after reaching the configured maximum duration.'
        : 'Tracking stopped.'
  } catch {
    statusMessage.value = 'Tracking stopped, but finalizing local activity data failed.'
    tracking.value = false
    currentDraft = null
    startedAtMs.value = null
    elapsedSeconds.value = 0
    activityId.value = ''
  } finally {
    stopping = false
  }
}

function formatDate(value: string): string {
  if (!value) {
    return 'n/a'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString()
}

function formatPointTs(ts: number): string {
  return new Date(ts).toLocaleString()
}

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

onMounted(async () => {
  await ensurePermissionState()
  await refreshSummaries()
})

onBeforeUnmount(() => {
  if (tracking.value) {
    void stopTracking('component_unmount')
  }
})
</script>

<template>
  <main class="app-shell">
    <section class="card">
      <h1>{{appDisplayName}}</h1>
      <p class="subtle">Simple local GPS activity tracker v{{pkgVersion}}</p>

      <div class="form-grid">
        <label>
          <span>Sample interval (seconds)</span>
          <input v-model.number="sampleIntervalSeconds" type="number" min="1" :disabled="tracking" />
        </label>

        <label>
          <span>Max duration (hours)</span>
          <input
            v-model.number="maxDurationHours"
            type="number"
            min="0.1"
            step="0.1"
            :disabled="tracking"
          />
        </label>
      </div>

      <div class="row">
        <button type="button" class="button secondary" @click="requestLocationPermission" :disabled="tracking">
          Enable Location Access
        </button>
      </div>

      <div class="row buttons">
        <button type="button" class="button primary" @click="startTracking" :disabled="tracking">Start</button>
        <button type="button" class="button danger" @click="stopTracking()" :disabled="!tracking">Stop</button>
      </div>

      <div class="status">
        <p><strong>Permission:</strong> {{ permissionState }}</p>
        <p><strong>Status:</strong> {{ statusMessage }}</p>
        <p><strong>Active activity:</strong> {{ activityId || 'none' }}</p>
        <p><strong>Elapsed:</strong> {{ formatElapsed(elapsedSeconds) }}</p>
        <p><strong>Points captured:</strong> {{ pointsCaptured }}</p>
      </div>

      <div v-if="lastPoint" class="status">
        <p>
          <strong>Last point:</strong>
          {{ lastPoint.lat.toFixed(6) }}, {{ lastPoint.lon.toFixed(6) }}
        </p>
        <p><strong>Accuracy:</strong> {{ lastPoint.acc ?? 'n/a' }} m</p>
      </div>
    </section>

    <section class="card">
      <h2>Recorded Activities (Local)</h2>

      <ul v-if="summaries.length > 0" class="activity-list">
        <li
          v-for="activity in summaries"
          :key="activity.activityId"
          :class="{ selected: selectedActivityId === activity.activityId }"
        >
          <p><strong>ID:</strong> {{ activity.activityId }}</p>
          <p><strong>Status:</strong> {{ activity.status }}</p>
          <p><strong>Points:</strong> {{ activity.pointsCount }}</p>
          <p><strong>Started:</strong> {{ formatDate(activity.startedAt) }}</p>
          <p><strong>Ended:</strong> {{ formatDate(activity.endedAt) }}</p>
          <button
            type="button"
            class="button secondary"
            @click="selectActivity(activity.activityId)"
            :aria-pressed="selectedActivityId === activity.activityId"
          >
            View Details
          </button>
        </li>
      </ul>

      <p v-else class="subtle">No recorded activities yet.</p>

      <div v-if="selectedActivity" class="status">
        <h3>Activity Details</h3>
        <p><strong>ID:</strong> {{ selectedActivity.activityId }}</p>
        <p><strong>Status:</strong> {{ selectedActivity.status }}</p>
        <p><strong>Total Points:</strong> {{ selectedActivity.points.length }}</p>
        <p><strong>Preview:</strong> showing first {{ selectedPointsPreview.length }} points</p>

        <div class="points-table-wrap">
          <table class="points-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Lat</th>
                <th>Lon</th>
                <th>Acc (m)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="point in selectedPointsPreview" :key="point.ts">
                <td>{{ formatPointTs(point.ts) }}</td>
                <td>{{ point.lat.toFixed(6) }}</td>
                <td>{{ point.lon.toFixed(6) }}</td>
                <td>{{ point.acc ?? 'n/a' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
:global(body) {
  margin: 0;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  background: #f4f5f7;
  color: #1b1f24;
}

:global(*) {
  box-sizing: border-box;
}

.app-shell {
  width: 100%;
  max-width: 460px;
  margin: 0 auto;
  padding: 12px;
  display: grid;
  gap: 12px;
}

.card {
  background: #fff;
  border: 1px solid #d8dee4;
  border-radius: 10px;
  padding: 12px;
}

h1,
h2 {
  margin: 0 0 8px;
}

h3 {
  margin: 0 0 8px;
  font-size: 1rem;
}

h1 {
  font-size: 1.4rem;
}

h2 {
  font-size: 1.15rem;
}

.subtle {
  margin: 0 0 10px;
  color: #57606a;
  font-size: 0.95rem;
}

.form-grid {
  display: grid;
  gap: 10px;
  margin-bottom: 10px;
}

label span {
  display: block;
  font-size: 0.88rem;
  margin-bottom: 4px;
}

input {
  width: 100%;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid #bfc7d1;
  font-size: 1rem;
}

.row {
  margin: 8px 0;
}

.buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.button {
  width: 100%;
  min-height: 44px;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.primary {
  background: #0969da;
  color: #fff;
}

.danger {
  background: #cf222e;
  color: #fff;
}

.secondary {
  background: #eaeef2;
  color: #1f2328;
}

.status {
  border-top: 1px solid #d8dee4;
  margin-top: 10px;
  padding-top: 10px;
}

.status p {
  margin: 4px 0;
  font-size: 0.95rem;
}

.activity-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.activity-list li {
  border: 1px solid #d8dee4;
  border-radius: 8px;
  padding: 10px;
  background: #fbfcfe;
}

.activity-list li.selected {
  border-color: #0969da;
}

.activity-list p {
  margin: 4px 0;
  font-size: 0.92rem;
}

.points-table-wrap {
  overflow-x: auto;
}

.points-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.points-table th,
.points-table td {
  border: 1px solid #d8dee4;
  padding: 6px;
  text-align: left;
  white-space: nowrap;
}

.points-table th {
  background: #f6f8fa;
}

@media (min-width: 768px) {
  .app-shell {
    max-width: 640px;
  }
}
</style>
