// ESLint flat config. Three environments live in this repo: the extension runs
// in Chrome (browser + chrome.* globals), the host and tools run in Node, and
// the tests run in Node but stub chrome.* and load pages through jsdom.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.browsers/**', '.bench/**', 'docs/**', 'coverage/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      // `let x = []; try { x = read() } catch { return }` is the house pattern for
      // a read that may throw. The initial value is the documented fallback, so
      // the rule that flags it as unused is off.
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.webextensions } },
  },
];
