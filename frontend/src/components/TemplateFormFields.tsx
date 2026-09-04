import { useTranslation } from 'react-i18next';
import { ColorValue } from '../api/templates';

// Shared by TemplateEditor.tsx (the template overlay editor) and, from a later task, the
// per-track overlay-override editor — both need the identical solid/gradient color picker built
// on the same NumberField/ColorField primitives, so it lives here rather than being duplicated.

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function NumberField({ label, value, onChange, min = 0, max, onFocus, onBlur }: { label: string; value: number; onChange: (v: number) => void; min?: number; max: number; onFocus?: () => void; onBlur?: () => void }) {
  return (
    <label className="block text-xs text-gray-600">
      {label}
      <input
        type="number"
        value={Math.round(value)}
        min={min}
        max={max}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(e) => {
          const n = Number(e.target.value);
          // Rounded before clamping/storing, not just before display (the input's `value` above
          // already rounds for display, but onChange used to pass the raw fractional value
          // through — round-tripping a typed "400.5" back as a state value of 400.5 even though
          // the field visibly showed "401"). Every current caller (x/y/width/height/fontSize/
          // strokeWidth/shadow blur+offsets/gradient angle) is a whole-pixel or whole-degree
          // value with no legitimate use for fractional precision.
          if (Number.isFinite(n)) onChange(clamp(Math.round(n), min, max));
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

// Solid/gradient toggle + the fields for whichever mode is active. Built on ColorField/NumberField
// above so both stay in one file — a caller with several ColorValue fields on one element (e.g.
// a future overlayOverride.color/.backgroundColor pair) passes a distinct `label` per instance.
export function ColorValueField({ label, value, onChange, onFocus, onBlur }: { label: string; value: ColorValue; onChange: (v: ColorValue) => void; onFocus?: () => void; onBlur?: () => void }) {
  const { t } = useTranslation();

  // The solid/gradient toggle buttons are an instantaneous, one-shot click — there's no separate
  // "user is mid-edit" moment to bracket the way a focus-then-blur gesture has one. Firing
  // onFocus() immediately followed by onBlur() around the onChange reuses the exact same
  // gesture-grouping prop plumbing every ColorField/NumberField call below already gets, so a
  // toggle click still produces exactly one undo-stack entry (a zero-duration gesture) instead of
  // needing a third callback prop just for this component.
  function handleModeToggle(next: ColorValue) {
    onFocus?.();
    onChange(next);
    onBlur?.();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-gray-600">
        <span>{label}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleModeToggle({ mode: 'solid', color: value.mode === 'solid' ? value.color : '#ffffff' })}
            className={value.mode === 'solid' ? 'font-semibold underline' : ''}
          >{t('templateEditor.colorModeSolid')}</button>
          <button
            type="button"
            onClick={() => handleModeToggle({ mode: 'gradient', stops: value.mode === 'gradient' ? value.stops : ['#ffffff', '#000000'], angleDeg: value.mode === 'gradient' ? value.angleDeg : 0 })}
            className={value.mode === 'gradient' ? 'font-semibold underline' : ''}
          >{t('templateEditor.colorModeGradient')}</button>
        </div>
      </div>
      {value.mode === 'solid' && (
        <ColorField label={t('templateEditor.fieldColor')} value={value.color} onChange={(v) => onChange({ mode: 'solid', color: v })} onFocus={onFocus} onBlur={onBlur} />
      )}
      {value.mode === 'gradient' && (
        <>
          {value.stops.map((stop, i) => (
            <ColorField
              key={i}
              label={t('templateEditor.fieldGradientStop', { n: i + 1 })}
              value={stop}
              onChange={(v) => {
                const stops = [...value.stops] as [string, string] | [string, string, string];
                stops[i] = v;
                onChange({ mode: 'gradient', stops, angleDeg: value.angleDeg });
              }}
              onFocus={onFocus}
              onBlur={onBlur}
            />
          ))}
          <NumberField label={t('templateEditor.fieldGradientAngle')} value={value.angleDeg} max={360} onChange={(v) => onChange({ ...value, angleDeg: v })} onFocus={onFocus} onBlur={onBlur} />
        </>
      )}
    </div>
  );
}
