import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = resolve(ROOT, 'public');
const DIST_ROOT = resolve(ROOT, 'dist');
const BRAND_ROOT = resolve(ROOT, 'src/assets/brand/v3');
const GEOMETRY_PATH = resolve(ROOT, 'brand/v3/geometry.json');
const EXPECTED_ICONS = new Map([
  ['icons/16.png', { size: 16, hash: '76f9093702dba17d2f0b8562dde4f8795f012a4b871c3efdedca3c218ddc8549' }],
  ['icons/32.png', { size: 32, hash: 'e886f65c52f144844cda26d1eaf0b1330ae918fbaab0fa136703a03077a475f4' }],
  ['icons/48.png', { size: 48, hash: '1fd19cd2b2697b448612df37c13ebd32c938fd4381435eb085d411571310a109' }],
  ['icons/128.png', { size: 128, hash: 'e37181c5b99a133846c045b07db782d89fbb04f401ec1f990a1bedb922581450' }],
]);
const EXPECTED_FAVICONS = new Map([
  ['favicon.svg', { hash: '900541a20a0339f97c31933719ed8ae5ad3b5a89dc9a14632fcb11e70509f188', size: null }],
  ['favicon-16.png', { hash: 'e93dfd2ddbe7dbae9bac8175d9556fa1cfab6f58fe46c608d98c7da0b030c51d', size: 16 }],
  ['favicon-32.png', { hash: '563590144d7db49c283df0013ef1bdc992755faa1dd106ea3c493c9b050046da', size: 32 }],
]);
const MARK_HASH = 'e9b7faea5ea8015195fd7ce5c7ee6dd54116c8372d73348a870613001e19ef47';
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(message) {
  throw new Error(`Extension build verification failed: ${message}`);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactFile(path, expectedHash) {
  if (!existsSync(path)) fail(`missing ${path}`);
  const bytes = readFileSync(path);
  const actual = hash(bytes);
  if (actual !== expectedHash) fail(`${path} has SHA-256 ${actual}, expected ${expectedHash}`);
  return bytes;
}

function pngHeader(path) {
  if (!existsSync(path)) fail(`missing ${path}`);
  const bytes = readFileSync(path);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) fail(`${path} is not a PNG`);
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') fail(`${path} has no leading IHDR`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colourType: bytes[25],
  };
}

function checkPng(path, expectedSize, expectedHash) {
  const bytes = exactFile(path, expectedHash);
  const header = pngHeader(path);
  if (header.width !== expectedSize || header.height !== expectedSize || header.bitDepth !== 8 || header.colourType !== 6) {
    fail(`${path} has ${JSON.stringify(header)}, expected ${expectedSize}x${expectedSize} 8-bit RGBA`);
  }
  return bytes;
}

function checkInertSvg(path, expectedHash) {
  const svg = exactFile(path, expectedHash).toString('utf8');
  if (!/^<svg\b/u.test(svg) || !/<\/svg>\s*$/u.test(svg)) fail(`${path} is not a complete SVG`);
  if (/<(?:script|foreignObject|iframe|object|embed)\b/iu.test(svg)) fail(`${path} contains active SVG content`);
  if (/\son[a-z]+\s*=/iu.test(svg) || /(?:href|xlink:href)\s*=\s*["'](?!#|\/)/iu.test(svg)) {
    fail(`${path} contains an active or external SVG reference`);
  }
}

function walk(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walk(path));
    else if (entry.isFile()) paths.push(path);
    else fail(`unsupported build entry ${path}`);
  }
  return paths;
}

checkInertSvg(resolve(BRAND_ROOT, 'wick-mark.svg'), MARK_HASH);
const geometry = JSON.parse(readFileSync(GEOMETRY_PATH, 'utf8'));
if (
  geometry.regular.emberPath !== 'M 18 0 L 8.45405845398161 9.55 A 13.5 13.5 0 1 0 27.54594154601839 9.55 Z' ||
  JSON.stringify(geometry.regular.body) !== JSON.stringify({ x: 0, y: 42, width: 36, height: 60, radius: 18 }) ||
  geometry.gradient.start !== '#e8a33d' || geometry.gradient.end !== '#c96442' ||
  geometry.colours.trackRegular !== '#3f3c37' || geometry.colours.trackSmall !== '#5f5b55' ||
  geometry.colours.tile !== '#141312'
) fail('shared v3 geometry differs from the reviewed canonical values');

for (const [path, expected] of EXPECTED_ICONS) {
  const source = resolve(SOURCE_ROOT, path);
  const built = resolve(DIST_ROOT, path);
  const sourceBytes = checkPng(source, expected.size, expected.hash);
  const builtBytes = checkPng(built, expected.size, expected.hash);
  if (!builtBytes.equals(sourceBytes)) fail(`${path} differs between public and dist`);
}

for (const [path, expected] of EXPECTED_FAVICONS) {
  const source = resolve(SOURCE_ROOT, path);
  const built = resolve(DIST_ROOT, path);
  if (expected.size === null) {
    checkInertSvg(source, expected.hash);
    checkInertSvg(built, expected.hash);
  } else {
    checkPng(source, expected.size, expected.hash);
    checkPng(built, expected.size, expected.hash);
  }
  if (!readFileSync(source).equals(readFileSync(built))) fail(`${path} differs between public and dist`);
}

const manifestPath = resolve(DIST_ROOT, 'manifest.json');
if (!existsSync(manifestPath)) fail('dist/manifest.json is missing; run the build first');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const manifestIcons = manifest.icons ?? {};
const actionIcons = manifest.action?.default_icon ?? {};
for (const [path, expected] of EXPECTED_ICONS) {
  if (manifestIcons[String(expected.size)] !== path) fail(`manifest icons.${expected.size} must reference ${path}`);
  if (actionIcons[String(expected.size)] !== path) fail(`action.default_icon.${expected.size} must reference ${path}`);
}

const alertSource = readFileSync(resolve(ROOT, 'src/background/alerts.ts'), 'utf8');
const notificationMatch = alertSource.match(/const NOTIFICATION_ICON = '([^']+)'/);
if (notificationMatch?.[1] !== 'icons/128.png') fail('notification must reference icons/128.png');

for (const path of walk(DIST_ROOT)) {
  const name = relative(DIST_ROOT, path).replaceAll('\\', '/');
  if (/support\.js$|\.dc\.html$|\.map$|^\.env(?:\.|$)/iu.test(name)) fail(`prohibited build path ${name}`);
  const bytes = readFileSync(path);
  if (bytes.includes(Buffer.from('wick-owner-design-86e94a19')) || bytes.includes(Buffer.from('C:\\Users\\'))) {
    fail(`private source path leaked into ${name}`);
  }
}

console.log(`Verified ${EXPECTED_ICONS.size} exact UNKNOWN icons, ${EXPECTED_FAVICONS.size} exact favicons, canonical inert SVG geometry, and reviewed build paths.`);
