import { PackageError } from './errors';

// Contêiner ZIP do pacote. O formato usa de propósito um subconjunto mínimo:
// entradas armazenadas sem compressão (método 0), sem criptografia, sem
// descritor de dados, sem ZIP64, sem campos extras e sem comentário. Assim o
// tamanho expandido é o tamanho do arquivo, a leitura não depende de
// descompressor e qualquer byte fora do previsto é recusado. Áudio já é
// comprimido; os documentos JSON são pequenos.

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_BYTES = 22;
/** Bit 11: nomes em UTF-8. É o único bit de uso geral aceito. */
const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 10;
/** Data fixa (1980-01-01 00:00): o mesmo conteúdo produz o mesmo arquivo. */
const DOS_DATE = 0x0021;
const MAX_UINT32 = 0xffffffff;
const MAX_UINT16 = 0xffff;
export const MAX_PATH_BYTES = 255;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) incremental. */
export class Crc32 {
  private crc = 0xffffffff;

  update(chunk: Uint8Array): this {
    let crc = this.crc;
    for (let index = 0; index < chunk.length; index += 1) crc = (CRC_TABLE[(crc ^ (chunk[index] as number)) & 0xff] as number) ^ (crc >>> 8);
    this.crc = crc;
    return this;
  }

  digest(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}

/** Lê um blob em pedaços, sem carregá-lo inteiro na memória. */
export async function eachChunk(blob: Blob, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onChunk(value);
  }
}

/**
 * Caminho aceito dentro do pacote: ASCII visível, relativo, sem `..`, sem
 * barra invertida e sem terminar em barra. O manifesto ainda restringe os
 * caminhos aos padrões do formato.
 */
export function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_BYTES) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(path)) return false;
  if (path.startsWith('/') || path.endsWith('/')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export type ZipInput = { path: string; data: Blob; crc32: number };

function ascii(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

/**
 * Monta o arquivo ZIP. Os blobs de dados entram por referência: o resultado é
 * um `Blob` composto, e o conteúdo não é copiado para a memória.
 */
export function writeZip(entries: readonly ZipInput[]): Blob {
  if (entries.length > MAX_UINT16 - 1) throw new PackageError('too-large', 'O pacote teria arquivos demais.');
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    if (!isSafePath(entry.path) || seen.has(entry.path)) throw new PackageError('unsafe-path', `Caminho inválido ou repetido no pacote: ${entry.path}`);
    seen.add(entry.path);
    const name = ascii(entry.path);
    const size = entry.data.size;
    if (size > MAX_UINT32 || offset > MAX_UINT32) throw new PackageError('too-large', 'O pacote passa do limite de 4 GiB do formato.');

    const local = new DataView(new ArrayBuffer(LOCAL_HEADER_BYTES));
    local.setUint32(0, LOCAL_SIGNATURE, true);
    local.setUint16(4, VERSION_NEEDED, true);
    local.setUint16(6, FLAG_UTF8, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, entry.crc32, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, entry.data);

    const header = new Uint8Array(new ArrayBuffer(CENTRAL_HEADER_BYTES + name.length));
    const view = new DataView(header.buffer);
    view.setUint32(0, CENTRAL_SIGNATURE, true);
    view.setUint16(4, VERSION_NEEDED, true);
    view.setUint16(6, VERSION_NEEDED, true);
    view.setUint16(8, FLAG_UTF8, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, DOS_DATE, true);
    view.setUint32(16, entry.crc32, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, name.length, true);
    view.setUint32(42, offset, true);
    header.set(name, CENTRAL_HEADER_BYTES);
    central.push(header);
    offset += LOCAL_HEADER_BYTES + name.length + size;
  }
  const centralSize = central.reduce((total, header) => total + header.length, 0);
  if (offset + centralSize > MAX_UINT32) throw new PackageError('too-large', 'O pacote passa do limite de 4 GiB do formato.');
  const end = new DataView(new ArrayBuffer(END_BYTES));
  end.setUint32(0, END_SIGNATURE, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

export type ZipEntry = {
  path: string;
  size: number;
  crc32: number;
  /** Fatia do arquivo original; os bytes só são lidos quando alguém pede. */
  data: Blob;
};

const notZip = (detail: string) => new PackageError('not-a-package', `O arquivo não é um pacote LouvorVisual válido (${detail}).`);

async function viewOf(file: Blob, start: number, length: number): Promise<DataView> {
  return new DataView(await file.slice(start, start + length).arrayBuffer());
}

/**
 * Lê o índice do ZIP e confere que o arquivo é exatamente o que o escritor
 * produz: entradas armazenadas, contíguas a partir do byte 0, cabeçalhos
 * locais iguais aos do índice e nada sobrando entre as partes ou no fim.
 * Não lê os dados das entradas.
 */
export async function readZip(file: Blob, limits: { maxEntries: number }): Promise<ZipEntry[]> {
  if (file.size < END_BYTES) throw notZip('arquivo curto demais');
  const endOffset = file.size - END_BYTES;
  const end = await viewOf(file, endOffset, END_BYTES);
  if (end.getUint32(0, true) !== END_SIGNATURE) throw notZip('fim do arquivo não reconhecido');
  const count = end.getUint16(10, true);
  const centralSize = end.getUint32(12, true);
  const centralOffset = end.getUint32(16, true);
  if (end.getUint16(4, true) !== 0 || end.getUint16(6, true) !== 0 || end.getUint16(8, true) !== count || end.getUint16(20, true) !== 0) throw notZip('arquivo em várias partes ou com comentário');
  if (count === MAX_UINT16 || centralOffset === MAX_UINT32 || centralSize === MAX_UINT32) throw notZip('ZIP64 não é aceito');
  if (count > limits.maxEntries) throw new PackageError('too-large', `O pacote tem ${count} arquivos; o limite é ${limits.maxEntries}.`);
  if (centralOffset + centralSize !== endOffset) throw notZip('índice fora do lugar');
  if (centralSize !== 0 && centralSize < count * CENTRAL_HEADER_BYTES) throw notZip('índice incompleto');
  // Sem campos extras nem comentários, o índice tem um teto conhecido: recusar
  // antes de ler evita carregar na memória um intervalo arbitrário do arquivo.
  if (centralSize > count * (CENTRAL_HEADER_BYTES + MAX_PATH_BYTES)) throw notZip('índice maior do que as entradas permitem');

  const central = await viewOf(file, centralOffset, centralSize);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: (ZipEntry & { offset: number; nameLength: number })[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > centralSize || central.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw notZip('índice corrompido');
    const flags = central.getUint16(cursor + 8, true);
    const method = central.getUint16(cursor + 10, true);
    const crc32 = central.getUint32(cursor + 16, true);
    const compressedSize = central.getUint32(cursor + 20, true);
    const size = central.getUint32(cursor + 24, true);
    const nameLength = central.getUint16(cursor + 28, true);
    const extraLength = central.getUint16(cursor + 30, true);
    const commentLength = central.getUint16(cursor + 32, true);
    const offset = central.getUint32(cursor + 42, true);
    if ((flags & ~FLAG_UTF8) !== 0) throw notZip('entrada criptografada ou com descritor de dados');
    if (method !== 0 || compressedSize !== size) throw notZip('entrada comprimida');
    if (extraLength !== 0 || commentLength !== 0 || central.getUint16(cursor + 34, true) !== 0) throw notZip('campos extras não são aceitos');
    if (size === MAX_UINT32 || offset === MAX_UINT32) throw notZip('ZIP64 não é aceito');
    if (cursor + CENTRAL_HEADER_BYTES + nameLength > centralSize) throw notZip('índice corrompido');
    let path: string;
    try {
      path = decoder.decode(new Uint8Array(central.buffer, central.byteOffset + cursor + CENTRAL_HEADER_BYTES, nameLength));
    } catch {
      throw notZip('nome de arquivo ilegível');
    }
    if (!isSafePath(path)) throw new PackageError('unsafe-path', `O pacote contém um caminho não permitido: ${JSON.stringify(path).slice(0, 80)}`);
    if (seen.has(path)) throw new PackageError('unsafe-path', `O pacote contém o mesmo caminho duas vezes: ${path}`);
    seen.add(path);
    entries.push({ path, size, crc32, offset, nameLength, data: file.slice(0, 0) });
    cursor += CENTRAL_HEADER_BYTES + nameLength;
  }
  if (cursor !== centralSize) throw notZip('sobra no índice');

  // As entradas precisam cobrir, sem buracos nem sobreposição, do byte 0 ao índice.
  const ordered = [...entries].sort((a, b) => a.offset - b.offset);
  let expected = 0;
  for (const entry of ordered) {
    if (entry.offset !== expected) throw notZip('dados fora do lugar');
    const local = await viewOf(file, entry.offset, LOCAL_HEADER_BYTES + entry.nameLength);
    if (local.byteLength !== LOCAL_HEADER_BYTES + entry.nameLength || local.getUint32(0, true) !== LOCAL_SIGNATURE) throw notZip('cabeçalho de entrada ausente');
    const sameHeader =
      (local.getUint16(6, true) & ~FLAG_UTF8) === 0 &&
      local.getUint16(8, true) === 0 &&
      local.getUint32(14, true) === entry.crc32 &&
      local.getUint32(18, true) === entry.size &&
      local.getUint32(22, true) === entry.size &&
      local.getUint16(26, true) === entry.nameLength &&
      local.getUint16(28, true) === 0;
    let localPath = '';
    try {
      localPath = decoder.decode(new Uint8Array(local.buffer, LOCAL_HEADER_BYTES, entry.nameLength));
    } catch {
      // Tratado abaixo como divergência.
    }
    if (!sameHeader || localPath !== entry.path) throw notZip('cabeçalho de entrada diferente do índice');
    const start = entry.offset + LOCAL_HEADER_BYTES + entry.nameLength;
    entry.data = file.slice(start, start + entry.size);
    expected = start + entry.size;
  }
  if (expected !== centralOffset) throw notZip('dados fora do índice');
  return entries.map(({ path, size, crc32, data }) => ({ path, size, crc32, data }));
}
