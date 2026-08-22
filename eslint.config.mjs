import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Lint configuration for the whole workspace.
 *
 * Two languages live here: the shared packages and the simulator are
 * TypeScript, the ten agents are CommonJS JavaScript. Rather than force one
 * into the other's config, each gets rules that make sense for it.
 *
 * The rule set is deliberately small and mostly about correctness. Style is
 * Prettier's job, and a linter that mostly complains about formatting trains
 * people to ignore it.
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/logs/**',
      '**/data/**',
      '**/coverage/**',
      '**/*.min.js',
    ],
  },

  js.configs.recommended,

  // ---- TypeScript packages -------------------------------------------
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['packages/**/*.ts'],
  })),
  {
    files: ['packages/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The Anthropic adapter loads its SDK lazily and untyped by design.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ---- CommonJS agents and tools --------------------------------------
  {
    files: ['agent*/**/*.js', 'tools/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // A catch binding that is deliberately ignored is common and fine -
          // `catch { }` is not always available where the error shape matters
          // for readability.
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Correctness rules that catch real defects rather than opinions.
      // `no-await-in-loop` is deliberately absent: sequential SNMP polling is
      // intentional here, and flagging it would train people to ignore output.
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'require-atomic-updates': 'warn',
      // no-return-await is deliberately NOT enabled. It is deprecated upstream
      // because `return await` inside a try block is meaningful - removing it
      // moves the rejection outside the catch. A rule that is wrong 28 times in
      // this codebase alone is a rule that teaches people to ignore the linter.

      // console.log bypasses the structured logger, so log lines from those
      // paths never reach a log aggregator. Warn rather than error: the
      // simulator and CLI output legitimately use it.
      'no-console': 'warn',
    },
  },

  // Tests and the simulator print to the console by design.
  {
    files: ['**/tests/**/*.js', '**/*.test.js', 'tools/router-sim/**/*.js'],
    rules: { 'no-console': 'off' },
  },

  prettier,
];
