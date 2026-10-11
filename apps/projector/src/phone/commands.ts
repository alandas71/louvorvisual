import type { PhoneCommand, PhoneCommandEvent } from '@louvorvisual/contracts';
import type { OperatorCommand } from '@louvorvisual/presentation';
import type { PresentationRequest } from '../app-context';
import type { HostClient } from '../host/client';

export async function phoneSelection(host: HostClient, event: PhoneCommandEvent): Promise<PresentationRequest> {
  const command = event.command;
  if (command.type !== 'select') throw new Error('Escolha um louvor.');
  const queue = command.setlistId ? (await host.request('library.getSetlist', { setlistId: command.setlistId })).items : [];
  if (command.setlistId && !queue.some(item => item.itemId === command.itemId && item.arrangementId === command.arrangementId)) throw new Error('Este louvor não pertence ao repertório.');
  if (!command.setlistId && command.itemId) throw new Error('Repertório inválido.');
  return { kind: 'start', remote: true, selectionId: event.id, arrangementId: command.arrangementId, context: { setlistId: command.setlistId, itemId: command.itemId }, queue };
}

export function phoneOperatorCommand(command: PhoneCommand): OperatorCommand | null {
  switch (command.type) {
    case 'start': case 'next': case 'previous': case 'toggle': return { type: command.type };
    case 'black': return { type: 'setVisualMode', visualMode: 'black' };
    case 'normal': return { type: 'setVisualMode', visualMode: 'normal' };
    default: return null;
  }
}

export function acknowledgePhone(host: HostClient, id: string, ok: boolean, message = ''): Promise<unknown> {
  return host.request('phone.ack', { id, ok, message: message.slice(0, 1000) }).catch(() => undefined);
}
