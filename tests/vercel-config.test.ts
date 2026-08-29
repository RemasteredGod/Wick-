import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url);

async function text(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await text(path)) as Record<string, unknown>;
}

describe('Vercel build contract', () => {
  it('installs development type packages on every pnpm install path', async () => {
    const npmrc = await text('.npmrc');
    const vercel = await json('vercel.json');

    expect(npmrc).toMatch(/^production=false$/m);
    expect(vercel['installCommand']).toBe(
      'pnpm install --prod=false --frozen-lockfile',
    );
  });

  it('keeps every ambient type required by native API transpilation installed', async () => {
    const rootConfig = await json('tsconfig.json');
    const compilerOptions = rootConfig['compilerOptions'] as Record<string, unknown>;
    const deploymentConfig = await text('tsconfig.vercel.json');

    expect(compilerOptions['types']).toEqual(['chrome', 'node', 'vite/client']);
    expect(deploymentConfig).toContain('"types": ["node"]');
    expect(deploymentConfig).not.toContain('"chrome"');
    expect(deploymentConfig).not.toContain('"vite/client"');
  });

  it('pins the same Vercel-supported Node and pnpm versions everywhere', async () => {
    const pkg = await json('package.json');
    const engines = pkg['engines'] as Record<string, unknown>;
    const workflows = await Promise.all([
      text('.github/workflows/ci.yml'),
      text('.github/workflows/release.yml'),
    ]);

    expect(engines['node']).toBe('24.x');
    expect(pkg['packageManager']).toBe('pnpm@10.33.4');
    expect((pkg['scripts'] as Record<string, unknown>)['build']).toBe(
      'node scripts/generate-icons.mjs && tsc --noEmit && vite build',
    );
    for (const workflow of workflows) {
      expect(workflow).toContain("node-version: '24'");
      expect(workflow).toContain('corepack enable pnpm');
      expect(workflow).toContain('corepack install --global pnpm@10.33.4');
      expect(workflow).not.toContain('pnpm@11.23.0');
    }
  });
});
