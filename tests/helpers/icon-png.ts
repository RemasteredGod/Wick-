import { readFileSync } from 'node:fs';

export const ICON_SIZES = [16, 32, 48, 128] as const;
export const ICON_PATHS = Object.fromEntries(
  ICON_SIZES.map((size) => [String(size), `icons/${size}.png`]),
) as Record<`${(typeof ICON_SIZES)[number]}`, string>;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
}

/** Read only PNG's fixed signature and first IHDR chunk; pixel decoding is unnecessary here. */
export function readPngHeader(path: string): PngHeader {
  const bytes = readFileSync(path);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${path} is not a PNG`);
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`${path} does not start with a PNG IHDR chunk`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24] ?? -1,
    colourType: bytes[25] ?? -1,
  };
}
