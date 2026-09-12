import { isValidTemplateElement, isValidTemplateElements, DEFAULT_TEMPLATE_ELEMENTS, DEFAULT_EQUALIZER_STYLE, isValidColorValue, normalizeEqualizerElement, globalPulseStrength } from '../../src/templates/templateTypes';
import type { EqualizerElement } from '../../src/templates/templateTypes';
import { MAX_GLOBAL_PULSE_STRENGTH } from '../../src/audio/pulseEngine';

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

  // Same ffmpeg-parses-this-directly reasoning as the equalizer shorthand-hex tests below:
  // TimerElement.color reaches a drawtext fontcolor argument, not Satori/CSS.
  it('rejects a timer with a shorthand 3-digit hex color', () => {
    expect(isValidTemplateElement({
      type: 'timer', x: 10, y: 10, fontSize: 20, color: '#f00', style: baseStyle,
    })).toBe(false);
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
  const validEqualizer = {
    type: 'equalizer', x: 10, y: 10, width: 400, height: 150,
    colors: ['#3b6fff', '#ff2f6e', '#3bdcff'],
    glowLayers: 9, glowRadius: 42, coreWidth: 1,
    sensitivity: 1.5, smoothing: 0.4, beatBoost: 0.5, bandCount: 56, globalPulse: 8,
  };

  it('accepts a valid equalizer element', () => {
    expect(isValidTemplateElement(validEqualizer)).toBe(true);
  });

  it('accepts every reactivity field at both ends of its range', () => {
    expect(isValidTemplateElement({ ...validEqualizer, sensitivity: 0.5, smoothing: 0, beatBoost: 0, bandCount: 8, globalPulse: 0 })).toBe(true);
    expect(isValidTemplateElement({ ...validEqualizer, sensitivity: 3, smoothing: 1, beatBoost: 1, bandCount: 112, globalPulse: 20 })).toBe(true);
  });

  it('rejects globalPulse outside 0-20', () => {
    expect(isValidTemplateElement({ ...validEqualizer, globalPulse: -1 })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, globalPulse: 21 })).toBe(false);
  });

  // Integer-only, like glowLayers/bandCount — the 0-20 range is what gives whole-number steps
  // enough resolution (see EqualizerElement in templateTypes.ts).
  it('rejects a non-integer globalPulse', () => {
    expect(isValidTemplateElement({ ...validEqualizer, globalPulse: 8.5 })).toBe(false);
  });

  it('rejects a missing or non-numeric globalPulse', () => {
    const { globalPulse, ...withoutGlobalPulse } = validEqualizer;
    expect(isValidTemplateElement(withoutGlobalPulse)).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, globalPulse: '8' })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, globalPulse: Number.NaN })).toBe(false);
  });

  it('rejects sensitivity outside 0.5-3.0', () => {
    expect(isValidTemplateElement({ ...validEqualizer, sensitivity: 0.49 })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, sensitivity: 3.01 })).toBe(false);
  });

  it('rejects smoothing outside 0-1', () => {
    expect(isValidTemplateElement({ ...validEqualizer, smoothing: -0.01 })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, smoothing: 1.01 })).toBe(false);
  });

  it('rejects beatBoost outside 0-1', () => {
    expect(isValidTemplateElement({ ...validEqualizer, beatBoost: -0.01 })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, beatBoost: 1.01 })).toBe(false);
  });

  it('rejects bandCount outside 8-112', () => {
    expect(isValidTemplateElement({ ...validEqualizer, bandCount: 7 })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, bandCount: 113 })).toBe(false);
  });

  it('rejects a non-integer bandCount', () => {
    expect(isValidTemplateElement({ ...validEqualizer, bandCount: 56.5 })).toBe(false);
  });

  it('rejects a missing or non-numeric reactivity field', () => {
    const { sensitivity, ...withoutSensitivity } = validEqualizer;
    expect(isValidTemplateElement(withoutSensitivity)).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, smoothing: '0.4' })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, beatBoost: Number.NaN })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, bandCount: null })).toBe(false);
  });

  it('rejects an equalizer with fewer than 2 color stops', () => {
    expect(isValidTemplateElement({ ...validEqualizer, colors: ['#3b6fff'] })).toBe(false);
  });

  it('rejects an equalizer with more than 6 color stops', () => {
    expect(isValidTemplateElement({ ...validEqualizer, colors: new Array(7).fill('#3b6fff') })).toBe(false);
  });

  it('rejects an equalizer with a non-hex color stop', () => {
    expect(isValidTemplateElement({ ...validEqualizer, colors: ['#3b6fff', 'not-a-color'] })).toBe(false);
  });

  // Unlike the MVP's ffmpeg-facing `color` (which needed STRICT_HEX_COLOR_PATTERN because
  // ffmpeg's av_parse_color can't do CSS shorthand), these colors reach resvg's SVG gradient
  // stops — a real CSS-color-parsing renderer, same as title/playlist's ColorValue — so 3/4-digit
  // shorthand is fine here.
  it('accepts a shorthand 3-digit hex color stop', () => {
    expect(isValidTemplateElement({ ...validEqualizer, colors: ['#f00', '#00f'] })).toBe(true);
  });

  it('rejects glowLayers below 3', () => {
    expect(isValidTemplateElement({ ...validEqualizer, glowLayers: 2 })).toBe(false);
  });

  it('rejects glowLayers above 9', () => {
    expect(isValidTemplateElement({ ...validEqualizer, glowLayers: 10 })).toBe(false);
  });

  it('rejects a non-integer glowLayers', () => {
    expect(isValidTemplateElement({ ...validEqualizer, glowLayers: 5.5 })).toBe(false);
  });

  it('rejects glowRadius outside 10-70', () => {
    expect(isValidTemplateElement({ ...validEqualizer, glowRadius: 9 })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, glowRadius: 71 })).toBe(false);
  });

  it('rejects coreWidth outside 1-6', () => {
    expect(isValidTemplateElement({ ...validEqualizer, coreWidth: 0.5 })).toBe(false);
    expect(isValidTemplateElement({ ...validEqualizer, coreWidth: 7 })).toBe(false);
  });

  it('rejects an equalizer with an out-of-canvas position', () => {
    expect(isValidTemplateElement({ ...validEqualizer, x: -1 })).toBe(false);
  });

  it('rejects an equalizer missing width/height', () => {
    const { width, height, ...rest } = validEqualizer;
    expect(isValidTemplateElement(rest)).toBe(false);
  });

  // pipe:5's `-s <width>x<height>` (like the old showfreqs `s=` option before it) requires
  // integer dimensions — see persistentEncoderArgs.ts.
  it('rejects an equalizer with a non-integer width', () => {
    expect(isValidTemplateElement({ ...validEqualizer, width: 400.5 })).toBe(false);
  });

  it('rejects an equalizer with a non-integer height', () => {
    expect(isValidTemplateElement({ ...validEqualizer, height: 150.5 })).toBe(false);
  });

  it('rejects an equalizer with a non-integer x', () => {
    expect(isValidTemplateElement({ ...validEqualizer, x: 10.5 })).toBe(false);
  });

  it('rejects an equalizer with a non-integer y', () => {
    expect(isValidTemplateElement({ ...validEqualizer, y: 10.5 })).toBe(false);
  });
});

describe('globalPulseStrength — the template field\'s 0-20 scale onto PulseEngine\'s own', () => {
  // 0 must land on the engine's exact-zero path (byte-identical to an engine without the option
  // — see pulseEngine.test.ts), not on some tiny positive strength.
  it('maps 0 to exactly 0', () => {
    expect(globalPulseStrength(0)).toBe(0);
  });

  // The default reproduces the engine strength the user approved in the internal-only A/B
  // captures (0.8), so a template that never touches the knob gets the approved look.
  it('maps the default (8) to the previously-approved engine strength 0.8, exactly', () => {
    expect(DEFAULT_EQUALIZER_STYLE.globalPulse).toBe(8);
    expect(globalPulseStrength(DEFAULT_EQUALIZER_STYLE.globalPulse)).toBe(0.8);
  });

  // Pins the two ends of the relationship together: the field's ceiling is the engine's clamp,
  // so nothing in the field's range silently saturates (if this fails, one of the two moved).
  it('maps the field\'s ceiling (20) onto the engine\'s MAX_GLOBAL_PULSE_STRENGTH', () => {
    expect(globalPulseStrength(20)).toBe(MAX_GLOBAL_PULSE_STRENGTH);
  });

  it('is linear, with no float noise on an in-between value', () => {
    expect(globalPulseStrength(12)).toBe(1.2);
    expect(globalPulseStrength(3)).toBe(0.3);
  });
});

describe('normalizeEqualizerElement', () => {
  it('returns an already-valid equalizer element unchanged', () => {
    const el: EqualizerElement = {
      type: 'equalizer', x: 10, y: 10, width: 400, height: 150,
      colors: ['#3b6fff', '#ff2f6e'], glowLayers: 5, glowRadius: 30, coreWidth: 2,
      sensitivity: 2, smoothing: 0.7, beatBoost: 0.1, bandCount: 32, globalPulse: 3,
    };
    expect(normalizeEqualizerElement(el)).toEqual(el);
  });

  // The shape every neon-pulse template saved before sensitivity/smoothing/beatBoost/bandCount
  // existed still has in the database. The user's own colors/glow must survive — only the fields
  // that didn't exist yet get the defaults.
  it('keeps the saved style and fills in only the missing reactivity fields for a template saved before they existed', () => {
    const saved = {
      type: 'equalizer', x: 10, y: 10, width: 400, height: 150,
      colors: ['#123456', '#abcdef'], glowLayers: 4, glowRadius: 15, coreWidth: 3,
    } as unknown as EqualizerElement;
    const result = normalizeEqualizerElement(saved);
    expect(result).toEqual({
      ...saved,
      sensitivity: DEFAULT_EQUALIZER_STYLE.sensitivity,
      smoothing: DEFAULT_EQUALIZER_STYLE.smoothing,
      beatBoost: DEFAULT_EQUALIZER_STYLE.beatBoost,
      bandCount: DEFAULT_EQUALIZER_STYLE.bandCount,
      globalPulse: DEFAULT_EQUALIZER_STYLE.globalPulse,
    });
    expect(isValidTemplateElement(result)).toBe(true);
  });

  // The next generation of that: a template saved with the four reactivity fields but before
  // globalPulse existed. It gets the default (8 — the approved look), not a validation failure
  // and not "off".
  it('fills in the default globalPulse for a template saved with the other reactivity fields but before globalPulse existed', () => {
    const saved = {
      type: 'equalizer', x: 10, y: 10, width: 400, height: 150,
      colors: ['#123456', '#abcdef'], glowLayers: 4, glowRadius: 15, coreWidth: 3,
      sensitivity: 2, smoothing: 0.7, beatBoost: 0.1, bandCount: 32,
    } as unknown as EqualizerElement;
    const result = normalizeEqualizerElement(saved);
    expect(result).toEqual({ ...saved, globalPulse: DEFAULT_EQUALIZER_STYLE.globalPulse });
    expect(result!.globalPulse).toBe(8);
    expect(isValidTemplateElement(result)).toBe(true);
  });

  it('replaces just an out-of-range reactivity field, keeping the valid ones', () => {
    const saved = {
      type: 'equalizer', x: 10, y: 10, width: 400, height: 150,
      colors: ['#123456', '#abcdef'], glowLayers: 4, glowRadius: 15, coreWidth: 3,
      sensitivity: 99, smoothing: 0.7, beatBoost: 0.1, bandCount: 32, globalPulse: 3,
    } as unknown as EqualizerElement;
    const result = normalizeEqualizerElement(saved);
    expect(result).toEqual({ ...saved, sensitivity: DEFAULT_EQUALIZER_STYLE.sensitivity });
    expect(isValidTemplateElement(result)).toBe(true);
  });

  it('fills in the default neon-pulse style for a legacy MVP-shaped element (bare color string, no colors[])', () => {
    // The real pre-neon-pulse showfreqs MVP shape — still sitting in real saved templates.
    const legacy = { type: 'equalizer', x: 44, y: 435, width: 861, height: 163, color: '#ec875b' } as unknown as EqualizerElement;
    const result = normalizeEqualizerElement(legacy);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(44);
    expect(result!.y).toBe(435);
    expect(result!.width).toBe(861);
    expect(result!.height).toBe(163);
    expect(Array.isArray(result!.colors)).toBe(true);
    expect(result!.colors.length).toBeGreaterThanOrEqual(2);
    expect(isValidTemplateElement(result)).toBe(true);
  });

  it('drops the element when even the default style cannot make it valid (a corrupt position)', () => {
    const corrupt = { type: 'equalizer', x: -1, y: 10, width: 400, height: 150 } as unknown as EqualizerElement;
    expect(normalizeEqualizerElement(corrupt)).toBeNull();
  });
});
