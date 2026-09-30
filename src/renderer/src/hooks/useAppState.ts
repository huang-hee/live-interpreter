import { useEffect, useState } from 'react'
import type { AppState } from '@shared/types'

const INITIAL: AppState = {
  channels: {
    listen: { status: 'idle', message: '', error: '', speaking: false },
    speak: { status: 'idle', message: '', error: '', speaking: false }
  },
  holding: false,
  listenPaused: false
}

/** 主进程维护的运行状态：通道状态、按住说话、防回授暂停 */
export function useAppState(): AppState {
  const [state, setState] = useState<AppState>(INITIAL)

  useEffect(() => {
    let active = true
    void window.api.getState().then((loaded) => {
      if (active) setState(loaded)
    })
    const unsubscribe = window.api.onStateChanged(setState)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}
