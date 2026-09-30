import type { CSSProperties } from 'react'
import type { OverlaySettings } from '@shared/types'

/** #rrggbb + 不透明度 → rgba() */
export function withOpacity(hex: string, opacity: number): string {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

export const TEXT_COLORS = ['#ffffff', '#ffe066', '#8ce99a', '#74c0fc', '#ffa8c5']
export const BACKGROUND_COLORS = ['#000000', '#1c2733', '#10263a', '#1e3325', '#3b2a1e']

/** 看板和记录共用的颜色、透明度，写成 CSS 变量 */
export function panelVars(style: OverlaySettings): CSSProperties {
  return {
    '--sub-size': `${style.fontSize}px`,
    '--sub-color': withOpacity(style.textColor, style.textOpacity),
    '--sub-bg': withOpacity(style.backgroundColor, style.backgroundOpacity)
  } as CSSProperties
}
