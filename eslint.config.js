import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import importPlugin from 'eslint-plugin-import';
import unicorn from 'eslint-plugin-unicorn';
import checkFile from 'eslint-plugin-check-file';

export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ignores: [
      // Build outputs
      '**/dist/**',
      '**/coverage/**',
      // Dependencies
      '**/node_modules/**',
      // Config files
      '*.config.js',
      '*.config.mjs',
      '*.config.ts',
      // Logs
      '**/*.log',
      '**/npm-debug.log*',
      '**/yarn-debug.log*',
      '**/yarn-error.log*',
    ],
  },
  {
    // Base config for all TypeScript files
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      import: importPlugin,
      unicorn,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
      },
    },
    rules: {
      // Enforce naming conventions
      '@typescript-eslint/naming-convention': [
        'error',
        // Types and Interfaces: Must be PascalCase, no I prefix (except IO, IP, ID), uppercase acronyms (ID not Id, IP not Ip, etc.)
        {
          selector: 'typeLike',
          format: ['PascalCase'],
          custom: {
            // Reject: I-prefix (but not IO, IP, ID) OR lowercase acronyms anywhere (Id, Ip, Api, etc.)
            regex:
              '^I(?!O|P|D)[A-Z]|(^|[A-Z][a-z]+)(Id|Ip|Io|Ui|Api|Url|Html|Css|Json|Xml|Svg|Pdf|Uri|Uuid|Jwt|Sql|Http|Https|Ws|Wss|Sse|Db|Os|Cpu|Gpu|Ram|Usb|Ms)([A-Z]|$)',
            match: false,
          },
        },
        // Classes: PascalCase with uppercase acronyms (ID not Id, IP not Ip, etc.)
        {
          selector: 'class',
          format: ['PascalCase'],
          custom: {
            // Reject: lowercase acronyms anywhere (Id, Ip, Api, etc.)
            regex:
              '(^|[A-Z][a-z]+)(Id|Ip|Io|Ui|Api|Url|Html|Css|Json|Xml|Svg|Pdf|Uri|Uuid|Jwt|Sql|Http|Https|Ws|Wss|Sse|Db|Os|Cpu|Gpu|Ram|Usb|Ms)([A-Z]|$)',
            match: false,
          },
        },
        // Quoted properties: Allow any format (for config files like '@': '...', 'some-key': '...', etc.)
        {
          selector: 'property',
          modifiers: ['requiresQuotes'],
          format: null,
        },
        // Properties: Allow snake_case for API compatibility (interfaces/types)
        {
          selector: 'property',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase', 'snake_case'],
          custom: {
            // Reject: lowercase acronyms in camelCase/PascalCase (but allow snake_case like user_id)
            // Matches: userId, getUserId but NOT user_id, USER_ID, or PascalCase like ComponentType
            regex:
              '[a-z](?!_)(Id|Ip|Io|Ui|Api|Url|Html|Css|Json|Xml|Svg|Pdf|Uri|Uuid|Jwt|Sql|Http|Https|Ws|Wss|Sse|Db|Os|Cpu|Gpu|Ram|Usb|Ms)([A-Z_]|$)',
            match: false,
          },
          leadingUnderscore: 'allow',
        },
        // Variables: camelCase, UPPER_CASE, or PascalCase
        // Note: PascalCase is allowed for React patterns like const ThemeContext = createContext(...)
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          custom: {
            // Reject: lowercase acronyms in camelCase/PascalCase (but allow PascalCase variables)
            // Matches: userId, getUserId but NOT userID, UserID, UPPER_CASE
            regex:
              '[a-z](Id|Ip|Io|Ui|Api|Url|Html|Css|Json|Xml|Svg|Pdf|Uri|Uuid|Jwt|Sql|Http|Https|Ws|Wss|Sse|Db|Os|Cpu|Gpu|Ram|Usb|Ms)([A-Z]|$)',
            match: false,
          },
          leadingUnderscore: 'allow',
        },
        // Parameters/methods/functions: camelCase or PascalCase with uppercase acronyms
        {
          selector: ['parameter', 'method', 'function'],
          format: ['camelCase', 'PascalCase'],
          custom: {
            // Reject: lowercase acronyms after lowercase letter (userId, getUserId, etc.)
            regex:
              '[a-z](Id|Ip|Io|Ui|Api|Url|Html|Css|Json|Xml|Svg|Pdf|Uri|Uuid|Jwt|Sql|Http|Https|Ws|Wss|Sse|Db|Os|Cpu|Gpu|Ram|Usb|Ms)([A-Z]|$)',
            match: false,
          },
          leadingUnderscore: 'allow',
        },
        // Boolean variables with prefix requirement
        {
          selector: 'variable',
          types: ['boolean'],
          format: ['PascalCase', 'UPPER_CASE'],
          prefix: [
            'is',
            'has',
            'should',
            'can',
            'did',
            'will',
            'was',
            'does',
            'enable',
            'allow',
            'use',
            'show',
          ],
          // Enforce acronyms stay uppercase
          custom: {
            regex:
              '(Id|Ip|Io|Ui|Api|Url|Html|Css|Json|Xml|Svg|Pdf|Uri|Uuid|Jwt|Sql|Http|Https|Ws|Wss|Sse|Db|Os|Cpu|Gpu|Ram|Usb|Ms)([A-Z]|$)',
            match: false,
          },
          // Allow UPPER_CASE without prefix for constants
          filter: {
            regex: '^[A-Z][A-Z0-9_]*$',
            match: false,
          },
        },
        {
          // Allow uppercase constants without prefix requirement
          selector: 'variable',
          types: ['boolean'],
          format: ['UPPER_CASE'],
        },
        {
          selector: 'parameter',
          types: ['boolean'],
          format: ['PascalCase'],
          prefix: [
            'is',
            'has',
            'should',
            'can',
            'did',
            'will',
            'was',
            'does',
            'enable',
            'allow',
            'use',
            'show',
          ],
          // Enforce acronyms stay uppercase
          custom: {
            regex:
              '(Id|Ip|Io|Ui|Api|Url|Html|Css|Json|Xml|Svg|Pdf|Uri|Uuid|Jwt|Sql|Http|Https|Ws|Wss|Sse|Db|Os|Cpu|Gpu|Ram|Usb|Ms)([A-Z]|$)',
            match: false,
          },
          // Allow unused parameters prefixed with _ to bypass the naming requirement
          filter: {
            regex: '^_',
            match: false,
          },
        },
      ],
      // Detect unused variables
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      // TypeScript specific rules
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Enforce consistent type imports and prevent inline imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          disallowTypeAnnotations: true, // Prevent inline imports like import('...').Type
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      // General code quality rules
      'no-console': 'warn',
      'no-debugger': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      // Import/export rules
      'no-duplicate-imports': 'off',
      'import/no-duplicates': 'error',
      'import/first': 'error',
      // Enforce case-sensitive import paths (prevents macOS/Windows vs Linux issues)
      'import/no-unresolved': [
        'error',
        {
          caseSensitive: true,
          // Ignore runtime-provided built-in modules
          ignore: ['^bun:', '^electron$'],
        },
      ],
      // Forbid importing deprecated modules/exports
      'import/no-deprecated': 'warn',
      // Forbid importing packages not listed in dependencies
      'import/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: [
            // *.test.ts naming convention is preferred
            // Both *.test.ts and *.spec.ts are supported for compatibility
            '**/*.test.ts',
            '**/*.test.tsx',
            '**/*.spec.ts',
            '**/*.spec.tsx',
            '**/vite.config.ts',
            '**/vitest.config.ts',
            'scripts/**/*.ts',
          ],
        },
      ],
      // Forbid mutable exports (helps with predictable module behavior)
      'import/no-mutable-exports': 'error',
      // Best practices
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'import/newline-after-import': 'error',
      // Prevent function declarations inside blocks
      'no-inner-declarations': 'error',
      // Limit callback nesting to prevent callback hell
      'max-nested-callbacks': ['error', 3],
      // Class member accessibility - require explicit public/private/protected
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {
          accessibility: 'explicit',
          overrides: {
            constructors: 'no-public', // Don't require public on constructors
          },
        },
      ],
      // Class member ordering - public first, then protected, then private
      '@typescript-eslint/member-ordering': [
        'error',
        {
          default: [
            'public-field',
            'protected-field',
            'private-field',
            'constructor',
            'public-method',
            'protected-method',
            'private-method',
          ],
        },
      ],
      // Enforce filename conventions - kebab-case for regular TS files
      'unicorn/filename-case': [
        'error',
        {
          case: 'kebabCase',
        },
      ],
      // Enforce using 'new' for builtins (except String, Number, Boolean, Symbol, BigInt)
      'unicorn/new-for-builtins': 'error',
      // Enforce Buffer.from() and Buffer.alloc() instead of deprecated new Buffer()
      'unicorn/no-new-buffer': 'error',
      // Enforce throwing TypeError in type checking conditions
      'unicorn/prefer-type-error': 'error',
      // Enforce consistent parameter name in catch clauses
      'unicorn/catch-error-name': 'error',
      // Prefer Date.now() over new Date().getTime()
      'unicorn/prefer-date-now': 'error',
      // Prefer new Date(date) over new Date(date.getTime())
      'unicorn/consistent-date-clone': 'error',
      // Prefer for...of over array.forEach()
      'unicorn/no-array-for-each': 'error',
      // Prefer for...of over traditional for loops
      'unicorn/no-for-loop': 'error',
      // Disallow named usage of default import/export
      'unicorn/no-named-default': 'error',
      // Prefer export...from when re-exporting
      'unicorn/prefer-export-from': 'error',
      // Disallow direct use of document.cookie (prefer helper functions/Cookie Store API)
      'unicorn/no-document-cookie': 'error',
      // Enforce Unicode escapes over hex escapes for better readability
      'unicorn/no-hex-escape': 'error',
      // Disallow assigning 'this' to a variable (use arrow functions instead)
      'unicorn/no-this-assignment': 'error',
      // Disallow unreadable IIFEs
      'unicorn/no-unreadable-iife': 'error',
      // Prefer .includes() over .indexOf() for checking existence
      'unicorn/prefer-includes': 'error',
      // Prefer Math.trunc() over bitwise operations for truncation
      'unicorn/prefer-math-trunc': 'error',
    },
  },
  {
    // React/JSX specific config for TSX files
    files: ['**/*.tsx'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // React-specific rules
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',
      'react/react-in-jsx-scope': 'off', // Not needed for React 17+
      // React Hooks rules (recommended config)
      ...reactHooks.configs.recommended.rules,
      // JSX Accessibility rules
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  {
    // React components: enforce PascalCase for TSX files
    files: ['**/*.tsx'],
    rules: {
      'unicorn/filename-case': [
        'error',
        {
          case: 'pascalCase',
        },
      ],
    },
  },
  {
    // React/JSX specific config for JSX files
    files: ['**/*.jsx'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // React-specific rules
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',
      'react/react-in-jsx-scope': 'off', // Not needed for React 17+
      // React Hooks rules (recommended config)
      ...reactHooks.configs.recommended.rules,
      // JSX Accessibility rules
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  {
    // Warn about *.spec.ts files - prefer *.test.ts instead
    files: ['**/*.spec.ts', '**/*.spec.tsx'],
    plugins: {
      'check-file': checkFile,
    },
    rules: {
      'check-file/filename-blocklist': [
        'warn',
        {
          '**/*.spec.ts': '*.test.ts',
          '**/*.spec.tsx': '*.test.tsx',
        },
      ],
    },
  },
  {
    // Test files: allow console and any for mocking
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      'max-nested-callbacks': 'off', // Test frameworks naturally have deep nesting
    },
  },
  {
    // Scripts: allow console for CLI output
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Disable type-checked rules for JavaScript files
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.js', '**/*.jsx'],
  },
];
