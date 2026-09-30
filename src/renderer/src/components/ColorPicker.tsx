import { useId, useState, type CSSProperties } from 'react'

interface Hsl {
  h: number
  s: number
  l: number
}

const HEX = /^#[0-9a-f]{6}$/

/** 输入框里的色值，不带 # 也认 */
const toHex = (text: string): string => (text.startsWith('#') ? text : `#${text}`).toLowerCase()

function hexToHsl(hex: string): Hsl {
  const value = Number.parseInt(hex.slice(1), 16)
  const r = ((value >> 16) & 0xff) / 255
  const g = ((value >> 8) & 0xff) / 255
  const b = (value & 0xff) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: Math.round(h * 60), s: Math.round(s * 100), l: Math.round(l * 100) }
}

function hslToHex({ h, s, l }: Hsl): string {
  const light = l / 100
  const a = (s / 100) * Math.min(light, 1 - light)
  const channel = (n: number): string => {
    const k = (n + h / 30) % 12
    const value = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

interface Props {
  label: string
  value: string
  onChange: (color: string) => void
  onClose: () => void
}

/**
 * 页面内的取色器，替代 input[type=color]。
 * 看板是屏保层级的置顶窗口，系统取色面板会被它压在下面，所以直接在页面里调色相、饱和、亮度。
 */
export function ColorPicker({ label, value, onChange, onClose }: Props): React.JSX.Element {
  const hexId = useId()
  // 拖滑块时以本地的 HSL 为准：灰色换算回来没有色相，来回转会把色相滑块弹回 0
  const [hsl, setHsl] = useState(() => hexToHsl(value))
  const [draft, setDraft] = useState(value)
  const [synced, setSynced] = useState(value)

  // 外面换了颜色（点了预设色块）时跟着更新
  if (value !== synced) {
    setSynced(value)
    setHsl(hexToHsl(value))
    setDraft(value)
  }

  const emit = (hex: string): void => {
    setSynced(hex)
    onChange(hex)
  }

  const pickHsl = (next: Hsl): void => {
    const hex = hslToHex(next)
    setHsl(next)
    setDraft(hex)
    emit(hex)
  }

  const pickHex = (text: string): void => {
    setDraft(text)
    const hex = toHex(text)
    if (!HEX.test(hex)) return
    setHsl(hexToHsl(hex))
    emit(hex)
  }

  const slider = (key: keyof Hsl, name: string, max: number, track: string): React.JSX.Element => (
    <label className="picker-slider">
      {name}
      <input
        type="range"
        min={0}
        max={max}
        value={hsl[key]}
        style={{ '--track': track } as CSSProperties}
        onChange={(event) => pickHsl({ ...hsl, [key]: Number(event.target.value) })}
      />
    </label>
  )

  return (
    <div
      className="color-picker"
      role="group"
      aria-label={`自定义${label}色`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <label className="picker-hex" htmlFor={hexId}>
        <span className="picker-preview" style={{ background: value }} />
        <input
          id={hexId}
          value={draft}
          maxLength={7}
          spellCheck={false}
          aria-label={`${label}色色值`}
          aria-invalid={!HEX.test(toHex(draft))}
          onChange={(event) => pickHex(event.target.value.trim())}
        />
      </label>
      {slider('h', '色相', 360, 'linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)')}
      {slider(
        's',
        '饱和',
        100,
        `linear-gradient(90deg, hsl(${hsl.h} 0% ${hsl.l}%), hsl(${hsl.h} 100% ${hsl.l}%))`
      )}
      {slider('l', '亮度', 100, `linear-gradient(90deg, #000, hsl(${hsl.h} ${hsl.s}% 50%), #fff)`)}
      <button type="button" className="picker-done" onClick={onClose}>
        完成
      </button>
    </div>
  )
}
