import { PRESENTATION_CHANNEL, type ChannelMessage } from '@louvorvisual/presentation';

export type LocalChannel = {
  post(message: ChannelMessage): void;
  close(): void;
};

/**
 * Canal local entre janelas da mesma origem. Não leva a biblioteca, só estado
 * visual e comandos; não conecta computadores diferentes.
 */
export function openLocalChannel(onMessage: (message: unknown) => void): LocalChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(PRESENTATION_CHANNEL);
  channel.onmessage = (event) => onMessage(event.data);
  return {
    post: (message) => channel.postMessage(message),
    close: () => channel.close(),
  };
}
