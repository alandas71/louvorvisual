import { ReceiverRelay, RelayError } from '@/receiver/relay';
import type { ChannelMessage } from '@louvorvisual/presentation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const shared = globalThis as typeof globalThis & { lvReceiverRelay?: ReceiverRelay };
const relay = shared.lvReceiverRelay ??= new ReceiverRelay();
const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function publicOrigin(request: Request) {
  const url = new URL(request.url);
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.slice(0, -1);
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host') || url.host;
  return `${protocol}://${host}`;
}
function credentials(request: Request) {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  return { id, token };
}
async function body(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new RelayError(400, 'Formato inválido.');
  const reader = request.body?.getReader();
  if (!reader) throw new RelayError(400, 'Dados obrigatórios.');
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 128 * 1024) { await reader.cancel(); throw new RelayError(413, 'Mensagem grande demais.'); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; } catch { throw new RelayError(400, 'Dados inválidos.'); }
}
async function handle(request: Request) {
  try {
    const origin = request.headers.get('origin');
    if ((origin && origin !== publicOrigin(request)) || request.headers.get('sec-fetch-site') === 'cross-site') throw new RelayError(403, 'Origem não permitida.');
    const { id, token } = credentials(request);
    if (request.method === 'GET') return response(relay.read(id, token));
    if (request.method === 'DELETE') { relay.close(id, token); return response({ closed: true }); }
    const input = await body(request);
    if (input.action === 'create' || input.action === 'pair') {
      relay.limit(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local');
      return response(input.action === 'create' ? relay.create() : relay.pair(typeof input.code === 'string' ? input.code : ''));
    }
    if (input.action === 'publish') { relay.publish(id, token, input.message as ChannelMessage); return response({ accepted: true }); }
    throw new RelayError(400, 'Ação inválida.');
  } catch (error) { return response({ error: error instanceof RelayError ? error.message : 'Não foi possível conectar ao receptor.' }, error instanceof RelayError ? error.status : 500); }
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
