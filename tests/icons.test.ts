import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_PATHS, ICON_SIZES, readPngHeader } from './helpers/icon-png';

const PUBLIC = resolve(import.meta.dirname, '../public');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const ICON_HASHES: Record<(typeof ICON_SIZES)[number], string> = {
  16: '76f9093702dba17d2f0b8562dde4f8795f012a4b871c3efdedca3c218ddc8549',
  32: 'e886f65c52f144844cda26d1eaf0b1330ae918fbaab0fa136703a03077a475f4',
  48: '1fd19cd2b2697b448612df37c13ebd32c938fd4381435eb085d411571310a109',
  128: 'e37181c5b99a133846c045b07db782d89fbb04f401ec1f990a1bedb922581450',
};

describe('packaged icon sources', () => {
  it.each(ICON_SIZES)('contains the exact deterministic %dpx UNKNOWN RGBA PNG', (size) => {
    const path = resolve(PUBLIC, ICON_PATHS[String(size) as keyof typeof ICON_PATHS]);
    expect(existsSync(path), `${path} must exist`).toBe(true);
    expect(readPngHeader(path)).toEqual({
      width: size,
      height: size,
      bitDepth: 8,
      colourType: 6,
    });
    expect(sha256(readFileSync(path))).toBe(ICON_HASHES[size]);
  });

  it('uses one exact path for each Chrome-relevant size', () => {
    expect(ICON_PATHS).toEqual({
      '16': 'icons/16.png',
      '32': 'icons/32.png',
      '48': 'icons/48.png',
      '128': 'icons/128.png',
    });
  });
});

describe('site favicons', () => {
  it.each([
    ['favicon-16.png', 16, 'e93dfd2ddbe7dbae9bac8175d9556fa1cfab6f58fe46c608d98c7da0b030c51d'],
    ['favicon-32.png', 32, '563590144d7db49c283df0013ef1bdc992755faa1dd106ea3c493c9b050046da'],
  ] as const)('keeps exact approved %s', (name, size, expectedHash) => {
    const path = resolve(PUBLIC, name);
    expect(readPngHeader(path)).toEqual({ width: size, height: size, bitDepth: 8, colourType: 6 });
    expect(sha256(readFileSync(path))).toBe(expectedHash);
  });

  it('keeps the approved SVG exact and inert', () => {
    const bytes = readFileSync(resolve(PUBLIC, 'favicon.svg'));
    const svg = bytes.toString('utf8');
    expect(sha256(bytes)).toBe(
      '900541a20a0339f97c31933719ed8ae5ad3b5a89dc9a14632fcb11e70509f188',
    );
    expect(svg).not.toMatch(/<(?:script|foreignObject|iframe|object|embed)\b/iu);
    expect(svg).not.toMatch(/\son[a-z]+\s*=/iu);
    expect(svg).not.toMatch(/(?:href|xlink:href)\s*=\s*["'](?!#|\/)/iu);
  });
});
