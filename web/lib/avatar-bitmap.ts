/**
 * Bot avatars on the graph's nodes (owner, 13 Nov): the same face as the team list (web/lib/bot-avatar.ts), drawn on
 * the canvas from a bitmap made once per name and theme, then reused every frame with one drawImage.
 *
 * The cache is generic over the bitmap type so the rule (one render per name + role + theme, reused, bounded) is
 * tested without a browser; the canvas side passes a renderer that turns the SVG markup into an offscreen canvas.
 */
import { botAvatarSvg } from './bot-avatar'

export type AvatarTheme = 'light' | 'dark'

export interface AvatarRequest {
  name: string
  /** The Orchestrator / coordinator style (hexagon head, crown). */
  coordinator: boolean
  theme: AvatarTheme
}

/** Same normalisation as the avatar's own hash (trimmed, lower case): " Orion" and "orion" share one bitmap. */
export function avatarKey(r: AvatarRequest): string {
  return `${r.theme}|${r.coordinator ? 'c' : 'm'}|${r.name.trim().toLowerCase()}`
}

export type AvatarRenderer<B> = (svg: string, req: AvatarRequest) => B

export class AvatarBitmapCache<B> {
  private readonly map = new Map<string, B>()
  private renders = 0

  constructor(private readonly render: AvatarRenderer<B>, private readonly max = 96) {}

  /** The bitmap for this name, role and theme: rendered on first use, the same object afterwards. */
  get(req: AvatarRequest): B {
    const key = avatarKey(req)
    const hit = this.map.get(key)
    if (hit !== undefined) {
      // keep recently used entries at the end (oldest first out when the cap is reached)
      this.map.delete(key)
      this.map.set(key, hit)
      return hit
    }
    const b = this.render(botAvatarSvg(req.name, { coordinator: req.coordinator }), req)
    this.renders++
    this.map.set(key, b)
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    return b
  }

  get size(): number {
    return this.map.size
  }

  /** How many bitmaps were rendered so far (for tests and the perf check). */
  get renderCount(): number {
    return this.renders
  }

  clear(): void {
    this.map.clear()
  }
}

/** Corner radius of the tile, as a share of its side (same as the React avatar: Math.round(size * 0.28)). */
export const AVATAR_CORNER = 0.28

/** Side of the avatar tile inside a node's hexagon of radius r: fits inside the hexagon's inner circle. */
export function avatarSide(r: number): number {
  return r * 1.3
}
