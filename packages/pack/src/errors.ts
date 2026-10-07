export type PackageErrorCode =
  /** Não é um ZIP no subconjunto aceito (comprimido, criptografado, truncado, com sobras). */
  | 'not-a-package'
  | 'too-large'
  | 'unsafe-path'
  | 'manifest-missing'
  | 'manifest-invalid'
  /** Escrito por uma versão do formato que este leitor não sabe ler. */
  | 'format-too-new'
  /** Documentos em uma versão de esquema mais nova do que a deste aplicativo. */
  | 'schema-too-new'
  | 'schema-unsupported'
  | 'font-pack-incompatible'
  /** Tema ou fonte de fábrica que este aplicativo não tem. */
  | 'catalog-missing'
  /** Arquivo presente no ZIP e ausente no manifesto. */
  | 'unexpected-file'
  | 'missing-file'
  /** Tamanho, CRC ou SHA-256 diferente do registrado: arquivo corrompido ou adulterado. */
  | 'hash-mismatch'
  | 'document-invalid'
  /** Referência a algo que não está no pacote, ou a outro espaço. */
  | 'reference-broken'
  /** Exportação: o repertório não pode ser empacotado como está. */
  | 'incomplete';

/** Falha de leitura ou escrita de pacote. Nada é gravado quando ela acontece. */
export class PackageError extends Error {
  constructor(
    readonly code: PackageErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PackageError';
  }
}
