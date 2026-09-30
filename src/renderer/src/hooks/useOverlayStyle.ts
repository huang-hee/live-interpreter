import { useCallback, useEffect, useRef, useState } from 'react'
import type { OverlaySettings, PublicSettings, SettingsPatch } from '@shared/types'

/** 拖滑块时的改动先在本窗口生效，最多每这么久保存一次 */
const SAVE_INTERVAL_MS = 100

/**
 * 字幕样式：看板和设置里的「外观」都能改，改动立刻在本窗口生效，
 * 节流后保存，其他窗口通过设置广播跟上。
 */
export function useOverlayStyle(
  settings: PublicSettings,
  save: (patch: SettingsPatch) => Promise<void>
): [OverlaySettings, (patch: Partial<OverlaySettings>) => void] {
  const [local, setLocal] = useState<Partial<OverlaySettings>>({})
  const pending = useRef<Partial<OverlaySettings>>({})
  const timer = useRef<number | undefined>(undefined)

  const flush = useCallback(() => {
    timer.current = undefined
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length === 0) return
    void save({ overlay: patch }).then(() => {
      // 保存回来的设置已经带上这些值，本地覆盖可以去掉了
      if (Object.keys(pending.current).length === 0) setLocal({})
    })
  }, [save])

  // 关窗口时把还没保存的改动写掉
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      flush()
    },
    [flush]
  )

  const update = useCallback(
    (patch: Partial<OverlaySettings>) => {
      setLocal((current) => ({ ...current, ...patch }))
      pending.current = { ...pending.current, ...patch }
      timer.current ??= window.setTimeout(flush, SAVE_INTERVAL_MS)
    },
    [flush]
  )

  return [{ ...settings.overlay, ...local }, update]
}
