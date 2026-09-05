import { useEffect, useRef } from 'react';

interface PulseEqualizerPreviewProps {
  colors: string[];
  glowLayers: number;
  glowRadius: number;
  coreWidth: number;
  boxWidth: number;
  boxHeight: number;
}

const BAND_COUNT = 56;

interface Pulse {
  band: number;
  amplitude: number;
  spread: number;
  attack: number;
  decay: number;
  startedAt: number;
}

function widthsFor(glowRadius: number, glowLayers: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < glowLayers; i++) {
    const f = i / (glowLayers - 1 || 1);
    out.push(glowRadius * Math.pow(1 - f, 1.5) + 0.4);
  }
  return out;
}

function tracePath(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
}

// A client-side port of the exact same drawing recipe PulseVisualizer uses server-side (layered
// glow strokes over an angular polyline, plus a gradient) — see the design spec's "Editor: live
// preview" section for why this can't be the real audio-driven render (there's no audio playing
// in the editor) but the STYLE (colors/glow/thickness) is still true WYSIWYG, since it's driven
// by the same props the saved element carries.
export function PulseEqualizerPreview({ colors, glowLayers, glowRadius, coreWidth, boxWidth, boxHeight }: PulseEqualizerPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const ctx: CanvasRenderingContext2D = context;
    canvas.width = boxWidth;
    canvas.height = boxHeight;

    let pulses: Pulse[] = [];
    let beatTimer = 0;
    let lastT = 0;
    let raf = 0;
    let running = true;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    function spawnBeat(band: number, t: number) {
      const sign = Math.random() < 0.5 ? 1 : -1;
      pulses.push({ band, amplitude: sign, spread: 1.3, attack: 0.03, decay: 0.09, startedAt: t });
      pulses.push({ band: band + (Math.random() - 0.5) * 1.3, amplitude: -sign * 0.4, spread: 1.17, attack: 0.02, decay: 0.1, startedAt: t + 0.1 });
    }

    function draw(tMs: number) {
      const t = tMs / 1000;
      const dt = lastT ? t - lastT : 0;
      lastT = t;

      beatTimer -= dt;
      if (beatTimer <= 0) {
        beatTimer = 0.35 + Math.random() * 0.3;
        spawnBeat(Math.floor(Math.random() * BAND_COUNT), t);
      }
      pulses = pulses.filter((p) => t - p.startedAt < p.attack + p.decay * 6);

      const values = new Array(BAND_COUNT).fill(0);
      for (const p of pulses) {
        const dtp = t - p.startedAt;
        if (dtp < 0) continue;
        const env = dtp < p.attack ? dtp / p.attack : Math.exp(-(dtp - p.attack) / p.decay);
        if (env < 0.002) continue;
        for (let b = 0; b < BAND_COUNT; b++) {
          const d = b - p.band;
          values[b] += p.amplitude * env * Math.exp(-(d * d) / (2 * p.spread * p.spread));
        }
      }

      ctx.clearRect(0, 0, boxWidth, boxHeight);
      const grad = ctx.createLinearGradient(0, 0, boxWidth, 0);
      colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1 || 1), c));

      const points = values.map((v, i) => ({
        x: (i / (BAND_COUNT - 1)) * boxWidth,
        y: boxHeight / 2 - Math.max(-1.3, Math.min(1.5, v)) * boxHeight * 0.4,
      }));

      const widths = widthsFor(glowRadius, glowLayers);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalCompositeOperation = 'lighter';
      widths.forEach((w, i) => {
        const f = i / (widths.length - 1 || 1);
        tracePath(ctx, points);
        ctx.strokeStyle = grad;
        ctx.lineWidth = w;
        ctx.globalAlpha = Math.min(1, 0.05 + 0.45 * Math.pow(f, 2.2));
        ctx.stroke();
      });
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      tracePath(ctx, points);
      ctx.strokeStyle = '#fbf3ff';
      ctx.lineWidth = coreWidth;
      ctx.stroke();

      if (running && !reduceMotion) raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [colors, glowLayers, glowRadius, coreWidth, boxWidth, boxHeight]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
}
