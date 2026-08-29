import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const releaseModule = await import(new URL('../scripts/release-notes.mjs', import.meta.url).href) as {
  validateReleaseVersion(tag: unknown, packageVersion: unknown): string;
  extractReleaseNotes(changelog: unknown, version: string): string;
  prepareReleaseMetadata(options: {
    tag: string;
    packagePath: string;
    changelogPath: string;
    archivePath: string;
    notesPath: string;
    checksumPath: string;
  }): Promise<{ sha256: string }>;
};
const { extractReleaseNotes, prepareReleaseMetadata, validateReleaseVersion } = releaseModule;
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wick-release-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('release version and changelog validation', () => {
  it('requires the requested stable tag to exactly match package.json version', () => {
    expect(validateReleaseVersion('v1.2.3', '1.2.3')).toBe('1.2.3');
    expect(() => validateReleaseVersion('v1.2.4', '1.2.3')).toThrow(/does not match/);
    expect(() => validateReleaseVersion(undefined, '1.2.3')).toThrow(/exact form/);
    expect(() => validateReleaseVersion('1.2.3', '1.2.3')).toThrow(/exact form/);
    expect(() => validateReleaseVersion('v01.2.3', '01.2.3')).toThrow(/exact form/);
  });

  it('extracts only the exact requested version section', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- Future work.',
      '',
      '## [1.2.3] - 2026-08-29',
      '',
      '### Added',
      '',
      '- Released behavior.',
      '',
      '## [1.2.2]',
      '',
      '- Older behavior.',
      '',
    ].join('\n');
    expect(extractReleaseNotes(changelog, '1.2.3')).toBe('### Added\n\n- Released behavior.\n');
  });

  it('rejects missing, empty, and duplicate exact version sections', () => {
    expect(() => extractReleaseNotes('## [Unreleased]\n\n- Later.\n', '1.2.3')).toThrow(/no exact section/);
    expect(() => extractReleaseNotes('## [1.2.3]\n\n## [1.2.2]\n\n- Older.\n', '1.2.3')).toThrow(/empty/);
    expect(() => extractReleaseNotes('## [1.2.3]\n\n- One.\n\n## [1.2.3]\n\n- Two.\n', '1.2.3')).toThrow(/more than one/);
  });

  it('writes exact notes and a SHA-256 checksum without echoing changelog content', async () => {
    const root = await temporaryDirectory();
    const artifacts = join(root, 'artifacts');
    const packagePath = join(root, 'package.json');
    const changelogPath = join(root, 'CHANGELOG.md');
    const archivePath = join(artifacts, 'wick-1.2.3.zip');
    const notesPath = join(artifacts, 'release-notes.md');
    const checksumPath = join(artifacts, 'wick-1.2.3.zip.sha256');
    const archive = Buffer.from('deterministic archive fixture');
    const unsafeForLogs = '::error title=injected::must stay in the notes file';
    await mkdir(artifacts);
    await writeFile(packagePath, JSON.stringify({ version: '1.2.3' }));
    await writeFile(changelogPath, `# Changelog\n\n## [1.2.3]\n\n${unsafeForLogs}\nvalue<<EOF\n`);
    await writeFile(archivePath, archive);

    const scriptPath = join(import.meta.dirname, '..', 'scripts', 'release-notes.mjs');
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--tag', 'v1.2.3',
      '--package', packagePath,
      '--changelog', changelogPath,
      '--archive', archivePath,
      '--notes-file', notesPath,
      '--checksum-file', checksumPath,
    ], { encoding: 'utf8' });

    const sha256 = createHash('sha256').update(archive).digest('hex');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('Prepared release metadata for v1.2.3.\n');
    expect(result.stdout).not.toContain(unsafeForLogs);
    expect(await readFile(notesPath, 'utf8')).toBe(`${unsafeForLogs}\nvalue<<EOF\n`);
    expect(await readFile(checksumPath, 'utf8')).toBe(`${sha256}  wick-1.2.3.zip\n`);
  });

  it('refuses an archive whose filename does not match the validated version', async () => {
    const root = await temporaryDirectory();
    const packagePath = join(root, 'package.json');
    const changelogPath = join(root, 'CHANGELOG.md');
    const archivePath = join(root, 'wick-9.9.9.zip');
    await writeFile(packagePath, JSON.stringify({ version: '1.2.3' }));
    await writeFile(changelogPath, '## [1.2.3]\n\n- Notes.\n');
    await writeFile(archivePath, 'archive');
    await expect(prepareReleaseMetadata({
      tag: 'v1.2.3', packagePath, changelogPath, archivePath,
      notesPath: join(root, 'notes.md'), checksumPath: join(root, 'checksum.txt'),
    })).rejects.toThrow(/archive filename/);
  });
});

describe('draft release workflow', () => {
  it('is owner-dispatched, protected, least-privilege, pinned, and draft-only', async () => {
    const workflow = await readFile(join(import.meta.dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
    const actionPins = [...workflow.matchAll(/uses: actions\/[^@\s]+@([a-f0-9]{40})$/gmu)];

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('if: github.actor == github.repository_owner');
    expect(workflow).toContain('environment:\n      name: release');
    expect(workflow).toMatch(/^permissions:\n  contents: read$/mu);
    expect(workflow.match(/contents: write/gu)).toHaveLength(1);
    expect(actionPins).toHaveLength(4);
    expect(workflow).toContain('# actions/checkout v7.0.1');
    expect(workflow).toContain('# actions/setup-node v7.0.0');
    expect(workflow).toContain('# actions/upload-artifact v4.6.2');
    expect(workflow).toContain('# actions/download-artifact v8.0.1');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('ref: refs/tags/${{ inputs.tag }}');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).toContain('pnpm test');
    expect(workflow).toContain('pnpm typecheck');
    expect(workflow).toContain('pnpm exec tsc --project tsconfig.vercel.json --noEmit');
    expect(workflow).toContain('pnpm verify:vercel-runtime');
    expect(workflow).toContain('pnpm verify:build');
    expect(workflow).toContain('pnpm verify:package');
    expect(workflow).toContain('gh release create "$RELEASE_TAG"');
    expect(workflow).toContain('--draft');
    expect(workflow).toContain('--verify-tag');
    expect(workflow).not.toMatch(/(?:web store|deploy|gh release (?:edit|upload).*--draft=false|git (?:tag|push)|npm publish)/iu);
    expect(workflow).not.toMatch(/uses: (?!actions\/)/u);
  });
});
