import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x21; // 1980-01-01, the earliest date representable by ZIP.
const UTF8_FLAG = 0x0800;
const UNIX_VERSION = 0x031e;
const FILE_MODE = 0o100644;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const FORBIDDEN_BASENAMES = new Set([
  '.dockerconfigjson', '.ds_store', '.netrc', '.npmrc', '.pypirc', '.yarnrc', '.yarnrc.yml',
  '_netrc', 'desktop.ini', 'thumbs.db',
]);
const FORBIDDEN_SECRET_NAME = /^\.?(?:credentials?|secrets?)(?:\.[a-z0-9_-]+)*$/u;
const FORBIDDEN_SERVICE_ACCOUNT_NAME = /^service[-_.]?account(?:\.[a-z0-9_-]+)*$/u;

function fail(message) {
  throw new Error(`Extension packaging failed: ${message}`);
}

export function assertSafeArchivePath(name) {
  if (typeof name !== 'string' || name.length === 0) fail('archive paths must be non-empty strings');
  if (name.includes('\\') || name.includes('\0') || /[\u0000-\u001f\u007f]/u.test(name)) {
    fail(`unsafe archive path ${JSON.stringify(name)}`);
  }
  if (name.startsWith('/') || /^[A-Za-z]:/u.test(name) || name.endsWith('/')) {
    fail(`archive path must be a relative file path: ${JSON.stringify(name)}`);
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`archive path contains an empty or traversal segment: ${JSON.stringify(name)}`);
  }
  if (posix.normalize(name) !== name || name.normalize('NFC') !== name) {
    fail(`archive path is not normalized: ${JSON.stringify(name)}`);
  }
  return name;
}

export function assertPublishablePath(name) {
  assertSafeArchivePath(name);
  const basename = posix.basename(name).toLowerCase();
  if (
    name.toLowerCase().endsWith('.map') ||
    /^\.env(?:\.|$)/u.test(basename) ||
    FORBIDDEN_BASENAMES.has(basename) ||
    FORBIDDEN_SECRET_NAME.test(basename) ||
    FORBIDDEN_SERVICE_ACCOUNT_NAME.test(basename) ||
    /(?:\.bak|\.tmp|\.swp|~)$/u.test(basename) ||
    /\.(?:cer|crt|der|jks|key|p12|p7b|p7c|pem|pfx)$/u.test(basename) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/u.test(basename)
  ) {
    fail(`refusing to package forbidden file ${JSON.stringify(name)}`);
  }
  return name;
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const bytes = Buffer.allocUnsafe(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function checkedUint32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) fail(`${label} exceeds classic ZIP limits`);
  return value;
}

export function createDeterministicZip(inputEntries) {
  if (!Array.isArray(inputEntries) || inputEntries.length === 0) fail('dist contains no files');
  if (inputEntries.length > MAX_UINT16) fail('too many files for classic ZIP');

  const seen = new Set();
  const entries = inputEntries.map((entry) => {
    const name = assertPublishablePath(entry.name);
    const identity = name.toLowerCase();
    if (seen.has(identity)) fail(`duplicate archive path ${JSON.stringify(name)}`);
    seen.add(identity);
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > MAX_UINT16) fail(`archive path is too long: ${JSON.stringify(name)}`);
    const data = Buffer.from(entry.data);
    checkedUint32(data.length, `file ${JSON.stringify(name)}`);
    return { name, nameBytes, data, crc: crc32(data), offset: 0 };
  });
  entries.sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes));

  const localParts = [];
  let offset = 0;
  for (const entry of entries) {
    entry.offset = checkedUint32(offset, 'local record offset');
    const header = Buffer.concat([
      uint32(0x04034b50), uint16(20), uint16(UTF8_FLAG), uint16(0),
      uint16(FIXED_DOS_TIME), uint16(FIXED_DOS_DATE), uint32(entry.crc),
      uint32(entry.data.length), uint32(entry.data.length), uint16(entry.nameBytes.length), uint16(0),
    ]);
    localParts.push(header, entry.nameBytes, entry.data);
    offset += header.length + entry.nameBytes.length + entry.data.length;
  }

  const centralOffset = checkedUint32(offset, 'central directory offset');
  const centralParts = [];
  let centralSize = 0;
  for (const entry of entries) {
    const header = Buffer.concat([
      uint32(0x02014b50), uint16(UNIX_VERSION), uint16(20), uint16(UTF8_FLAG), uint16(0),
      uint16(FIXED_DOS_TIME), uint16(FIXED_DOS_DATE), uint32(entry.crc),
      uint32(entry.data.length), uint32(entry.data.length), uint16(entry.nameBytes.length),
      uint16(0), uint16(0), uint16(0), uint16(0), uint32((FILE_MODE << 16) >>> 0), uint32(entry.offset),
    ]);
    centralParts.push(header, entry.nameBytes);
    centralSize += header.length + entry.nameBytes.length;
  }
  checkedUint32(centralSize, 'central directory size');

  const end = Buffer.concat([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(centralSize), uint32(centralOffset), uint16(0),
  ]);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export async function collectDistEntries(distRoot) {
  const root = resolve(distRoot);
  const entries = [];

  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const status = await lstat(absolute);
      const name = relative(root, absolute).split(sep).join('/');
      assertPublishablePath(name);
      if (status.isSymbolicLink()) fail(`symbolic links are not allowed: ${JSON.stringify(name)}`);
      if (status.isDirectory()) await visit(absolute);
      else if (status.isFile()) entries.push({ name, data: await readFile(absolute) });
      else fail(`unsupported filesystem entry ${JSON.stringify(name)}`);
    }
  }

  let rootStatus;
  try {
    rootStatus = await lstat(root);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') fail(`${root} does not exist; run the build first`);
    throw error;
  }
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) fail(`${root} must be a real directory`);
  await visit(root);
  return entries;
}

export function defaultArchivePath(packageVersion, root = ROOT) {
  return resolve(root, 'artifacts', `wick-${packageVersion}.zip`);
}

export async function packageExtension({ distRoot = resolve(ROOT, 'dist'), outputPath, packagePath = resolve(ROOT, 'package.json') } = {}) {
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) fail('package.json has no version');
  const archivePath = resolve(outputPath ?? defaultArchivePath(pkg.version));
  const entries = await collectDistEntries(distRoot);
  const archive = createDeterministicZip(entries);
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);
  return { archivePath, bytes: archive.length, entries: entries.length };
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [distArgument, outputArgument] = process.argv.slice(2);
  const result = await packageExtension({
    ...(distArgument === undefined ? {} : { distRoot: resolve(distArgument) }),
    ...(outputArgument === undefined ? {} : { outputPath: resolve(outputArgument) }),
  });
  console.log(`Packaged ${result.entries} files (${result.bytes} bytes) at ${result.archivePath}`);
}
