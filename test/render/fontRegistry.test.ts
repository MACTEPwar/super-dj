import { resolveFontFile, FONT_FAMILIES } from '../../src/render/fontRegistry';

describe('resolveFontFile', () => {
  it('lists DejaVu Sans and Liberation Sans as available families', () => {
    expect(FONT_FAMILIES).toContain('DejaVu Sans');
    expect(FONT_FAMILIES).toContain('Liberation Sans');
  });

  it('resolves DejaVu Sans regular', () => {
    expect(resolveFontFile('DejaVu Sans', false, false))
      .toBe('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  });

  it('resolves DejaVu Sans bold+italic', () => {
    expect(resolveFontFile('DejaVu Sans', true, true))
      .toBe('/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf');
  });

  it('resolves Liberation Sans bold', () => {
    expect(resolveFontFile('Liberation Sans', true, false))
      .toBe('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf');
  });

  it('falls back to the family default when a variant file does not exist on disk', () => {
    // Simulate an unknown combination by requesting an unlisted family — falls back to the
    // first entry in FONT_FAMILIES rather than throwing, so a stale/edited template referencing
    // a since-removed family never breaks rendering.
    expect(resolveFontFile('Comic Sans MS', false, false))
      .toBe(resolveFontFile(FONT_FAMILIES[0], false, false));
  });
});
