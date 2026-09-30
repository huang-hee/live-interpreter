import type { OverlaySettings } from '@shared/types'
import { BACKGROUND_COLORS, TEXT_COLORS } from '../panel/color'
import { ColorPicker } from './ColorPicker'
import '../panel/panel.css'

const FONT_MIN = 16
const FONT_MAX = 64

/** 正在自定义哪一种颜色 */
export type ColorTarget = 'text' | 'background'

interface SwatchesProps {
  label: string
  colors: string[]
  value: string
  picking: boolean
  onChange: (color: string) => void
  onTogglePicker: () => void
}

function Swatches({
  label,
  colors,
  value,
  picking,
  onChange,
  onTogglePicker
}: SwatchesProps): React.JSX.Element {
  const custom = !colors.includes(value)
  return (
    <div className="swatches" role="radiogroup" aria-label={`${label}色`}>
      <span>{label}</span>
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          className="swatch"
          style={{ background: color }}
          onClick={() => onChange(color)}
        />
      ))}
      <button
        type="button"
        className="swatch swatch-custom"
        data-checked={custom}
        aria-expanded={picking}
        aria-label={`自定义${label}色`}
        title="自定义颜色"
        onClick={onTogglePicker}
      />
    </div>
  )
}

interface Props {
  style: OverlaySettings
  onChange: (patch: Partial<OverlaySettings>) => void
  /** 取色器展开在哪种颜色上，由外面管：看板收起工具栏时要一起收起 */
  picking: ColorTarget | null
  onPickingChange: (target: ColorTarget | null) => void
}

/**
 * 字幕样式：字号、字色、底色、两种透明度。看板工具栏和设置里的「外观」共用。
 * 取色器放在最后，父容器是换行的 flex，它会独占一行。
 */
export function StyleControls({
  style,
  onChange,
  picking,
  onPickingChange
}: Props): React.JSX.Element {
  const toggle = (target: ColorTarget) => (): void =>
    onPickingChange(picking === target ? null : target)
  return (
    <>
      <div className="stepper" role="group" aria-label="字号">
        <button
          type="button"
          aria-label="字号减小"
          disabled={style.fontSize <= FONT_MIN}
          onClick={() => onChange({ fontSize: style.fontSize - 2 })}
        >
          −
        </button>
        <span>{style.fontSize}</span>
        <button
          type="button"
          aria-label="字号增大"
          disabled={style.fontSize >= FONT_MAX}
          onClick={() => onChange({ fontSize: style.fontSize + 2 })}
        >
          +
        </button>
      </div>
      <Swatches
        label="字"
        colors={TEXT_COLORS}
        value={style.textColor}
        picking={picking === 'text'}
        onChange={(textColor) => onChange({ textColor })}
        onTogglePicker={toggle('text')}
      />
      <Swatches
        label="底"
        colors={BACKGROUND_COLORS}
        value={style.backgroundColor}
        picking={picking === 'background'}
        onChange={(backgroundColor) => onChange({ backgroundColor })}
        onTogglePicker={toggle('background')}
      />
      <div className="sliders">
        <label className="slider">
          字透明
          <input
            type="range"
            min={0.3}
            max={1}
            step={0.05}
            value={style.textOpacity}
            onChange={(event) => onChange({ textOpacity: Number(event.target.value) })}
          />
        </label>
        <label className="slider">
          底透明
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={style.backgroundOpacity}
            onChange={(event) => onChange({ backgroundOpacity: Number(event.target.value) })}
          />
        </label>
      </div>
      {picking && (
        <ColorPicker
          key={picking}
          label={picking === 'text' ? '字' : '底'}
          value={picking === 'text' ? style.textColor : style.backgroundColor}
          onChange={(color) =>
            onChange(picking === 'text' ? { textColor: color } : { backgroundColor: color })
          }
          onClose={() => onPickingChange(null)}
        />
      )}
    </>
  )
}
