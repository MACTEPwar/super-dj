import { PointerEvent as ReactPointerEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ColorValue, GradientStop, GradientType } from '../api/templates';
import { gradientCss, insertStopAtMidpoint, MIN_GRADIENT_STOPS, MAX_GRADIENT_STOPS } from '../api/colorValue';

// Shared by TemplateEditor.tsx (the template overlay editor) and, from a later task, the
// per-track overlay-override editor — both need the identical solid/gradient color picker built
// on the same NumberField/ColorField primitives, so it lives here rather than being duplicated.

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function NumberField({ label, value, onChange, min = 0, max, step = 1, onFocus, onBlur }: { label: string; value: number; onChange: (v: number) => void; min?: number; max: number; step?: number; onFocus?: () => void; onBlur?: () => void }) {
  // Values snap to the step's grid — whole numbers by default, since nearly every caller (x/y/
  // width/height/fontSize/strokeWidth/shadow blur+offsets/gradient angle) is a whole-pixel or
  // whole-degree value with no legitimate use for fractional precision. A fractional step (the
  // equalizer's 0.5-3.0 sensitivity, 0-1 smoothing/beatBoost) snaps to that grid instead, with
  // the float noise of e.g. 3 * 0.1 = 0.30000000000000004 trimmed so state stays as clean as
  // what the field displays.
  const decimals = step >= 1 ? 0 : Math.ceil(-Math.log10(step));
  const snap = (n: number) => Number((Math.round(n / step) * step).toFixed(decimals));
  return (
    <label className="block text-xs text-gray-600">
      {label}
      <input
        type="number"
        value={snap(value)}
        min={min}
        max={max}
        step={step}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(e) => {
          const n = Number(e.target.value);
          // Snapped before clamping/storing, not just before display (the input's `value` above
          // already snaps for display, but onChange used to pass the raw fractional value
          // through — round-tripping a typed "400.5" back as a state value of 400.5 even though
          // the field visibly showed "401").
          if (Number.isFinite(n)) onChange(clamp(snap(n), min, max));
        }}
        className="mt-1 w-full rounded border px-2 py-1 text-sm"
      />
    </label>
  );
}

export function ColorField({ label, value, onChange, onFocus, onBlur }: { label: string; value: string; onChange: (v: string) => void; onFocus?: () => void; onBlur?: () => void }) {
  const isSimpleHex = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <label className="block text-xs text-gray-600">
      {label}
      <div className="mt-1 flex items-center gap-2">
        <input
          type="color"
          value={isSimpleHex ? value : '#ffffff'}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          className="h-8 w-8 shrink-0 cursor-pointer rounded border p-0"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          className="w-full rounded border px-2 py-1 text-sm"
        />
      </div>
    </label>
  );
}

const DEFAULT_GRADIENT_STOPS: GradientStop[] = [
  { color: '#ffffff', offset: 0 },
  { color: '#000000', offset: 100 },
];

function clampOffset(value: number): number {
  return clamp(Math.round(value), 0, 100);
}

// Solid/gradient toggle, gradient-type toggle, and the fields for whichever mode is active. Built
// on ColorField/NumberField above so both stay in one file — a caller with several ColorValue
// fields on one element (overlayOverride.color/.backgroundColor) passes a distinct `label` per
// instance.
export function ColorValueField({ label, value, onChange, onFocus, onBlur }: { label: string; value: ColorValue; onChange: (v: ColorValue) => void; onFocus?: () => void; onBlur?: () => void }) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);
  // Which stop index a drag is currently moving, if any — a ref (not state) since it's only read
  // from the same pointermove/pointerup handlers that set it, never rendered.
  const draggingIndexRef = useRef<number | null>(null);

  // Every button in this component is an instantaneous, one-shot click — there's no separate
  // "user is mid-edit" moment to bracket the way a focus-then-blur gesture has one. Firing
  // onFocus() immediately followed by onBlur() around the onChange reuses the exact same
  // gesture-grouping prop plumbing every ColorField/NumberField call below already gets, so a
  // click still produces exactly one undo-stack entry (a zero-duration gesture) instead of
  // needing a third callback prop just for this. Library.tsx passes neither prop, hence `?.`.
  function commitOneShot(next: ColorValue) {
    onFocus?.();
    onChange(next);
    onBlur?.();
  }

  function patchGradient(patch: Partial<Extract<ColorValue, { mode: 'gradient' }>>, oneShot = false) {
    if (value.mode !== 'gradient') return;
    const next: ColorValue = { ...value, ...patch };
    if (oneShot) commitOneShot(next); else onChange(next);
  }

  // A drag is one continuous gesture (like the canvas's own element drag in TemplateEditor.tsx) —
  // bracketed by a single onFocus/onBlur pair around every pointermove it produces, not one pair
  // per tick.
  function handleStopPointerDown(e: ReactPointerEvent<HTMLDivElement>, index: number) {
    e.stopPropagation();
    onFocus?.();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported in every test/browser environment; drag still works via the handlers below */ }
    draggingIndexRef.current = index;
  }

  function offsetFromClientX(clientX: number): number {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clampOffset(((clientX - rect.left) / rect.width) * 100);
  }

  function handleStopPointerMove(e: ReactPointerEvent<HTMLDivElement>, index: number) {
    if (draggingIndexRef.current !== index || value.mode !== 'gradient') return;
    const offset = offsetFromClientX(e.clientX);
    patchGradient({ stops: value.stops.map((s, j) => (j === index ? { ...s, offset } : s)) });
  }

  function handleStopPointerUp(index: number) {
    if (draggingIndexRef.current !== index) return;
    draggingIndexRef.current = null;
    onBlur?.();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-gray-600">
        <span>{label}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => commitOneShot({ mode: 'solid', color: value.mode === 'solid' ? value.color : '#ffffff' })}
            className={value.mode === 'solid' ? 'font-semibold underline' : ''}
          >{t('templateEditor.colorModeSolid')}</button>
          <button
            type="button"
            onClick={() => commitOneShot(value.mode === 'gradient' ? value : {
              mode: 'gradient', gradientType: 'linear', stops: DEFAULT_GRADIENT_STOPS, angleDeg: 0,
            })}
            className={value.mode === 'gradient' ? 'font-semibold underline' : ''}
          >{t('templateEditor.colorModeGradient')}</button>
        </div>
      </div>

      {value.mode === 'solid' && (
        <ColorField label={t('templateEditor.fieldColor')} value={value.color} onChange={(v) => onChange({ mode: 'solid', color: v })} onFocus={onFocus} onBlur={onBlur} />
      )}

      {value.mode === 'gradient' && (
        <>
          <div className="flex gap-2 text-xs text-gray-600">
            {(['linear', 'radial'] as GradientType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => patchGradient({ gradientType: type }, true)}
                className={value.gradientType === type ? 'font-semibold underline' : ''}
              >{t(type === 'linear' ? 'templateEditor.gradientTypeLinear' : 'templateEditor.gradientTypeRadial')}</button>
            ))}
          </div>

          {/* The draggable gradient strip: its background is the EXACT CSS string the backend
              will render (colorValue.ts's hand-kept gradientCss mirror), and each stop is a
              pointer-draggable handle positioned along it by offset. Dragging a handle recomputes
              that stop's offset from the pointer's position within the strip's own bounding box
              and feeds it straight through onChange — the same live path every other field here
              uses, so it drives the editor's existing debounced real-preview mechanism for free. */}
          <div ref={stripRef} className="relative h-4 w-full rounded border" style={{ background: gradientCss(value) }}>
            {value.stops.map((stop, i) => (
              <div
                key={i}
                data-testid={`gradient-stop-handle-${i}`}
                onPointerDown={(e) => handleStopPointerDown(e, i)}
                onPointerMove={(e) => handleStopPointerMove(e, i)}
                onPointerUp={() => handleStopPointerUp(i)}
                onPointerCancel={() => handleStopPointerUp(i)}
                className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-gray-800 shadow"
                style={{ left: `${stop.offset}%` }}
              />
            ))}
          </div>

          {value.stops.map((stop, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <ColorField
                  label={t('templateEditor.fieldGradientStop', { n: i + 1 })}
                  value={stop.color}
                  onChange={(v) => patchGradient({ stops: value.stops.map((s, j) => (j === i ? { ...s, color: v } : s)) })}
                  onFocus={onFocus}
                  onBlur={onBlur}
                />
              </div>
              <div className="w-20">
                <NumberField
                  label={t('templateEditor.fieldGradientStopOffset', { n: i + 1 })}
                  value={stop.offset}
                  max={100}
                  onChange={(v) => patchGradient({ stops: value.stops.map((s, j) => (j === i ? { ...s, offset: v } : s)) })}
                  onFocus={onFocus}
                  onBlur={onBlur}
                />
              </div>
              {value.stops.length > MIN_GRADIENT_STOPS && (
                <button
                  type="button"
                  onClick={() => patchGradient({ stops: value.stops.filter((_, j) => j !== i) }, true)}
                  className="pb-1 text-xs text-red-600"
                >{t('templateEditor.removeGradientStop')}</button>
              )}
            </div>
          ))}

          {value.stops.length < MAX_GRADIENT_STOPS && (
            // Inserts ONE new stop at the midpoint of the widest gap between existing stops,
            // leaving every existing stop's offset untouched — a deliberate product decision
            // (see colorValue.ts's insertStopAtMidpoint) over re-spreading the whole array: the
            // author may have just placed stops precisely via the strip above, and a change to
            // the stop COUNT should not silently move stops they didn't touch. Removing a stop
            // (above) already leaves the remaining offsets alone; this makes both directions
            // consistent.
            <button
              type="button"
              onClick={() => patchGradient({ stops: insertStopAtMidpoint(value.stops) }, true)}
              className="text-xs text-blue-600"
            >{t('templateEditor.addGradientStop')}</button>
          )}

          {value.gradientType === 'linear' && (
            <NumberField label={t('templateEditor.fieldGradientAngle')} value={value.angleDeg} max={360} onChange={(v) => patchGradient({ angleDeg: v })} onFocus={onFocus} onBlur={onBlur} />
          )}
        </>
      )}
    </div>
  );
}
