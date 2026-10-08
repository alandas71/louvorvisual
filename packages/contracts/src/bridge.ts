import { z } from 'zod';
import { arrangementSchema, audioBindingSchema } from './arrangement';
import { assetSchema, sha256Schema } from './asset';
import { civilDateSchema, isoInstantSchema, uuidSchema } from './common';
import { songSchema } from './song';

// Ponte entre o bundle do projetor (apps/projector) e o host que o embarca
// (apps/android). O bundle não tem banco, arquivos, player nem rede: tudo isso
// é do host, e só passa por aqui o que está neste arquivo. Regras
// (planejamento/21):
//
// - mensagens são JSON em texto, com versão, e são validadas dos dois lados;
// - nenhum byte de áudio ou de pacote atravessa a ponte: só IDs e metadados;
// - cookies, tokens, e-mail e senha ficam no host — não existe campo para eles;
// - listas são paginadas; notas privadas de repertório não têm campo;
// - as teclas do controle chegam já normalizadas pelo host, uma vez cada, com
//   número de sequência para o bundle descartar repetições da própria ponte.

/** Versão do protocolo. Muda quando uma mensagem deixa de ser compatível. */
export const BRIDGE_VERSION = 1;
/** Nome do objeto que o host injeta em `window`, só na origem embarcada. */
export const BRIDGE_GLOBAL = 'louvorvisualHost';
/** Origem virtual do WebViewAssetLoader; o host só expõe a ponte para ela. */
export const BRIDGE_ORIGIN = 'https://appassets.androidplatform.net';
/** Caminho sob o qual o bundle é servido (os chunks usam este prefixo). */
export const BRIDGE_BASE_PATH = '/assets';

const empty = z.strictObject({});
const count = z.int().min(0);
/** JSON que o host guarda e devolve sem interpretar (snapshot e checkpoint da sessão). */
const opaque = z.record(z.string(), z.unknown());
const cursor = z.string().min(1).max(200).nullable();
const pageParams = z.strictObject({ cursor, limit: z.int().min(1).max(50) });

export const HOST_ERROR_CODES = [
  /** Método ou parâmetros que este host não reconhece. */
  'invalid-request',
  'unsupported',
  'not-found',
  /** Recurso local indisponível agora (arquivo de áudio ausente, player ocupado). */
  'unavailable',
  /** O sistema recusou tocar (foco de áudio negado). */
  'blocked',
  'storage',
  'quota',
  'offline',
  'auth-required',
  'cancelled',
  'failed',
] as const;
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

// ── teclas do controle ──────────────────────────────────────────────────────

export const REMOTE_KEYS = ['up', 'down', 'left', 'right', 'ok', 'back', 'menu', 'playPause'] as const;
export type RemoteKey = (typeof REMOTE_KEYS)[number];

/**
 * Uma tecla do controle, como o host a recebeu. O host envia `down` (com
 * `repeat` crescente enquanto a tecla fica pressionada) e `up`; quem decide o
 * que vira comando é o bundle, conforme o contexto de foco.
 */
export const remoteKeyEventSchema = z.object({
  /** Identifica a execução do host; a sequência recomeça quando ele reinicia. */
  epoch: z.string().min(1).max(64),
  /** Crescente dentro do `epoch`; mensagem com sequência já vista é descartada. */
  seq: count,
  key: z.enum(REMOTE_KEYS),
  action: z.enum(['down', 'up']),
  /** 0 no pressionamento inicial; maior que zero na repetição automática. */
  repeat: count,
});
export type RemoteKeyEvent = z.infer<typeof remoteKeyEventSchema>;

// ── biblioteca local (somente leitura) ──────────────────────────────────────

export const audioAvailabilitySchema = z.enum(['none', 'ready', 'missing']);

export const songSummarySchema = z.object({
  songId: uuidSchema,
  /** Arranjo que será apresentado. */
  arrangementId: uuidSchema,
  title: z.string(),
  artist: z.string().nullable(),
  slideCount: count,
  /** Faixa escolhida do arranjo: sem faixa, com os bytes conferidos neste aparelho, ou ausente. */
  audio: audioAvailabilitySchema,
});
export type SongSummary = z.infer<typeof songSummarySchema>;

export const setlistSummarySchema = z.object({
  setlistId: uuidSchema,
  title: z.string(),
  serviceDate: civilDateSchema.nullable(),
  itemCount: count,
});
export type SetlistSummary = z.infer<typeof setlistSummarySchema>;

export const setlistEntrySchema = songSummarySchema.extend({ itemId: uuidSchema });
export type SetlistEntry = z.infer<typeof setlistEntrySchema>;

/** Documentos de um arranjo, validados pelos mesmos esquemas da sincronização e do pacote. */
export const presentableSchema = z.object({
  song: songSchema,
  arrangement: arrangementSchema,
  songGeneration: count,
  arrangementGeneration: count,
  /** Faixa escolhida com os bytes presentes e conferidos; `null` sem faixa ou com ela ausente. */
  audio: z.object({ binding: audioBindingSchema, asset: assetSchema }).nullable(),
  /** O arranjo tem faixa escolhida, mas os bytes não estão neste aparelho. */
  audioMissing: z.boolean(),
});
export type Presentable = z.infer<typeof presentableSchema>;

// ── preferências do aparelho e sessão ───────────────────────────────────────

export const projectorPrefsSchema = z.object({
  // Valores das versões que aceitavam 180°/270° continuam legíveis, mas são
  // normalizados à orientação equivalente agora que só há duas opções.
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).transform<0 | 90>((value) => (value === 90 || value === 270 ? 90 : 0)),
  /** Margem de segurança em % de cada borda, para firmware que corta a imagem. */
  safeAreaPercent: z.number().min(0).max(10),
  recentSetlistId: uuidSchema.nullable(),
});
export type ProjectorPrefs = z.infer<typeof projectorPrefsSchema>;
export const DEFAULT_PROJECTOR_PREFS: ProjectorPrefs = { rotation: 0, safeAreaPercent: 0, recentSetlistId: null };

/** De onde a sessão foi aberta, para voltar ao mesmo lugar ao encerrar ou recuperar. */
export const sessionContextSchema = z.object({ setlistId: uuidSchema.nullable(), itemId: uuidSchema.nullable() });
export type SessionContext = z.infer<typeof sessionContextSchema>;

export const recoverableSessionSchema = z.object({
  sessionId: uuidSchema,
  snapshot: opaque,
  checkpoint: opaque.nullable(),
  savedAt: isoInstantSchema.nullable(),
  context: sessionContextSchema,
});
export type RecoverableSession = z.infer<typeof recoverableSessionSchema>;

// ── pacote .louvorvisual.zip ────────────────────────────────────────────────

/** Recusas do leitor de pacote (packages/pack) mais as de gravação. */
export const IMPORT_REJECTIONS = [
  'not-a-package',
  'too-large',
  'unsafe-path',
  'manifest-missing',
  'manifest-invalid',
  'format-too-new',
  'schema-too-new',
  'schema-unsupported',
  'font-pack-incompatible',
  'catalog-missing',
  'unexpected-file',
  'missing-file',
  'hash-mismatch',
  'document-invalid',
  'reference-broken',
  'unreadable',
  'quota',
] as const;
export type ImportRejection = (typeof IMPORT_REJECTIONS)[number];

export const importPreviewSchema = z.object({
  title: z.string(),
  /** O pacote veio do mesmo espaço deste perfil. */
  sameWorkspace: z.boolean(),
  songs: count,
  /** Documentos que entram, que já existem iguais, e que entram como cópia "(importado)". */
  newDocuments: count,
  existingDocuments: count,
  copiedDocuments: count,
  mediaBytes: count,
  /** Bytes de áudio que ainda não estão neste aparelho. */
  newMediaBytes: count,
  /** Faixas citadas que não vieram no pacote. */
  omittedMedia: count,
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const pickPackageResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }),
  z.object({ status: z.literal('rejected'), code: z.enum(IMPORT_REJECTIONS) }),
  /** Arquivo copiado para a área do aplicativo e conferido por inteiro; nada foi importado ainda. */
  z.object({ status: z.literal('ready'), importId: z.string().min(1).max(64), fileName: z.string().max(255), preview: importPreviewSchema }),
]);
export type PickPackageResult = z.infer<typeof pickPackageResultSchema>;

// ── conta e sincronização ───────────────────────────────────────────────────

export const accountStatusSchema = z.object({
  profile: z.enum(['personal', 'team']),
  /** Nome da equipe; nenhum dado da pessoa (nome, e-mail) passa pela ponte. */
  teamName: z.string().max(200).nullable(),
  signedIn: z.boolean(),
  online: z.boolean(),
  sync: z.object({
    state: z.enum(['disabled', 'idle', 'syncing', 'error']),
    pending: count,
    conflicts: count,
    lastSyncedAt: isoInstantSchema.nullable(),
  }),
});
export type AccountStatus = z.infer<typeof accountStatusSchema>;

// ── áudio ───────────────────────────────────────────────────────────────────

export const audioStateEventSchema = z.object({
  type: z.enum(['playing', 'paused', 'waiting', 'time', 'ended', 'error']),
  /** Posição efetiva do player nativo no instante do evento. */
  positionMs: z.number().min(0),
  /** `paused` que não veio de um pedido pela ponte (foco de áudio, tecla de mídia, fone removido). */
  external: z.boolean().optional(),
  reason: z.enum(['missing', 'unplayable', 'unknown']).optional(),
});
export type AudioStateEvent = z.infer<typeof audioStateEventSchema>;

// ── métodos ─────────────────────────────────────────────────────────────────

/** Tudo o que o bundle pode pedir ao host: parâmetros (estritos) e resultado. */
export const hostMethods = {
  'host.info': {
    params: empty,
    result: z.object({
      bridgeVersion: z.int().min(1),
      host: z.enum(['android', 'mock']),
      appVersion: z.string().max(60),
      fontPackVersion: z.string().max(20),
    }),
  },
  /** Mantém a tela ligada durante a sessão. */
  'host.setKeepAwake': { params: z.strictObject({ on: z.boolean() }), result: empty },
  /** Voltar na tela inicial: o host decide como sair do aplicativo. */
  'host.exit': { params: empty, result: empty },

  'prefs.get': { params: empty, result: z.object({ prefs: projectorPrefsSchema }) },
  'prefs.set': { params: z.strictObject({ prefs: projectorPrefsSchema.partial() }), result: z.object({ prefs: projectorPrefsSchema }) },

  'library.listSetlists': { params: pageParams, result: z.object({ items: z.array(setlistSummarySchema), nextCursor: cursor }) },
  'library.getSetlist': { params: z.strictObject({ setlistId: uuidSchema }), result: z.object({ setlist: setlistSummarySchema, items: z.array(setlistEntrySchema) }) },
  'library.listSongs': { params: pageParams, result: z.object({ items: z.array(songSummarySchema), nextCursor: cursor }) },
  'library.getPresentable': { params: z.strictObject({ arrangementId: uuidSchema }), result: presentableSchema },

  /** Grava a base da sessão e encerra a anterior, na mesma transação. */
  'session.create': { params: z.strictObject({ sessionId: uuidSchema, snapshot: opaque, context: sessionContextSchema }), result: empty },
  /** Só responde depois de o checkpoint estar gravado. */
  'session.saveCheckpoint': { params: z.strictObject({ sessionId: uuidSchema, checkpoint: opaque }), result: z.object({ savedAt: isoInstantSchema }) },
  'session.findRecoverable': { params: empty, result: z.object({ session: recoverableSessionSchema.nullable() }) },
  'session.end': { params: z.strictObject({ sessionId: uuidSchema }), result: empty },

  /** Abre o seletor de arquivos do sistema, copia o pacote escolhido e o confere. */
  'files.pickPackage': { params: empty, result: pickPackageResultSchema },
  'files.applyImport': { params: z.strictObject({ importId: z.string().min(1).max(64) }), result: z.object({ setlistId: uuidSchema }) },
  'files.discardImport': { params: z.strictObject({ importId: z.string().min(1).max(64) }), result: empty },

  /** Prepara o player único com o arquivo local conferido; não toca. */
  'audio.load': { params: z.strictObject({ assetId: uuidSchema, sha256: sha256Schema }), result: z.object({ durationMs: z.number().min(0) }) },
  'audio.play': { params: empty, result: empty },
  'audio.pause': { params: empty, result: z.object({ positionMs: z.number().min(0) }) },
  /** Responde com a posição confirmada pelo player. */
  'audio.seek': { params: z.strictObject({ positionMs: z.number().min(0) }), result: z.object({ positionMs: z.number().min(0) }) },
  'audio.setVolume': { params: z.strictObject({ volume: z.number().min(0).max(1) }), result: empty },
  'audio.release': { params: empty, result: empty },

  'account.status': { params: empty, result: accountStatusSchema },
  /** Abre a tela nativa de entrada (teclado do sistema); credenciais não passam pelo bundle. */
  'account.signIn': { params: empty, result: z.object({ status: z.enum(['signed-in', 'cancelled', 'failed', 'offline']) }) },
  'account.signOut': { params: empty, result: empty },
  'account.syncNow': { params: empty, result: z.object({ started: z.boolean() }) },
} as const;

export type HostMethod = keyof typeof hostMethods;
export type HostParams<M extends HostMethod> = z.input<(typeof hostMethods)[M]['params']>;
export type HostResult<M extends HostMethod> = z.output<(typeof hostMethods)[M]['result']>;
export const HOST_METHODS = Object.keys(hostMethods) as HostMethod[];

// ── eventos ─────────────────────────────────────────────────────────────────

/** Tudo o que o host avisa sem ser perguntado. */
export const hostEvents = {
  'remote.key': remoteKeyEventSchema,
  'audio.state': audioStateEventSchema,
  'files.progress': z.object({ phase: z.enum(['copying', 'verifying', 'importing']), loadedBytes: count, totalBytes: count }),
  'account.changed': accountStatusSchema,
  /** `background`: Home, outro aplicativo, suspensão. O bundle pausa e grava o checkpoint. */
  'host.lifecycle': z.object({ state: z.enum(['foreground', 'background']) }),
} as const;

export type HostEventName = keyof typeof hostEvents;
export type HostEventPayload<E extends HostEventName> = z.output<(typeof hostEvents)[E]>;
export const HOST_EVENTS = Object.keys(hostEvents) as HostEventName[];

// ── envelopes ───────────────────────────────────────────────────────────────

const version = z.literal(BRIDGE_VERSION);
const requestId = z.int().min(1);

/** Bundle → host. */
export const hostRequestSchema = z.strictObject({
  v: version,
  kind: z.literal('request'),
  id: requestId,
  method: z.enum(HOST_METHODS as [HostMethod, ...HostMethod[]]),
  params: z.record(z.string(), z.unknown()),
});
export type HostRequest = z.infer<typeof hostRequestSchema>;

/** Host → bundle: resposta a um pedido, ou evento. */
export const hostMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    v: version,
    kind: z.literal('response'),
    id: requestId,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    v: version,
    kind: z.literal('error'),
    id: requestId,
    error: z.object({ code: z.enum(HOST_ERROR_CODES), message: z.string().max(500) }),
  }),
  z.object({
    v: version,
    kind: z.literal('event'),
    event: z.enum(HOST_EVENTS as [HostEventName, ...HostEventName[]]),
    payload: z.unknown(),
  }),
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;

/**
 * Objeto que o host expõe em `window[BRIDGE_GLOBAL]` — o formato do
 * `WebViewCompat.addWebMessageListener`: texto para lá, texto para cá.
 */
export interface HostPort {
  postMessage(message: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}
