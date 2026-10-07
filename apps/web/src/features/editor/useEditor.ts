'use client';

import {
  bundledFont,
  canRedo,
  canUndo,
  createHistory,
  duplicateArrangement,
  editOccurrenceText,
  generateOccurrences,
  maxLinesForStyle,
  mergeOccurrences,
  moveOccurrence,
  pushHistory,
  reconcileAudioBindings,
  redoHistory,
  removeOccurrences,
  reparseLyrics,
  repeatOccurrences,
  setOccurrenceDuration,
  splitOccurrence,
  touch,
  undoHistory,
  type Arrangement,
  type ArrangementStructure,
  type EditErrorCode,
  type EditResult,
  type History,
  type SectionKind,
  type Song,
  type SongSection,
  type Uuid,
} from '@louvorvisual/domain';
import { measureSlideFit, type ArrangementVisual } from '@louvorvisual/presentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { entityStateKey, FLUSH_EVENT, getSong, listArrangements, saveDocuments, type LocalDocument, type LocalRevision, type LocalSession } from '@/local';
import { acquireEditLease } from '@/sync/leases';
import type { ReviewCode } from './messages';
import { DocumentSaver, type SaveStatus } from './saver';
import { canvasMeasurer, loadFontFace } from '@/presentation/measure';
import { resolveArrangementVisual } from './visual';

/** A face exata do arranjo já está disponível para medir, sem cair na fonte de reserva. */
function fontsReady(visual: ArrangementVisual): boolean {
  return document.fonts.check(`${visual.style.fontWeight} 48px "${bundledFont(visual.fontId).family}"`);
}

/** O que desfazer/refazer restaura: classificação das seções e a sequência de slides. */
type Snapshot = { sections: SongSection[]; structure: ArrangementStructure };

type Loaded = {
  song: Song;
  arrangement: Arrangement;
  /** Todos os arranjos ativos do louvor, para o seletor. */
  arrangements: { id: Uuid; name: string }[];
  history: History<Snapshot>;
};

export type EditorNotice = { kind: 'error'; code: EditErrorCode } | { kind: 'review'; codes: ReviewCode[] };

export type EditorState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready'; song: Song; arrangement: Arrangement; arrangements: Loaded['arrangements']; canUndo: boolean; canRedo: boolean };

type SongFields = Partial<Pick<Song, 'title' | 'artist' | 'authors' | 'musicalKey' | 'tags' | 'notes' | 'rawLyrics'>>;

function structureOf(arrangement: Arrangement): ArrangementStructure {
  const { occurrences, audioBindings, selectedAudioBindingId } = arrangement;
  return { occurrences, audioBindings, selectedAudioBindingId };
}

/**
 * Estado do editor de um louvor e de um de seus arranjos. Toda alteração passa
 * pelas regras puras do domínio e vai para a fila de gravação: digitação com
 * debounce, operações estruturais imediatamente.
 */
export function useEditor(session: LocalSession, songId: Uuid, arrangementId: Uuid | null) {
  const [loaded, setLoaded] = useState<Loaded | 'loading' | 'missing'>('loading');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ state: 'saved' });
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const current = useRef<Loaded | null>(null);
  const saver = useRef<DocumentSaver | null>(null);

  useEffect(() => {
    let active = true;
    const queue = new DocumentSaver((documents, revisions) => saveDocuments(session.db, documents, { revisions }), (status) => {
      if (active) setSaveStatus(status);
    });
    saver.current = queue;

    // Editor aberto = documentos marcados como em edição **antes** de serem
    // lidos. Daí em diante a sincronização não os troca por baixo desta tela:
    // uma versão remota fica adiada e, se houver edição local, vira conflito.
    const leases: (() => void)[] = [];
    const hold = async (key: string) => {
      const release = await acquireEditLease(session.db, [key]).catch(() => null);
      if (!release) return;
      if (active) leases.push(release);
      else release();
    };

    void (async () => {
      await hold(entityStateKey('song', songId));
      const candidates = await listArrangements(session.db, songId);
      const first = candidates.find((item) => item.id === arrangementId) ?? candidates[0];
      if (first) await hold(entityStateKey('arrangement', first.id));
      // Leitura feita já com as marcações gravadas.
      const song = await getSong(session.db, songId);
      const arrangements = song ? await listArrangements(session.db, songId) : [];
      const arrangement = arrangements.find((item) => item.id === first?.id) ?? arrangements[0];
      if (!active) return;
      if (!song || !arrangement) {
        setLoaded('missing');
        return;
      }
      const next: Loaded = {
        song,
        arrangement,
        arrangements: arrangements.map(({ id, name }) => ({ id, name })),
        history: createHistory({ sections: song.sections, structure: structureOf(arrangement) }),
      };
      current.current = next;
      setLoaded(next);
      const visual = resolveArrangementVisual(arrangement);
      void loadFontFace(visual.fontId, visual.style.fontWeight);
    })();

    // Sair do editor ou esconder a página conclui a escrita pendente.
    const onHide = () => void queue.flush();
    window.addEventListener('pagehide', onHide);
    window.addEventListener(FLUSH_EVENT, onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      active = false;
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener(FLUSH_EVENT, onHide);
      document.removeEventListener('visibilitychange', onHide);
      // A marcação só é solta depois de a última escrita do editor terminar.
      void queue.flush().finally(() => {
        for (const release of leases.splice(0)) release();
      });
      current.current = null;
    };
  }, [session, songId, arrangementId]);

  /** Publica o novo estado e agenda a gravação dos documentos que mudaram. */
  const commit = useCallback(
    (next: Loaded, options: { immediate?: boolean; revisions?: LocalRevision[] } = {}) => {
      const previous = current.current;
      if (!previous) return;
      const documents: LocalDocument[] = [];
      if (next.song !== previous.song) documents.push({ entityType: 'song', document: next.song });
      if (next.arrangement !== previous.arrangement) documents.push({ entityType: 'arrangement', document: next.arrangement });
      current.current = next;
      setLoaded(next);
      if (documents.length > 0) saver.current?.schedule(documents, options);
    },
    [],
  );

  /** Aplica um novo par seções/sequência registrando-o no histórico. */
  const applySnapshot = useCallback(
    (snapshot: Snapshot, options: { coalesceKey?: string; history?: History<Snapshot>; revisions?: LocalRevision[]; immediate?: boolean } = {}) => {
      const previous = current.current;
      if (!previous) return;
      const context = session.context();
      const song = snapshot.sections === previous.song.sections ? previous.song : touch({ ...previous.song, sections: snapshot.sections }, context);
      const arrangement =
        snapshot.structure.occurrences === previous.arrangement.occurrences &&
        snapshot.structure.audioBindings === previous.arrangement.audioBindings &&
        snapshot.structure.selectedAudioBindingId === previous.arrangement.selectedAudioBindingId
          ? previous.arrangement
          : touch({ ...previous.arrangement, ...snapshot.structure }, context);
      commit(
        { ...previous, song, arrangement, history: options.history ?? pushHistory(previous.history, snapshot, options.coalesceKey ?? null) },
        { immediate: options.immediate ?? true, revisions: options.revisions },
      );
    },
    [commit, session],
  );

  const applyEdit = useCallback(
    (run: (structure: ArrangementStructure) => EditResult, options: { coalesceKey?: string; immediate?: boolean } = {}): EditResult | null => {
      const previous = current.current;
      if (!previous) return null;
      const result = run(structureOf(previous.arrangement));
      if (!result.ok) {
        setNotice({ kind: 'error', code: result.error });
        return result;
      }
      // Depois de qualquer edição, os intervalos da faixa vinculada são recalculados
      // pelos tempos; um slide sem tempo desfaz o vínculo em vez de salvar um documento inválido.
      const audio = reconcileAudioBindings(result.structure);
      const review: ReviewCode[] = [...result.review, ...(audio.unlinked.length > 0 ? (['audio-unlinked'] as const) : [])];
      setNotice(review.length > 0 ? { kind: 'review', codes: review } : null);
      applySnapshot({ sections: previous.song.sections, structure: audio.structure }, options);
      return result;
    },
    [applySnapshot],
  );

  const newId = useCallback(() => session.context().newId(), [session]);

  const actions = {
    /** Metadados e letra: gravação com debounce; título em branco não é gravado. */
    updateSong(fields: SongFields) {
      const previous = current.current;
      if (!previous) return;
      if (fields.title !== undefined && fields.title.trim() === '') return;
      commit({ ...previous, song: touch({ ...previous.song, ...fields }, session.context()) });
    },
    updateArrangement(fields: Partial<Pick<Arrangement, 'name' | 'themeRef' | 'fontId' | 'themeOverrides'>>, immediate = true) {
      const previous = current.current;
      if (!previous) return;
      if (fields.name !== undefined && fields.name.trim() === '') return;
      const arrangement = touch({ ...previous.arrangement, ...fields }, session.context());
      commit(
        { ...previous, arrangement, arrangements: previous.arrangements.map((item) => (item.id === arrangement.id ? { id: item.id, name: arrangement.name } : item)) },
        { immediate },
      );
    },
    /** Corrige a classificação sugerida; os slides dessa seção acompanham o rótulo. */
    updateSection(sectionId: Uuid, fields: { kind?: SectionKind; label?: string }) {
      const previous = current.current;
      const section = previous?.song.sections.find((item) => item.id === sectionId);
      if (!previous || !section) return;
      const label = fields.label ?? section.label;
      const sections = previous.song.sections.map((item) =>
        item.id === sectionId ? { ...item, kind: fields.kind ?? item.kind, label, detection: 'manual' as const } : item,
      );
      const structure = structureOf(previous.arrangement);
      const occurrences =
        label === section.label
          ? structure.occurrences
          : structure.occurrences.map((item) => (item.sourceSectionId === sectionId && item.label === section.label ? { ...item, label } : item));
      applySnapshot(
        { sections, structure: occurrences === structure.occurrences ? structure : { ...structure, occurrences } },
        { coalesceKey: fields.label !== undefined ? `section-label:${sectionId}` : undefined, immediate: fields.label === undefined },
      );
    },
    editText: (ids: Uuid[], text: string) =>
      applyEdit((structure) => editOccurrenceText(structure, ids, text), { coalesceKey: `text:${ids.join(',')}`, immediate: false }),
    split: (id: Uuid, lineIndex: number) => applyEdit((structure) => splitOccurrence(structure, id, lineIndex, newId)),
    merge: (ids: Uuid[]) => applyEdit((structure) => mergeOccurrences(structure, ids)),
    repeat: (ids: Uuid[]) => applyEdit((structure) => repeatOccurrences(structure, ids, newId)),
    move: (id: Uuid, toIndex: number) => applyEdit((structure) => moveOccurrence(structure, id, toIndex)),
    remove: (ids: Uuid[]) => applyEdit((structure) => removeOccurrences(structure, ids)),
    setDuration: (ids: Uuid[], durationMs: number | null) => applyEdit((structure) => setOccurrenceDuration(structure, ids, durationMs)),
    /** Associações de áudio (arquivo, política, volume, ponto de partida, faixa ativa). */
    updateAudio: (change: (structure: ArrangementStructure) => ArrangementStructure) =>
      applyEdit((structure) => ({ ok: true, structure: change(structure), review: [], issues: [], createdIds: [] })),
    undo() {
      const previous = current.current;
      if (!previous || !canUndo(previous.history)) return;
      const history = undoHistory(previous.history);
      setNotice(null);
      applySnapshot(history.present, { history });
    },
    redo() {
      const previous = current.current;
      if (!previous || !canRedo(previous.history)) return;
      const history = redoHistory(previous.history);
      setNotice(null);
      applySnapshot(history.present, { history });
    },
    /** Prévia da regeneração a partir da letra atual, sem alterar nada. */
    previewRegeneration() {
      const previous = current.current;
      if (!previous) return null;
      const parsed = reparseLyrics(previous.song.rawLyrics, previous.song.sections, newId);
      const visual = resolveArrangementVisual(previous.arrangement);
      const maxLines = maxLinesForStyle(visual.style);
      // Com a fonte já carregada, a divisão conta as linhas como aparecem na tela.
      const visualLines = fontsReady(visual) ? (line: string) => measureSlideFit({ text: line, style: visual.style, fontId: visual.fontId }, canvasMeasurer).visualLines : undefined;
      return { parsed, occurrences: generateOccurrences(parsed, newId, { maxLines, visualLines }) };
    },
    /**
     * Substitui seções e sequência pela nova sugestão. O arranjo e o louvor
     * anteriores ficam guardados como revisão, na mesma transação.
     */
    regenerate() {
      const previous = current.current;
      const next = actions.previewRegeneration();
      if (!previous || !next) return;
      const context = session.context();
      const revisions: LocalRevision[] = [
        { id: context.newId(), entityType: 'song', entityId: previous.song.id, workspaceId: previous.song.workspaceId, createdAt: context.now, reason: 'regenerate', document: previous.song },
        { id: context.newId(), entityType: 'arrangement', entityId: previous.arrangement.id, workspaceId: previous.arrangement.workspaceId, createdAt: context.now, reason: 'regenerate', document: previous.arrangement },
      ];
      // As faixas continuam no arranjo; os slides novos não têm tempo, então a vinculada vira independente.
      const audio = reconcileAudioBindings({ occurrences: next.occurrences, audioBindings: previous.arrangement.audioBindings, selectedAudioBindingId: previous.arrangement.selectedAudioBindingId });
      setNotice(audio.unlinked.length > 0 ? { kind: 'review', codes: ['audio-unlinked'] } : null);
      applySnapshot({ sections: next.parsed.sections, structure: audio.structure }, { revisions });
    },
    /** Cria uma cópia independente do arranjo atual e devolve seu ID depois de gravada. */
    async duplicateArrangement(name: string): Promise<Uuid | null> {
      const previous = current.current;
      if (!previous || name.trim() === '') return null;
      await saver.current?.flush();
      const copy = duplicateArrangement(previous.arrangement, session.context(), { name: name.trim() });
      await saveDocuments(session.db, [{ entityType: 'arrangement', document: copy }]);
      return copy.id;
    },
    /** Conclui a escrita pendente; usar antes de trocar de item. */
    flush: () => saver.current?.flush() ?? Promise.resolve(),
    retrySave: () => void saver.current?.flush(),
    dismissNotice: () => setNotice(null),
  };

  const state: EditorState =
    loaded === 'loading' || loaded === 'missing'
      ? { status: loaded }
      : {
          status: 'ready',
          song: loaded.song,
          arrangement: loaded.arrangement,
          arrangements: loaded.arrangements,
          canUndo: canUndo(loaded.history),
          canRedo: canRedo(loaded.history),
        };

  return { state, saveStatus, notice, actions };
}

export type EditorActions = ReturnType<typeof useEditor>['actions'];
