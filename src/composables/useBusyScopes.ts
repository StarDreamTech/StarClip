import { computed, reactive } from 'vue'
import type { WritableComputedRef } from 'vue'

export type BusyScope =
  | 'dataOperation'
  | 'starPet'
  | 'update'
  | 'startup'
  | 'share'
  | 'imageBatch'
  | 'appearance'
  | 'privacy'
  | 'telemetry'
  | 'stats'
  | 'ai'
  | 'clipPrivacy'
  | 'clipDetails'

export function useBusyScopes() {
  const active = reactive(new Set<BusyScope>())

  function setBusy(scope: BusyScope, value: boolean) {
    if (value) active.add(scope)
    else active.delete(scope)
  }

  function scopeRef(scope: BusyScope): WritableComputedRef<boolean> {
    return computed({
      get: () => active.has(scope),
      set: (value: boolean) => setBusy(scope, value),
    })
  }

  const anyBusy = computed(() => active.size > 0)

  return {
    active,
    anyBusy,
    setBusy,
    scopeRef,
  }
}
