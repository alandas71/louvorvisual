import { AUDIO_CHUNK_BYTES, ReceiverRelay, RelayError, type ReceiverAudioStatus, type RelayAudioState } from '@/receiver/relay';
import type { ChannelMessage } from '@louvorvisual/presentation';
import { join } from 'node:path';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const shared = globalThis as typeof globalThis & { lvReceiverRelay?: ReceiverRelay };
// As faixas enviadas ao projetor ficam em disco, fora do build: um deploy não obriga a reenviá-las.
const relay = shared.lvReceiverRelay ??= new ReceiverRelay(undefined, process.env.LV_RECEIVER_AUDIO_DIR || join(process.cwd(), '.receiver-audio'));
const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
/** A leitura em espera fica abaixo dos prazos comuns de proxy (60 s) e do cliente. */
const WAIT_MS = 10_000;
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
async function bytes(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new RelayError(400, 'Dados obrigatórios.');
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new RelayError(413, 'Mensagem grande demais.'); } chunks.push(value); }
  return Buffer.concat(chunks);
}
async function body(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new RelayError(400, 'Formato inválido.');
  try { return JSON.parse((await bytes(request, 128 * 1024)).toString()) as Record<string, unknown>; } catch (error) { if (error instanceof RelayError) throw error; throw new RelayError(400, 'Dados inválidos.'); }
}
async function handle(request: Request) {
  try {
    const origin = request.headers.get('origin');
    if ((origin && origin !== publicOrigin(request)) || request.headers.get('sec-fetch-site') === 'cross-site') throw new RelayError(403, 'Origem não permitida.');
    const { id, token } = credentials(request);
    const query = new URL(request.url).searchParams;
    if (request.method === 'GET') {
      const audio = query.get('audio');
      if (audio) {
        const file = relay.getAudio(id, token, audio);
        return new Response(new Uint8Array(file.bytes), { headers: { 'Content-Type': file.mime, 'Content-Length': String(file.bytes.byteLength), 'Cache-Control': 'no-store' } });
      }
      const wait = query.get('wait');
      return response(wait === null ? relay.read(id, token) : await relay.wait(id, token, Number(wait), WAIT_MS));
    }
    if (request.method === 'DELETE') { relay.close(id, token); return response({ closed: true }); }
    if (request.method === 'PUT') {
      const file = { sha256: query.get('sha') ?? '', mime: request.headers.get('content-type') ?? '', total: Number(query.get('total')), offset: Number(query.get('offset')) };
      return response(relay.putAudio(id, token, file, await bytes(request, AUDIO_CHUNK_BYTES * 2)));
    }
    const input = await body(request);
    if (input.action === 'create' || input.action === 'pair') {
      relay.limit(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local');
      return response(input.action === 'create' ? relay.create() : relay.pair(typeof input.code === 'string' ? input.code : ''));
    }
    if (input.action === 'publish') { relay.publish(id, token, input.message as ChannelMessage); return response({ accepted: true }); }
    if (input.action === 'audio') return response(relay.setAudio(id, token, (input.state ?? null) as RelayAudioState | null, Number(input.latencyMs)));
    if (input.action === 'audio-status') { relay.setAudioStatus(id, token, String(input.sha256), input.status as ReceiverAudioStatus); return response({ accepted: true }); }
    throw new RelayError(400, 'Ação inválida.');
  } catch (error) { return response({ error: error instanceof RelayError ? error.message : 'Não foi possível conectar ao receptor.' }, error instanceof RelayError ? error.status : 500); }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
