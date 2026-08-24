/**
 * Not a test — a way to look at the icon.
 *
 * `iconDisplayList` is pure, so the same list that Chrome rasterises can be
 * written out as SVG and opened. That is how deviation 2 was settled in
 * docs/decisions/0004-mark-at-16px.md: by looking at the mark at 16px rather
 * than by arguing about it.
 *
 * It lives under `tests/` because that is where the module resolver and the
 * `~` alias already work, and it is skipped unless asked for — a suite that
 * writes files into the working directory on every run is a suite that leaves
 * a mess in someone's `git status`.
 *
 *     WICK_ICON_OUT=. pnpm test
 */

import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { ICON_SIZES, iconDisplayList, type DrawOp } from '~/background/icon';

const OUT = process.env.WICK_ICON_OUT;

function toSvg(ops: DrawOp[], size: number): string {
  const defs: string[] = [];
  const body: string[] = [];
  ops.forEach((op, i) => {
    if (op.kind === 'path') {
      const t = op.rotate ? ` transform="rotate(${op.rotate.degrees} ${op.rotate.x} ${op.rotate.y})"` : '';
      body.push(`<path d="${op.d}" fill="${op.colour}"${t}/>`);
    } else {
      let clip = '';
      if (op.clip) {
        defs.push(`<clipPath id="c${i}"><path d="${op.clip}"/></clipPath>`);
        clip = ` clip-path="url(#c${i})"`;
      }
      body.push(`<rect x="${op.x}" y="${op.y}" width="${op.width}" height="${op.height}" fill="${op.colour}"${clip}/>`);
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs>${defs.join('')}</defs>${body.join('')}</svg>`;
}

describe.skipIf(OUT === undefined)('icon generation', () => {
  it('emits svg for each size', () => {
    for (const size of ICON_SIZES) {
      const svg = toSvg(iconDisplayList({ remaining: null, state: 'unknown' }, size), size);
      writeFileSync(`${OUT ?? '.'}/wick-${size}.svg`, svg, 'utf8');
    }
  });
});
