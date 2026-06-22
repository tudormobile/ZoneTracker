<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  sampleIntervalSeconds: number
  maxDurationHours: number
  tracking: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:sampleIntervalSeconds', value: number): void
  (e: 'update:maxDurationHours', value: number): void
}>()

const sampleInterval = computed({
  get: () => props.sampleIntervalSeconds,
  set: (value: number) => emit('update:sampleIntervalSeconds', value),
})

const maxDuration = computed({
  get: () => props.maxDurationHours,
  set: (value: number) => emit('update:maxDurationHours', value),
})
</script>

<template>
  <div class="form-grid">
    <label>
      <span>Sample interval (seconds)</span>
      <input v-model.number="sampleInterval" type="number" min="1" :disabled="tracking" />
    </label>

    <label>
      <span>Max duration (hours)</span>
      <input
        v-model.number="maxDuration"
        type="number"
        min="0.1"
        step="0.1"
        :disabled="tracking"
      />
    </label>
  </div>
</template>
