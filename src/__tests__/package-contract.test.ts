import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as {
  version: string;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('package auth compatibility contract', () => {
  it('accepts the tinyland-auth 0.3 and 1.0 lines while retaining 0.2 consumers', () => {
    expect(packageJson.version).toBe('0.1.3');
    expect(packageJson.peerDependencies?.['@tummycrypt/tinyland-auth']).toBe(
      '^0.2.0 || ^0.3.0 || ^1.0.0',
    );
    expect(packageJson.devDependencies?.['@tummycrypt/tinyland-auth']).toBe('^0.3.3');
  });
});
