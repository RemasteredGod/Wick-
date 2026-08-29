import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ICON_SIZES, readPngHeader } from './helpers/icon-png';

const generator = await import(new URL('../scripts/generate-icons.mjs', import.meta.url).href) as {
  generateIcons(output?: string): Array<{ size: number; path: string; bytes: Buffer }>;
  rasterUnknown(size: number): Buffer;
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wick-icons-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('deterministic icon generation', () => {
  it('writes byte-identical UNKNOWN-state icons with reviewed dimensions', async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    generator.generateIcons(first);
    generator.generateIcons(second);

    for (const size of ICON_SIZES) {
      const firstPath = join(first, `${size}.png`);
      const secondPath = join(second, `${size}.png`);
      expect(await readFile(secondPath)).toEqual(await readFile(firstPath));
      expect(readPngHeader(firstPath)).toEqual({
        width: size,
        height: size,
        bitDepth: 8,
        colourType: 6,
      });
    }
  });

  it('makes every tile pixel opaque rather than leaking page-dependent colour', () => {
    for (const size of ICON_SIZES) {
      const rgba = generator.rasterUnknown(size);
      for (let offset = 3; offset < rgba.length; offset += 4) expect(rgba[offset]).toBe(255);
    }
  });

  it('keeps the approved 128px manifest/notification capsule edge-to-edge', () => {
    const size = 128;
    const rgba = generator.rasterUnknown(size);
    const tile = [0x14, 0x13, 0x12];
    const bottomRowHasMark = Array.from({ length: size }, (_, x) => {
      const offset = ((size - 1) * size + x) * 4;
      return tile.some((channel, index) => rgba[offset + index] !== channel);
    }).some(Boolean);

    expect(bottomRowHasMark).toBe(true);
  });

  it('does not encode the owner specimen percentages into generated state', async () => {
    const source = await readFile(
      new URL('../scripts/generate-icons.mjs', import.meta.url),
      'utf8',
    );
    expect(source).toContain('rasterUnknown');
    expect(source).not.toMatch(/remaining\s*[:=]\s*(?:26|30)\b/u);
  });
});
