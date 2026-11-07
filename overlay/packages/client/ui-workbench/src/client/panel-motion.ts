/** Pointer-following panel reorder; the editor and conversation remain mounted. */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

type Side = 'left' | 'right'
const spring = 'linear(0, 0.16, 0.43, 0.69, 0.88, 1, 1.045, 1.048, 1.029, 1.012, 1.002, 1)'

/** Own drag capture, adjacent-panel movement and the settling animation. */
export function usePanelMotion() {
  const stage = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLElement>(null)
  const chat = useRef<HTMLDivElement>(null)
  const [side, setSide] = useState<Side>('right')
  const dispose = useRef<(() => void) | undefined>()
  const animation = useRef<Animation | undefined>()
  const chatAnimation = useRef<Animation | undefined>()
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const moveTo = (next: Side) => {
    const parent = stage.current, panel = editor.current, conversation = chat.current
    if (!parent || !panel || !conversation || parent.dataset.editorSide === next) return
    const before = conversation.getBoundingClientRect()
    parent.dataset.editorSide = next
    setSide(next)
    chatAnimation.current?.cancel()
    if (!reduced()) chatAnimation.current = conversation.animate([
      { transform: `translateX(${before.left - conversation.getBoundingClientRect().left}px)` },
      { transform: 'translateX(0)' },
    ], { duration: 380, easing: spring })
  }
  const place = (next: Side) => {
    dispose.current?.()
    const panel = editor.current
    if (!panel) return
    const before = panel.getBoundingClientRect()
    moveTo(next)
    animation.current?.cancel()
    if (!reduced()) animation.current = panel.animate([
      { transform: `translateX(${before.left - panel.getBoundingClientRect().left}px)` },
      { transform: 'translateX(0)' },
    ], { duration: 420, easing: spring })
  }
  useEffect(() => () => { dispose.current?.(); animation.current?.cancel(); chatAnimation.current?.cancel() }, [])
  const start = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button, input, select, a, [role="menu"]'))) return
    const parent = stage.current, panel = editor.current
    if (!parent || !panel || !chat.current || getComputedStyle(chat.current).display === 'none') return
    dispose.current?.(); animation.current?.cancel()
    const handle = event.currentTarget, pointer = event.pointerId
    const original = parent.dataset.editorSide === 'left' ? 'left' : 'right'
    const origin = panel.getBoundingClientRect(), bounds = parent.getBoundingClientRect()
    const x = event.clientX, y = event.clientY
    let moved = false
    handle.setPointerCapture(pointer)
    const finish = (cancel: boolean) => {
      handle.removeEventListener('pointermove', follow)
      handle.removeEventListener('pointerup', drop)
      handle.removeEventListener('pointercancel', abort)
      handle.removeEventListener('lostpointercapture', abort)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', abort)
      dispose.current = undefined
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
      if (!moved) return
      const before = panel.getBoundingClientRect()
      if (cancel) moveTo(original)
      panel.style.removeProperty('transform')
      delete panel.dataset.dragging
      const after = panel.getBoundingClientRect()
      if (!reduced()) animation.current = panel.animate([
        { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(1.012)` },
        { transform: 'translate(0, 0) scale(1)' },
      ], { duration: 420, easing: spring })
    }
    const follow = (move: PointerEvent) => {
      if (move.pointerId !== pointer) return
      const dx = move.clientX - x, dy = move.clientY - y
      if (!moved && Math.hypot(dx, dy) < 5) return
      moved = true
      move.preventDefault()
      panel.dataset.dragging = 'true'
      const fraction = (origin.left + dx + origin.width / 2 - bounds.left) / bounds.width
      if (fraction < 0.44) moveTo('left')
      else if (fraction > 0.56) moveTo('right')
      panel.style.removeProperty('transform')
      const destination = panel.getBoundingClientRect()
      const transform = `translate(${origin.left + dx - destination.left}px, ${Math.max(-32, Math.min(32, dy))}px) scale(1.012)`
      panel.style.transform = transform
    }
    const drop = (up: PointerEvent) => { if (up.pointerId === pointer) finish(false) }
    const abort = () => { finish(true) }
    const escape = (key: KeyboardEvent) => {
      if (key.key === 'Escape') { key.preventDefault(); key.stopImmediatePropagation(); finish(true) }
    }
    handle.addEventListener('pointermove', follow)
    handle.addEventListener('pointerup', drop)
    handle.addEventListener('pointercancel', abort)
    handle.addEventListener('lostpointercapture', abort)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', abort)
    dispose.current = abort
  }
  return { stage, editor, chat, side, place, start }
}
