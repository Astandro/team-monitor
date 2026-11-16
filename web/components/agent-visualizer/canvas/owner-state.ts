// The graph nodes in the "Butuh jawaban owner" state (lib/owner-decision.ts). The canvas draws from frame data, not
// React props, so the visualizer sets them here whenever the open decisions or the nodes change (same pattern as
// the coordinator in identity.ts).

let ownerNodes: ReadonlySet<string> = new Set()

export function setCanvasOwnerNodes(ids: ReadonlySet<string>): void {
  ownerNodes = ids
}

export function isCanvasOwnerNode(id: string): boolean {
  return ownerNodes.has(id)
}
