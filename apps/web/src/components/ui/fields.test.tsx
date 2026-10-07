import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Input } from './Input';
import { Label } from './Label';
import { Textarea } from './Textarea';

describe('campos de formulário', () => {
  it('sem erro, não marca o campo como inválido', () => {
    const html = renderToStaticMarkup(<Input name="title" />);
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('aria-describedby');
  });

  it('associa a mensagem de erro ao campo', () => {
    const html = renderToStaticMarkup(<Textarea name="lyrics" error="Informe a letra" />);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain('aria-invalid="true"');
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<span id="${describedBy}"`);
    expect(html).toContain('Informe a letra');
  });

  it('o asterisco de obrigatório não é lido como conteúdo do rótulo', () => {
    expect(renderToStaticMarkup(<Label required>Título</Label>)).toContain('<span aria-hidden="true"');
  });
});
