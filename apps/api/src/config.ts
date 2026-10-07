const positiveInteger = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} deve ser um inteiro positivo.`);
  return value;
};

export type ApiConfig = {
  publicOrigin?: string;
  maxAssetBytes: number;
  sessionDays: number;
  syncRetentionDays: number;
  trashRetentionDays: number;
  backupRetentionDays: number;
  minClientVersion: string;
  maxClientVersion: string;
};

export function readApiConfig(): ApiConfig {
  const publicOrigin = process.env.LOUVORVISUAL_PUBLIC_ORIGIN ?? process.env.WEB_ORIGIN;
  if (publicOrigin) {
    try { new URL(publicOrigin); } catch { throw new Error('LOUVORVISUAL_PUBLIC_ORIGIN deve ser uma origem URL válida.'); }
  }
  return {
    publicOrigin,
    maxAssetBytes: positiveInteger('LOUVORVISUAL_MAX_ASSET_BYTES', 100 * 1024 * 1024),
    sessionDays: positiveInteger('LOUVORVISUAL_SESSION_DAYS', 30),
    trashRetentionDays: positiveInteger('LOUVORVISUAL_TRASH_RETENTION_DAYS', 30),
    syncRetentionDays: positiveInteger('LOUVORVISUAL_SYNC_RETENTION_DAYS', 180),
    backupRetentionDays: positiveInteger('LOUVORVISUAL_BACKUP_RETENTION_DAYS', 30),
    minClientVersion: process.env.LOUVORVISUAL_MIN_CLIENT_VERSION ?? '0.1.0',
    maxClientVersion: process.env.LOUVORVISUAL_MAX_CLIENT_VERSION ?? '0.1.x',
  };
}

export function assertProductionConfig(config: ApiConfig): void {
  if (process.env.NODE_ENV === 'production' && !config.publicOrigin) throw new Error('LOUVORVISUAL_PUBLIC_ORIGIN é obrigatória em produção.');
}

type Version = [number, number, number];
const version = (value: string): Version | null => { const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(value); return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null; };
const compare = (left: Version, right: Version) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

/** A ausência do cabeçalho mantém clientes antigos operando; quem o envia recebe validação explícita. */
export function clientVersionAccepted(value: string, config: Pick<ApiConfig, 'minClientVersion' | 'maxClientVersion'>): boolean {
  const current=version(value); const min=version(config.minClientVersion); if(!current||!min||compare(current,min)<0)return false;
  const wildcard=/^(\d+)\.(\d+)\.x$/.exec(config.maxClientVersion);
  if(wildcard)return current[0]===Number(wildcard[1])&&current[1]===Number(wildcard[2]);
  const max=version(config.maxClientVersion); return !!max&&compare(current,max)<=0;
}
