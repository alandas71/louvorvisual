'use client';
import { useEffect, useState } from 'react';
import { buttonClass } from '@/components/ui/buttonStyles';
import { setLocalQuery } from '@/lib/localQuery';
import { ServiceWorkerRegistration } from '@/pwa/ServiceWorkerRegistration';
import { CONTROLLER_KEY, RECEIVER_KEY, RECEIVER_PREFERENCE, relayRequest, storedConnection, type Connection } from './client';
import { ReceiverScreen } from './ReceiverScreen';

/**
 * "Projetor e celular" dentro do aplicativo: no celular, informa o código do
 * projetor; em um navegador ligado ao projetor, vira a própria saída. O
 * aplicativo do projetor não passa por aqui: ele abre /receptor direto.
 */
export function ReceiverView() {
  const [receiving, setReceiving] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore this browser tab's pairing after hydration
    setReceiving(Boolean(storedConnection(RECEIVER_KEY)));
    setControlling(Boolean(storedConnection(CONTROLLER_KEY)));
  }, []);
  function activate() {
    try { localStorage.setItem(RECEIVER_PREFERENCE, '1'); } catch { /* A escolha vale só para esta abertura. */ }
    setReceiving(true);
  }
  async function connect() {
    setBusy(true); setError('');
    try {
      const next = await relayRequest<Connection>('POST', null, { action: 'pair', code: code.replace(/\s/g, '') });
      sessionStorage.setItem(CONTROLLER_KEY, JSON.stringify(next)); setControlling(true);
      setLocalQuery({ view: 'biblioteca' });
    } catch (error) { setError(error instanceof Error ? error.message : 'Não foi possível conectar.'); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    const current = storedConnection(CONTROLLER_KEY);
    if (current) await relayRequest('DELETE', current).catch(() => {});
    sessionStorage.removeItem(CONTROLLER_KEY); setControlling(false);
  }
  function leave() {
    try { localStorage.removeItem(RECEIVER_PREFERENCE); } catch { /* Nada guardado. */ }
    setLocalQuery({ view: 'biblioteca' });
  }
  if (receiving) return <><ServiceWorkerRegistration holdsSession /><ReceiverScreen onLeave={leave} /></>;
  return <main className="relative min-h-dvh bg-black text-white" data-testid="pwa-receiver-setup">
    <ServiceWorkerRegistration holdsSession />
    <section className="relative mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-5 p-6">
      <h1 className="text-2xl font-bold">Projetor e celular</h1>
      <p className="text-sm text-muted">Abra o aplicativo LouvorVisual no projetor: ele mostra um código de quatro dígitos. Informe o código aqui e escolha o louvor na biblioteca; letra e som saem no projetor.</p>
      {controlling ? <><p role="status">Este dispositivo está conectado como controle.</p><button className={buttonClass('secondary')} onClick={() => void disconnect()}>Desconectar controle</button></> : <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void connect(); }}>
        <label htmlFor="receiver-code">Código exibido no projetor</label>
        <input id="receiver-code" inputMode="numeric" autoComplete="off" pattern="[0-9]{4}" maxLength={4} required value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} className="rounded-lg border border-border bg-surface p-3 text-white" />
        <button disabled={busy} className={buttonClass('primary')}>Conectar como controle</button>
      </form>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {!controlling && <>
        <p className="text-sm text-muted">Sem o aplicativo no projetor, um navegador ligado a ele também serve de saída.</p>
        <button className={buttonClass('secondary')} onClick={activate}>Ativar receptor neste dispositivo</button>
      </>}
      <button className={buttonClass('ghost')} onClick={leave}>Voltar à biblioteca</button>
    </section>
  </main>;
}
