import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UTF8_FLAG = 0x0800;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x21;
const UNIX_VERSION = 0x031e;
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
const EXPECTED_PERMISSIONS = ['storage', 'alarms', 'cookies', 'webRequest', 'notifications'];
const EXPECTED_HOST_PERMISSIONS = ['https://claude.ai/*'];
const EXPECTED_OPTIONAL_HOST_PERMISSIONS = ['https://www.usewick.lol/*'];
const EXPECTED_ICONS = {
  '16': 'icons/16.png',
  '32': 'icons/32.png',
  '48': 'icons/48.png',
  '128': 'icons/128.png',
};
const FORBIDDEN_BASENAMES = new Set([
  '.dockerconfigjson', '.ds_store', '.netrc', '.npmrc', '.pypirc', '.yarnrc', '.yarnrc.yml',
  '_netrc', 'desktop.ini', 'thumbs.db',
]);
const FORBIDDEN_SECRET_NAME = /^\.?(?:credentials?|secrets?)(?:\.[a-z0-9_-]+)*$/u;
const FORBIDDEN_SERVICE_ACCOUNT_NAME = /^service[-_.]?account(?:\.[a-z0-9_-]+)*$/u;
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  throw new Error(`Extension package verification failed: ${message}`);
}

function readUInt16(bytes, offset, label) {
  if (offset < 0 || offset + 2 > bytes.length) fail(`truncated ${label}`);
  return bytes.readUInt16LE(offset);
}

function readUInt32(bytes, offset, label) {
  if (offset < 0 || offset + 4 > bytes.length) fail(`truncated ${label}`);
  return bytes.readUInt32LE(offset);
}

function assertSafePath(name) {
  if (name.length === 0 || name.includes('\\') || name.includes('\0') || /[\u0000-\u001f\u007f]/u.test(name)) fail(`unsafe path ${JSON.stringify(name)}`);
  if (name.startsWith('/') || /^[A-Za-z]:/u.test(name) || name.endsWith('/')) fail(`non-root file path ${JSON.stringify(name)}`);
  const segments = name.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) fail(`path traversal in ${JSON.stringify(name)}`);
  if (posix.normalize(name) !== name || name.normalize('NFC') !== name) fail(`non-normalized path ${JSON.stringify(name)}`);
  const basename = posix.basename(name).toLowerCase();
  if (
    name.toLowerCase().endsWith('.map') || /^\.env(?:\.|$)/u.test(basename) ||
    FORBIDDEN_BASENAMES.has(basename) || FORBIDDEN_SECRET_NAME.test(basename) ||
    FORBIDDEN_SERVICE_ACCOUNT_NAME.test(basename) || /(?:\.bak|\.tmp|\.swp|~)$/u.test(basename) ||
    /\.(?:cer|crt|der|jks|key|p12|p7b|p7c|pem|pfx)$/u.test(basename) || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/u.test(basename)
  ) fail(`forbidden packaged file ${JSON.stringify(name)}`);
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function decodeName(bytes, start, length, label) {
  if (start < 0 || length < 0 || start + length > bytes.length) fail(`truncated ${label}`);
  try {
    return decoder.decode(bytes.subarray(start, start + length));
  } catch {
    fail(`invalid UTF-8 in ${label}`);
  }
}

export function parseExtensionZip(archive) {
  const bytes = Buffer.from(archive);
  if (bytes.length < 22) fail('archive is truncated');
  const endOffset = bytes.length - 22;
  if (readUInt32(bytes, endOffset, 'end record signature') !== 0x06054b50) fail('missing end record or archive has trailing data/comments');
  if (readUInt16(bytes, endOffset + 4, 'disk number') !== 0 || readUInt16(bytes, endOffset + 6, 'central disk') !== 0) fail('multi-disk ZIP is not allowed');
  const diskEntries = readUInt16(bytes, endOffset + 8, 'disk entry count');
  const entryCount = readUInt16(bytes, endOffset + 10, 'entry count');
  const centralSize = readUInt32(bytes, endOffset + 12, 'central size');
  const centralOffset = readUInt32(bytes, endOffset + 16, 'central offset');
  if (readUInt16(bytes, endOffset + 20, 'comment length') !== 0) fail('ZIP comments are not allowed');
  if (diskEntries !== entryCount || entryCount === 0) fail('invalid ZIP entry count');
  if (centralOffset + centralSize !== endOffset) fail('central directory bounds do not match the archive');

  const entries = [];
  const identities = new Set();
  let cursor = centralOffset;
  let previousNameBytes;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(bytes, cursor, 'central record signature') !== 0x02014b50) fail(`invalid central record ${index}`);
    const versionMade = readUInt16(bytes, cursor + 4, 'creator version');
    const versionNeeded = readUInt16(bytes, cursor + 6, 'required version');
    const flags = readUInt16(bytes, cursor + 8, 'central flags');
    const method = readUInt16(bytes, cursor + 10, 'central compression method');
    const time = readUInt16(bytes, cursor + 12, 'central time');
    const date = readUInt16(bytes, cursor + 14, 'central date');
    const crc = readUInt32(bytes, cursor + 16, 'central CRC');
    const compressedSize = readUInt32(bytes, cursor + 20, 'central compressed size');
    const size = readUInt32(bytes, cursor + 24, 'central size');
    const nameLength = readUInt16(bytes, cursor + 28, 'central name length');
    const extraLength = readUInt16(bytes, cursor + 30, 'central extra length');
    const commentLength = readUInt16(bytes, cursor + 32, 'central comment length');
    const disk = readUInt16(bytes, cursor + 34, 'central disk start');
    const internalAttributes = readUInt16(bytes, cursor + 36, 'internal attributes');
    const externalAttributes = readUInt32(bytes, cursor + 38, 'external attributes');
    const localOffset = readUInt32(bytes, cursor + 42, 'local offset');
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > centralOffset + centralSize) fail(`truncated central record ${index}`);
    if (versionMade !== UNIX_VERSION || versionNeeded !== 20 || flags !== UTF8_FLAG || method !== 0) fail(`unsupported metadata in central record ${index}`);
    if (time !== FIXED_DOS_TIME || date !== FIXED_DOS_DATE || extraLength !== 0 || commentLength !== 0) fail(`non-deterministic metadata in central record ${index}`);
    if (disk !== 0 || internalAttributes !== 0 || externalAttributes !== FILE_ATTRIBUTES) fail(`unexpected attributes in central record ${index}`);
    if (compressedSize !== size) fail(`compressed entry ${index} is not allowed`);
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeName(bytes, cursor + 46, nameLength, `central name ${index}`);
    assertSafePath(name);
    if (previousNameBytes !== undefined && Buffer.compare(previousNameBytes, rawName) >= 0) fail('central directory paths are not strictly sorted');
    previousNameBytes = Buffer.from(rawName);
    const identity = name.toLowerCase();
    if (identities.has(identity)) fail(`duplicate path ${JSON.stringify(name)}`);
    identities.add(identity);
    entries.push({ name, rawName: Buffer.from(rawName), crc, size, localOffset, data: Buffer.alloc(0) });
    cursor = recordEnd;
  }
  if (cursor !== centralOffset + centralSize) fail('central directory contains unparsed data');

  let expectedLocalOffset = 0;
  for (const [index, entry] of entries.entries()) {
    const offset = entry.localOffset;
    if (offset !== expectedLocalOffset || offset >= centralOffset) fail(`invalid local record offset for ${JSON.stringify(entry.name)}`);
    if (readUInt32(bytes, offset, 'local record signature') !== 0x04034b50) fail(`invalid local record ${index}`);
    const version = readUInt16(bytes, offset + 4, 'local version');
    const flags = readUInt16(bytes, offset + 6, 'local flags');
    const method = readUInt16(bytes, offset + 8, 'local method');
    const time = readUInt16(bytes, offset + 10, 'local time');
    const date = readUInt16(bytes, offset + 12, 'local date');
    const crc = readUInt32(bytes, offset + 14, 'local CRC');
    const compressedSize = readUInt32(bytes, offset + 18, 'local compressed size');
    const size = readUInt32(bytes, offset + 22, 'local size');
    const nameLength = readUInt16(bytes, offset + 26, 'local name length');
    const extraLength = readUInt16(bytes, offset + 28, 'local extra length');
    const name = decodeName(bytes, offset + 30, nameLength, `local name ${index}`);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) fail(`truncated data for ${JSON.stringify(entry.name)}`);
    if (version !== 20 || flags !== UTF8_FLAG || method !== 0 || time !== FIXED_DOS_TIME || date !== FIXED_DOS_DATE || extraLength !== 0) fail(`unsupported local metadata for ${JSON.stringify(entry.name)}`);
    if (name !== entry.name || !bytes.subarray(offset + 30, offset + 30 + nameLength).equals(entry.rawName)) fail(`local/central name mismatch for ${JSON.stringify(entry.name)}`);
    if (crc !== entry.crc || compressedSize !== entry.size || size !== entry.size) fail(`local/central size or CRC mismatch for ${JSON.stringify(entry.name)}`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (crc32(data) !== entry.crc) fail(`CRC mismatch for ${JSON.stringify(entry.name)}`);
    entry.data = Buffer.from(data);
    expectedLocalOffset = dataEnd;
  }
  if (expectedLocalOffset !== centralOffset) fail('unparsed data exists between local records and central directory');
  return entries.map(({ rawName: _rawName, ...entry }) => entry);
}

async function collectDistFiles(distRoot) {
  const root = resolve(distRoot);
  const files = new Map();
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const status = await lstat(absolute);
      const name = relative(root, absolute).split(sep).join('/');
      assertSafePath(name);
      if (status.isSymbolicLink()) fail(`dist contains symbolic link ${JSON.stringify(name)}`);
      if (status.isDirectory()) await visit(absolute);
      else if (status.isFile()) files.set(name, await readFile(absolute));
      else fail(`dist contains unsupported entry ${JSON.stringify(name)}`);
    }
  }
  await visit(root);
  return files;
}

function equalJsonArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function verifyManifest(entries, packageVersion) {
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
  const manifestBytes = byName.get('manifest.json');
  if (manifestBytes === undefined) fail('manifest.json is missing from archive root');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('manifest.json is not valid JSON');
  }
  if (manifest.manifest_version !== 3) fail('manifest.json must use Manifest V3');
  if (manifest.version !== packageVersion) fail(`manifest version ${JSON.stringify(manifest.version)} does not match package version ${JSON.stringify(packageVersion)}`);
  if (!equalJsonArray(manifest.permissions, EXPECTED_PERMISSIONS)) fail('manifest permissions differ from the reviewed set');
  if (!equalJsonArray(manifest.host_permissions, EXPECTED_HOST_PERMISSIONS)) fail('manifest host permissions differ from the reviewed set');
  if (!equalJsonArray(manifest.optional_host_permissions, EXPECTED_OPTIONAL_HOST_PERMISSIONS)) fail('manifest optional host permissions differ from the reviewed set');
  if (JSON.stringify(manifest.icons) !== JSON.stringify(EXPECTED_ICONS)) fail('manifest extension icon references differ from the reviewed set');
  if (JSON.stringify(manifest.action?.default_icon) !== JSON.stringify(EXPECTED_ICONS)) fail('manifest action icon references differ from the reviewed set');
  for (const path of Object.values(EXPECTED_ICONS)) {
    if (!byName.has(path)) fail(`referenced icon ${path} is missing`);
  }
}

export async function verifyExtensionPackage({ archivePath, distRoot = resolve(ROOT, 'dist'), packagePath = resolve(ROOT, 'package.json') } = {}) {
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) fail('package.json has no version');
  const selectedArchive = resolve(archivePath ?? resolve(ROOT, 'artifacts', `wick-${pkg.version}.zip`));
  const entries = parseExtensionZip(await readFile(selectedArchive));
  const distFiles = await collectDistFiles(distRoot);
  if (entries.length !== distFiles.size) fail(`archive has ${entries.length} files but dist has ${distFiles.size}`);
  for (const entry of entries) {
    const expected = distFiles.get(entry.name);
    if (expected === undefined) fail(`unexpected archive file ${JSON.stringify(entry.name)}`);
    if (!entry.data.equals(expected)) fail(`archive bytes differ from dist for ${JSON.stringify(entry.name)}`);
    distFiles.delete(entry.name);
  }
  if (distFiles.size !== 0) fail(`archive is missing dist file ${JSON.stringify(distFiles.keys().next().value)}`);
  verifyManifest(entries, pkg.version);
  return { archivePath: selectedArchive, entries: entries.length };
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [archiveArgument, distArgument] = process.argv.slice(2);
  const result = await verifyExtensionPackage({
    ...(archiveArgument === undefined ? {} : { archivePath: resolve(archiveArgument) }),
    ...(distArgument === undefined ? {} : { distRoot: resolve(distArgument) }),
  });
  console.log(`Verified ${result.entries} files in ${result.archivePath}`);
}
