interface FontVariants {
  regular: string;
  bold: string;
  italic: string;
  boldItalic: string;
}

const REGISTRY: Record<string, FontVariants> = {
  'DejaVu Sans': {
    regular: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    italic: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
    boldItalic: '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf',
  },
  'Liberation Sans': {
    regular: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    bold: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    italic: '/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf',
    boldItalic: '/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf',
  },
};

export const FONT_FAMILIES: readonly string[] = Object.keys(REGISTRY);

export function resolveFontFile(family: string, bold: boolean, italic: boolean): string {
  const variants = REGISTRY[family] ?? REGISTRY[FONT_FAMILIES[0]];
  if (bold && italic) return variants.boldItalic;
  if (bold) return variants.bold;
  if (italic) return variants.italic;
  return variants.regular;
}
