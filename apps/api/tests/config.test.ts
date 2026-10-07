import { describe, expect, it } from 'vitest';
import { clientVersionAccepted } from '../src/config';

describe('janela de versão do cliente', () => {
  const config={ minClientVersion:'0.1.0', maxClientVersion:'0.1.x' };
  it('aceita somente a faixa declarada quando o cliente se identifica', () => {
    expect(clientVersionAccepted('0.1.0',config)).toBe(true);
    expect(clientVersionAccepted('0.1.99',config)).toBe(true);
    expect(clientVersionAccepted('0.0.9',config)).toBe(false);
    expect(clientVersionAccepted('0.2.0',config)).toBe(false);
    expect(clientVersionAccepted('invalida',config)).toBe(false);
  });
});
