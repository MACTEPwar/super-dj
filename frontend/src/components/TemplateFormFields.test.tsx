import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ColorField, ColorValueField, NumberField } from './TemplateFormFields';
import { ColorValue } from '../api/templates';

// jsdom in this project doesn't implement a real PointerEvent constructor (see TemplateEditor.test.tsx,
// which hit the same gap first), so @testing-library's fireEvent.pointer* falls back to a plain `Event`,
// silently dropping clientX/clientY/pointerId from the init dict. MouseEvent (which PointerEvent is
// spec'd to extend) DOES carry clientX/clientY correctly in this jsdom version, so this minimal polyfill
// makes the draggable gradient-strip tests below see real coordinates instead of NaN.
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

describe('NumberField', () => {
  it('clamps a value above max down to max before calling onChange', () => {
    const onChange = vi.fn();
    render(<NumberField label="Width" value={50} min={10} max={100} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '500' } });

    expect(onChange).toHaveBeenCalledWith(100);
  });

  it('clamps a value below min up to min before calling onChange', () => {
    const onChange = vi.fn();
    render(<NumberField label="Width" value={50} min={10} max={100} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '1' } });

    expect(onChange).toHaveBeenCalledWith(10);
  });

  // The equalizer element's width/height must be whole pixels — ffmpeg's showfreqs `s=` (size)
  // option requires integer dimensions, and only the DISPLAYED value used to be rounded, not
  // the value actually stored/passed to onChange, so a fractional value silently round-tripped
  // through state.
  it('rounds a fractional typed value to the nearest integer before calling onChange', () => {
    const onChange = vi.fn();
    render(<NumberField label="Width" value={50} min={10} max={1000} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '400.5' } });

    expect(onChange).toHaveBeenCalledWith(401);
  });

  it('rounds a fractional value before clamping it to max', () => {
    const onChange = vi.fn();
    render(<NumberField label="Width" value={50} min={10} max={100} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '100.6' } });

    expect(onChange).toHaveBeenCalledWith(100);
  });

  // The equalizer's sensitivity (0.5-3.0) / smoothing / beatBoost (0-1) are genuinely fractional
  // — with the default integer rounding a typed 0.4 would silently become 0.
  it('with a fractional step, snaps to that step instead of to an integer', () => {
    const onChange = vi.fn();
    render(<NumberField label="Smoothing" value={0.4} min={0} max={1} step={0.05} onChange={onChange} />);

    expect((screen.getByLabelText('Smoothing') as HTMLInputElement).value).toBe('0.4');
    fireEvent.change(screen.getByLabelText('Smoothing'), { target: { value: '0.42' } });
    expect(onChange).toHaveBeenCalledWith(0.4);

    fireEvent.change(screen.getByLabelText('Smoothing'), { target: { value: '0.3' } });
    // 6 * 0.05 is 0.30000000000000004 in floating point — the stored value must be the clean 0.3.
    expect(onChange).toHaveBeenLastCalledWith(0.3);
  });

  it('clamps a stepped value to its min/max', () => {
    const onChange = vi.fn();
    render(<NumberField label="Sensitivity" value={1.5} min={0.5} max={3} step={0.1} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Sensitivity'), { target: { value: '0.2' } });
    expect(onChange).toHaveBeenCalledWith(0.5);
    fireEvent.change(screen.getByLabelText('Sensitivity'), { target: { value: '9' } });
    expect(onChange).toHaveBeenLastCalledWith(3);
  });

  it('calls onFocus/onBlur when provided', () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    render(<NumberField label="Width" value={50} min={10} max={100} onChange={vi.fn()} onFocus={onFocus} onBlur={onBlur} />);

    const field = screen.getByLabelText('Width');
    fireEvent.focus(field);
    fireEvent.blur(field);

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('does not throw when onFocus/onBlur are omitted', () => {
    render(<NumberField label="Width" value={50} min={10} max={100} onChange={vi.fn()} />);

    const field = screen.getByLabelText('Width');
    expect(() => {
      fireEvent.focus(field);
      fireEvent.blur(field);
    }).not.toThrow();
  });
});

describe('ColorField', () => {
  it('shows the color swatch and text input in sync', () => {
    render(<ColorField label="Color" value="#ff0000" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Color')).toHaveValue('#ff0000');
  });

  it('calls onChange with the typed value', () => {
    const onChange = vi.fn();
    render(<ColorField label="Color" value="#ff0000" onChange={onChange} />);

    const textInput = screen.getAllByDisplayValue('#ff0000').find((el) => el.getAttribute('type') === 'text')!;
    fireEvent.change(textInput, { target: { value: '#00ff00' } });

    expect(onChange).toHaveBeenCalledWith('#00ff00');
  });

  it('calls onFocus/onBlur on both the swatch and text inputs when provided', () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    render(<ColorField label="Color" value="#ff0000" onChange={vi.fn()} onFocus={onFocus} onBlur={onBlur} />);

    const textInput = screen.getAllByDisplayValue('#ff0000').find((el) => el.getAttribute('type') === 'text')!;
    fireEvent.focus(textInput);
    fireEvent.blur(textInput);

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('does not throw when onFocus/onBlur are omitted', () => {
    render(<ColorField label="Color" value="#ff0000" onChange={vi.fn()} />);

    const textInput = screen.getAllByDisplayValue('#ff0000').find((el) => el.getAttribute('type') === 'text')!;
    expect(() => {
      fireEvent.focus(textInput);
      fireEvent.blur(textInput);
    }).not.toThrow();
  });
});

describe('ColorValueField', () => {
  const solid: ColorValue = { mode: 'solid', color: '#ff0000' };
  const gradient: ColorValue = {
    mode: 'gradient', gradientType: 'linear', angleDeg: 45,
    stops: [{ color: '#ffffff', offset: 0 }, { color: '#000000', offset: 100 }],
  };

  it('shows the solid color field and no gradient stops when value.mode is solid', () => {
    render(<ColorValueField label="Fill" value={solid} onChange={() => {}} />);
    expect(screen.getByLabelText('Color')).toBeInTheDocument();
    expect(screen.queryByLabelText('Stop 1')).not.toBeInTheDocument();
  });

  it('switching to gradient mode calls onChange with a default two-stop linear gradient', async () => {
    const onChange = vi.fn();
    render(<ColorValueField label="Fill" value={solid} onChange={onChange} />);
    await userEvent.click(screen.getByText('Gradient'));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ffffff', offset: 0 }, { color: '#000000', offset: 100 }],
    });
  });

  it('shows a color field and a position field per stop, plus an angle field, in linear mode', () => {
    render(<ColorValueField label="Fill" value={gradient} onChange={() => {}} />);
    expect(screen.getByLabelText('Stop 1')).toHaveValue('#ffffff');
    expect(screen.getByLabelText('Stop 2')).toHaveValue('#000000');
    expect(screen.getByLabelText('Stop 1 position')).toHaveValue(0);
    expect(screen.getByLabelText('Stop 2 position')).toHaveValue(100);
    expect(screen.getByLabelText('Gradient angle')).toHaveValue(45);
  });

  it('switching to radial hides the angle field and keeps the stops', async () => {
    const onChange = vi.fn();
    render(<ColorValueField label="Fill" value={gradient} onChange={onChange} />);
    await userEvent.click(screen.getByText('Radial'));
    expect(onChange).toHaveBeenCalledWith({ ...gradient, gradientType: 'radial' });

    render(<ColorValueField label="Fill2" value={{ ...gradient, gradientType: 'radial' }} onChange={() => {}} />);
    expect(screen.queryAllByLabelText('Gradient angle')).toHaveLength(1); // only the linear instance above
  });

  // Override on the plan's original "re-spread all stops evenly" default: adding a stop inserts
  // ONE new stop at the midpoint of the widest gap between existing stops, leaving the existing
  // stops' offsets exactly as they were (see colorValue.ts's insertStopAtMidpoint).
  it('adding a stop appends a white stop at the midpoint gap, leaving existing offsets untouched', async () => {
    const onChange = vi.fn();
    render(<ColorValueField label="Fill" value={gradient} onChange={onChange} />);
    await userEvent.click(screen.getByText('+ Add stop'));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'gradient', gradientType: 'linear', angleDeg: 45,
      stops: [{ color: '#ffffff', offset: 0 }, { color: '#000000', offset: 100 }, { color: '#ffffff', offset: 50 }],
    });
  });

  it('removing a stop drops it and leaves the remaining offsets untouched', async () => {
    const onChange = vi.fn();
    const three: ColorValue = {
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#00ff00', offset: 20 }, { color: '#0000ff', offset: 100 }],
    };
    render(<ColorValueField label="Fill" value={three} onChange={onChange} />);
    await userEvent.click(screen.getAllByText('Remove')[1]);
    expect(onChange).toHaveBeenCalledWith({
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 100 }],
    });
  });

  it('hides Remove at the 2-stop minimum and Add at the 6-stop maximum', () => {
    const { unmount } = render(<ColorValueField label="Fill" value={gradient} onChange={() => {}} />);
    expect(screen.queryByText('Remove')).not.toBeInTheDocument();
    expect(screen.getByText('+ Add stop')).toBeInTheDocument();
    unmount();
    const six: ColorValue = {
      mode: 'gradient', gradientType: 'linear', angleDeg: 0,
      stops: [0, 20, 40, 60, 80, 100].map((offset) => ({ color: '#ffffff', offset })),
    };
    render(<ColorValueField label="Fill" value={six} onChange={() => {}} />);
    expect(screen.queryByText('+ Add stop')).not.toBeInTheDocument();
    expect(screen.getAllByText('Remove')).toHaveLength(6);
  });

  it('editing a stop position (numeric field) calls onChange with that stop moved', () => {
    const onChange = vi.fn();
    render(<ColorValueField label="Fill" value={gradient} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Stop 2 position'), { target: { value: '70' } });
    expect(onChange).toHaveBeenCalledWith({
      ...gradient,
      stops: [{ color: '#ffffff', offset: 0 }, { color: '#000000', offset: 70 }],
    });
  });

  // The user explicitly asked for a draggable strip (not just a numeric field) as this v1's
  // stop editor. Each stop renders a pointer-draggable handle positioned along the strip by its
  // offset; dragging it recomputes the offset from the pointer's position within the strip's
  // bounding box and calls onChange live.
  describe('draggable gradient strip', () => {
    function mockStripRect() {
      // jsdom never lays out real geometry — stub the strip's bounding box so drag math has
      // something real to divide by (a 0-width rect would make every drag resolve to NaN/0).
      return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 16, width: 200, height: 16, toJSON: () => {},
      } as DOMRect);
    }

    it('renders one draggable handle per stop, positioned by offset', () => {
      render(<ColorValueField label="Fill" value={gradient} onChange={() => {}} />);
      expect(screen.getByTestId('gradient-stop-handle-0')).toBeInTheDocument();
      expect(screen.getByTestId('gradient-stop-handle-1')).toBeInTheDocument();
    });

    it('dragging a handle updates that stop\'s offset live', () => {
      const rectSpy = mockStripRect();
      const onChange = vi.fn();
      render(<ColorValueField label="Fill" value={gradient} onChange={onChange} />);

      const handle = screen.getByTestId('gradient-stop-handle-0');
      fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 }); // 140/200 = 70%
      fireEvent.pointerUp(handle, { clientX: 140, pointerId: 1 });

      expect(onChange).toHaveBeenCalledWith({
        ...gradient,
        stops: [{ color: '#ffffff', offset: 70 }, { color: '#000000', offset: 100 }],
      });
      rectSpy.mockRestore();
    });

    it('clamps a drag to the 0-100 range', () => {
      const rectSpy = mockStripRect();
      const onChange = vi.fn();
      render(<ColorValueField label="Fill" value={gradient} onChange={onChange} />);

      const handle = screen.getByTestId('gradient-stop-handle-1');
      fireEvent.pointerDown(handle, { clientX: 200, pointerId: 2 });
      fireEvent.pointerMove(handle, { clientX: 500, pointerId: 2 }); // way past the strip's right edge

      expect(onChange).toHaveBeenLastCalledWith({
        ...gradient,
        stops: [{ color: '#ffffff', offset: 0 }, { color: '#000000', offset: 100 }],
      });
      rectSpy.mockRestore();
    });

    // Dragging is a single continuous gesture (like the canvas's own element drag) — it must
    // bracket to exactly one undo entry, not one per pointermove tick.
    it('brackets a whole drag gesture in one onFocus/onBlur pair', () => {
      const rectSpy = mockStripRect();
      const onFocus = vi.fn(); const onBlur = vi.fn();
      render(<ColorValueField label="Fill" value={gradient} onChange={() => {}} onFocus={onFocus} onBlur={onBlur} />);

      const handle = screen.getByTestId('gradient-stop-handle-0');
      fireEvent.pointerDown(handle, { clientX: 0, pointerId: 3 });
      fireEvent.pointerMove(handle, { clientX: 20, pointerId: 3 });
      fireEvent.pointerMove(handle, { clientX: 40, pointerId: 3 });
      fireEvent.pointerUp(handle, { clientX: 40, pointerId: 3 });

      expect(onFocus).toHaveBeenCalledTimes(1);
      expect(onBlur).toHaveBeenCalledTimes(1);
      rectSpy.mockRestore();
    });
  });

  it('switching back to solid mode resets to white', async () => {
    const onChange = vi.fn();
    render(<ColorValueField label="Fill" value={gradient} onChange={onChange} />);
    await userEvent.click(screen.getByText('Solid'));
    expect(onChange).toHaveBeenCalledWith({ mode: 'solid', color: '#ffffff' });
  });

  // The mode/type toggles and the add/remove buttons are one-shot clicks, so each must produce
  // exactly one undo entry via the onFocus -> onChange -> onBlur trick.
  it('brackets every one-shot action in a zero-duration gesture', async () => {
    const onFocus = vi.fn(); const onBlur = vi.fn();
    render(<ColorValueField label="Fill" value={gradient} onChange={() => {}} onFocus={onFocus} onBlur={onBlur} />);
    await userEvent.click(screen.getByText('+ Add stop'));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('does not throw when onFocus/onBlur are omitted (Library.tsx passes neither)', async () => {
    render(<ColorValueField label="Fill" value={gradient} onChange={() => {}} />);
    await userEvent.click(screen.getByText('+ Add stop'));
    await userEvent.click(screen.getByText('Radial'));
  });
});
