import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/ReaproveitaRecursos/**"],
              message: "ReaproveitaRecursos é apenas referência; não importar código do domínio antigo.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Gerados: service worker e relatórios do Playwright.
    "public/sw.js",
    // Copiado de node_modules: modelo e runtime da detecção de voz.
    "public/vad/**",
    "playwright-report/**",
    "test-results/**",
  ]),
  {
    files: ["src/sw/**/*.js"],
    languageOptions: { globals: { __LV_BUILD__: "readonly" } },
  },
]);

export default eslintConfig;
