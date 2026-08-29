import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function fail(message) {
  throw new Error(`Release metadata failed: ${message}`);
}

export function validateReleaseVersion(tag, packageVersion) {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    fail('tag must have the exact form vX.Y.Z with no leading zeroes');
  }
  if (typeof packageVersion !== 'string' || !VERSION_PATTERN.test(packageVersion)) {
    fail('package.json version must have the exact form X.Y.Z with no leading zeroes');
  }
  if (tag !== `v${packageVersion}`) {
    fail(`requested tag ${JSON.stringify(tag)} does not match package.json version ${JSON.stringify(packageVersion)}`);
  }
  return packageVersion;
}

export function extractReleaseNotes(changelog, version) {
  if (typeof changelog !== 'string') fail('CHANGELOG.md must be text');
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) fail('release version is invalid');

  const normalized = changelog.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const headingPattern = /^## \[([^\]\n]+)\](?: - \d{4}-\d{2}-\d{2})?[ \t]*$/gmu;
  const matches = [...normalized.matchAll(headingPattern)].filter((match) => match[1] === version);
  if (matches.length === 0) fail(`CHANGELOG.md has no exact section for ${version}`);
  if (matches.length > 1) fail(`CHANGELOG.md has more than one section for ${version}`);

  const heading = matches[0];
  if (heading.index === undefined) fail('could not locate the changelog section');
  const contentStart = heading.index + heading[0].length;
  const nextHeading = /^## /gmu;
  nextHeading.lastIndex = contentStart;
  const boundary = nextHeading.exec(normalized);
  const notes = normalized.slice(contentStart, boundary?.index ?? normalized.length).trim();
  if (notes.length === 0) fail(`CHANGELOG.md section for ${version} is empty`);
  return `${notes}\n`;
}

async function readPackageVersion(packagePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    fail('could not read valid package.json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('package.json must contain an object');
  }
  return parsed.version;
}

function assertDistinctOutputs(paths) {
  const resolved = paths.map((path) => resolve(path));
  if (new Set(resolved).size !== resolved.length) fail('input and output paths must be distinct');
}

export async function prepareReleaseMetadata(options) {
  if (options === null || typeof options !== 'object') fail('options are required');
  const packagePath = resolve(options.packagePath ?? resolve(ROOT, 'package.json'));
  const changelogPath = resolve(options.changelogPath ?? resolve(ROOT, 'CHANGELOG.md'));
  const archivePath = resolve(options.archivePath ?? '');
  const notesPath = resolve(options.notesPath ?? '');
  const checksumPath = resolve(options.checksumPath ?? '');
  if (!options.archivePath || !options.notesPath || !options.checksumPath) {
    fail('archive, notes, and checksum paths are required');
  }
  assertDistinctOutputs([packagePath, changelogPath, archivePath, notesPath, checksumPath]);

  const packageVersion = await readPackageVersion(packagePath);
  const version = validateReleaseVersion(options.tag, packageVersion);
  const expectedArchiveName = `wick-${version}.zip`;
  if (basename(archivePath) !== expectedArchiveName) {
    fail(`archive filename must be ${expectedArchiveName}`);
  }

  let changelog;
  let archive;
  try {
    [changelog, archive] = await Promise.all([
      readFile(changelogPath, 'utf8'),
      readFile(archivePath),
    ]);
  } catch {
    fail('could not read CHANGELOG.md and the release archive');
  }
  const notes = extractReleaseNotes(changelog, version);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const checksum = `${sha256}  ${expectedArchiveName}\n`;

  await Promise.all([mkdir(dirname(notesPath), { recursive: true }), mkdir(dirname(checksumPath), { recursive: true })]);
  await Promise.all([writeFile(notesPath, notes, { encoding: 'utf8', flag: 'wx' }), writeFile(checksumPath, checksum, { encoding: 'utf8', flag: 'wx' })]);
  return { version, tag: options.tag, archivePath, notesPath, checksumPath, sha256 };
}

function parseArguments(arguments_) {
  const values = new Map();
  const allowed = new Set(['--tag', '--package', '--changelog', '--archive', '--notes-file', '--checksum-file']);
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith('--') || values.has(name)) {
      fail('expected unique --tag, --archive, --notes-file, and --checksum-file arguments');
    }
    values.set(name, value);
  }
  return {
    tag: values.get('--tag'),
    packagePath: values.get('--package'),
    changelogPath: values.get('--changelog'),
    archivePath: values.get('--archive'),
    notesPath: values.get('--notes-file'),
    checksumPath: values.get('--checksum-file'),
  };
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  prepareReleaseMetadata(parseArguments(process.argv.slice(2)))
    .then(({ tag }) => console.log(`Prepared release metadata for ${tag}.`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Release metadata failed');
      process.exitCode = 1;
    });
}
