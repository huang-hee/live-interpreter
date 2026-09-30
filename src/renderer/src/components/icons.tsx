import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

/** 16px 线性图标，颜色跟随 currentColor */
function Icon({ children, ...props }: IconProps): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export function EyeIcon({ off, ...props }: IconProps & { off?: boolean }): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
      <circle cx="8" cy="8" r="1.75" />
      {off && <path d="M2.5 13.5l11-11" />}
    </Icon>
  )
}
