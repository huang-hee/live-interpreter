import { useCallback, useEffect, useState } from 'react'

export interface AudioDevices {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}

// Chromium 会额外列出 default / communications 两个别名设备，界面上用「系统默认」代替
const ALIAS_IDS = new Set(['default', 'communications'])

async function listDevices(): Promise<AudioDevices> {
  const all = await navigator.mediaDevices.enumerateDevices()
  const real = all.filter((device) => !ALIAS_IDS.has(device.deviceId))
  return {
    inputs: real.filter((device) => device.kind === 'audioinput'),
    outputs: real.filter((device) => device.kind === 'audiooutput')
  }
}

/** 设备名要在拿到麦克风权限后才有，拿到权限时调用 refresh 重新读一遍 */
export function useAudioDevices(): AudioDevices & { refresh: () => void } {
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [] })

  const refresh = useCallback(() => {
    void listDevices().then(setDevices)
  }, [])

  useEffect(() => {
    let active = true
    const load = (): void => {
      void listDevices().then((next) => {
        if (active) setDevices(next)
      })
    }
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => {
      active = false
      navigator.mediaDevices.removeEventListener('devicechange', load)
    }
  }, [])

  return { ...devices, refresh }
}
