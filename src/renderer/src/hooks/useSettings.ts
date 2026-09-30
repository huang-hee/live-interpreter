import { useCallback, useEffect, useState } from 'react'
import type { PublicSettings, SettingsPatch } from '@shared/types'

/** 读设置并跟随其他窗口的修改；主窗口和看板共用同一份设置 */
export function useSettings(): [PublicSettings | null, (patch: SettingsPatch) => Promise<void>] {
  const [settings, setSettings] = useState<PublicSettings | null>(null)

  useEffect(() => {
    let active = true
    void window.api.getSettings().then((loaded) => {
      if (active) setSettings(loaded)
    })
    const unsubscribe = window.api.onSettingsChanged(setSettings)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const save = useCallback(async (patch: SettingsPatch) => {
    setSettings(await window.api.saveSettings(patch))
  }, [])

  return [settings, save]
}
