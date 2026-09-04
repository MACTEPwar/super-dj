import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import TemplateEditor from './TemplateEditor';
import { getFontFamilies, templateImageUrl, templatesApi, uploadTemplateImage } from '../api/templates';
import { renderWithProviders } from '../test/renderWithProviders';

vi.mock('../api/templates');

// jsdom in this project doesn't implement a real PointerEvent constructor (confirmed: `window.PointerEvent`
// is undefined), so @testing-library's fireEvent.pointer* falls back to a plain `Event`, which silently
// drops clientX/clientY/pointerId from the init dict — a drag-simulating test would see NaN deltas instead
// of a real intermediate position. MouseEvent, which PointerEvent is spec'd to extend, DOES carry
// clientX/clientY correctly in this jsdom version, so this minimal polyfill (pointerId only, the one
// Pointer-specific field TemplateEditor reads) is enough to make a real drag gesture reproducible in tests.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, params: MouseEventInit & { pointerId?: number } = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
    }
  }
  // @ts-expect-error test-only jsdom polyfill, not a spec-complete PointerEvent
  window.PointerEvent = PointerEventPolyfill;
}

const DEFAULT_STYLE = { fontFamily: 'DejaVu Sans', bold: false, italic: false };

function renderEditor() {
  return renderWithProviders(
    <Routes><Route path="/templates/:id" element={<TemplateEditor />} /></Routes>,
    { route: '/templates/t1' },
  );
}

describe('TemplateEditor', () => {
  beforeEach(() => {
    vi.mocked(templatesApi.previewBlobUrl).mockResolvedValue('blob:mock-preview');
    vi.mocked(getFontFamilies).mockResolvedValue(['DejaVu Sans', 'Liberation Sans']);
    vi.mocked(templateImageUrl).mockImplementation((templateId, assetId) => `blob:template-image/${templateId}/${assetId}`);
  });

  it('loads the template and shows its existing elements on the canvas', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [
        { type: 'cover', x: 40, y: 40, width: 200, height: 200 },
        { type: 'title', x: 300, y: 40, width: 500, fontSize: 32, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
      ],
    });
    renderEditor();

    expect(await screen.findByDisplayValue('My Theme')).toBeInTheDocument();
    expect(screen.getByText('Cover', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Title', { selector: 'span' })).toBeInTheDocument();
  });

  it('adding an element selects it and shows the matching fields in the properties panel', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({ id: 't1', name: 'Empty', elements: [], createdAt: '', updatedAt: '' });
    renderEditor();
    await screen.findByText('Add an element above to get started.');

    await userEvent.click(screen.getByText('+ Add Cover'));

    // Cover has width/height but no font size/color; the properties panel should reflect that.
    expect(await screen.findByLabelText('Width')).toBeInTheDocument();
    expect(screen.getByLabelText('Height')).toBeInTheDocument();
    expect(screen.queryByLabelText('Font size')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Color')).not.toBeInTheDocument();
  });

  it('adding a timer shows font size/color but no width/height field (timer has no stored width)', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({ id: 't1', name: 'Empty', elements: [], createdAt: '', updatedAt: '' });
    renderEditor();
    await screen.findByText('Add an element above to get started.');

    await userEvent.click(screen.getByText('+ Add Timer'));

    expect(await screen.findByLabelText('Font size')).toBeInTheDocument();
    expect(screen.getByLabelText('Color')).toBeInTheDocument();
    expect(screen.queryByLabelText('Width')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Height')).not.toBeInTheDocument();
  });

  it('editing a field in the properties panel updates the element, and Save persists the full element list', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE }],
    });
    vi.mocked(templatesApi.update).mockResolvedValue({ id: 't1', name: 'My Theme', elements: [], createdAt: '', updatedAt: '' });
    renderEditor();
    await screen.findByText('Title', { selector: 'span' });

    // Selecting the existing element by clicking its box on the canvas.
    await userEvent.click(screen.getByText('Title', { selector: 'span' }));
    const xField = await screen.findByLabelText('X');
    await userEvent.clear(xField);
    await userEvent.type(xField, '99');

    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(templatesApi.update).toHaveBeenCalledWith('t1', {
      name: 'My Theme',
      elements: [{ type: 'title', x: 99, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE }],
    }));
  });

  it('"Remove element" takes the selected element off the canvas', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'cover', x: 10, y: 10, width: 100, height: 100 }],
    });
    renderEditor();
    await userEvent.click(await screen.findByText('Cover', { selector: 'span' }));
    expect(await screen.findByLabelText('Width')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Remove element'));

    expect(screen.queryByLabelText('Width')).not.toBeInTheDocument();
    expect(screen.getByText('Select an element on the canvas to edit its position and style.')).toBeInTheDocument();
  });

  it('starting a drag on an element box selects it (pointerdown, same as a click)', async () => {
    // The actual drag *math* (screen-delta -> canvas-coordinate, clamped to the canvas bounds)
    // lives in a plain, reviewable function with no DOM dependency and is exercised indirectly
    // by the "editing a field" test above via the same updateElement() path a drag uses.
    // Simulating a real multi-event pointer drag and asserting the resulting position needs
    // jsdom's PointerEvent/clientX plumbing to behave like a real browser's, which it doesn't
    // reliably do in this project's jsdom version — verified instead via a live browser check.
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'cover', x: 40, y: 40, width: 100, height: 100 }],
    });
    renderEditor();
    const box = await screen.findByText('Cover', { selector: 'span' });
    const handle = box.closest('div')!;

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(await screen.findByLabelText('X')).toBeInTheDocument();
  });

  it('adding a text element inserts it with default text', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({ id: 't1', name: 'Empty', elements: [], createdAt: '', updatedAt: '' });
    renderEditor();
    await screen.findByText('Add an element above to get started.');

    await userEvent.click(screen.getByText('+ Add Text'));

    const textField = await screen.findByLabelText('Text content');
    expect(textField).toHaveValue('New text');
  });

  it('clicking "add image" triggers the hidden file input', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({ id: 't1', name: 'Empty', elements: [], createdAt: '', updatedAt: '' });
    renderEditor();
    await screen.findByText('Add an element above to get started.');
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');

    await userEvent.click(screen.getByText('+ Add Image'));

    expect(clickSpy).toHaveBeenCalled();
  });

  it('a successful upload appends an image element with the returned assetId', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({ id: 't1', name: 'Empty', elements: [], createdAt: '', updatedAt: '' });
    vi.mocked(uploadTemplateImage).mockResolvedValue({ assetId: 'asset-123' });
    renderEditor();
    await screen.findByText('Add an element above to get started.');

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(uploadTemplateImage).toHaveBeenCalledWith('t1', file));
    expect(await screen.findByText('Replace image')).toBeInTheDocument();
    expect(templateImageUrl).toHaveBeenCalledWith('t1', 'asset-123');
  });

  it('selecting a title element shows the font-family select populated from the fonts query', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE }],
    });
    renderEditor();

    await userEvent.click(await screen.findByText('Title', { selector: 'span' }));

    const select = await screen.findByLabelText('Font') as HTMLSelectElement;
    expect(select.value).toBe('DejaVu Sans');
    expect(screen.getByRole('option', { name: 'DejaVu Sans' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Liberation Sans' })).toBeInTheDocument();
  });

  it('shows the overflow-ellipsis checkbox for a title element, unchecked by default', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE }],
    });
    renderEditor();

    await userEvent.click(await screen.findByText('Title', { selector: 'span' }));

    const checkbox = await screen.findByLabelText('Truncate with …') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('shows the overflow-ellipsis checkbox for a text element, and it reflects an already-set style.overflow', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{
        type: 'text', x: 10, y: 10, width: 400, fontSize: 30, text: 'now streaming',
        color: { mode: 'solid', color: '#ffffff' },
        style: { ...DEFAULT_STYLE, overflow: 'ellipsis' },
      }],
    });
    renderEditor();

    await userEvent.click(await screen.findByText('Text', { selector: 'span' }));

    const checkbox = await screen.findByLabelText('Truncate with …') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('does not show the overflow-ellipsis checkbox for a playlist element (multi-line wrapping is intentional)', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'playlist', x: 10, y: 10, width: 400, fontSize: 22, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE }],
    });
    renderEditor();

    await userEvent.click(await screen.findByText('Playlist', { selector: 'span' }));
    await screen.findByLabelText('Font size');

    expect(screen.queryByLabelText('Truncate with …')).not.toBeInTheDocument();
  });

  it('checking the overflow-ellipsis checkbox sets style.overflow, and Save persists it', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE }],
    });
    vi.mocked(templatesApi.update).mockResolvedValue({ id: 't1', name: 'My Theme', elements: [], createdAt: '', updatedAt: '' });
    renderEditor();
    await userEvent.click(await screen.findByText('Title', { selector: 'span' }));

    const checkbox = await screen.findByLabelText('Truncate with …');
    await userEvent.click(checkbox);

    expect((checkbox as HTMLInputElement).checked).toBe(true);

    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(templatesApi.update).toHaveBeenCalledWith('t1', {
      name: 'My Theme',
      elements: [{
        type: 'title', x: 10, y: 10, width: 400, fontSize: 30,
        color: { mode: 'solid', color: '#ffffff' },
        style: { ...DEFAULT_STYLE, overflow: 'ellipsis' },
      }],
    }));
  });

  it('unchecking the overflow-ellipsis checkbox clears style.overflow', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{
        type: 'title', x: 10, y: 10, width: 400, fontSize: 30,
        color: { mode: 'solid', color: '#ffffff' },
        style: { ...DEFAULT_STYLE, overflow: 'ellipsis' },
      }],
    });
    vi.mocked(templatesApi.update).mockResolvedValue({ id: 't1', name: 'My Theme', elements: [], createdAt: '', updatedAt: '' });
    renderEditor();
    await userEvent.click(await screen.findByText('Title', { selector: 'span' }));

    const checkbox = await screen.findByLabelText('Truncate with …');
    await userEvent.click(checkbox);

    expect((checkbox as HTMLInputElement).checked).toBe(false);

    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(templatesApi.update).toHaveBeenCalledWith('t1', {
      name: 'My Theme',
      elements: [{
        type: 'title', x: 10, y: 10, width: 400, fontSize: 30,
        color: { mode: 'solid', color: '#ffffff' },
        style: DEFAULT_STYLE,
      }],
    }));
  });

  it('toggling gradient mode shows/hides the stop color fields', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE }],
    });
    renderEditor();
    await userEvent.click(await screen.findByText('Title', { selector: 'span' }));
    expect(screen.queryByText('Stop 1')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Gradient'));

    expect(await screen.findByText('Stop 1')).toBeInTheDocument();
    expect(screen.getByText('Stop 2')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Solid'));

    expect(screen.queryByText('Stop 1')).not.toBeInTheDocument();
  });

  it('timer selection never shows a gradient toggle', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'timer', x: 10, y: 10, fontSize: 30, color: '#ffffff', style: DEFAULT_STYLE }],
    });
    renderEditor();

    await userEvent.click(await screen.findByText('Timer', { selector: 'span' }));

    expect(await screen.findByLabelText('Color')).toBeInTheDocument();
    expect(screen.queryByText('Gradient')).not.toBeInTheDocument();
    expect(screen.queryByText('Solid')).not.toBeInTheDocument();
  });

  it('adding an equalizer element inserts it with sane defaults', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({ id: 't1', name: 'Empty', elements: [], createdAt: '', updatedAt: '' });
    vi.mocked(templatesApi.update).mockResolvedValue({ id: 't1', name: 'Empty', elements: [], createdAt: '', updatedAt: '' });
    renderEditor();
    await screen.findByText('Add an element above to get started.');

    await userEvent.click(screen.getByText('+ Add Equalizer'));

    expect(await screen.findByLabelText('Width')).toBeInTheDocument();
    expect(screen.getByLabelText('Height')).toBeInTheDocument();
    expect(screen.queryByLabelText('Font size')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(templatesApi.update).toHaveBeenCalledWith('t1', {
      name: 'Empty',
      elements: [{ type: 'equalizer', x: 100, y: 500, width: 400, height: 150, color: '#ffffff' }],
    }));
  });

  it('selecting an equalizer element shows only a plain color field, no gradient toggle', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'equalizer', x: 100, y: 500, width: 400, height: 150, color: '#ffffff' }],
    });
    renderEditor();

    await userEvent.click(await screen.findByText('Equalizer', { selector: 'span' }));

    expect(await screen.findByLabelText('Color')).toBeInTheDocument();
    expect(screen.queryByText('Gradient')).not.toBeInTheDocument();
    expect(screen.queryByText('Solid')).not.toBeInTheDocument();
  });

  it('the equalizer canvas box renders the "not shown here" placeholder label', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'equalizer', x: 100, y: 500, width: 400, height: 150, color: '#ffffff' }],
    });
    renderEditor();

    expect(await screen.findByText('Equalizer — reacts to sound during live playback, not shown here')).toBeInTheDocument();
  });

  it('undo restores the element position from before a drag gesture, not mid-drag', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'cover', x: 40, y: 40, width: 100, height: 100 }],
    });
    renderEditor();
    const box = await screen.findByText('Cover', { selector: 'span' });
    const handle = box.closest('div')!;
    const canvas = screen.getByRole('group', { name: 'Overlay canvas — drag elements to reposition them' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    // dx/dy are divided by SCALE (0.625) inside the component, so a 50px/30px screen delta here
    // becomes an 80/48 canvas-coordinate delta — origin (40,40) + that delta = (120, 88).
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 130 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    const xFieldMoved = await screen.findByLabelText('X') as HTMLInputElement;
    expect(xFieldMoved.value).toBe('120');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('88');

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    await waitFor(() => expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('40'));
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('40');
  });

  it('undo/redo round-trips a single field edit in the properties panel', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'timer', x: 10, y: 10, fontSize: 30, color: '#ffffff', style: DEFAULT_STYLE }],
    });
    renderEditor();
    await userEvent.click(await screen.findByText('Timer', { selector: 'span' }));

    const colorField = await screen.findByLabelText('Color');
    fireEvent.focus(colorField);
    fireEvent.change(colorField, { target: { value: '#123456' } });
    fireEvent.blur(colorField);

    expect(screen.getAllByDisplayValue('#123456').length).toBeGreaterThan(0);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(screen.getAllByDisplayValue('#ffffff').length).toBeGreaterThan(0));

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getAllByDisplayValue('#123456').length).toBeGreaterThan(0));
  });

  it('a new action after an undo clears the redo stack', async () => {
    // Uses the Undo/Redo buttons rather than the keyboard shortcut here: the keyboard handler
    // deliberately ignores Ctrl+Z while focus is inside an INPUT/TEXTAREA (so a text field's own
    // native undo isn't hijacked), and userEvent's real focus management would otherwise leave
    // focus sitting inside a field after each edit.
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'cover', x: 40, y: 40, width: 100, height: 100 }],
    });
    renderEditor();
    await userEvent.click(await screen.findByText('Cover', { selector: 'span' }));
    const xField = await screen.findByLabelText('X');
    await userEvent.clear(xField);
    await userEvent.type(xField, '99');
    fireEvent.blur(xField);

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Redo' })).not.toBeDisabled());

    const yField = screen.getByLabelText('Y');
    await userEvent.clear(yField);
    await userEvent.type(yField, '55');
    fireEvent.blur(yField);

    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });

  it('undo/redo buttons are disabled when their respective stack is empty', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({ id: 't1', name: 'Empty', elements: [], createdAt: '', updatedAt: '' });
    renderEditor();
    await screen.findByText('Add an element above to get started.');

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();

    await userEvent.click(screen.getByText('+ Add Cover'));

    expect(await screen.findByRole('button', { name: 'Undo' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });

  it('undo/redo round-trips a gradient stop color edit made through ColorValueField', async () => {
    // ColorValueField (the solid/gradient picker used for title/playlist/text colors) is a
    // separate wrapper around ColorField/NumberField, with its own { onFocus, onBlur } props that
    // must be threaded down to its internal fields for a focus-then-blur gesture edit (e.g. typing
    // a gradient stop's hex value) to land on the undo stack at all.
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{
        type: 'title', x: 10, y: 10, width: 400, fontSize: 30,
        color: { mode: 'gradient', stops: ['#ffffff', '#000000'], angleDeg: 0 },
        style: DEFAULT_STYLE,
      }],
    });
    renderEditor();
    await userEvent.click(await screen.findByText('Title', { selector: 'span' }));
    // A plain click-to-select currently pushes its own (pre-existing, out-of-scope for this fix —
    // see the "Known follow-ups" note on click-to-select wiping the redo stack) no-op history
    // entry via startDrag/endInteraction, whose "before" snapshot happens to carry these same
    // pre-edit stop colors. Left in place, undoing the color edit below would "pass" by coincidence
    // — reverting to that unrelated no-op snapshot rather than because the edit itself was ever
    // recorded. Clear it first so the test isolates exactly what the gradient-stop edit
    // contributes to the undo stack.
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled());

    const stop1 = await screen.findByLabelText('Stop 1');
    fireEvent.focus(stop1);
    fireEvent.change(stop1, { target: { value: '#123456' } });
    fireEvent.blur(stop1);

    expect(screen.getAllByDisplayValue('#123456').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Undo' })).not.toBeDisabled();

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(screen.getAllByDisplayValue('#ffffff').length).toBeGreaterThan(0));
    expect(screen.queryAllByDisplayValue('#123456')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  it('the solid/gradient mode-toggle click on ColorValueField produces exactly one undo step', async () => {
    // The toggle buttons call onChange directly from an onClick — an instantaneous one-shot
    // change, not a focus/blur gesture — so this exercises the separate handleModeToggle path
    // (onFocus() then onChange() then onBlur() back-to-back) rather than the focus/blur wiring
    // the test above covers.
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{
        type: 'title', x: 10, y: 10, width: 400, fontSize: 30,
        color: { mode: 'solid', color: '#ffffff' },
        style: DEFAULT_STYLE,
      }],
    });
    renderEditor();
    await userEvent.click(await screen.findByText('Title', { selector: 'span' }));
    // A plain click-to-select currently pushes its own (pre-existing, out-of-scope for this fix —
    // see the "Known follow-ups" note on click-to-select wiping the redo stack) no-op history
    // entry via startDrag/endInteraction. Undo it first so this test starts from a clean, empty
    // undo stack and isolates exactly what the mode-toggle click itself contributes.
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled());

    await userEvent.click(screen.getByText('Gradient'));

    expect(await screen.findByText('Stop 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).not.toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));

    // Back to solid mode, and — since exactly one entry was pushed for the single click — nothing
    // further left to undo.
    await waitFor(() => expect(screen.queryByText('Stop 1')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  it('applies the equalizer color as its own fill layer instead of opacity on the whole box, so the label/resize handle stay at full opacity', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'equalizer', x: 100, y: 500, width: 400, height: 150, color: '#ffffff' }],
    });
    renderEditor();

    const label = await screen.findByText('Equalizer', { selector: 'span' });
    const box = label.parentElement as HTMLElement;

    // CSS opacity composites the whole subtree — the outer interactive box (which also holds
    // the label and resize handle as children) must not carry it, or those would be dimmed too.
    expect(box.style.opacity).toBe('');

    // The translucent color swatch lives in its own child layer instead.
    const fillLayer = Array.from(box.children).find(
      (child) => (child as HTMLElement).style.opacity === '0.25',
    ) as HTMLElement | undefined;
    expect(fillLayer).toBeDefined();
    expect(fillLayer!.style.backgroundColor).not.toBe('');
    expect(fillLayer!.textContent).toBe('');
  });

  it('the layers panel lists elements frontmost-first', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [
        { type: 'cover', x: 40, y: 40, width: 100, height: 100 },
        { type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
        { type: 'playlist', x: 10, y: 200, width: 400, fontSize: 22, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
      ],
    });
    renderEditor();
    await screen.findByDisplayValue('My Theme');

    const layersPanel = screen.getByTestId('layers-panel');
    const layerButtons = within(layersPanel).getAllByRole('button', { name: /^(Cover|Title|Playlist)$/ });

    // elements[elements.length - 1] (playlist) is frontmost — the panel lists frontmost-first,
    // i.e. the reverse of the underlying array order (cover, title, playlist).
    expect(layerButtons.map((b) => b.textContent)).toEqual(['Playlist', 'Title', 'Cover']);
  });

  it('clicking a layer entry selects the same element clicking its canvas box would', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [
        { type: 'cover', x: 40, y: 40, width: 100, height: 100 },
        { type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
      ],
    });
    renderEditor();
    await screen.findByDisplayValue('My Theme');

    await userEvent.click(screen.getByRole('button', { name: 'Title' }));

    // Title's fields (font size + font-family select) show up in the properties panel, same as
    // clicking its canvas box would — cover has neither.
    expect(await screen.findByLabelText('Font size')).toBeInTheDocument();
    expect(screen.getByLabelText('Font')).toBeInTheDocument();
  });

  it('moving a layer up swaps it toward the front of the elements array', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [
        { type: 'cover', x: 40, y: 40, width: 100, height: 100 },
        { type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
        { type: 'playlist', x: 10, y: 200, width: 400, fontSize: 22, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
      ],
    });
    vi.mocked(templatesApi.update).mockResolvedValue({ id: 't1', name: 'My Theme', elements: [], createdAt: '', updatedAt: '' });
    renderEditor();
    await screen.findByDisplayValue('My Theme');

    const titleRow = screen.getByRole('button', { name: 'Title' }).closest('div')!;
    await userEvent.click(within(titleRow).getByRole('button', { name: '▲' }));

    await userEvent.click(screen.getByText('Save'));

    // title (index 1) swapped with the array-index-adjacent playlist (index 2) — the resulting
    // array is [cover, playlist, title], moving title toward the end/front.
    await waitFor(() => expect(templatesApi.update).toHaveBeenCalledWith('t1', {
      name: 'My Theme',
      elements: [
        { type: 'cover', x: 40, y: 40, width: 100, height: 100 },
        { type: 'playlist', x: 10, y: 200, width: 400, fontSize: 22, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
        { type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
      ],
    }));
  });

  it('move-up is disabled for the already-frontmost element, move-down disabled for the backmost', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [
        { type: 'cover', x: 40, y: 40, width: 100, height: 100 },
        { type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
      ],
    });
    renderEditor();
    await screen.findByDisplayValue('My Theme');

    // title is at index 1 — the frontmost element (elements.length - 1) — so its "move up"
    // (toward the front) button is disabled; cover is at index 0 — the backmost — so its
    // "move down" (toward the back) button is disabled.
    const titleRow = screen.getByRole('button', { name: 'Title' }).closest('div')!;
    const coverRow = screen.getByRole('button', { name: 'Cover' }).closest('div')!;

    expect(within(titleRow).getByRole('button', { name: '▲' })).toBeDisabled();
    expect(within(titleRow).getByRole('button', { name: '▼' })).not.toBeDisabled();
    expect(within(coverRow).getByRole('button', { name: '▼' })).toBeDisabled();
    expect(within(coverRow).getByRole('button', { name: '▲' })).not.toBeDisabled();
  });

  it('dragging an element within 8px of the canvas horizontal center snaps its center exactly to it', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'cover', x: 345, y: 300, width: 200, height: 100 }],
    });
    renderEditor();
    const box = await screen.findByText('Cover', { selector: 'span' });
    const handle = box.closest('div')!;
    const canvas = screen.getByRole('group', { name: 'Overlay canvas — drag elements to reposition them' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    // dx = (225-100)/0.625 = 200 canvas px -> candidate x = 345+200 = 545, candidate center =
    // 545+100 = 645 (5px from the canvas horizontal center, 640) -> snaps center to exactly 640,
    // so x lands at 640 - width/2 = 540, not the unsnapped 545. dy is 0, so y is untouched (its
    // center, 350, sits 10px from the vertical center target 360 — past the 8px threshold).
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 225, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    const xField = await screen.findByLabelText('X') as HTMLInputElement;
    expect(xField.value).toBe('540');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('300');
  });

  it('dragging more than 8px away from any snap target does not snap', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'cover', x: 345, y: 300, width: 200, height: 100 }],
    });
    renderEditor();
    const box = await screen.findByText('Cover', { selector: 'span' });
    const handle = box.closest('div')!;
    const canvas = screen.getByRole('group', { name: 'Overlay canvas — drag elements to reposition them' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    // dx = dy = 100/0.625 = 160 canvas px -> candidate x = 505 (center 605, 35px from the 640
    // center target), candidate y = 460 (center 510, at least 150px from every y target: 0/360/
    // 720) -> neither axis is within the 8px snap threshold, so both land exactly where dragged.
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    const xField = await screen.findByLabelText('X') as HTMLInputElement;
    expect(xField.value).toBe('505');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('460');
  });

  it('a snap guide line renders while a snap is active, and clears on pointer-up', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'cover', x: 345, y: 300, width: 200, height: 100 }],
    });
    renderEditor();
    const box = await screen.findByText('Cover', { selector: 'span' });
    const handle = box.closest('div')!;
    const canvas = screen.getByRole('group', { name: 'Overlay canvas — drag elements to reposition them' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 225, clientY: 100 });

    expect(await screen.findByTestId('snap-guide-x')).toBeInTheDocument();

    fireEvent.pointerUp(canvas, { pointerId: 1 });

    expect(screen.queryByTestId('snap-guide-x')).not.toBeInTheDocument();
  });

  it('duplicating an element inserts a copy offset by +20/+20, selected, immediately after the original', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [
        { type: 'cover', x: 40, y: 40, width: 100, height: 100 },
        { type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
      ],
    });
    renderEditor();
    // Select the title element (index 1)
    await userEvent.click(await screen.findByText('Title', { selector: 'span' }));
    expect(await screen.findByLabelText('Font size')).toBeInTheDocument();

    // Click the Duplicate button
    await userEvent.click(screen.getByText('Duplicate'));

    // Verify the new element was inserted at index 2 (after the original)
    // by checking that we now have 3 elements
    const coverLabel = screen.getAllByText('Cover', { selector: 'span' });
    expect(coverLabel.length).toBe(1); // Still just one cover

    // The new title copy should be selected now, showing its properties
    expect(screen.getByLabelText('Font size')).toBeInTheDocument();
    const xField = screen.getByLabelText('X') as HTMLInputElement;
    const yField = screen.getByLabelText('Y') as HTMLInputElement;
    // Original was at (10, 10), copy should be at (30, 30)
    expect(xField.value).toBe('30');
    expect(yField.value).toBe('30');

    // Save to verify the full element list
    vi.mocked(templatesApi.update).mockResolvedValue({ id: 't1', name: 'My Theme', elements: [], createdAt: '', updatedAt: '' });
    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(templatesApi.update).toHaveBeenCalledWith('t1', {
      name: 'My Theme',
      elements: [
        { type: 'cover', x: 40, y: 40, width: 100, height: 100 },
        { type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
        { type: 'title', x: 30, y: 30, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE },
      ],
    }));
  });

  it('arrow keys nudge the selected element by 1px, Shift+arrow by 10px', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'cover', x: 40, y: 40, width: 100, height: 100 }],
    });
    renderEditor();
    await userEvent.click(await screen.findByText('Cover', { selector: 'span' }));
    await screen.findByLabelText('X');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('41'));
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('40');

    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    await waitFor(() => expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('50'));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('41');
  });

  it('arrow keys do nothing when no element is selected', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'cover', x: 40, y: 40, width: 100, height: 100 }],
    });
    renderEditor();
    await screen.findByText('Cover', { selector: 'span' });
    expect(screen.queryByLabelText('X')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'ArrowRight' });

    // Selecting the element afterward proves its position was never touched while unselected.
    await userEvent.click(screen.getByText('Cover', { selector: 'span' }));
    expect(await screen.findByLabelText('X')).toHaveValue(40);
    expect(screen.getByLabelText('Y')).toHaveValue(40);
  });

  it('arrow keys do not nudge while focus is inside a text/number input', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'cover', x: 40, y: 40, width: 100, height: 100 }],
    });
    renderEditor();
    await userEvent.click(await screen.findByText('Cover', { selector: 'span' }));
    const xField = await screen.findByLabelText('X') as HTMLInputElement;
    xField.focus();

    // The browser's own native number-input increment behavior on ArrowUp, if any, is not this
    // task's concern — this only asserts the editor's own nudge logic didn't also fire.
    fireEvent.keyDown(xField, { key: 'ArrowUp' });

    expect(xField.value).toBe('40');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('40');
  });
});
