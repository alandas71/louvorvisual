import { PRESENTATION_CHANNEL, type ChannelMessage } from '@louvorvisual/presentation';
import { openRemoteController } from '@/receiver/client';

export type LocalChannel = {
  post(message: ChannelMessage): void;
  close(): void;
};

/**
 * Canal entre janelas locais, com saída pela rede quando um receptor está pareado.
 * Envia estado visual e confirmações; não transfere a biblioteca nem áudio.
 */
export function openLocalChannel(onMessage: (message: unknown) => void): LocalChannel | null {
  const remote = openRemoteController(onMessage);
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(PRESENTATION_CHANNEL);
  if (!channel && !remote) return null;
  if (channel) channel.onmessage = (event) => onMessage(event.data);
  return {
    post: (message) => { channel?.postMessage(message); remote?.post(message); },
    close: () => { channel?.close(); remote?.close(); },
  };
}
