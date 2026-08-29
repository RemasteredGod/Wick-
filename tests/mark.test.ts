import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toChildArray, type ComponentChild, type VNode } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import {
  EMBER_PATH,
  MARK_IDENTITY,
  MARK_SIZES,
  bodyPath,
  fillRect,
  layout,
  rasterLayout,
  remainingFor,
} from '~/assets/mark';
import { Mark } from '~/popup/components/Mark';

vi.mock('preact/hooks', () => {
  let nextId = 0;
  return { useId: () => `test-${String(++nextId)}` };
});

function descendants(root: ComponentChild): Array<VNode<Record<string, unknown>>> {
  const found: Array<VNode<Record<string, unknown>>> = [];
  const visit = (child: ComponentChild): void => {
    if (child === null || child === undefined || typeof child === 'boolean') return;
    if (Array.isArray(child)) {
      for (const item of child) visit(item);
      return;
    }
    if (typeof child !== 'object' || !('type' in child)) return;
    const node = child as VNode<Record<string, unknown>>;
    found.push(node);
    const children = (node.props as { children?: ComponentChild }).children;
    for (const item of toChildArray(children)) visit(item);
  };
  visit(root);
  return found;
}

function one(
  nodes: Array<VNode<Record<string, unknown>>>,
  type: string,
): VNode<Record<string, unknown>> {
  const matches = nodes.filter((node) => node.type === type);
  expect(matches).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) throw new Error(`missing ${type}`);
  return match;
}

const ROOT = resolve(import.meta.dirname, '..');
const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');

describe('canonical v3 identity', () => {
  it('keeps the selected regular SVG exact and inert', () => {
    const path = resolve(ROOT, 'src/assets/brand/v3/wick-mark.svg');
    const bytes = readFileSync(path);
    const svg = bytes.toString('utf8');
    expect(sha256(bytes)).toBe(
      'e9b7faea5ea8015195fd7ce5c7ee6dd54116c8372d73348a870613001e19ef47',
    );
    expect(svg).toContain('viewBox="0 0 36 102"');
    expect(svg).toContain(EMBER_PATH);
    expect(svg).not.toMatch(/<(?:script|foreignObject|iframe|object|embed)\b/iu);
    expect(svg).not.toMatch(/\son[a-z]+\s*=/iu);
  });

  it('pins project-authored shared geometry and exact reviewed values', () => {
    const bytes = readFileSync(resolve(ROOT, 'brand/v3/geometry.json'));
    expect(sha256(bytes)).toBe(
      '33dcb2707abeff5304a980112bd872d1b9eb9d602eb540710e54162364dc2930',
    );
    expect(layout()).toEqual(MARK_IDENTITY.regular);
    expect(MARK_IDENTITY.regular.viewBox).toEqual({ x: 0, y: 0, width: 36, height: 102 });
    expect(MARK_IDENTITY.regular.body).toEqual({
      x: 0,
      y: 42,
      width: 36,
      height: 60,
      radius: 18,
    });
    expect(MARK_IDENTITY.gradient).toEqual({
      x1: 0,
      y1: 0,
      x2: 0.45,
      y2: 1,
      start: '#e8a33d',
      end: '#c96442',
    });
    expect(MARK_IDENTITY.colours).toEqual({
      trackRegular: '#3f3c37',
      trackSmall: '#5f5b55',
      tile: '#141312',
    });
  });

  it('retains the prior popup/content layout boxes', () => {
    expect(MARK_SIZES.inline).toEqual({
      width: 5.656854249492381,
      height: 20.656854249492383,
    });
    expect(MARK_SIZES.hero).toEqual({
      width: 7.0710678118654755,
      height: 36.071067811865476,
    });
  });

  it('renders accessible known and unknown VNodes with unique paint-server IDs', () => {
    const unknown = Mark({ remaining: null, state: 'unknown' });
    const known = Mark({ remaining: 38, state: 'warn', size: 'hero' });
    const unknownNodes = descendants(unknown);
    const knownNodes = descendants(known);

    expect(unknown.props).toMatchObject({
      role: 'img',
      'aria-label': 'Usage unknown',
      viewBox: '0 0 36 102',
    });
    expect(known.props).toMatchObject({ role: 'img', 'aria-label': '38% remaining' });

    const unknownGradient = one(unknownNodes, 'linearGradient');
    const knownGradient = one(knownNodes, 'linearGradient');
    const unknownClip = one(unknownNodes, 'clipPath');
    const knownClip = one(knownNodes, 'clipPath');
    expect(unknownGradient.props.id).not.toBe(knownGradient.props.id);
    expect(unknownClip.props.id).not.toBe(knownClip.props.id);
    expect(String(unknownGradient.props.id)).toMatch(/^wick-mark-ember-/u);
    expect(String(unknownClip.props.id)).toMatch(/^wick-mark-body-/u);
    expect(knownGradient.props).toMatchObject({ x1: 0, y1: 0, x2: 0.45, y2: 1 });

    const knownStops = knownNodes.filter((node) => node.type === 'stop');
    expect(knownStops.map((node) => node.props['stop-color'])).toEqual(['#e8a33d', '#c96442']);

    const unknownPaths = unknownNodes.filter((node) => node.type === 'path');
    const knownPaths = knownNodes.filter((node) => node.type === 'path');
    expect(unknownPaths[0]?.props.fill).toBe('var(--wick-mark-track)');
    expect(knownPaths[0]?.props.fill).toBe(`url(#${String(knownGradient.props.id)})`);

    const unknownClipped = unknownNodes.find((node) => node.props['clip-path'] !== undefined);
    const knownClipped = knownNodes.find((node) => node.props['clip-path'] !== undefined);
    expect(unknownClipped?.props['clip-path']).toBe(`url(#${String(unknownClip.props.id)})`);
    expect(knownClipped?.props['clip-path']).toBe(`url(#${String(knownClip.props.id)})`);
    expect(unknownClipped?.props.fill).toBe('var(--wick-text-dim)');
    expect(knownClipped?.props.fill).toBe('var(--wick-warn)');
  });
});

describe('fillRect', () => {
  const body = { x: 0, y: 42, width: 36, height: 60 };

  it('anchors quota remaining to the bottom', () => {
    const specimen = fillRect(body, 26);
    expect(specimen).toMatchObject({ x: 0, width: 36 });
    expect(specimen.y).toBeCloseTo(86.4, 12);
    expect(specimen.height).toBeCloseTo(15.6, 12);
    const fill = fillRect(body, 40);
    expect(fill.y + fill.height).toBe(102);
  });

  it('clamps out-of-range input without inventing state', () => {
    expect(fillRect(body, -1)).toEqual({ x: 0, y: 102, width: 36, height: 0 });
    expect(fillRect(body, 101)).toEqual(body);
  });
});

describe('remainingFor', () => {
  it('tracks the most constrained known window', () => {
    expect(remainingFor([68, 82])).toBe(18);
    expect(remainingFor([null, 30, null])).toBe(70);
  });

  it('returns unknown rather than a confident full gauge', () => {
    expect(remainingFor([null, null])).toBeNull();
    expect(remainingFor([])).toBeNull();
  });

  it('defensively clamps provider overflow', () => {
    expect(remainingFor([103])).toBe(0);
    expect(remainingFor([-4])).toBe(100);
  });
});

describe('v3 raster layout', () => {
  it('uses the approved small optical build only at 16px', () => {
    const small = rasterLayout(16);
    expect(small.variant).toBe('small');
    expect(small.body).toMatchObject({ x: 5, y: 7, width: 6, height: 9 });
    expect(small.ember.gradient).toBe(false);
    expect(small.ember.d).toBe(EMBER_PATH);
  });

  it.each([32, 48, 128])('uses exact regular geometry and gradient at %dpx', (size) => {
    const regular = rasterLayout(size);
    expect(regular.variant).toBe('regular');
    expect(regular.ember.gradient).toBe(true);
    expect(regular.ember.d).toBe(EMBER_PATH);
    expect(regular.body.y + regular.body.height).toBe(size);
  });

  it.each([16, 32, 48, 128])('shares one exact horizontal centre at %dpx', (size) => {
    const mark = rasterLayout(size);
    const bodyCentre = mark.body.x + mark.body.width / 2;
    const emberBoundsCentre = mark.ember.bounds.x + mark.ember.bounds.width / 2;
    const canonicalEmberCentre =
      MARK_IDENTITY.regular.emberBounds.x + MARK_IDENTITY.regular.emberBounds.width / 2;
    const transformedEmberCentre =
      canonicalEmberCentre * mark.ember.transform.scaleX + mark.ember.transform.translateX;

    expect(bodyCentre).toBe(size / 2);
    expect(emberBoundsCentre).toBe(size / 2);
    expect(transformedEmberCentre).toBe(size / 2);
  });

  it('keeps the approved 128px manifest/notification optical fit edge-to-edge', () => {
    const { body } = rasterLayout(128);
    expect(body.y + body.height).toBe(128);
  });

  it('preserves the exact capsule path', () => {
    expect(bodyPath(0, 42, 36, 60, 18)).toBe(
      'M18 42H18A18 18 0 0 1 36 60V84A18 18 0 0 1 18 102H18A18 18 0 0 1 0 84V60A18 18 0 0 1 18 42Z',
    );
  });
});
