import type { Arrangement, Asset, Setlist, Song, Theme } from '@louvorvisual/domain';
import type { ArrangementDocument } from './arrangement';
import type { AssetDocument } from './asset';
import type { SetlistDocument } from './setlist';
import type { SongDocument } from './song';
import type { ThemeDocument } from './theme';

// Verificação em tempo de compilação: o que os esquemas produzem é exatamente
// o tipo de domínio. Divergência entre os dois pacotes quebra o typecheck.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type DocumentsMatchDomain = [
  Assert<Same<SongDocument, Song>>,
  Assert<Same<ArrangementDocument, Arrangement>>,
  Assert<Same<ThemeDocument, Theme>>,
  Assert<Same<SetlistDocument, Setlist>>,
  Assert<Same<AssetDocument, Asset>>,
];
