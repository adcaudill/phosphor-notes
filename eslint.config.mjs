import { defineConfig } from 'eslint/config';
import tseslint from '@electron-toolkit/eslint-config-ts';
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier';
import eslintPluginReact from 'eslint-plugin-react';
import eslintPluginReactHooks from 'eslint-plugin-react-hooks';
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh';
import { createRequire } from 'node:module';

// eslint-plugin-react's `version: 'detect'` calls context.getFilename(), which
// ESLint 10 removed. Read the installed React version directly instead.
const reactVersion = createRequire(import.meta.url)('react/package.json').version;

export default defineConfig(
  // docs/ is the Jekyll site (built and deployed separately); coverage/ is generated.
  { ignores: ['**/node_modules', '**/dist', '**/out', 'coverage', 'docs'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: reactVersion
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      semi: ['error', 'always'],
      'prettier/prettier': ['error', { semi: true }]
    }
  },
  eslintConfigPrettier
);
