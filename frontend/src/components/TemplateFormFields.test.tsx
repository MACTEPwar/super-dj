import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ColorField, ColorValueField, NumberField } from './TemplateFormFields';
import { ColorValue } from '../api/templates';

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
  it('shows the solid color field and no gradient stops when value.mode is solid', () => {
    const value: ColorValue = { mode: 'solid', color: '#ffffff' };
    render(<ColorValueField label="Color" value={value} onChange={vi.fn()} />);

    expect(screen.getByLabelText('Color')).toBeInTheDocument();
    expect(screen.queryByText('Stop 1')).not.toBeInTheDocument();
  });

  it('switching to gradient mode calls onChange with a default two-stop gradient', async () => {
    const value: ColorValue = { mode: 'solid', color: '#ffffff' };
    const onChange = vi.fn();
    render(<ColorValueField label="Color" value={value} onChange={onChange} />);

    await userEvent.click(screen.getByText('Gradient'));

    expect(onChange).toHaveBeenCalledWith({ mode: 'gradient', stops: ['#ffffff', '#000000'], angleDeg: 0 });
  });

  it('shows a labeled field per stop plus an angle field when value.mode is gradient', () => {
    const value: ColorValue = { mode: 'gradient', stops: ['#ffffff', '#000000'], angleDeg: 45 };
    render(<ColorValueField label="Color" value={value} onChange={vi.fn()} />);

    expect(screen.getByLabelText('Stop 1')).toHaveValue('#ffffff');
    expect(screen.getByLabelText('Stop 2')).toHaveValue('#000000');
    expect(screen.getByLabelText('Gradient angle')).toHaveValue(45);
  });

  it('switching back to solid mode restores the last solid color', async () => {
    const value: ColorValue = { mode: 'gradient', stops: ['#111111', '#222222'], angleDeg: 90 };
    const onChange = vi.fn();
    render(<ColorValueField label="Color" value={value} onChange={onChange} />);

    await userEvent.click(screen.getByText('Solid'));

    expect(onChange).toHaveBeenCalledWith({ mode: 'solid', color: '#ffffff' });
  });
});
