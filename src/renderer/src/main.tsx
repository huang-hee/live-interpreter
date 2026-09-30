import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Engine } from './engine/engine'
import { Overlay } from './overlay/Overlay'
import { Records } from './records/Records'
import { SettingsApp } from './settings/SettingsApp'

// 所有窗口共用一个页面入口，preload 按启动参数告诉页面自己是哪个窗口
const role = window.api.role

if (role === 'engine') {
  // 引擎没有界面；主进程通过 executeJavaScript 调 window.__engine.handle()
  window.__engine = new Engine()
} else {
  document.title = role === 'settings' ? '同传设置' : role === 'records' ? '翻译记录' : '同传'
  if (role !== 'settings') document.documentElement.classList.add('panel-window')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {role === 'overlay' ? <Overlay /> : role === 'records' ? <Records /> : <SettingsApp />}
    </StrictMode>
  )
}
