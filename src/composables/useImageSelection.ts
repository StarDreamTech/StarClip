import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { Clip } from '../types.ts'
import { selectClip } from '../clip-selection.ts'
import { errorText, t } from '../i18n/index.ts'

export function useImageSelection(options: {
  visible: ComputedRef<Clip[]>
  imageBatchBusy: Ref<boolean>
  notify: (message: string, isError?: boolean) => void
}) {
  const imageSelectMode = ref(false)
  const imageSelection = ref<number[]>([])
  let imageAnchor: number | null = null

  const pageImageIds = computed(() =>
    options.visible.value.filter(c => c.kind === 'image' || c.kind === 'bundle').map(c => c.id),
  )

  function clearImageSelection() {
    imageSelection.value = []
    imageAnchor = null
  }

  function finishImageSelection() {
    imageSelectMode.value = false
    clearImageSelection()
  }

  function chooseImage(clip: Clip, range = false) {
    if (!imageSelectMode.value || (clip.kind !== 'image' && clip.kind !== 'bundle') || options.imageBatchBusy.value) return
    try {
      imageSelection.value = selectClip(imageSelection.value, clip.id, pageImageIds.value, imageAnchor, range)
      imageAnchor = clip.id
    } catch (error) {
      options.notify(errorText(error), true)
    }
  }

  function checkImage(clip: Clip, event: MouseEvent) {
    chooseImage(clip, event.shiftKey)
    const input = event.currentTarget as HTMLInputElement
    input.checked = imageSelection.value.includes(clip.id)
  }

  function selectPageImages() {
    const ids = [...new Set([...imageSelection.value, ...pageImageIds.value])]
    if (ids.length > 50) {
      options.notify(t('每批最多选择 50 张图片。'), true)
      return
    }
    imageSelection.value = ids
  }

  return {
    imageSelectMode,
    imageSelection,
    pageImageIds,
    clearImageSelection,
    finishImageSelection,
    chooseImage,
    checkImage,
    selectPageImages,
  }
}
