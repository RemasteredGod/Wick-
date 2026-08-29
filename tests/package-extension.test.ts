import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type ZipInput = { name: string; data: Uint8Array };
type ParsedEntry = { name: string; data: Buffer };
type PackageOptions = { distRoot?: string; outputPath?: string; packagePath?: string };

const packageModule = await import(new URL('../scripts/package-extension.mjs', import.meta.url).href) as {
  collectDistEntries(distRoot: string): Promise<ZipInput[]>;
  createDeterministicZip(entries: ZipInput[]): Buffer;
  packageExtension(options?: PackageOptions): Promise<{ archivePath: string; bytes: number; entries: number }>;
};
const verifierModule = await import(new URL('../scripts/verify-extension-package.mjs', import.meta.url).href) as {
  parseExtensionZip(archive: Uint8Array): ParsedEntry[];
};
const { collectDistEntries, createDeterministicZip, packageExtension } = packageModule;
const { parseExtensionZip } = verifierModule;

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wick-package-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('deterministic extension packager', () => {
  it('writes sorted root-relative files with fixed metadata and identical bytes', async () => {
    const root = await temporaryDirectory();
    const dist = join(root, 'dist');
    await mkdir(join(dist, 'z'), { recursive: true });
    await writeFile(join(dist, 'z', 'last.txt'), 'last');
    await writeFile(join(dist, 'first.txt'), 'first');
    await utimes(join(dist, 'first.txt'), new Date('2020-01-01'), new Date('2020-01-01'));

    const first = createDeterministicZip(await collectDistEntries(dist));
    await utimes(join(dist, 'first.txt'), new Date('2030-01-01'), new Date('2030-01-01'));
    const second = createDeterministicZip(await collectDistEntries(dist));

    expect(second).toEqual(first);
    expect(parseExtensionZip(first).map((entry) => entry.name)).toEqual(['first.txt', 'z/last.txt']);
  });

  it('writes the default versioned artifact and is repeatable', async () => {
    const root = await temporaryDirectory();
    const dist = join(root, 'dist');
    const packagePath = join(root, 'package.json');
    await mkdir(dist);
    await writeFile(join(dist, 'manifest.json'), '{}');
    await writeFile(packagePath, JSON.stringify({ version: '1.2.3' }));
    const firstPath = join(root, 'first.zip');
    const secondPath = join(root, 'second.zip');

    const first = await packageExtension({ distRoot: dist, outputPath: firstPath, packagePath });
    const second = await packageExtension({ distRoot: dist, outputPath: secondPath, packagePath });

    expect(first).toMatchObject({ archivePath: firstPath, entries: 1 });
    expect(second.bytes).toBe(first.bytes);
    expect(await readFile(secondPath)).toEqual(await readFile(firstPath));
  });

  it.each([
    'bundle.js.map', '.env.production', 'private.pem', 'private.crt', 'certificate.cer',
    'credentials.json', 'secrets.txt', '.npmrc', 'service-account.json', '.DS_Store', 'notes.swp',
  ])('refuses forbidden output %s', async (name) => {
    const root = await temporaryDirectory();
    await writeFile(join(root, name), 'not publishable');
    await expect(collectDistEntries(root)).rejects.toThrow(/forbidden file/);
    expect(() => createDeterministicZip([{ name, data: Buffer.alloc(0) }])).toThrow(/forbidden file/);
  });

  it('rejects traversal, absolute, backslash, and case-folded duplicate paths', () => {
    for (const name of ['../secret', '/absolute', 'C:/drive', 'dir\\file']) {
      expect(() => createDeterministicZip([{ name, data: Buffer.alloc(0) }])).toThrow(/archive path/);
    }
    expect(() => createDeterministicZip([
      { name: 'File.txt', data: Buffer.from('one') },
      { name: 'file.txt', data: Buffer.from('two') },
    ])).toThrow(/duplicate archive path/);
  });

  it('collects exact public identity assets and no private design material', async () => {
    const root = join(import.meta.dirname, '..');
    const entries = await collectDistEntries(join(root, 'public'));
    const byName = new Map(entries.map((entry) => [entry.name, Buffer.from(entry.data)]));
    const expected = new Map([
      ['favicon.svg', '900541a20a0339f97c31933719ed8ae5ad3b5a89dc9a14632fcb11e70509f188'],
      ['favicon-16.png', 'e93dfd2ddbe7dbae9bac8175d9556fa1cfab6f58fe46c608d98c7da0b030c51d'],
      ['favicon-32.png', '563590144d7db49c283df0013ef1bdc992755faa1dd106ea3c493c9b050046da'],
      ['icons/16.png', '76f9093702dba17d2f0b8562dde4f8795f012a4b871c3efdedca3c218ddc8549'],
      ['icons/32.png', 'e886f65c52f144844cda26d1eaf0b1330ae918fbaab0fa136703a03077a475f4'],
      ['icons/48.png', '1fd19cd2b2697b448612df37c13ebd32c938fd4381435eb085d411571310a109'],
      ['icons/128.png', 'e37181c5b99a133846c045b07db782d89fbb04f401ec1f990a1bedb922581450'],
    ]);

    for (const [name, expectedHash] of expected) {
      const bytes = byName.get(name);
      expect(bytes, name).toBeDefined();
      expect(createHash('sha256').update(bytes ?? Buffer.alloc(0)).digest('hex')).toBe(expectedHash);
    }
    expect(entries.map((entry) => entry.name).join('\n')).not.toMatch(/support\.js|\.dc\.html/u);
  });
});



describe('package CI configuration', () => {
  it('uses least privilege, frozen installs, and immutable official action pins', async () => {
    const root = join(import.meta.dirname, '..');
    const workflow = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const actionPins = [...workflow.matchAll(/uses: actions\/(?:checkout|setup-node)@([a-f0-9]{40})$/gmu)];

    expect(actionPins).toHaveLength(2);
    expect(workflow).toContain('# actions/checkout v7.0.1');
    expect(workflow).toContain('# actions/setup-node v7.0.0');
    expect(workflow).toMatch(/permissions:\n  contents: read/u);
    expect(workflow).not.toMatch(/(?:contents|packages|actions|id-token): write/u);
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain("node-version: '24'");
    expect(workflow).toContain('corepack install --global pnpm@10.33.4');
    expect(workflow).toContain('package-manager-cache: false');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).toContain('pnpm exec tsc --project tsconfig.vercel.json --noEmit');
    expect(workflow).toContain('pnpm verify:build');
    expect(workflow).toContain('pnpm verify:package');
  });

  it('bounds monthly npm and GitHub Actions updates', async () => {
    const root = join(import.meta.dirname, '..');
    const dependabot = await readFile(join(root, '.github', 'dependabot.yml'), 'utf8');

    expect(dependabot.match(/package-ecosystem:/gu)).toHaveLength(2);
    expect(dependabot).toContain('package-ecosystem: npm');
    expect(dependabot).toContain('package-ecosystem: github-actions');
    expect(dependabot.match(/interval: monthly/gu)).toHaveLength(2);
    expect(dependabot.match(/open-pull-requests-limit: 5/gu)).toHaveLength(2);
  });
});
