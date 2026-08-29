import { describe, expect, it } from 'vitest';

const verifier = await import(
  new URL('../scripts/verify-vercel-runtime.mjs', import.meta.url).href
) as {
  verifyVercelRuntime(): Promise<string[]>;
};

describe('Vercel Node runtime', () => {
  it('loads and renders every public route through emitted native ESM', async () => {
    await expect(verifier.verifyVercelRuntime()).resolves.toEqual([
      'landing',
      'board',
      'profile',
    ]);
  });
});
