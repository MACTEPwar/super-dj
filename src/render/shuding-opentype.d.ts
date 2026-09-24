// @shuding/opentype.js ships no TypeScript declarations of its own (verified: no .d.ts anywhere
// under node_modules/@shuding/opentype.js, and no @types package exists for it either). Minimal
// ambient declaration covering only the surface textWidth.ts actually uses.
declare module '@shuding/opentype.js' {
  export interface Font {
    unitsPerEm: number;
    getAdvanceWidth(text: string, fontSize: number, options?: Record<string, unknown>): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
