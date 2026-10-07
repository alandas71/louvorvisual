import type { LocalDatabase } from '@/local/db';

const LEASE_TTL_MS = 20_000;
const LEASE_RENEW_MS = 5_000;
/**
 * A trava da janela é pedida logo antes de a marcação ser gravada. Uma
 * marcação criada até este intervalo antes da consulta das travas vale mesmo
 * sem trava visível: a consulta pode ter acontecido entre os dois passos.
 */
export const LEASE_GRACE_MS = 1_000;
const LOCK_PREFIX = 'lv-edit:';

export const editLockName = (holder: string) => `${LOCK_PREFIX}${holder}`;

/**
 * Editores vivos nesta origem, pelas travas (Web Locks) que cada um mantém
 * enquanto a sua janela existir. `null` quando o navegador não informa: aí
 * vale só a validade da marcação.
 */
export async function liveEditHolders(): Promise<Set<string> | null> {
  if (typeof navigator === 'undefined' || !navigator.locks?.query) return null;
  try {
    const state = await navigator.locks.query();
    return new Set((state.held ?? []).flatMap((lock) => (lock.name?.startsWith(LOCK_PREFIX) ? [lock.name.slice(LOCK_PREFIX.length)] : [])));
  } catch {
    return null;
  }
}

/** Segura uma trava enquanto a janela viver; o navegador a solta sozinho se a aba fechar ou travar. */
function holdLock(holder: string): Promise<() => void> {
  if (!navigator.locks?.request) return Promise.resolve(() => undefined);
  return new Promise((ready) => {
    void navigator.locks
      .request(editLockName(holder), () => new Promise<void>((release) => ready(release)))
      .catch(() => ready(() => undefined));
  });
}

/**
 * Marca documentos como abertos em um editor. Resolve só depois de a marcação
 * estar gravada: quem chama lê os documentos em seguida, e a partir daí nenhum
 * recebimento os troca por baixo do editor (a versão remota fica adiada). A
 * marcação vale entre janelas do perfil e morre junto com a janela que a criou.
 */
export async function acquireEditLease(db: LocalDatabase, keys: readonly string[]): Promise<() => void> {
  const holder = crypto.randomUUID();
  const createdAt = Date.now();
  const unlock = await holdLock(holder);
  const rows = () => keys.map((key) => ({ id: `${key}|${holder}`, key, holder, createdAt, expiresAt: Date.now() + LEASE_TTL_MS }));
  await db.editLeases.bulkPut(rows());
  // Marcações vencidas de janelas que fecharam sem avisar não se acumulam. A de
  // uma janela viva fica, mesmo vencida: ela só está com os timers atrasados.
  void liveEditHolders()
    .then((live) => db.editLeases.filter((lease) => lease.expiresAt < createdAt && !live?.has(lease.holder)).delete())
    .catch(() => undefined);
  const timer = setInterval(() => void db.editLeases.bulkPut(rows()).catch(() => undefined), LEASE_RENEW_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    void db.editLeases
      .bulkDelete(rows().map((row) => row.id))
      .catch(() => undefined)
      .finally(unlock);
  };
}
