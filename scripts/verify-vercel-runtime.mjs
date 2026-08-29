import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function emitDeployment(outputDirectory) {
  const result = spawnSync(process.execPath, [
    TSC,
    '--project', 'tsconfig.vercel.json',
    '--noEmit', 'false',
    '--allowImportingTsExtensions', 'false',
    '--rootDir', '.',
    '--outDir', outputDirectory,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout}${result.stderr}`.trim();
    throw new Error(`Vercel runtime emit failed${detail === '' ? '' : `:\n${detail}`}`);
  }
}

function responseCapture() {
  const headers = new Map();
  let body = '';

  return {
    res: {
      statusCode: 0,
      setHeader(name, value) {
        headers.set(name.toLowerCase(), String(value));
      },
      end(value = '') {
        body = String(value);
      },
    },
    result() {
      return { body, headers, status: this.res.statusCode };
    },
  };
}

async function invoke(handler, request) {
  const capture = responseCapture();
  await handler(request, capture.res);
  return capture.result();
}

function requireRenderedPage(name, result, expectedStatus) {
  if (result.status !== expectedStatus) {
    throw new Error(`${name} returned ${String(result.status)}, expected ${String(expectedStatus)}`);
  }
  if (!result.body.startsWith('<!doctype html>')) {
    throw new Error(`${name} did not render an HTML document`);
  }
}

/** Emit and invoke the same server-rendered module graph that Vercel loads. */
export async function verifyVercelRuntime() {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'wick-vercel-runtime-'));

  try {
    emitDeployment(outputDirectory);

    const route = (name) => pathToFileURL(join(outputDirectory, 'api', `${name}.js`)).href;
    const [{ default: landing }, { default: board }, { default: profile }] = await Promise.all([
      import(route('landing')),
      import(route('board')),
      import(route('profile')),
    ]);

    const landingResult = await invoke(landing, { method: 'GET', url: '/' });

    // Force the data-backed handlers through their rendered unavailable paths.
    // Empty configuration prevents this smoke check from making a network request.
    const previousUrl = process.env.SUPABASE_URL;
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    let boardResult;
    let profileResult;
    try {
      boardResult = await invoke(board, { method: 'GET', url: '/board' });
      profileResult = await invoke(profile, { method: 'GET', url: '/u/quiet-fern' });
    } finally {
      if (previousUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    }

    requireRenderedPage('landing', landingResult, 200);
    requireRenderedPage('board', boardResult, 503);
    requireRenderedPage('profile', profileResult, 503);

    return ['landing', 'board', 'profile'];
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  verifyVercelRuntime()
    .then((routes) => {
      process.stdout.write(`Verified Node server rendering: ${routes.join(', ')}.\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
