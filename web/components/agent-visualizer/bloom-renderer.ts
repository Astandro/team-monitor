/**
 * Bloom post-processing for holographic glow effect.
 * Takes the main canvas, extracts bright areas, blurs them,
 * and composites back with additive blending.
 */

/** The parts of a 2D context compositeBloom uses (a fake one in tests). */
export type BloomTarget = Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'setTransform' | 'drawImage' | 'globalCompositeOperation' | 'globalAlpha'>

/**
 * Lays the blurred copy over the canvas, pixel for pixel. The target context carries the device-pixel-ratio scale
 * (canvas.tsx calls ctx.scale(dpr, dpr)), while `deviceW` x `deviceH` are the canvas's own pixels, so the draw must
 * happen with the identity transform. Without the reset the glow of every node was drawn dpr times too large from
 * the top-left corner: on a phone (dpr 3) it showed as big soft blobs far from their nodes that slid three times as
 * fast as the graph when panning (owner screenshots 13 Nov). At dpr 1 the two are the same, which is why desktop
 * looked right.
 */
export function compositeBloom(
  targetCtx: BloomTarget, bloom: CanvasImageSource, deviceW: number, deviceH: number, intensity: number,
): void {
  targetCtx.save()
  targetCtx.setTransform(1, 0, 0, 1, 0, 0)
  targetCtx.globalCompositeOperation = 'lighter'
  targetCtx.globalAlpha = intensity
  targetCtx.drawImage(bloom, 0, 0, deviceW, deviceH)
  targetCtx.restore()
}

export class BloomRenderer {
  private bloomCanvas: HTMLCanvasElement
  private bloomCtx: CanvasRenderingContext2D
  private tempCanvas: HTMLCanvasElement
  private tempCtx: CanvasRenderingContext2D
  private intensity: number

  private enabled: boolean

  constructor(intensity: number = 0.6) {
    this.intensity = intensity
    this.bloomCanvas = document.createElement('canvas')
    this.tempCanvas = document.createElement('canvas')
    const bCtx = this.bloomCanvas.getContext('2d')
    const tCtx = this.tempCanvas.getContext('2d')
    this.enabled = !!(bCtx && tCtx)
    this.bloomCtx = bCtx!
    this.tempCtx = tCtx!
  }

  resize(width: number, height: number): void {
    // Bloom at half resolution for performance
    const scale = 0.5
    this.bloomCanvas.width = width * scale
    this.bloomCanvas.height = height * scale
    this.tempCanvas.width = width * scale
    this.tempCanvas.height = height * scale
  }

  apply(sourceCanvas: HTMLCanvasElement, targetCtx: CanvasRenderingContext2D): void {
    const w = this.bloomCanvas.width
    const h = this.bloomCanvas.height

    if (w === 0 || h === 0 || !this.enabled) return

    // Draw source at half resolution
    this.bloomCtx.clearRect(0, 0, w, h)
    this.bloomCtx.drawImage(sourceCanvas, 0, 0, w, h)

    // Apply blur passes (box blur approximation of gaussian)
    this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 8)
    this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 6)
    this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 4)

    compositeBloom(targetCtx, this.bloomCanvas, sourceCanvas.width, sourceCanvas.height, this.intensity)
  }

  private boxBlur(
    srcCtx: CanvasRenderingContext2D,
    tmpCtx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
  ): void {
    // Use CSS filter for fast blur
    tmpCtx.clearRect(0, 0, w, h)
    tmpCtx.filter = `blur(${radius}px)`
    tmpCtx.drawImage(srcCtx.canvas, 0, 0)
    tmpCtx.filter = 'none'

    srcCtx.clearRect(0, 0, w, h)
    srcCtx.drawImage(tmpCtx.canvas, 0, 0)
  }

  setIntensity(intensity: number): void {
    this.intensity = Math.max(0, Math.min(1, intensity))
  }
}
