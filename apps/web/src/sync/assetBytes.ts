import type { AssetBytes, AssetDoc } from '@louvorvisual/sync';
import { assetPresent, hashBlob, readAssetBlob } from '@/local/assets';
import type { LocalDatabase } from '@/local/db';
import { assetBlobKey, type AssetBlobRow } from '@/local/schema';

/**
 * Bytes de mídia do perfil. Um download só fica disponível depois de reler o
 * que foi gravado e conferir tamanho e SHA-256 (planejamento/08): escrita em
 * área de preparação, verificação e só então publicação.
 */
export class LocalAssetBytes implements AssetBytes {
  constructor(
    private readonly db: LocalDatabase,
    private readonly profileId: string,
  ) {}

  read(asset: AssetDoc): Promise<Blob | null> {
    return readAssetBlob(this.db, asset.workspaceId, asset.sha256);
  }

  has(asset: AssetDoc): Promise<boolean> {
    return assetPresent(this.db, asset);
  }

  async write(asset: AssetDoc, blob: Blob): Promise<'stored' | 'mismatch'> {
    if (blob.size !== asset.byteSize || (await hashBlob(blob)) !== asset.sha256) return 'mismatch';
    const key = assetBlobKey(asset.workspaceId, asset.sha256);
    const now = new Date().toISOString();
    const staged: AssetBlobRow = { key, profileId: this.profileId, workspaceId: asset.workspaceId, sha256: asset.sha256, byteSize: asset.byteSize, mimeType: asset.mimeType, blob, state: 'staged', storedAt: now, verifiedAt: null };
    await this.db.assetBlobs.put(staged);
    const written = await this.db.assetBlobs.get(key);
    const intact = written !== undefined && written.blob.size === asset.byteSize && (await hashBlob(written.blob)) === asset.sha256;
    if (!intact) {
      await this.db.assetBlobs.delete(key);
      return 'mismatch';
    }
    await this.db.assetBlobs.update(key, { state: 'ready', verifiedAt: new Date().toISOString() });
    return 'stored';
  }
}
