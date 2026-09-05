import { Resvg } from '@resvg/resvg-js';

export interface PulseRenderTask {
  svg: string;
}

export interface PulseRenderResult {
  pixels: Uint8Array;
  width: number;
  height: number;
}

// Piscina's worker entry point for pulse-frame rasterization — see pulseRenderWorkerPool.ts for
// the pool this feeds into, and the design spec's spike for why `loadSystemFonts: false` matters:
// without it, every call pays a ~130ms system-font-scan cost regardless of the SVG's actual
// content (verified against the real resvg binary; this element's SVG has no <text> at all, so
// there is nothing lost by skipping that scan).
export default function renderPulseFrame(task: PulseRenderTask): PulseRenderResult {
  const pixmap = new Resvg(task.svg, { font: { loadSystemFonts: false } }).render();
  return { pixels: pixmap.pixels, width: pixmap.width, height: pixmap.height };
}
