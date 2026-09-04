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
