'use client';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ChannelMessage } from '@louvorvisual/presentation';
import { SlideView } from '@/components/SlideView';
import { useFontFace } from '@/presentation/measure';
import { ConnectionError, RECEIVER_KEY, SILENT_PEER_MS, cachedAudio, relayAudioBlob, relayRequest, storedConnection, type Connection, type RelayAudio, type RelayState } from './client';
import type { ReceiverAudioStatus } from './relay';
import { WaitingLight } from './WaitingLight';

type Snapshot = Extract<ChannelMessage, { type: 'SESSION_SNAPSHOT' }>;
type Storage = 'sessionStorage' | 'localStorage';

/** Acima do prazo da leitura em espera do servidor (10 s), com folga para a rede. */
const WAIT_TIMEOUT_MS = 25_000;
const fill: CSSProperties = { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' };

/** Confirma ao celular a sequência que esta tela desenhou e se a fonte do slide carregou. */
function Acknowledge({ connection, message, onLatency }: { connection: Connection; message: Snapshot; onLatency: (ms: number) => void }) {
  const { state } = message;
  const font = useFontFace(state.frame.slide.fontId, state.frame.slide.style.fontWeight);
  useEffect(() => {
    if (font === 'loading') return;
    const startedAt = performance.now();
    void relayRequest('POST', connection, { action: 'publish', message: { type: 'STATE_ACK', sessionId: message.sessionId, generation: message.generation, windowId: connection.id, sequenceNumber: state.sequenceNumber, armed: true, fontMissing: font === 'missing' } })
      .then(() => onLatency((performance.now() - startedAt) / 2))
      .catch(() => {});
  }, [connection, message.sessionId, message.generation, state.sequenceNumber, font, onLatency]);
  return null;
}

/**
 * Toca neste dispositivo a faixa que o celular enviou, presa à posição do
 * player dele. Pequenos desvios são corrigidos pela velocidade; os grandes, por
 * reposicionamento. Não decide nada: sem notícia do celular, para.
 */
function useReceiverAudio(connection: Connection | null, audio: RelayAudio | null, receivedAt: number, online: boolean, volume: number | null, latency: { current: number }) {
  const element = useRef<HTMLAudioElement | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const sha256 = audio?.sha256 ?? null;
  const available = useRef(false);
  useEffect(() => { available.current = audio?.available ?? false; }, [audio]);
  const report = useCallback((sha: string, status: ReceiverAudioStatus) => {
    if (connection) void relayRequest('POST', connection, { action: 'audio-status', sha256: sha, status }).catch(() => {});
  }, [connection]);

  useEffect(() => {
    if (!connection || !sha256) return;
    let current = true; let url = '';
    const player = new Audio();
    player.preload = 'auto';
    report(sha256, 'loading');
    // A faixa guardada de outra vez vale na hora, antes mesmo de o celular terminar (ou começar) o envio.
    const fetchTrack = async (): Promise<Blob | null> => {
      while (current) {
        const blob = (await cachedAudio(sha256)) ?? (available.current ? await relayAudioBlob(connection, sha256) : null);
        if (blob) return blob;
        await new Promise(resolve => window.setTimeout(resolve, 400));
      }
      return null;
    };
    void fetchTrack().then(blob => {
      if (!current || !blob) return;
      url = URL.createObjectURL(blob);
      // Basta conhecer a faixa: no Android o player não adianta o carregamento ("canplay"
      // só viria depois do play), e esperar por ele deixaria o projetor mudo para sempre.
      const ready = () => { if (current && element.current !== player) { element.current = player; setLoaded(sha256); report(sha256, 'ready'); } };
      player.addEventListener('loadedmetadata', ready, { once: true });
      window.setTimeout(ready, 1500);
      player.addEventListener('error', () => { if (current) report(sha256, 'failed'); });
      player.src = url;
    }).catch(() => { if (current) report(sha256, 'failed'); });
    return () => {
      current = false;
      if (element.current === player) element.current = null;
      setLoaded(null);
      player.pause(); player.removeAttribute('src'); player.load();
      if (url) URL.revokeObjectURL(url);
    };
  }, [connection, sha256, report]);

  const lostAt = useRef<number | null>(null);
  const blocked = useRef(false);
  useEffect(() => {
    const allow = () => { blocked.current = false; };
    window.addEventListener('pointerdown', allow); window.addEventListener('keydown', allow);
    return () => { window.removeEventListener('pointerdown', allow); window.removeEventListener('keydown', allow); };
  }, []);
  useEffect(() => {
    const player = element.current;
    if (!player || !audio || loaded !== audio.sha256) return;
    const follow = () => {
      // O celular sumiu: sem o relógio dele a faixa não segue sozinha.
      if (!online) lostAt.current ??= performance.now(); else lostAt.current = null;
      // Tela oculta (aplicativo do projetor em segundo plano) também não toca.
      const silent = document.hidden || (lostAt.current !== null && performance.now() - lostAt.current > SILENT_PEER_MS);
      player.volume = Math.min(1, Math.max(0, volume ?? audio.volume));
      if (!audio.playing || silent) {
        if (!player.paused) player.pause();
        if (!silent && Math.abs(player.currentTime * 1000 - audio.positionMs) > 150) player.currentTime = audio.positionMs / 1000;
        return;
      }
      const target = audio.positionMs + audio.ageMs + latency.current + (performance.now() - receivedAt);
      const drift = player.currentTime * 1000 - target;
      if (player.paused) {
        // Recusado pelo navegador (sem gesto nesta tela): o celular continua audível e não se insiste.
        if (blocked.current) return;
        player.currentTime = target / 1000; player.playbackRate = 1;
        void player.play().then(() => report(audio.sha256, 'ready'), () => { blocked.current = true; report(audio.sha256, 'blocked'); });
      } else if (Math.abs(drift) > 400) { player.currentTime = target / 1000; player.playbackRate = 1; }
      else player.playbackRate = Math.abs(drift) < 50 ? 1 : drift > 0 ? 0.97 : 1.03;
    };
    follow();
    const timer = window.setInterval(follow, 250);
    return () => window.clearInterval(timer);
  }, [audio, loaded, receivedAt, online, volume, latency, report]);

  // Sem faixa publicada (sessão encerrada ou sem áudio), nada continua tocando.
  useEffect(() => { if (!audio) element.current?.pause(); }, [audio]);
}

function CodeScreen({ code, paired, error, kiosk, onFullscreen, onLeave }: { code: string | null; paired: boolean; error: string; kiosk: boolean; onFullscreen: () => void; onLeave?: () => void }) {
  const [engine, setEngine] = useState('');
  useEffect(() => {
    const agent = navigator.userAgent;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- o navegador só existe depois da hidratação
    setEngine([/Chrome\/(\d+)/.exec(agent)?.[0], /Android [\d.]+/.exec(agent)?.[0]].filter(Boolean).join(' · '));
  }, []);
  return (
    <div style={{ ...fill, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '4vh 6vw', color: '#fff' }}>
      <p style={{ fontSize: '2.6vh', letterSpacing: '0.3em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', margin: 0 }}>LouvorVisual</p>
      <p style={{ fontSize: '3.6vh', margin: '5vh 0 1vh', color: 'rgba(255,255,255,0.85)' }}>{paired ? 'Celular desconectado. Para reconectar, digite o código:' : 'Digite este código no celular'}</p>
      <p data-testid="receiver-code" style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '24vh', fontWeight: 700, lineHeight: 1.1, letterSpacing: '0.18em', margin: 0, paddingLeft: '0.18em', color: '#ffe1a2', textShadow: '0 0 6vh rgba(255,215,140,0.45)' }}>{code ?? '····'}</p>
      <p style={{ fontSize: '2.6vh', margin: '4vh 0 0', color: 'rgba(255,255,255,0.6)', maxWidth: '80vw' }}>No celular, abra o LouvorVisual, toque em “Projetor e celular” e informe o código.</p>
      <p role="status" style={{ fontSize: '2.2vh', margin: '2vh 0 0', minHeight: '3vh', color: error ? '#ff9d9d' : 'rgba(255,255,255,0.45)' }}>{error || (code ? 'Aguardando o celular…' : 'Conectando ao servidor…')}</p>
      {/* Versão do navegador embutido do projetor: é o que se pede ao investigar algo que só acontece nele. */}
      <p data-testid="receiver-engine" style={{ position: 'absolute', left: '2vw', bottom: '2vh', margin: 0, fontSize: '1.8vh', color: 'rgba(255,255,255,0.3)' }}>{engine}</p>
      {!kiosk && (
        <div style={{ display: 'flex', gap: '2vh', marginTop: '3vh' }}>
          <button type="button" onClick={onFullscreen} style={{ padding: '1.4vh 2.4vh', borderRadius: 12, border: '1px solid rgba(255,255,255,0.35)', color: '#fff', fontSize: '2.2vh', cursor: 'pointer' }}>Tela cheia</button>
          {onLeave && <button type="button" onClick={onLeave} style={{ padding: '1.4vh 2.4vh', borderRadius: 12, border: '1px solid rgba(255,255,255,0.35)', color: '#fff', fontSize: '2.2vh', cursor: 'pointer' }}>Voltar à biblioteca</button>}
        </div>
      )}
    </div>
  );
}

/**
 * Saída do projetor: só mostra o código de pareamento, a espera e o que o
 * celular apresenta. `kiosk` é o aplicativo do projetor (rota /receptor): gera
 * o código sozinho, guarda o pareamento entre aberturas e não tem botões.
 */
export function ReceiverScreen({ kiosk = false, onLeave }: { kiosk?: boolean; onLeave?: () => void }) {
  const storage: Storage = kiosk ? 'localStorage' : 'sessionStorage';
  const [connection, setConnection] = useState<Connection | null>(null);
  const [relay, setRelay] = useState<{ data: RelayState; at: number } | null>(null);
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);
  const latency = useRef(40);
  const onLatency = useCallback((ms: number) => { latency.current = latency.current * 0.7 + Math.min(1000, ms) * 0.3; }, []);

  // Sem sala guardada (ou com a sala expirada), cria outra e mostra o código novo.
  useEffect(() => {
    if (connection) return;
    let current = true; let timer: ReturnType<typeof setTimeout>;
    const restored = storedConnection(RECEIVER_KEY, storage);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- o pareamento guardado só existe no navegador
    if (restored) { setConnection(restored); return; }
    const create = async () => {
      try {
        const created = await relayRequest<Connection>('POST', null, { action: 'create' });
        if (!current) return;
        try { window[storage].setItem(RECEIVER_KEY, JSON.stringify({ id: created.id, token: created.token })); } catch { /* Sem armazenamento, o pareamento vale só enquanto a tela estiver aberta. */ }
        setError(''); setConnection(created);
      } catch (failure) {
        if (!current) return;
        setError(failure instanceof Error ? failure.message : 'Sem conexão.');
        timer = setTimeout(() => void create(), 3000);
      }
    };
    void create();
    return () => { current = false; clearTimeout(timer); };
  }, [connection, storage]);

  useEffect(() => {
    if (!connection) return;
    let current = true; let timer: ReturnType<typeof setTimeout>; let version: number | null = null;
    const poll = async () => {
      try {
        const data = await relayRequest<RelayState>('GET', connection, undefined, version === null ? {} : { query: 'wait=' + version, timeoutMs: WAIT_TIMEOUT_MS });
        if (!current) return;
        version = data.version;
        setRelay({ data, at: performance.now() }); setError('');
        timer = setTimeout(() => void poll(), 0);
      } catch (failure) {
        if (!current) return;
        if (failure instanceof ConnectionError && failure.expired) {
          try { window[storage].removeItem(RECEIVER_KEY); } catch { /* Nada guardado. */ }
          setRelay(null); setConnection(null);
          return;
        }
        // A imagem já recebida continua na tela; só a conexão é refeita.
        setError(failure instanceof Error ? failure.message : 'Sem conexão.');
        version = null;
        timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [connection, storage]);

  useEffect(() => {
    if (!('wakeLock' in navigator)) return;
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
  }, []);

  // OK/Enter no controle remoto (ou M/Esc no teclado) mostra o código sobre a apresentação, para parear outro celular.
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === 'Escape' || event.key.toLowerCase() === 'm') setPairing(open => !open); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);

  function fullscreen() {
    void document.documentElement.requestFullscreen?.().then(() => (screen.orientation as ScreenOrientation & { lock?: (orientation: string) => Promise<void> }).lock?.('landscape')).catch(() => {});
  }
  function leave() {
    if (connection) void relayRequest('DELETE', connection).catch(() => {});
    try { window[storage].removeItem(RECEIVER_KEY); } catch { /* Nada guardado. */ }
    onLeave?.();
  }

  const data = relay?.data ?? null;
  const message = data?.message?.type === 'SESSION_SNAPSHOT' ? data.message : null;
  const paired = data?.paired ?? false;
  const online = data?.peerOnline ?? false;
  // Antes de "Iniciar" o operador ainda está preparando: o público vê a espera, não o slide.
  const live = message !== null && message.state.controls.status !== 'ready';
  const code = data?.code ?? null;
  // Pareado, o código só volta a ocupar a tela a pedido: o celular bloqueado
  // durante a pregação não pode trocar a espera por uma tela de pareamento.
  const showCode = data !== null && (!paired || (code !== null && pairing));
  const hint = !showCode && !live && paired && code !== null;
  const frame = message?.state.frame;
  const mode = showCode || !data ? 'code' : live && frame ? 'slide' : 'waiting';
  const [covered, setCovered] = useState(false);
  if (covered && mode !== 'slide') setCovered(false);
  // Da abertura para a primeira letra a troca é lenta, como um respiro; entre letras continua curta.
  const frameKey = frame ? `${frame.occurrenceId}:${frame.cover ? 'abertura' : 'letra'}` : '';
  const [shown, setShown] = useState({ key: frameKey, cover: Boolean(frame?.cover), slow: false });
  if (shown.key !== frameKey) setShown({ key: frameKey, cover: Boolean(frame?.cover), slow: shown.cover && frame !== undefined && !frame.cover });
  const pace = (shown.slow ? { '--lv-slide-out': '0.9s', '--lv-slide-in': '1.2s' } : {}) as CSSProperties;

  useReceiverAudio(connection, data?.audio ?? null, relay?.at ?? 0, online, message?.state.controls.audio?.volume ?? null, latency);

  return (
    <main className="lv-output-motion" data-testid="pwa-receiver" data-online={online} data-armed={!showCode} data-live={live} data-mode={mode} data-sequence={message?.state.sequenceNumber ?? ''} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', overflow: 'hidden', background: '#000', cursor: showCode && !kiosk ? 'auto' : 'none' }}>
      {connection && message && <Acknowledge connection={connection} message={message} onLatency={onLatency} />}
      {/* Só a espera e o código são desta tela. A apresentação surge por cima da luz, e só então ela para de ser desenhada. */}
      {!(mode === 'slide' && covered) && <WaitingLight strength={mode === 'code' ? 0.45 : 1} />}
      {mode === 'code' && (data ? <CodeScreen code={code} paired={paired} error={error} kiosk={kiosk} onFullscreen={fullscreen} onLeave={onLeave ? leave : undefined} />
        : <p role="status" style={{ ...fill, top: 'auto', bottom: '6vh', height: 'auto', textAlign: 'center', fontSize: '2.4vh', color: error ? '#ff9d9d' : 'rgba(255,255,255,0.5)', margin: 0 }}>{error || 'Conectando ao servidor…'}</p>)}
      {/*
        O quadro é desenhado como na prévia "O público vê agora" e na janela de
        projeção do PWA: a mesma chamada do SlideView, com a abertura (nome do
        louvor e artista), as luzes atrás da letra e a troca suave entre slides.
      */}
      {mode === 'slide' && frame && (
        <div className="lv-receiver-slide-enter" style={{ ...fill, ...pace }} onAnimationEnd={event => { if (event.target === event.currentTarget) setCovered(true); }}>
          <SlideView fit="fill" text={frame.slide.text} style={frame.slide.style} fontId={frame.slide.fontId} visualMode={frame.visualMode} rotation={0} cover={frame.cover} transitionKey={frameKey} />
        </div>
      )}
      {hint && <p data-testid="receiver-code-hint" style={{ position: 'absolute', right: '3vw', bottom: '3vh', margin: 0, fontSize: '2.2vh', color: 'rgba(255,255,255,0.4)' }}>Reconectar o celular: {code}</p>}
    </main>
  );
}
