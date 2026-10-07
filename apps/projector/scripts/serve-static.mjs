import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Servidor de arquivos para desenvolver e testar o bundle sem aparelho. Faz o
// que o WebViewAssetLoader faz: entrega dist/ sob /assets/ e mais nada. A CSP
// recusa qualquer outra origem, então um recurso remoto esquecido aparece como
// erro no teste, não como algo que "funciona com internet".
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.argv[2] ?? 3321);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};
const CSP = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    response.writeHead(302, { Location: '/assets/index.html?host=mock' }).end();
    return;
  }
  const path = decodeURIComponent(url.pathname);
  const file = path.startsWith('/assets/') ? resolve(dist, normalize(path.slice('/assets/'.length))) : null;
  const info = file && (file === dist || file.startsWith(dist + sep)) ? await stat(file).catch(() => null) : null;
  if (!file || !info?.isFile() || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
    return;
  }
  response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => console.log(`Bundle do projetor em http://127.0.0.1:${port}/assets/index.html?host=mock`));
