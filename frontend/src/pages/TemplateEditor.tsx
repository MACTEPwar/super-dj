import { ChangeEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getFontFamilies, TemplateElement, templateImageUrl, templatesApi, uploadTemplateImage } from '../api/templates';
import { ApiError } from '../api/client';
import { usePageTitle } from '../hooks/usePageTitle';
import { ColorField, ColorValueField, NumberField } from '../components/TemplateFormFields';

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
const DEFAULT_FONT_FAMILY = 'DejaVu Sans';

// 'image' is deliberately excluded here — it needs an uploaded assetId before an element can
// exist at all, so it's added through its own dedicated upload button/mutation (see
// onAddImageClick below) rather than through defaultElement()/the generic add-element loop.
type AddableType = Exclude<TemplateElement['type'], 'image'>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Not every test/browser environment implements URL.revokeObjectURL (jsdom doesn't) — guarding
// it means a missing implementation just leaks the blob URL for that environment's lifetime
// instead of crashing the component.
function revokePreviewUrl(url: string): void {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

function defaultElement(type: AddableType, t: (key: string) => string): TemplateElement {
  switch (type) {
    case 'cover':
      return { type: 'cover', x: 40, y: 40, width: 300, height: 300 };
    case 'title':
      return {
        type: 'title', x: 360, y: 40, width: 600, fontSize: 40,
        color: { mode: 'solid', color: '#ffffff' },
        style: { fontFamily: DEFAULT_FONT_FAMILY, bold: false, italic: false },
      };
    case 'playlist':
      return {
        type: 'playlist', x: 360, y: 140, width: 600, fontSize: 22,
        color: { mode: 'solid', color: '#ffffff' },
        style: { fontFamily: DEFAULT_FONT_FAMILY, bold: false, italic: false },
      };
    case 'timer':
      return {
        type: 'timer', x: 360, y: 260, fontSize: 28, color: '#ffffff',
        style: { fontFamily: DEFAULT_FONT_FAMILY, bold: false, italic: false },
      };
    case 'text':
      return {
        type: 'text', x: 100, y: 100, width: 400, fontSize: 24,
        text: t('templateEditor.defaultText'),
        color: { mode: 'solid', color: '#ffffff' },
        style: { fontFamily: DEFAULT_FONT_FAMILY, bold: false, italic: false },
      };
    case 'equalizer':
      return { type: 'equalizer', x: 100, y: 500, width: 400, height: 150, color: '#ffffff' };
  }
}

// Non-cover/image elements have no stored height (drawtext/flex text sizes itself) — this is
// purely the editor's own interactive box height, derived from fontSize so bigger text gets a
// bigger (rough) selection target.
function displayHeight(el: TemplateElement): number {
  return el.type === 'cover' || el.type === 'image' || el.type === 'equalizer' ? el.height : Math.round(el.fontSize * 1.6);
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

export default function TemplateEditor() {
  const { id } = useParams<{ id: string }>();
  const templateId = id!;
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const templateQuery = useQuery({ queryKey: ['templates', templateId], queryFn: () => templatesApi.get(templateId) });
  const fontFamiliesQuery = useQuery({ queryKey: ['fontFamilies'], queryFn: getFontFamilies });
  usePageTitle(templateQuery.data?.name ?? t('templateEditor.title'));

  const [name, setName] = useState('');
  const [elements, setElements] = useState<TemplateElement[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const loadedRef = useRef(false);
  const [past, setPast] = useState<TemplateElement[][]>([]);
  const [future, setFuture] = useState<TemplateElement[][]>([]);
  // Captures the "before" snapshot exactly once per gesture/edit-session, guarded so a gesture
  // spanning many pointermove/updateElement calls only ever records its START state — by the
  // time a drag gesture's pointer-up fires, `elements` has already been mutated continuously
  // throughout the drag, so the "before the drag" state must be captured at gesture start, not
  // gesture end.
  const gestureSnapshotRef = useRef<TemplateElement[] | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  // null means "append a new image element"; a real index means "replace this element's assetId"
  // (set by onReplaceImageClick, consumed by uploadImageMutation.onSuccess below).
  const [replaceTargetIndex, setReplaceTargetIndex] = useState<number | null>(null);

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

  const uploadImageMutation = useMutation({
    mutationFn: (file: File) => uploadTemplateImage(templateId, file),
    onSuccess: ({ assetId }) => {
      if (replaceTargetIndex !== null) {
        updateElement(replaceTargetIndex, { assetId });
        setReplaceTargetIndex(null);
      } else {
        setElements((els) => [...els, { type: 'image', x: 100, y: 100, width: 200, height: 200, assetId }]);
        setSelectedIndex(elements.length);
      }
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : t('templateEditor.imageUploadFailed'));
      setReplaceTargetIndex(null);
    },
  });

  function onAddImageClick() {
    setReplaceTargetIndex(null);
    imageInputRef.current?.click();
  }

  function onReplaceImageClick() {
    setReplaceTargetIndex(selectedIndex);
    imageInputRef.current?.click();
  }

  function onImageFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadImageMutation.mutate(file);
    e.target.value = '';
  }

  function updateElement(index: number, patch: Partial<TemplateElement>) {
    setElements((els) => els.map((el, i) => (i === index ? ({ ...el, ...patch } as TemplateElement) : el)));
  }

  function beginHistoryGesture() {
    if (gestureSnapshotRef.current === null) gestureSnapshotRef.current = elements;
  }

  function commitHistoryGesture() {
    const before = gestureSnapshotRef.current;
    gestureSnapshotRef.current = null;
    if (before === null) return;
    setPast((p) => [...p, before]);
    setFuture([]);
  }

  // For one-shot actions with no separate "gesture" phase (add/remove/duplicate) — captures the
  // CURRENT elements as the undo target, then the caller applies its change immediately after.
  function commitHistoryNow() {
    setPast((p) => [...p, elements]);
    setFuture([]);
  }

  // Deliberately NOT using the functional setState-updater form here (setPast(p => {... calls
  // setFuture/setElements inside ...})) — React may invoke an updater function more than once
  // (StrictMode's dev-mode double-invoke check being the concrete case that would bite here),
  // which would double-fire the nested setFuture/setElements calls too. Reading `past`/`future`/
  // `elements` directly from the surrounding closure is correct because undo/redo are plain
  // event-handler functions re-created fresh every render (not stored across renders), so they
  // always see the current values.
  function undo() {
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    setFuture((f) => [elements, ...f]);
    setPast((p) => p.slice(0, -1));
    setElements(previous);
  }

  function redo() {
    if (future.length === 0) return;
    const next = future[0];
    setPast((p) => [...p, elements]);
    setFuture((f) => f.slice(1));
    setElements(next);
  }

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return; // Ctrl+Z inside a text field should be that field's own native undo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]); // undo/redo close over past/future/elements — must be in the dependency array,
    // or wrap them in useCallback with correct deps; do not silence the exhaustive-deps lint rule
    // here instead of fixing it.

  function addElement(type: AddableType) {
    commitHistoryNow();
    setElements((els) => [...els, defaultElement(type, t)]);
    setSelectedIndex(elements.length);
  }

  function removeElement(index: number) {
    commitHistoryNow();
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
    beginHistoryGesture();
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
    commitHistoryGesture();
  }

  function startResize(e: ReactPointerEvent<HTMLDivElement>, index: number) {
    e.stopPropagation();
    beginHistoryGesture();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* see startDrag */ }
    const el = elements[index];
    resizeRef.current = {
      index,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originWidth: displayWidth(el),
      originHeight: el.type === 'cover' || el.type === 'image' || el.type === 'equalizer' ? el.height : null,
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
        <div className="flex items-center gap-2">
          <button onClick={undo} disabled={!canUndo} className="rounded border px-3 py-2 text-sm disabled:opacity-50">
            {t('templateEditor.undo')}
          </button>
          <button onClick={redo} disabled={!canRedo} className="rounded border px-3 py-2 text-sm disabled:opacity-50">
            {t('templateEditor.redo')}
          </button>
          <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
            {saveMutation.isPending ? t('templateEditor.saving') : t('templateEditor.save')}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(['cover', 'title', 'playlist', 'timer', 'text', 'equalizer'] as const).map((type) => (
          <button key={type} onClick={() => addElement(type)} className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50">
            {t('templateEditor.addElement', { type: t(`templateEditor.elementType.${type}`) })}
          </button>
        ))}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif"
          className="hidden"
          onChange={onImageFileChosen}
        />
        <button onClick={onAddImageClick} className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50">
          {t('templateEditor.addElement', { type: t('templateEditor.elementType.image') })}
        </button>
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
              {el.type === 'equalizer' && (
                // A separate fill layer for the translucent color swatch, rather than `opacity`
                // on the outer box itself — CSS opacity composites the whole subtree, which
                // would dim the label span and resize handle below (both siblings of this layer)
                // right along with the color fill.
                <div className="pointer-events-none absolute inset-0" style={{ backgroundColor: el.color, opacity: 0.25 }} />
              )}
              <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-black/70 px-1 text-xs text-white">
                {t(`templateEditor.elementType.${el.type}`)}
              </span>
              {el.type === 'equalizer' && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-white/90">
                  {t('templateEditor.equalizerPlaceholder')}
                </span>
              )}
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
              <NumberField label={t('templateEditor.fieldX')} value={selected.x} max={CANVAS_WIDTH} onChange={(v) => updateElement(selectedIndex!, { x: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
              <NumberField label={t('templateEditor.fieldY')} value={selected.y} max={CANVAS_HEIGHT} onChange={(v) => updateElement(selectedIndex!, { y: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
              {selected.type !== 'timer' && (
                <NumberField label={t('templateEditor.fieldWidth')} value={selected.width} min={10} max={CANVAS_WIDTH} onChange={(v) => updateElement(selectedIndex!, { width: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
              )}
              {(selected.type === 'cover' || selected.type === 'image' || selected.type === 'equalizer') && (
                <NumberField label={t('templateEditor.fieldHeight')} value={selected.height} min={10} max={CANVAS_HEIGHT} onChange={(v) => updateElement(selectedIndex!, { height: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
              )}
              {selected.type !== 'cover' && selected.type !== 'image' && selected.type !== 'equalizer' && (
                <NumberField label={t('templateEditor.fieldFontSize')} value={selected.fontSize} min={8} max={MAX_FONT_SIZE} onChange={(v) => updateElement(selectedIndex!, { fontSize: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
              )}

              {selected.type === 'text' && (
                <label className="block text-xs text-gray-600">
                  {t('templateEditor.fieldText')}
                  <textarea
                    value={selected.text}
                    onChange={(e) => updateElement(selectedIndex!, { text: e.target.value })}
                    className="mt-1 w-full rounded border px-2 py-1 text-sm"
                  />
                </label>
              )}

              {selected.type === 'image' && (
                <>
                  <img src={templateImageUrl(templateId, selected.assetId)} alt="" className="w-full rounded border" />
                  <button onClick={onReplaceImageClick} className="text-sm text-blue-600">{t('templateEditor.replaceImage')}</button>
                </>
              )}

              {'style' in selected && (
                <>
                  <label className="block text-xs text-gray-600">
                    {t('templateEditor.fieldFontFamily')}
                    <select
                      value={selected.style.fontFamily}
                      onChange={(e) => updateElement(selectedIndex!, { style: { ...selected.style, fontFamily: e.target.value } })}
                      className="mt-1 w-full rounded border px-2 py-1 text-sm"
                    >
                      {fontFamiliesQuery.data?.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => updateElement(selectedIndex!, { style: { ...selected.style, bold: !selected.style.bold } })}
                      className={selected.style.bold ? 'font-bold underline' : ''}
                    >{t('templateEditor.bold')}</button>
                    <button
                      onClick={() => updateElement(selectedIndex!, { style: { ...selected.style, italic: !selected.style.italic } })}
                      className={selected.style.italic ? 'italic underline' : ''}
                    >{t('templateEditor.italic')}</button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={selected.style.stroke !== undefined}
                      onChange={(e) => updateElement(selectedIndex!, {
                        style: { ...selected.style, stroke: e.target.checked ? { color: '#000000', width: 2 } : undefined },
                      })}
                    />
                    {t('templateEditor.fieldStroke')}
                  </label>
                  {selected.style.stroke && (
                    <>
                      <ColorField
                        label={t('templateEditor.fieldColor')}
                        value={selected.style.stroke.color}
                        onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, stroke: { ...selected.style.stroke!, color: v } } })}
                        onFocus={beginHistoryGesture}
                        onBlur={commitHistoryGesture}
                      />
                      <NumberField
                        label={t('templateEditor.fieldStrokeWidth')}
                        value={selected.style.stroke.width}
                        min={1}
                        max={20}
                        onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, stroke: { ...selected.style.stroke!, width: v } } })}
                        onFocus={beginHistoryGesture}
                        onBlur={commitHistoryGesture}
                      />
                    </>
                  )}
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={selected.style.shadow !== undefined}
                      onChange={(e) => updateElement(selectedIndex!, {
                        style: { ...selected.style, shadow: e.target.checked ? { color: '#000000', blur: 4, offsetX: 2, offsetY: 2 } : undefined },
                      })}
                    />
                    {t('templateEditor.fieldShadow')}
                  </label>
                  {selected.style.shadow && (
                    <>
                      <ColorField
                        label={t('templateEditor.fieldColor')}
                        value={selected.style.shadow.color}
                        onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, shadow: { ...selected.style.shadow!, color: v } } })}
                        onFocus={beginHistoryGesture}
                        onBlur={commitHistoryGesture}
                      />
                      <NumberField
                        label={t('templateEditor.fieldShadowBlur')}
                        value={selected.style.shadow.blur}
                        min={0}
                        max={50}
                        onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, shadow: { ...selected.style.shadow!, blur: v } } })}
                        onFocus={beginHistoryGesture}
                        onBlur={commitHistoryGesture}
                      />
                      <NumberField
                        label={t('templateEditor.fieldShadowOffsetX')}
                        value={selected.style.shadow.offsetX}
                        min={-50}
                        max={50}
                        onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, shadow: { ...selected.style.shadow!, offsetX: v } } })}
                        onFocus={beginHistoryGesture}
                        onBlur={commitHistoryGesture}
                      />
                      <NumberField
                        label={t('templateEditor.fieldShadowOffsetY')}
                        value={selected.style.shadow.offsetY}
                        min={-50}
                        max={50}
                        onChange={(v) => updateElement(selectedIndex!, { style: { ...selected.style, shadow: { ...selected.style.shadow!, offsetY: v } } })}
                        onFocus={beginHistoryGesture}
                        onBlur={commitHistoryGesture}
                      />
                    </>
                  )}
                </>
              )}

              {(selected.type === 'title' || selected.type === 'playlist' || selected.type === 'text') && (
                <ColorValueField label={t('templateEditor.fieldColor')} value={selected.color} onChange={(v) => updateElement(selectedIndex!, { color: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
              )}
              {(selected.type === 'timer' || selected.type === 'equalizer') && (
                <ColorField label={t('templateEditor.fieldColor')} value={selected.color} onChange={(v) => updateElement(selectedIndex!, { color: v })} onFocus={beginHistoryGesture} onBlur={commitHistoryGesture} />
              )}

              <button onClick={() => removeElement(selectedIndex!)} className="text-sm text-red-600">{t('templateEditor.removeElement')}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
