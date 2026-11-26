import { ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { Clip, HistoryQuery } from '../types.ts'

export interface FavoriteDragState {
  id: number
  top: boolean
  target: number | null
  before: boolean
  pointer: number
}

export function useFavoriteDrag(options: {
  visible: ComputedRef<Clip[]>
  historyScroll: Ref<HTMLElement | undefined>
  layout: ComputedRef<'grid' | 'list'>
  favoriteSort: Ref<NonNullable<HistoryQuery['sort']>>
  imageSelectMode: Ref<boolean>
  isBusy: () => boolean
  onMoveFavorite: (clip: Clip, target: number | null, before: boolean) => Promise<void>
}) {
  const favoriteDrag = ref<FavoriteDragState | null>(null)

  function startFavoriteDrag(clip: Clip, event: PointerEvent) {
    if (event.button !== 0 || options.isBusy() || options.imageSelectMode.value || options.favoriteSort.value !== 'manual') return
    event.preventDefault()
    event.stopPropagation()
    favoriteDrag.value = { id: clip.id, top: !!clip.onTop, target: null, before: true, pointer: event.pointerId }
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
  }

  function updateFavoriteDrag(event: PointerEvent) {
    const drag = favoriteDrag.value
    if (!drag || drag.pointer !== event.pointerId) return
    const article = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-clip-id]')
    const clip = options.visible.value.find(item => item.id === Number(article?.dataset.clipId))
    drag.target = null
    if (clip && article && clip.id !== drag.id && !!clip.onTop === drag.top) {
      const rect = article.getBoundingClientRect()
      drag.target = clip.id
      drag.before = options.layout.value === 'list'
        ? event.clientY < rect.top + rect.height / 2
        : event.clientX < rect.left + rect.width / 2
    }
    const scroll = options.historyScroll.value
    if (scroll) {
      const rect = scroll.getBoundingClientRect()
      if (event.clientY < rect.top + 40) scroll.scrollTop -= 20
      if (event.clientY > rect.bottom - 40) scroll.scrollTop += 20
    }
  }

  async function finishFavoriteDrag(event: PointerEvent) {
    const drag = favoriteDrag.value
    if (!drag || drag.pointer !== event.pointerId) return
    favoriteDrag.value = null
    const clip = options.visible.value.find(item => item.id === drag.id)
    if (clip && drag.target !== null) await options.onMoveFavorite(clip, drag.target, drag.before)
  }

  return {
    favoriteDrag,
    startFavoriteDrag,
    updateFavoriteDrag,
    finishFavoriteDrag,
  }
}
