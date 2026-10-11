'use client';
import { useEffect, useState } from 'react';
import type { ChannelMessage } from '@louvorvisual/presentation';
import { SlideView } from '@/components/SlideView';
import { buttonClass } from '@/components/ui/buttonStyles';
import { setLocalQuery } from '@/lib/localQuery';
import { useFontFace } from '@/presentation/measure';
import { ServiceWorkerRegistration } from '@/pwa/ServiceWorkerRegistration';
import { ConnectionError, CONTROLLER_KEY, RECEIVER_KEY, RECEIVER_PREFERENCE, relayRequest, storedConnection, type Connection, type RelayState } from './client';

function ReceivedSlide({ connection, message, armed }: { connection: Connection; message: Extract<ChannelMessage, { type: 'SESSION_SNAPSHOT' }>; armed: boolean }) {
  const { state } = message;
  const font = useFontFace(state.frame.slide.fontId, state.frame.slide.style.fontWeight);
  useEffect(() => {
    if (font === 'loading') return;
    void relayRequest('POST', connection, { action: 'publish', message: { type: 'STATE_ACK', sessionId: message.sessionId, generation: message.generation, windowId: connection.id, sequenceNumber: state.sequenceNumber, armed, fontMissing: font === 'missing' } }).catch(() => {});
  }, [connection, message, state.sequenceNumber, armed, font]);
  // The receiver is a physical landscape output. `rotation` is a preference
  // for a local output window and is not applied to the phone preview; using
  // it here can therefore turn an otherwise correct slide sideways.
  if (!armed) return null;
  // Empty Introduction/Instrumental occurrences are valid slides. Give them a
  // gentle worship transition instead of showing an unexplained blank frame.
  if (state.frame.visualMode === 'normal' && state.frame.slide.text.trim() === '') return <WorshipWaiting variant="intro" label={state.controls.label} />;
  return (
    <div key={state.sequenceNumber} className="lv-receiver-slide-enter h-full w-full">
      <SlideView fit="fill" text={state.frame.slide.text} style={state.frame.slide.style} fontId={state.frame.slide.fontId} visualMode={state.frame.visualMode} rotation={0} />
    </div>
  );
}

function WorshipWaiting({ variant = 'waiting', label }: { variant?: 'waiting' | 'intro'; label?: string }) {
  const introduction = variant === 'intro';
  return (
    <div className="lv-receiver-waiting flex h-full w-full items-center justify-center overflow-hidden" data-testid="receiver-waiting">
      <div className="lv-receiver-glow" aria-hidden="true" />
      <div className="relative flex flex-col items-center gap-5 px-8 text-center text-white">
        <div className="lv-receiver-cross" aria-hidden="true"><span /><span /></div>
        <p className="text-xl font-medium tracking-wide sm:text-3xl">{introduction ? label || 'Introdução' : 'Prepare o seu coração'}</p>
        <p className="text-sm tracking-[0.18em] text-white/65 uppercase sm:text-base">{introduction ? 'Momento instrumental' : 'Aguardando o próximo louvor'}</p>
      </div>
    </div>
  );
}

export function ReceiverView() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [message, setMessage] = useState<Extract<ChannelMessage, { type: 'SESSION_SNAPSHOT' }> | null>(null);
  const [paired, setPaired] = useState(false);
  const [online, setOnline] = useState(false);
  const [armed, setArmed] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [controlling, setControlling] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore this browser tab's pairing after hydration
    setConnection(storedConnection(RECEIVER_KEY));
    setControlling(Boolean(storedConnection(CONTROLLER_KEY)));
  }, []);
  useEffect(() => {
    if (!connection) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await relayRequest<RelayState>('GET', connection);
        if (stopped) return;
        setPaired(data.paired); setOnline(data.peerOnline); setError('');
        // Parear o celular já é a autorização para ocupar a saída. A espera
        // visual substitui a antiga pergunta "Exibir apresentação".
        if (data.paired) setArmed(true);
        if (data.message?.type === 'SESSION_SNAPSHOT') {
          setMessage(data.message);
          // Sequence zero is the prepared state. Once the operator advances
          // past it, the remote output follows the started presentation without
          // requiring a second action on the projector.
          if (data.message.state.sequenceNumber > 0) setArmed(true);
        }
        else if (data.message?.type === 'SESSION_ENDED' || data.message?.type === 'SESSION_HANDOFF') setMessage(null);
      } catch (error) {
        if (stopped) return;
        setOnline(false); setError(error instanceof Error ? error.message : 'Sem conexão.');
        if (error instanceof ConnectionError && error.expired) { sessionStorage.removeItem(RECEIVER_KEY); setConnection(null); setMessage(null); setArmed(false); return; }
      }
      // The receiver carries only compact visual state; a short polling
      // interval keeps projector changes perceptibly aligned with the phone.
      if (!stopped) timer = setTimeout(() => void poll(), 100);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [connection]);
  useEffect(() => {
    if (!connection || !('wakeLock' in navigator)) return;
    let stopped = false; let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || lock) return;
      try {
        const acquired = await navigator.wakeLock.request('screen');
        if (stopped) { void acquired.release().catch(() => {}); return; }
        lock = acquired; acquired.addEventListener('release', () => { if (lock === acquired) lock = null; });
      } catch { /* The projector/browser may not support keeping the screen awake. */ }
    };
    void acquire(); document.addEventListener('visibilitychange', acquire);
    return () => { stopped = true; document.removeEventListener('visibilitychange', acquire); void lock?.release().catch(() => {}); };
  }, [connection]);
  async function fullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      const orientation = screen.orientation as ScreenOrientation & { lock?: (orientation: string) => Promise<void> };
      await orientation.lock?.('landscape').catch(() => {});
    } catch { setError('O navegador recusou tela cheia. Tente novamente pelo botão Tela cheia.'); }
  }
  async function activate() {
    setBusy(true); setError('');
    try {
      if (storedConnection(CONTROLLER_KEY)) throw new Error('Desconecte o controle antes de usar este dispositivo como receptor.');
      const next = await relayRequest<Connection>('POST', null, { action: 'create' });
      sessionStorage.setItem(RECEIVER_KEY, JSON.stringify(next)); localStorage.setItem(RECEIVER_PREFERENCE, '1');
      setConnection(next); setPaired(false); setMessage(null); setArmed(false);
    } catch (error) { setError(error instanceof Error ? error.message : 'Não foi possível ativar.'); }
    finally { setBusy(false); }
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
  function leave() {
    if (connection) void relayRequest('DELETE', connection).catch(() => {});
    sessionStorage.removeItem(RECEIVER_KEY); localStorage.removeItem(RECEIVER_PREFERENCE);
    setLocalQuery({ view: 'biblioteca' });
  }
  async function disconnect() {
    const current = storedConnection(CONTROLLER_KEY);
    if (current) await relayRequest('DELETE', current).catch(() => {});
    sessionStorage.removeItem(CONTROLLER_KEY); setControlling(false);
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' || event.key.toLowerCase() === 'm') setArmed(false); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  return <main className="relative min-h-dvh bg-black text-white" data-testid="pwa-receiver" data-online={online} data-armed={armed} data-sequence={message?.state.sequenceNumber ?? ''}>
    <ServiceWorkerRegistration holdsSession />
    {armed && <div className="absolute inset-0 cursor-none">{message ? <ReceivedSlide connection={connection!} message={message} armed /> : <WorshipWaiting />}</div>}
    {!armed && <section className="relative mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-5 p-6">
      <h1 className="text-2xl font-bold">Projetor e controle pelo celular</h1>
      <p className="text-sm text-muted">No projetor, ative o receptor. No celular, abra este mesmo sistema e informe o código. Os dois precisam de conexão com o servidor.</p>
      {connection ? <>
        <h2 className="text-lg font-semibold">Modo receptor</h2>
        {!paired && <><p>Digite este código no celular (válido por 10 minutos):</p><p data-testid="receiver-code" className="font-mono text-4xl tracking-widest">{connection.code}</p></>}
        <p role="status">{paired ? online ? 'Celular conectado.' : 'Aguardando a conexão do celular…' : 'Aguardando o celular…'}</p>
        <div className="flex flex-wrap gap-3"><button className={buttonClass('secondary')} onClick={() => void fullscreen()}>Tela cheia</button></div>
        <p className="text-sm text-muted">Assim que o celular conectar, esta tela entra automaticamente na projeção e mostra uma espera até você iniciar um louvor. A tecla M reabre esta preparação. O áudio toca no celular.</p>
        <button disabled={busy} className={buttonClass('secondary')} onClick={() => { void relayRequest('DELETE', connection).catch(() => {}); void activate(); }}>Gerar novo código</button>
      </> : <>
        {!controlling && <button disabled={busy} className={buttonClass('primary')} onClick={() => void activate()}>Ativar receptor neste dispositivo</button>}
        {controlling ? <><p role="status">Este dispositivo está conectado como controle.</p><button className={buttonClass('secondary')} onClick={() => void disconnect()}>Desconectar controle</button></> : <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void connect(); }}>
          <label htmlFor="receiver-code">Código exibido no projetor</label>
          <input id="receiver-code" inputMode="numeric" autoComplete="off" pattern="[0-9]{8}" maxLength={8} required value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} className="rounded-lg border border-border bg-surface p-3 text-white" />
          <button disabled={busy} className={buttonClass('secondary')}>Conectar como controle</button>
        </form>}
      </>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <button className={buttonClass('ghost')} onClick={leave}>Voltar à biblioteca</button>
    </section>}
  </main>;
}
