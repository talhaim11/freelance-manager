declare module 'bidi-js' {
  interface EmbeddingLevels { levels: Uint8Array; paragraphs: { start: number; end: number; level: number }[] }
  interface Bidi {
    getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl' | 'auto'): EmbeddingLevels;
    getReorderSegments(text: string, levels: EmbeddingLevels, start?: number, end?: number): [number, number][];
    getMirroredCharactersMap(text: string, levels: EmbeddingLevels, start?: number, end?: number): Map<number, string>;
    getMirroredCharacter(ch: string): string | null;
  }
  export default function bidiFactory(): Bidi;
}
