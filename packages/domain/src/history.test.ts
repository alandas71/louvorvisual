import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, createHistory, HISTORY_LIMIT, pushHistory, redoHistory, undoHistory } from './history';

describe('histórico de edição', () => {
  it('desfaz e refaz a última operação', () => {
    let history = pushHistory(pushHistory(createHistory('a'), 'b'), 'c');
    expect(canUndo(history)).toBe(true);
    history = undoHistory(history);
    expect(history.present).toBe('b');
    expect(canRedo(history)).toBe(true);
    history = redoHistory(history);
    expect(history.present).toBe('c');
    expect(canRedo(history)).toBe(false);
  });

  it('nova operação depois de desfazer descarta o que seria refeito', () => {
    const history = pushHistory(undoHistory(pushHistory(createHistory('a'), 'b')), 'c');
    expect(history).toMatchObject({ past: ['a'], present: 'c', future: [] });
  });

  it('desfazer sem operações não muda nada', () => {
    const history = createHistory('a');
    expect(undoHistory(history)).toBe(history);
    expect(redoHistory(history)).toBe(history);
  });

  it('digitação com a mesma chave conta como uma operação', () => {
    let history = createHistory('');
    for (const text of ['S', 'Sa', 'San']) history = pushHistory(history, text, 'texto:o1');
    history = pushHistory(history, 'outro', 'texto:o2');
    expect(history.past).toEqual(['', 'San']);
    expect(undoHistory(undoHistory(history)).present).toBe('');
  });

  it('depois de desfazer, a mesma chave abre outra operação', () => {
    let history = pushHistory(createHistory('a'), 'ab', 'k');
    history = pushHistory(undoHistory(history), 'ac', 'k');
    expect(history.past).toEqual(['a']);
  });

  it('guarda no máximo o limite de operações', () => {
    let history = createHistory(0);
    for (let value = 1; value <= HISTORY_LIMIT + 20; value += 1) history = pushHistory(history, value);
    expect(history.past).toHaveLength(HISTORY_LIMIT);
  });
});
