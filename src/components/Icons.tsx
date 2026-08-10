/** Inline SVG icons, so the app ships without an icon dependency or webfont. */

interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function IconLogo({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 19V7.5L12 3l8 4.5V19" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <path d="M4 19h16" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <circle cx="12" cy="12.5" r="2.4" stroke="currentColor" strokeWidth={2} />
    </svg>
  )
}

export function IconOpen(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z" />
    </Svg>
  )
}

export function IconFit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </Svg>
  )
}

export function IconZoomIn(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.4-4.4M11 8.5v5M8.5 11h5" />
    </Svg>
  )
}

export function IconZoomOut(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.4-4.4M8.5 11h5" />
    </Svg>
  )
}

export function IconHand(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1a1.5 1.5 0 0 1 3 0v4.5a5 5 0 0 1-5 5h-1.6a5 5 0 0 1-3.9-1.87L5 15.5s-.9-1.3.2-2.1c.9-.65 1.9.2 1.9.2L9 15.5" />
    </Svg>
  )
}

export function IconRuler(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15.6 3.9 20.1 8.4a1.5 1.5 0 0 1 0 2.12L10.52 20.1a1.5 1.5 0 0 1-2.12 0L3.9 15.6a1.5 1.5 0 0 1 0-2.12l9.58-9.58a1.5 1.5 0 0 1 2.12 0Z" />
      <path d="m7.5 12 1.8 1.8M10.5 9l1.8 1.8M13.5 6l1.8 1.8" />
    </Svg>
  )
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 9.5h16M4 14.5h16M9.5 4v16M14.5 4v16" />
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
    </Svg>
  )
}

export function IconAxes(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 19V5M5 19h14" />
      <path d="M5 5l-2 2.5M5 5l2 2.5M19 19l-2.5-2M19 19l-2.5 2" />
    </Svg>
  )
}

export function IconExtents(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="6" width="17" height="12" rx="1.5" strokeDasharray="3 2.5" />
      <path d="M8.5 12h7" />
    </Svg>
  )
}

export function IconWeight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16" strokeWidth={1} />
      <path d="M4 12h16" strokeWidth={2.2} />
      <path d="M4 17h16" strokeWidth={3.4} />
    </Svg>
  )
}

export function IconText(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" />
    </Svg>
  )
}

export function IconFill(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 11.5 6.5-6.5 6.5 6.5-6.5 6.5z" />
      <path d="M9 8 5.6 4.6" />
      <path d="M18.8 15c.8 1.3 1.2 2.2 1.2 2.8a1.9 1.9 0 0 1-3.8 0c0-.6.4-1.5 1.2-2.8l.7-1.1z" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconEye(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 14}>
      <path d="M2.5 12s3.6-6.2 9.5-6.2S21.5 12 21.5 12s-3.6 6.2-9.5 6.2S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </Svg>
  )
}

export function IconEyeOff(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 14}>
      <path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.7c5.9 0 9.5 6.3 9.5 6.3a17 17 0 0 1-2.4 3.2M6.3 7.8A16.7 16.7 0 0 0 2.5 12s3.6 6.2 9.5 6.2c1.6 0 3-.4 4.2-1" />
      <path d="M10.2 10.3a2.6 2.6 0 0 0 3.6 3.7M3.5 3.5l17 17" />
    </Svg>
  )
}

export function IconIsolate(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 14}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" />
    </Svg>
  )
}

export function IconChevron(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 13}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  )
}

export function IconPanel(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M9.5 4.5v15" />
    </Svg>
  )
}

export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v10.5M8 11l4 4 4-4M4.5 19h15" />
    </Svg>
  )
}

export function IconWarning(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 15}>
      <path d="M12 4.8 21 19.2H3z" />
      <path d="M12 10v4M12 16.6v.1" />
    </Svg>
  )
}

export function IconError(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 15}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.6v5M12 15.9v.1" />
    </Svg>
  )
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 13}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  )
}

export function IconLayers(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3.5 8.5 4.7-8.5 4.7-8.5-4.7z" />
      <path d="m3.5 12.5 8.5 4.7 8.5-4.7" />
    </Svg>
  )
}

export function IconFile(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 28}>
      <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13.5 3.5V9H19" />
      <path d="M8.6 16.2c1.4-3 2.6-4.6 3.4-4.6.9 0 .5 3.4 1.3 3.4.6 0 1-1.2 2.1-2" />
    </Svg>
  )
}
