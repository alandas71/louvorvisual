import { BRIDGE_GLOBAL, BRIDGE_VERSION, type HostPort, type HostResult } from '@louvorvisual/contracts';
import { HostClient } from './client';

export type HostConnection = { client: HostClient; info: HostResult<'host.info'> };

export type HostUnavailableReason =
  /** O bundle foi aberto fora do aplicativo e sem pedir o host simulado. */
  | 'no-host'
  /** O host fala outra versão da ponte. */
  | 'incompatible'
  | 'no-answer';

export class HostUnavailableError extends Error {
  constructor(readonly reason: HostUnavailableReason) {
    super(`Host indisponível: ${reason}`);
    this.name = 'HostUnavailableError';
  }
}

function nativePort(): HostPort | null {
  const candidate = (window as unknown as Record<string, unknown>)[BRIDGE_GLOBAL];
  return candidate && typeof (candidate as HostPort).postMessage === 'function' ? (candidate as HostPort) : null;
}

let connecting: Promise<HostConnection> | null = null;

/**
 * Liga o bundle ao host. No aparelho, o objeto injetado pelo aplicativo. Fora
 * dele, o host simulado — só em desenvolvimento ou com `?host=mock`, e nunca
 * quando existe um host de verdade: o simulado é carregado sob demanda e não
 * roda dentro do APK.
 */
export function connectHost(): Promise<HostConnection> {
  connecting ??= (async () => {
    let port = nativePort();
    if (!port) {
      const query = new URLSearchParams(window.location.search);
      if (query.get('host') !== 'mock' && process.env.NODE_ENV === 'production') throw new HostUnavailableError('no-host');
      const { createMockHost } = await import('./mock/mockHost');
      const mock = createMockHost(query);
      port = mock.port;
      (window as unknown as { __lvMock: unknown }).__lvMock = mock.controls;
    }
    const client = new HostClient(port);
    const info = await client.request('host.info', {}).catch(() => {
      throw new HostUnavailableError('no-answer');
    });
    if (info.bridgeVersion !== BRIDGE_VERSION) throw new HostUnavailableError('incompatible');
    return { client, info };
  })();
  connecting.catch(() => {
    connecting = null;
  });
  return connecting;
}
