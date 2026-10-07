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
          // O bundle embarcado não tem servidor: nada do Next que dependa de um.
          paths: [
            { name: "next/headers", message: "Sem servidor no aparelho." },
            { name: "next/server", message: "Sem servidor no aparelho." },
            { name: "next/cache", message: "Sem servidor no aparelho." },
            { name: "next/font/google", message: "Fontes só do pacote local." },
            { name: "next/image", message: "Sem otimização de imagem no aparelho." },
            { name: "dexie", message: "O armazenamento é do host; use a ponte." },
          ],
          patterns: [
            { group: ["**/ReaproveitaRecursos/**"], message: "ReaproveitaRecursos é apenas referência." },
            { group: ["**/apps/web/**", "@louvorvisual/web"], message: "O projetor não depende do shell web." },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "A rede é do host; use a ponte." },
        { name: "localStorage", message: "O WebView do host não tem DOM storage; use a ponte." },
        { name: "indexedDB", message: "O armazenamento é do host; use a ponte." },
        { name: "XMLHttpRequest", message: "A rede é do host; use a ponte." },
        { name: "WebSocket", message: "A rede é do host; use a ponte." },
      ],
    },
  },
  {
    // O host simulado roda só no navegador de desenvolvimento e pode guardar estado nele;
    // os testes consultam o armazenamento justamente para provar que o bundle não o usa.
    files: ["src/host/mock/**", "e2e/**"],
    rules: { "no-restricted-globals": "off" },
  },
  globalIgnores([".next/**", "out/**", "dist/**", "public/fonts/**", "next-env.d.ts", "playwright-report/**", "test-results/**"]),
]);

export default eslintConfig;
