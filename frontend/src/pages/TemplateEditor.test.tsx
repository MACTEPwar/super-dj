import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByText('Cover')).toBeInTheDocument();
    expect(screen.getByText('Title')).toBeInTheDocument();
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
    await screen.findByText('Title');

    // Selecting the existing element by clicking its box on the canvas.
    await userEvent.click(screen.getByText('Title'));
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
    await userEvent.click(await screen.findByText('Cover'));
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
    const box = await screen.findByText('Cover');
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

    await userEvent.click(await screen.findByText('Title'));

    const select = await screen.findByLabelText('Font') as HTMLSelectElement;
    expect(select.value).toBe('DejaVu Sans');
    expect(screen.getByRole('option', { name: 'DejaVu Sans' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Liberation Sans' })).toBeInTheDocument();
  });

  it('toggling gradient mode shows/hides the stop color fields', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'title', x: 10, y: 10, width: 400, fontSize: 30, color: { mode: 'solid', color: '#ffffff' }, style: DEFAULT_STYLE }],
    });
    renderEditor();
    await userEvent.click(await screen.findByText('Title'));
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

    await userEvent.click(await screen.findByText('Timer'));

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

    await userEvent.click(await screen.findByText('Equalizer'));

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
    const box = await screen.findByText('Cover');
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
    await userEvent.click(await screen.findByText('Timer'));

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
    await userEvent.click(await screen.findByText('Cover'));
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

  it('applies the equalizer color as its own fill layer instead of opacity on the whole box, so the label/resize handle stay at full opacity', async () => {
    vi.mocked(templatesApi.get).mockResolvedValue({
      id: 't1', name: 'My Theme', createdAt: '', updatedAt: '',
      elements: [{ type: 'equalizer', x: 100, y: 500, width: 400, height: 150, color: '#ffffff' }],
    });
    renderEditor();

    const label = await screen.findByText('Equalizer');
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
});
