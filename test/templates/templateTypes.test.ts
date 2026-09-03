import { isValidTemplateElement, isValidTemplateElements, DEFAULT_TEMPLATE_ELEMENTS } from '../../src/templates/templateTypes';

describe('isValidTemplateElement', () => {
  it('accepts a valid cover element', () => {
    expect(isValidTemplateElement({ type: 'cover', x: 0, y: 0, width: 100, height: 100 })).toBe(true);
  });

  it('accepts a valid title element', () => {
    expect(isValidTemplateElement({ type: 'title', x: 0, y: 0, width: 100, fontSize: 24, color: '#fff' })).toBe(true);
  });

  it('accepts a valid playlist element', () => {
    expect(isValidTemplateElement({ type: 'playlist', x: 0, y: 0, width: 100, fontSize: 18, color: '#fff' })).toBe(true);
  });

  it('accepts a valid timer element (no width, unlike title/playlist)', () => {
    expect(isValidTemplateElement({ type: 'timer', x: 0, y: 0, fontSize: 18, color: '#fff' })).toBe(true);
  });

  it('rejects a timer element missing color', () => {
    expect(isValidTemplateElement({ type: 'timer', x: 0, y: 0, fontSize: 18 })).toBe(false);
  });

  it('rejects a non-hex color', () => {
    expect(isValidTemplateElement({ type: 'title', x: 0, y: 0, width: 100, fontSize: 24, color: 'red' })).toBe(false);
    expect(isValidTemplateElement({ type: 'title', x: 0, y: 0, width: 100, fontSize: 24, color: '#gggggg' })).toBe(false);
  });

  it('rejects a position outside the canvas', () => {
    expect(isValidTemplateElement({ type: 'cover', x: 99999, y: 0, width: 100, height: 100 })).toBe(false);
    expect(isValidTemplateElement({ type: 'cover', x: -1, y: 0, width: 100, height: 100 })).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(isValidTemplateElement({ type: 'watermark', x: 0, y: 0 })).toBe(false);
  });

  it('rejects a cover element missing width/height', () => {
    expect(isValidTemplateElement({ type: 'cover', x: 0, y: 0 })).toBe(false);
  });

  it('rejects a title element missing color', () => {
    expect(isValidTemplateElement({ type: 'title', x: 0, y: 0, width: 100, fontSize: 24 })).toBe(false);
  });

  it('rejects non-finite coordinates', () => {
    expect(isValidTemplateElement({ type: 'cover', x: NaN, y: 0, width: 100, height: 100 })).toBe(false);
    expect(isValidTemplateElement({ type: 'cover', x: 0, y: Infinity, width: 100, height: 100 })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isValidTemplateElement(null)).toBe(false);
    expect(isValidTemplateElement('cover')).toBe(false);
    expect(isValidTemplateElement(42)).toBe(false);
  });
});

describe('isValidTemplateElements', () => {
  it('accepts an array of valid elements, including empty', () => {
    expect(isValidTemplateElements([])).toBe(true);
    expect(isValidTemplateElements([{ type: 'cover', x: 0, y: 0, width: 10, height: 10 }])).toBe(true);
  });

  it('rejects a non-array', () => {
    expect(isValidTemplateElements({})).toBe(false);
  });

  it('rejects an array containing one invalid element', () => {
    expect(isValidTemplateElements([
      { type: 'cover', x: 0, y: 0, width: 10, height: 10 },
      { type: 'cover', x: 0, y: 0 },
    ])).toBe(false);
  });

  it('DEFAULT_TEMPLATE_ELEMENTS (used when a stream starts with no templateId) is itself valid', () => {
    expect(isValidTemplateElements(DEFAULT_TEMPLATE_ELEMENTS)).toBe(true);
  });
});
