import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**', 'generated/**']),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // O Express identifica o tratador de erros pelos quatro parâmetros.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/ReaproveitaRecursos/**'], message: 'A referência não é uma dependência.' }],
      }],
    },
  },
]);
