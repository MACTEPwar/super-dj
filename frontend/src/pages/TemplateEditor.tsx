import { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { templatesApi, TemplateElement } from '../api/templates';
import { ApiError } from '../api/client';
import { usePageTitle } from '../hooks/usePageTitle';

// Mirrors src/templates/templateTypes.ts on the backend — kept in sync by hand rather than
// shared code (no shared package between frontend/backend in this project). Clamping to these
// bounds during every drag/resize/field edit means the editor can never produce a state the
// backend would reject with a 400, so there's no separate "invalid template" error UI to build.
const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const MAX_FONT_SIZE = 300;
const DISPLAY_WIDTH = 800;
const DISPLAY_HEIGHT = (DISPLAY_WIDTH * CANVAS_HEIGHT) / CANVAS_WIDTH;
const SCALE = DISPLAY_WIDTH / CANVAS_WIDTH;
const PREVIEW_DEBOUNCE_MS = 400;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Not every test/browser environment implements URL.revokeObjectURL (jsdom doesn't) — guarding
// it means a missing implementation just leaks the blob URL for that environment's lifetime
// instead of crashing the component.
function revokePreviewUrl(url: string): void {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

function defaultElement(type: TemplateElement['type']): TemplateElement {
  switch (type) {
    case 'cover':
      return { type: 'cover', x: 40, y: 40, width: 300, height: 300 };
    case 'title':
      return { type: 'title', x: 360, y: 40, width: 600, fontSize: 40, color: '#ffffff' };
    case 'playlist':
      return { type: 'playlist', x: 360, y: 140, width: 600, fontSize: 22, color: '#ffffff' };
    case 'timer':
      return { type: 'timer', x: 360, y: 260, fontSize: 28, color: '#ffffff' };
  }
}

// Non-cover elements have no stored height (drawtext/flex text sizes itself) — this is purely
// the editor's own interactive box height, derived from fontSize so bigger text gets a bigger
// (rough) selection target.
function displayHeight(el: TemplateElement): number {
  return el.type === 'cover' ? el.height : Math.round(el.fontSize * 1.6);
}

function displayWidth(el: TemplateElement): number {
  return el.type === 'timer' ? 160 : el.width;
}

interface DragState {
  index: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
}

interface ResizeState {
  index: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originWidth: number;
  originHeight: number | null;
}

function NumberField({ label, value, onChange, min = 0, max }: { label: string; value: number; onChange: (v: number) => void; min?: number; max: number }) {
  return (
    <label className="block text-xs text-gray-600">
      {label}
      <input
        type="number"
        value={Math.round(value)}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(clamp(n, min, max));
        }}
        className="mt-1 w-full rounded border px-2 py-1 text-sm"
      />
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const isSimpleHex = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <label className="block text-xs text-gray-600">
      {label}
      <div className="mt-1 flex items-center gap-2">
        <input
          type="color"
          value={isSimpleHex ? value : '#ffffff'}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-8 shrink-0 cursor-pointer rounded border p-0"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border px-2 py-1 text-sm"
        />
      </div>
    </label>
  );
}

export default function TemplateEditor() {
  const { id } = useParams<{ id: string }>();
  const templateId = id!;
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const templateQuery = useQuery({ queryKey: ['templates', templateId], queryFn: () => templatesApi.get(templateId) });
  usePageTitle(templateQuery.data?.name ?? t('templateEditor.title'));

  const [name, setName] = useState('');
  const [elements, setElements] = useState<TemplateElement[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (templateQuery.data && !loadedRef.current) {
      setName(templateQuery.data.name);
      setElements(templateQuery.data.elements);
      loadedRef.current = true;
    }
  }, [templateQuery.data]);

  // Live preview: debounced re-render on every element change, using the real backend pipeline
  // (Satori + resvg) so what's shown here is what will actually appear on stream, not an
  // approximation. Errors (e.g. a momentarily-invalid draft) just keep the last good preview
  // rather than showing an error state for every keystroke.
  useEffect(() => {
    if (!loadedRef.current) return;
    const timer = window.setTimeout(() => {
      templatesApi.previewBlobUrl(templateId, { elements })
        .then((url) => {
          if (previewUrlRef.current) revokePreviewUrl(previewUrlRef.current);
          previewUrlRef.current = url;
          setPreviewUrl(url);
        })
        .catch(() => { /* keep the last good preview */ });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [templateId, elements]);

  useEffect(() => () => {
    if (previewUrlRef.current) revokePreviewUrl(previewUrlRef.current);
  }, []);

  const saveMutation = useMutation({
    mutationFn: () => templatesApi.update(templateId, { name, elements }),
    onSuccess: () => {
      toast.success(t('templateEditor.saved'));
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('templateEditor.saveFailed')),
  });

  function updateElement(index: number, patch: Partial<TemplateElement>) {
    setElements((els) => els.map((el, i) => (i === index ? ({ ...el, ...patch } as TemplateElement) : el)));
  }

  function addElement(type: TemplateElement['type']) {
    setElements((els) => [...els, defaultElement(type)]);
    setSelectedIndex(elements.length);
  }

  function removeElement(index: number) {
    setElements((els) => els.filter((_, i) => i !== index));
    setSelectedIndex(null);
  }

  // Selection (click) and drag (pointerdown + pointermove) are handled separately, even though
  // a drag always starts with a pointerdown too — keeping "select" as its own plain click handler
  // means clicking an element to inspect it in the properties panel works the same way as every
  // other click target in the app, without depending on pointer-event support.
  function selectElement(e: ReactMouseEvent<HTMLDivElement>, index: number) {
    e.stopPropagation();
    setSelectedIndex(index);
  }

  function startDrag(e: ReactPointerEvent<HTMLDivElement>, index: number) {
    e.stopPropagation();
    setSelectedIndex(index);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported in every test/browser environment; drag still works within the element's own bounds */ }
    const el = elements[index];
    dragRef.current = { index, pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, originX: el.x, originY: el.y };
  }

  function onCanvasPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      const dx = (e.clientX - drag.startClientX) / SCALE;
      const dy = (e.clientY - drag.startClientY) / SCALE;
      updateElement(drag.index, { x: clamp(Math.round(drag.originX + dx), 0, CANVAS_WIDTH), y: clamp(Math.round(drag.originY + dy), 0, CANVAS_HEIGHT) });
      return;
    }
    const resize = resizeRef.current;
    if (resize && resize.pointerId === e.pointerId) {
      const dx = (e.clientX - resize.startClientX) / SCALE;
      const dy = (e.clientY - resize.startClientY) / SCALE;
      const patch: Partial<TemplateElement> = { width: clamp(Math.round(resize.originWidth + dx), 10, CANVAS_WIDTH) } as Partial<TemplateElement>;
      if (resize.originHeight !== null) (patch as { height?: number }).height = clamp(Math.round(resize.originHeight + dy), 10, CANVAS_HEIGHT);
      updateElement(resize.index, patch);
    }
  }

  function endInteraction(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
    if (resizeRef.current?.pointerId === e.pointerId) resizeRef.current = null;
  }

  function startResize(e: ReactPointerEvent<HTMLDivElement>, index: number) {
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* see startDrag */ }
    const el = elements[index];
    resizeRef.current = {
      index,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originWidth: displayWidth(el),
      originHeight: el.type === 'cover' ? el.height : null,
    };
  }

  const selected = selectedIndex !== null ? elements[selectedIndex] : null;

  if (templateQuery.isLoading) return <p className="text-sm text-gray-500">{t('templateEditor.loading')}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/templates" className="text-sm text-gray-500 underline">{t('templateEditor.back')}</Link>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded border px-3 py-2 text-lg font-semibold"
          />
        </div>
        <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {saveMutation.isPending ? t('templateEditor.saving') : t('templateEditor.save')}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(['cover', 'title', 'playlist', 'timer'] as const).map((type) => (
          <button key={type} onClick={() => addElement(type)} className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50">
            {t('templateEditor.addElement', { type: t(`templateEditor.elementType.${type}`) })}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div
          role="group"
          aria-label={t('templateEditor.canvasLabel')}
          className="relative shrink-0 overflow-hidden rounded border bg-gray-800 bg-[linear-gradient(45deg,#374151_25%,transparent_25%),linear-gradient(-45deg,#374151_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#374151_75%),linear-gradient(-45deg,transparent_75%,#374151_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0]"
          style={{ width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT }}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={endInteraction}
          onPointerCancel={endInteraction}
          onClick={() => setSelectedIndex(null)}
        >
          {previewUrl && <img src={previewUrl} alt="" className="pointer-events-none absolute inset-0 h-full w-full" />}
          {elements.length === 0 && (
            <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-gray-300">
              {t('templateEditor.emptyCanvasHint')}
            </p>
          )}
          {elements.map((el, i) => (
            <div
              key={i}
              onClick={(e) => selectElement(e, i)}
              onPointerDown={(e) => startDrag(e, i)}
              className={`absolute cursor-move border-2 ${selectedIndex === i ? 'border-blue-500' : 'border-white/60 hover:border-white'}`}
              style={{
                left: el.x * SCALE,
                top: el.y * SCALE,
                width: displayWidth(el) * SCALE,
                height: displayHeight(el) * SCALE,
              }}
            >
              <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-black/70 px-1 text-xs text-white">
                {t(`templateEditor.elementType.${el.type}`)}
              </span>
              {el.type !== 'timer' && (
                <div
                  onPointerDown={(e) => startResize(e, i)}
                  className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-se-resize rounded-sm bg-blue-500"
                />
              )}
            </div>
          ))}
        </div>

        <div className="w-64 shrink-0 space-y-3 rounded-lg border p-4">
          {!selected ? (
            <p className="text-sm text-gray-500">{t('templateEditor.noSelection')}</p>
          ) : (
            <>
              <div className="text-sm font-medium">{t(`templateEditor.elementType.${selected.type}`)}</div>
              <NumberField label={t('templateEditor.fieldX')} value={selected.x} max={CANVAS_WIDTH} onChange={(v) => updateElement(selectedIndex!, { x: v })} />
              <NumberField label={t('templateEditor.fieldY')} value={selected.y} max={CANVAS_HEIGHT} onChange={(v) => updateElement(selectedIndex!, { y: v })} />
              {selected.type !== 'timer' && (
                <NumberField label={t('templateEditor.fieldWidth')} value={selected.width} min={10} max={CANVAS_WIDTH} onChange={(v) => updateElement(selectedIndex!, { width: v })} />
              )}
              {selected.type === 'cover' && (
                <NumberField label={t('templateEditor.fieldHeight')} value={selected.height} min={10} max={CANVAS_HEIGHT} onChange={(v) => updateElement(selectedIndex!, { height: v })} />
              )}
              {selected.type !== 'cover' && (
                <NumberField label={t('templateEditor.fieldFontSize')} value={selected.fontSize} min={8} max={MAX_FONT_SIZE} onChange={(v) => updateElement(selectedIndex!, { fontSize: v })} />
              )}
              {selected.type !== 'cover' && (
                <ColorField label={t('templateEditor.fieldColor')} value={selected.color} onChange={(v) => updateElement(selectedIndex!, { color: v })} />
              )}
              <button onClick={() => removeElement(selectedIndex!)} className="text-sm text-red-600">{t('templateEditor.removeElement')}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
