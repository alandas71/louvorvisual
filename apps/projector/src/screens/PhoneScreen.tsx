'use client';

import type { PhoneConnection } from '@louvorvisual/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/app-context';
import { useFocusLayer } from '@/input/focus';
import { Action } from '@/ui/Action';

export function PhoneScreen() {
  const { host, back } = useApp();
  const [connection, setConnection] = useState<PhoneConnection | null>(null);
  const [error, setError] = useState('');
  const ref = useFocusLayer<HTMLElement>({ name: 'phone', level: 0, repeat: 'directions', onBack: () => back() });
  const open = useCallback(async () => {
    setError('');
    try { setConnection(await host.request('phone.open', {})); }
    catch { setError('Não foi possível abrir o controle. Conecte o projetor ao Wi-Fi e tente novamente.'); }
  }, [host]);
  useEffect(() => {
    let current = true;
    const update = async (initial = false) => {
      try {
        let status = await host.request('phone.status', {});
        if (initial && !status.enabled) status = await host.request('phone.open', {});
        if (current) setConnection(status);
      } catch { if (current) setError('Não foi possível abrir o controle. Verifique o Wi-Fi do projetor.'); }
    };
    void update(true);
    const timer = window.setInterval(() => void update(), 2000);
    return () => { current = false; window.clearInterval(timer); };
  }, [host]);
  return (
    <main className="screen" ref={ref} data-testid="phone-screen" data-layer="phone">
      <header className="screen-header"><h1>Controlar pelo celular</h1></header>
      <section className="panel">
        <p>Conecte o celular e o projetor à mesma rede Wi-Fi.</p>
        <p>Abra este endereço no navegador do celular:</p>
        {connection?.urls.map(url => <h2 key={url} style={{ overflowWrap: 'anywhere' }}>{url}</h2>)}
        {connection?.enabled && connection.urls.length === 0 && <p className="alert">Nenhum endereço local encontrado. Conecte o projetor ao Wi-Fi e gere um novo código.</p>}
        {connection?.code && <h2 data-testid="phone-code">Código de pareamento: {connection.code}</h2>}
        <p role="status" data-testid="phone-connection">{connection?.connected ? 'Celular conectado. Escolha um louvor no celular.' : connection?.code ? 'Digite o código no celular. Ele vale por 10 minutos.' : 'Gere um novo código para conectar o celular.'}</p>
        <p>Os repertórios precisam estar neste projetor. Use “Importar pacote” para trazê-los do LouvorVisual.</p>
      </section>
      {error && <p role="alert" className="alert">{error}</p>}
      <Action className="button" autoFocus testId="phone-renew" onSelect={() => void open()}>Gerar novo código · desconecta o celular anterior</Action>
      <Action className="button" testId="phone-close" onSelect={() => void host.request('phone.close', {}).then(() => back()).catch(() => setError('Não foi possível desligar o controle.'))}>Desligar controle pelo celular</Action>
      <Action className="button" testId="phone-back" onSelect={() => back()}>Voltar · manter conexão</Action>
    </main>
  );
}
