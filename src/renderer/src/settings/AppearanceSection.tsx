import { useState, type CSSProperties } from 'react'
import type { PublicSettings, SettingsPatch, Theme } from '@shared/types'
import { Segmented, Switch } from '../components/fields'
import { StyleControls, type ColorTarget } from '../components/StyleControls'
import { useOverlayStyle } from '../hooks/useOverlayStyle'
import { panelVars } from '../panel/color'

const LINE_OPTIONS = ['1', '2', '3', '4'].map((value) => ({ value, label: `${value} 行` }))

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '白天' },
  { value: 'dark', label: '黑夜' }
]

interface Props {
  settings: PublicSettings
  save: (patch: SettingsPatch) => Promise<void>
}

export function AppearanceSection({ settings, save }: Props): React.JSX.Element {
  const [style, updateStyle] = useOverlayStyle(settings, save)
  const [picking, setPicking] = useState<ColorTarget | null>(null)
  return (
    <>
      <header className="section-head">
        <h2>外观</h2>
        <p>主题管设置窗口；字幕样式管底部看板和翻译记录。</p>
      </header>
      <div className="section-body">
        <h3>主题</h3>
        <Segmented
          label="主题"
          value={settings.theme}
          options={THEMES}
          onChange={(theme) => void save({ theme })}
        />

        <h3>字幕样式</h3>
        <div className="style-preview" style={panelVars(style)}>
          <div className="style-preview-block">
            {style.showSource && (
              <p className="style-preview-source">Could you push the fix before Friday?</p>
            )}
            <p
              className="style-preview-translation"
              style={{ '--lines': style.lines } as CSSProperties}
            >
              好的，登录页这周四提测。你能在周五前把修复推上去吗？我们下周一再对一下排期。
            </p>
          </div>
        </div>
        <div className="style-controls">
          <StyleControls
            style={style}
            onChange={updateStyle}
            picking={picking}
            onPickingChange={setPicking}
          />
        </div>
        <Switch
          label="显示原文"
          checked={style.showSource}
          hint="在译文上面加一行对方说的原话。"
          onChange={(showSource) => updateStyle({ showSource })}
        />
        <Switch
          label="显示「说」的字幕"
          checked={style.showSpeak}
          hint="看板底部单独一条显示你说的话和译文。"
          onChange={(showSpeak) => updateStyle({ showSpeak })}
        />
        <div className="field">
          <span className="field-label">译文显示几行</span>
          <Segmented
            label="译文显示几行"
            value={String(style.lines)}
            options={LINE_OPTIONS}
            onChange={(lines) => updateStyle({ lines: Number(lines) })}
          />
          <small className="field-hint">实时字幕会滚动：新字从下面补上，旧行从上面滚走。</small>
        </div>
      </div>
    </>
  )
}
