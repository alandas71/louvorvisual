import { describe, expect, it, vi } from 'vitest';
import { phoneCommandSchema, phonePresentationSchema } from '@louvorvisual/contracts';
import type { HostClient } from '../host/client';
import { phoneOperatorCommand, phoneSelection } from './commands';
const arrangementId = '11111111-1111-4111-8111-111111111111';
const setlistId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const id = '44444444-4444-4444-8444-444444444444';

describe('controle pelo celular', () => {
  it('mantém o repertório e a posição para troca de louvores', async () => {
    const queue = [{ itemId, arrangementId, title: 'Louvor' }];
    const request = vi.fn(async () => ({ items: queue }));
    const host = { request } as unknown as HostClient;
    expect(await phoneSelection(host, { id, command: { type: 'select', arrangementId, setlistId, itemId } })).toEqual({kind:'start', remote:true, selectionId:id, arrangementId, context:{setlistId,itemId}, queue});
    expect(request).toHaveBeenCalledWith('library.getSetlist', {setlistId});
    await expect(phoneSelection(host, { id, command: { type:'select', arrangementId, setlistId, itemId:id } })).rejects.toThrow('não pertence');
  });
  it('recusa comandos arbitrários e controle sem sessão identificada', () => {
    expect(phoneCommandSchema.safeParse({type:'next'}).success).toBe(false);
    expect(phoneCommandSchema.safeParse({type:'next',sessionId:id}).success).toBe(true);
    expect(phoneCommandSchema.safeParse({type:'next',sessionId:id,code:'eval()'}).success).toBe(false);
    expect(phoneCommandSchema.safeParse({type:'account.signOut',sessionId:id}).success).toBe(false);
    expect(phoneOperatorCommand({type:'black',sessionId:id})).toEqual({type:'setVisualMode',visualMode:'black'});
    expect(phoneOperatorCommand({type:'normal',sessionId:id})).toEqual({type:'setVisualMode',visualMode:'normal'});
  });
  it('não publica notas privadas ou dados de conta no estado do celular', () => {
    expect(phonePresentationSchema.safeParse({sessionId:id,phase:'running',title:'Louvor',text:'Letra',index:0,total:1,visualMode:'normal',transport:false,message:'',notes:'privado'}).success).toBe(false);
  });
});
