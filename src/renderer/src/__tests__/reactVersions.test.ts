import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('React package versions', () => {
  // React throws "Incompatible React versions" at startup - leaving a blank
  // window - unless react and react-dom are the exact same version. Catch a
  // partial dependency bump here instead of at launch.
  it('installs react and react-dom at exactly the same version', () => {
    const react = require('react/package.json') as { version: string };
    const reactDom = require('react-dom/package.json') as { version: string };
    expect(reactDom.version).toBe(react.version);
  });
});
