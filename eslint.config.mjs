import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Configuração dos pacotes compartilhados. apps/web tem configuração própria
// (eslint-config-next) e é analisado pelo seu script de lint.
const eslintConfig = defineConfig([
  globalIgnores([
    'ReaproveitaRecursos/**',
    'apps/**',
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
  ]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/ReaproveitaRecursos/**'],
              message: 'ReaproveitaRecursos é apenas referência; não importar código do domínio antigo.',
            },
          ],
        },
      ],
    },
  },
  {
    // Regras puras: sem validação, interface, armazenamento ou rede.
    files: ['packages/domain/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['zod', 'react', 'react-dom', 'next', 'dexie', 'zustand'],
          patterns: [
            { group: ['@louvorvisual/*'], message: 'O domínio não depende de outros pacotes do produto.' },
            { group: ['**/ReaproveitaRecursos/**'], message: 'Não importar código do domínio antigo.' },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
