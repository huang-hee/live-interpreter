/**
 * 按下后跟踪指针相对起点的位移，每帧最多回调一次，松开时再补一次最终位置。
 * 用 pointer capture，指针移出窗口也能继续收到事件。
 */
export function trackPointer(
  event: React.PointerEvent<HTMLElement>,
  onDelta: (dx: number, dy: number) => void,
  onEnd?: () => void
): void {
  const target = event.currentTarget
  const { pointerId, screenX: startX, screenY: startY } = event
  target.setPointerCapture(pointerId)

  let frame = 0
  let dx = 0
  let dy = 0

  const move = (moveEvent: PointerEvent): void => {
    dx = moveEvent.screenX - startX
    dy = moveEvent.screenY - startY
    frame ||= requestAnimationFrame(() => {
      frame = 0
      onDelta(dx, dy)
    })
  }

  const end = (): void => {
    cancelAnimationFrame(frame)
    onDelta(dx, dy)
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', end)
    target.removeEventListener('pointercancel', end)
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    onEnd?.()
  }

  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', end)
  target.addEventListener('pointercancel', end)
}

const INTERACTIVE = 'button, input, select, textarea, label, a, [data-no-drag]'

export function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE) !== null
}

/** 无边框面板的拖动：按在非控件的地方就能拖走整个窗口 */
export function startWindowMove(event: React.PointerEvent<HTMLElement>, onEnd?: () => void): void {
  if (event.button !== 0 || isInteractive(event.target)) return
  const { screenX, screenY } = window
  trackPointer(event, (dx, dy) => window.api.moveWindow(screenX + dx, screenY + dy), onEnd)
}

/** 无边框面板的缩放：拖右下角的手柄 */
export function startWindowResize(
  event: React.PointerEvent<HTMLElement>,
  onEnd?: () => void,
  { widthOnly = false }: { widthOnly?: boolean } = {}
): void {
  if (event.button !== 0) return
  event.stopPropagation()
  const { outerWidth, outerHeight } = window
  trackPointer(
    event,
    (dx, dy) =>
      window.api.resizeWindow(outerWidth + dx, widthOnly ? outerHeight : outerHeight + dy),
    onEnd
  )
}
