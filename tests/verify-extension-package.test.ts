import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type ZipInput = { name: string; data: Uint8Array };
type ParsedEntry = { name: string; data: Buffer };
type VerifyOptions = { archivePath?: string; distRoot?: string; packagePath?: string };

const packageModule = await import(new URL('../scripts/package-extension.mjs', import.meta.url).href) as {
  collectDistEntries(distRoot: string): Promise<ZipInput[]>;
  createDeterministicZip(entries: ZipInput[]): Buffer;
};
const verifierModule = await import(new URL('../scripts/verify-extension-package.mjs', import.meta.url).href) as {
  parseExtensionZip(archive: Uint8Array): ParsedEntry[];
  verifyExtensionPackage(options?: VerifyOptions): Promise<{ archivePath: string; entries: number }>;
};
const { collectDistEntries, createDeterministicZip } = packageModule;
const { parseExtensionZip, verifyExtensionPackage } = verifierModule;

const temporaryDirectories: string[] = [];
const icons = {
  '16': 'icons/16.png',
  '32': 'icons/32.png',
  '48': 'icons/48.png',
  '128': 'icons/128.png',
};

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'Fixture',
    version: '1.2.3',
    permissions: ['storage', 'alarms', 'cookies', 'webRequest', 'notifications'],
    host_permissions: ['https://claude.ai/*'],
    optional_host_permissions: ['https://www.usewick.lol/*'],
    icons,
    action: { default_icon: icons },
    ...overrides,
  };
}

async function fixture(manifest = validManifest()) {
  const root = await mkdtemp(join(tmpdir(), 'wick-verify-'));
  temporaryDirectories.push(root);
  const dist = join(root, 'dist');
  const packagePath = join(root, 'package.json');
  const archivePath = join(root, 'extension.zip');
  await mkdir(join(dist, 'icons'), { recursive: true });
  await writeFile(packagePath, JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dist, 'worker.js'), 'UNIQUE_WORKER_PAYLOAD');
  for (const path of Object.values(icons)) await writeFile(join(dist, path), `fixture-${path}`);
  await writeFile(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await writeFile(join(dist, 'favicon-16.png'), 'fixture-favicon-16');
  await writeFile(join(dist, 'favicon-32.png'), 'fixture-favicon-32');
  await writeFile(archivePath, createDeterministicZip(await collectDistEntries(dist)));
  return { root, dist, distRoot: dist, packagePath, archivePath };
}

function replaceOccurrences(bytes: Buffer, before: string, after: string, maximum = Number.POSITIVE_INFINITY): Buffer {
  expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
  const result = Buffer.from(bytes);
  const needle = Buffer.from(before);
  let offset = 0;
  let replacements = 0;
  while (replacements < maximum) {
    const found = result.indexOf(needle, offset);
    if (found < 0) break;
    result.write(after, found, 'utf8');
    offset = found + needle.length;
    replacements += 1;
  }
  expect(replacements).toBeGreaterThan(0);
  return result;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('extension ZIP parser', () => {
  it('parses a valid deterministic archive without an external ZIP program', () => {
    const archive = createDeterministicZip([
      { name: 'a.txt', data: Buffer.from('alpha') },
      { name: 'nested/b.txt', data: Buffer.from('beta') },
    ]);
    expect(parseExtensionZip(archive).map(({ name, data }) => [name, data.toString()])).toEqual([
      ['a.txt', 'alpha'],
      ['nested/b.txt', 'beta'],
    ]);
  });

  it('rejects truncation and trailing data', () => {
    const archive = createDeterministicZip([{ name: 'safe.txt', data: Buffer.from('safe') }]);
    expect(() => parseExtensionZip(archive.subarray(0, archive.length - 1))).toThrow(/truncated|missing end record/);
    expect(() => parseExtensionZip(Buffer.concat([archive, Buffer.from([0])]))).toThrow(/trailing data|missing end record/);
  });

  it('rejects modified file bytes through CRC integrity checks', () => {
    const archive = createDeterministicZip([{ name: 'safe.txt', data: Buffer.from('UNIQUE_PAYLOAD') }]);
    const tampered = Buffer.from(archive);
    const payloadOffset = tampered.indexOf(Buffer.from('UNIQUE_PAYLOAD'));
    expect(payloadOffset).toBeGreaterThanOrEqual(0);
    tampered[payloadOffset] = tampered[payloadOffset]! ^ 1;
    expect(() => parseExtensionZip(tampered)).toThrow(/CRC mismatch/);
  });

  it('rejects traversal names present in both local and central records', () => {
    const archive = createDeterministicZip([{ name: 'safe.txt', data: Buffer.from('safe') }]);
    const tampered = replaceOccurrences(archive, 'safe.txt', '../x.txt');
    expect(() => parseExtensionZip(tampered)).toThrow(/traversal/);
  });

  it('rejects duplicate and local/central-conflicting names', () => {
    const archive = createDeterministicZip([
      { name: 'one.txt', data: Buffer.from('one') },
      { name: 'two.txt', data: Buffer.from('two') },
    ]);
    expect(() => parseExtensionZip(replaceOccurrences(archive, 'two.txt', 'one.txt'))).toThrow(/sorted|duplicate/);

    const one = createDeterministicZip([{ name: 'safe.txt', data: Buffer.from('safe') }]);
    expect(() => parseExtensionZip(replaceOccurrences(one, 'safe.txt', 'fake.txt', 1))).toThrow(/local\/central name mismatch/);
  });

  it.each([
    ['harmless.js', 'private.crt'],
    ['placeholder.txt', 'certificate.cer'],
    ['placeholder.json', 'credentials.json'],
    ['harmless.js', 'secrets.txt'],
    ['readme', '.npmrc'],
  ])('rejects a handcrafted archive containing forbidden artifact %s → %s', (safeName, forbiddenName) => {
    const archive = createDeterministicZip([{ name: safeName, data: Buffer.from('safe') }]);
    const handcrafted = replaceOccurrences(archive, safeName, forbiddenName);
    expect(() => parseExtensionZip(handcrafted)).toThrow(/forbidden packaged file/);
  });
});

describe('extension package verifier', () => {
  it('compares every archive byte with dist and validates the manifest contract', async () => {
    const paths = await fixture();
    await expect(verifyExtensionPackage(paths)).resolves.toMatchObject({ entries: 9 });
  });

  it('rejects unexpected archive files and dist byte differences', async () => {
    const paths = await fixture();
    await writeFile(join(paths.dist, 'extra.txt'), 'extra');
    await writeFile(paths.archivePath, createDeterministicZip(await collectDistEntries(paths.dist)));
    await unlink(join(paths.dist, 'extra.txt'));
    await expect(verifyExtensionPackage(paths)).rejects.toThrow(/archive has|unexpected archive file/);

    const second = await fixture();
    await writeFile(join(second.dist, 'worker.js'), 'changed after packaging');
    await expect(verifyExtensionPackage(second)).rejects.toThrow(/bytes differ/);
  });

  it.each([
    ['Manifest V3', { manifest_version: 2 }, /Manifest V3/],
    ['package version', { version: '9.9.9' }, /does not match package version/],
    ['permissions', { permissions: ['storage'] }, /permissions differ/],
    ['host permissions', { host_permissions: ['<all_urls>'] }, /host permissions differ/],
    ['optional host permissions', { optional_host_permissions: [] }, /optional host permissions differ/],
    ['icon references', { icons: { ...icons, '16': 'wrong.png' } }, /icon references/],
  ])('rejects an invalid %s contract', async (_label, override, expected) => {
    const paths = await fixture(validManifest(override));
    await expect(verifyExtensionPackage(paths)).rejects.toThrow(expected as RegExp);
  });

  it('rejects an archive modified after packaging', async () => {
    const paths = await fixture();
    const bytes = await readFile(paths.archivePath);
    const payload = Buffer.from('UNIQUE_WORKER_PAYLOAD');
    const at = bytes.indexOf(payload);
    expect(at).toBeGreaterThanOrEqual(0);
    bytes[at] = bytes[at]! ^ 1;
    await writeFile(paths.archivePath, bytes);
    await expect(verifyExtensionPackage(paths)).rejects.toThrow(/CRC mismatch/);
  });
});
