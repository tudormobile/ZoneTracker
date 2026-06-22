<script setup lang="ts">
interface LastPoint {
  lat: number
  lon: number
  acc: number | null
}

interface Props {
  tracking: boolean
  permissionState: 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown'
  statusMessage: string
  activityId: string
  elapsedSeconds: number
  pointsCaptured: number
  lastPoint: LastPoint | null
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'request-location-permission'): void
  (e: 'start-tracking'): void
  (e: 'stop-tracking'): void
}>()

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}
</script>

<template>
  <div class="row">
    <button
      type="button"
      class="button secondary"
      @click="emit('request-location-permission')"
      :disabled="tracking"
    >
      Enable Location Access
    </button>
  </div>

  <div class="row buttons">
    <button type="button" class="button primary" @click="emit('start-tracking')" :disabled="tracking">Start</button>
    <button type="button" class="button danger" @click="emit('stop-tracking')" :disabled="!tracking">Stop</button>
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
</template>
