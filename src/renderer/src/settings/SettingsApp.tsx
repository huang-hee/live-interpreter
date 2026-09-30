import { useState } from 'react'
import type { ChannelStatus } from '@shared/types'
import { useAppState } from '../hooks/useAppState'
import { useAudioDevices } from '../hooks/useAudioDevices'
import { useSettings } from '../hooks/useSettings'
import { AccountSection } from './AccountSection'
import { AppearanceSection } from './AppearanceSection'
import { GlossarySection } from './GlossarySection'
import { TranslateSection } from './TranslateSection'
import { VoiceSection } from './VoiceSection'
import './settings.css'

type Section = 'account' | 'translate' | 'voice' | 'glossary' | 'appearance'

const SECTIONS: { value: Section; label: string }[] = [
  { value: 'account', label: '账号' },
  { value: 'translate', label: '翻译' },
  { value: 'voice', label: '音色' },
  { value: 'glossary', label: '术语表' },
  { value: 'appearance', label: '外观' }
]

/** 这些页面的改动会让正在进行的通道自动重连 */
const SESSION_SECTIONS = new Set<Section>(['translate', 'voice', 'glossary'])

const running = (status: ChannelStatus): boolean => status !== 'idle' && status !== 'error'

export function SettingsApp(): React.JSX.Element {
  const [settings, save] = useSettings()
  const state = useAppState()
  const devices = useAudioDevices()
  const [section, setSection] = useState<Section>('account')

  if (!settings) return <div className="settings-app" />

  const anyRunning = running(state.channels.listen.status) || running(state.channels.speak.status)

  return (
    <div className="settings-app">
      <nav className="settings-nav" aria-label="设置分类">
        {SECTIONS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-current={section === item.value ? 'page' : undefined}
            data-attention={item.value === 'account' && !settings.hasApiKey}
            onClick={() => setSection(item.value)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="settings-main">
        {anyRunning && SESSION_SECTIONS.has(section) && (
          <p className="settings-banner" role="status">
            改动立即生效。正在进行的通道会自动重连，重连时会漏掉不到一秒的声音。
          </p>
        )}
        {section === 'account' && <AccountSection settings={settings} save={save} />}
        {section === 'translate' && (
          <TranslateSection settings={settings} devices={devices} save={save} />
        )}
        {section === 'voice' && <VoiceSection settings={settings} save={save} />}
        {section === 'glossary' && <GlossarySection settings={settings} save={save} />}
        {section === 'appearance' && <AppearanceSection settings={settings} save={save} />}
      </main>
    </div>
  )
}
