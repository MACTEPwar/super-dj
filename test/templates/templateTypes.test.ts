import { isValidTemplateElement, isValidTemplateElements, DEFAULT_TEMPLATE_ELEMENTS, isValidColorValue } from '../../src/templates/templateTypes';

describe('isValidTemplateElement', () => {
  const baseStyle = { fontFamily: 'DejaVu Sans', bold: false, italic: false };

  it('accepts a valid cover element', () => {
    expect(isValidTemplateElement({ type: 'cover', x: 0, y: 0, width: 100, height: 100 })).toBe(true);
  });

  it('accepts a valid title element', () => {
    expect(isValidTemplateElement({ type: 'title', x: 0, y: 0, width: 100, fontSize: 24, color: { mode: 'solid', color: '#ffffff' }, style: baseStyle })).toBe(true);
  });

  it('accepts a valid playlist element', () => {
    expect(isValidTemplateElement({ type: 'playlist', x: 0, y: 0, width: 100, fontSize: 18, color: { mode: 'solid', color: '#ffffff' }, style: baseStyle })).toBe(true);
  });

  it('accepts a valid timer element (no width, unlike title/playlist)', () => {
    expect(isValidTemplateElement({ type: 'timer', x: 0, y: 0, fontSize: 18, color: '#ffffff', style: baseStyle })).toBe(true);
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

describe('isValidTemplateElement — ColorValue and TextStyle', () => {
  const baseStyle = { fontFamily: 'DejaVu Sans', bold: false, italic: false };

  it('accepts a title with a solid color and minimal style', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: baseStyle,
    })).toBe(true);
  });

  it('accepts a title with a 3-stop gradient', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'gradient', stops: ['#ff0000', '#00ff00', '#0000ff'], angleDeg: 45 },
      style: baseStyle,
    })).toBe(true);
  });

  it('rejects a gradient with an out-of-range angle', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'gradient', stops: ['#ff0000', '#00ff00'], angleDeg: 361 },
      style: baseStyle,
    })).toBe(false);
  });

  it('rejects a gradient with an invalid stop color', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'gradient', stops: ['#ff0000', 'not-a-color'], angleDeg: 0 },
      style: baseStyle,
    })).toBe(false);
  });

  it('accepts a style with stroke and shadow', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: { ...baseStyle, bold: true, italic: true,
        stroke: { color: '#000000', width: 2 },
        shadow: { color: '#000000', blur: 4, offsetX: 1, offsetY: 1 } },
    })).toBe(true);
  });

  it('rejects a half-filled shadow', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: { ...baseStyle, shadow: { color: '#000000', blur: 4 } as unknown },
    })).toBe(false);
  });

  // An unbounded shadow blur reaches resvg/tiny-skia's rasterizer, where an extreme value
  // panics in Rust — uncatchable from JS, aborting the whole worker process (and with it every
  // other tenant's stream). Bound it at validation time so it can never get that far.
  it('rejects a shadow blur above the allowed maximum', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: { ...baseStyle, shadow: { color: '#000000', blur: 1_000_000, offsetX: 1, offsetY: 1 } },
    })).toBe(false);
  });

  it('rejects a shadow offset beyond the allowed magnitude, in either direction', () => {
    const withOffset = (offsetX: number, offsetY: number) => isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: { ...baseStyle, shadow: { color: '#000000', blur: 4, offsetX, offsetY } },
    });
    expect(withOffset(100_000, 1)).toBe(false);
    expect(withOffset(1, -100_000)).toBe(false);
    expect(withOffset(-50, 50)).toBe(true);
  });

  it('rejects a stroke width above the allowed maximum', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 10, y: 10, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: { ...baseStyle, stroke: { color: '#000000', width: 10_000 } },
    })).toBe(false);
  });

  it('accepts a TextStyle with overflow: ellipsis', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 0, y: 0, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, overflow: 'ellipsis' },
    })).toBe(true);
  });

  it('rejects an invalid overflow value', () => {
    expect(isValidTemplateElement({
      type: 'title', x: 0, y: 0, width: 200, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: { fontFamily: 'DejaVu Sans', bold: false, italic: false, overflow: 'clip' as unknown },
    })).toBe(false);
  });

  it('rejects a timer with a gradient color (timer color must be a plain string)', () => {
    expect(isValidTemplateElement({
      type: 'timer', x: 10, y: 10, fontSize: 20,
      color: { mode: 'solid', color: '#ffffff' },
      style: baseStyle,
    })).toBe(false);
  });

  it('accepts a timer with a plain hex color string and a style', () => {
    expect(isValidTemplateElement({
      type: 'timer', x: 10, y: 10, fontSize: 20,
      color: '#ffffff',
      style: baseStyle,
    })).toBe(true);
  });

  it('accepts a text element', () => {
    expect(isValidTemplateElement({
      type: 'text', x: 10, y: 10, width: 300, fontSize: 24,
      text: 'now streaming',
      color: { mode: 'solid', color: '#ffffff' },
      style: baseStyle,
    })).toBe(true);
  });

  it('rejects a text element with an empty text field', () => {
    expect(isValidTemplateElement({
      type: 'text', x: 10, y: 10, width: 300, fontSize: 24,
      text: '',
      color: { mode: 'solid', color: '#ffffff' },
      style: baseStyle,
    })).toBe(false);
  });

  it('accepts an image element', () => {
    expect(isValidTemplateElement({
      type: 'image', x: 10, y: 10, width: 200, height: 200,
      assetId: '3fa2c1e0-1234-4a5b-9c0d-abcdef123456',
    })).toBe(true);
  });

  it('rejects an image element with a non-string assetId', () => {
    expect(isValidTemplateElement({
      type: 'image', x: 10, y: 10, width: 200, height: 200, assetId: 123,
    })).toBe(false);
  });

  // TemplateImageService.resolvePath() throws InvalidAssetIdError on an id shaped like this,
  // and that throw escapes the per-element image fallback (it happens while BUILDING the
  // element list, before renderTemplatePng's allSettled protection) — blanking the entire live
  // overlay and 500ing the preview endpoint. Reject the id at save time instead, so the id
  // stored in a template is structurally incapable of reaching that throw.
  it.each([
    '../../etc/passwd',
    'foo/bar',
    'foo\\bar',
    '..',
    'has spaces',
    'a'.repeat(65),
    '',
  ])('rejects an image element with a malformed assetId (%p)', (assetId) => {
    expect(isValidTemplateElement({
      type: 'image', x: 10, y: 10, width: 200, height: 200, assetId,
    })).toBe(false);
  });
});

describe('isValidTemplateElement — equalizer', () => {
  it('accepts a valid equalizer element', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: 10, y: 10, width: 400, height: 150, color: '#ffffff',
    })).toBe(true);
  });

  it('rejects an equalizer with a non-hex color', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: 10, y: 10, width: 400, height: 150, color: 'not-a-color',
    })).toBe(false);
  });

  it('rejects an equalizer with an out-of-canvas position', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: -1, y: 10, width: 400, height: 150, color: '#ffffff',
    })).toBe(false);
  });

  it('rejects an equalizer missing width/height', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: 10, y: 10, color: '#ffffff',
    })).toBe(false);
  });

  // ffmpeg's showfreqs `s=` (size) option requires integer dimensions — a fractional width/
  // height used to pass this validation and only fail later, at stream-start, deep inside
  // ffmpeg's filtergraph build. Reject it here instead, so a malformed template can't be saved.
  it('rejects an equalizer with a non-integer width', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: 10, y: 10, width: 400.5, height: 150, color: '#ffffff',
    })).toBe(false);
  });

  it('rejects an equalizer with a non-integer height', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: 10, y: 10, width: 400, height: 150.5, color: '#ffffff',
    })).toBe(false);
  });

  it('rejects an equalizer with a non-integer x', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: 10.5, y: 10, width: 400, height: 150, color: '#ffffff',
    })).toBe(false);
  });

  it('rejects an equalizer with a non-integer y', () => {
    expect(isValidTemplateElement({
      type: 'equalizer', x: 10, y: 10.5, width: 400, height: 150, color: '#ffffff',
    })).toBe(false);
  });
});
