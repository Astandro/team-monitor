'use client'

import { useMemo } from 'react'
import { botAvatarSvg } from '@/lib/bot-avatar'

/**
 * A member's bot face (web/lib/bot-avatar.ts), the same in the team list, the task bubbles, the graph's node card and
 * the chat. Decorative: the name always sits next to it as text. The markup is built from fixed shapes and palette
 * colours only (the name is hashed, never inserted), so injecting it is safe.
 */
export function BotAvatar({ name, coordinator, size, className, style }: {
  name: string
  coordinator?: boolean
  /** px; omit to fill the parent */
  size?: number
  className?: string
  style?: React.CSSProperties
}) {
  const html = useMemo(() => botAvatarSvg(name, { coordinator }), [name, coordinator])
  return (
    <span
      className={`tm-bot${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      style={{
        display: 'block',
        overflow: 'hidden',
        flexShrink: 0,
        ...(size ? { width: size, height: size, borderRadius: Math.round(size * 0.28) } : { width: '100%', height: '100%', borderRadius: 'inherit' }),
        ...style,
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
