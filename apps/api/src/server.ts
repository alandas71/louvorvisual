import { createApp } from './app';
import { PrismaClient } from '@prisma/client';
import { LocalAssetStorage, PrismaIdentityStore } from './modules/identity/prisma-identity-store';
import { assertProductionConfig, readApiConfig } from './config';
import { PrismaRetentionService } from './modules/retention/prisma-retention-service';
import { PrismaSyncStore } from './modules/sync/prisma-sync-store';

const port = Number(process.env.LOUVORVISUAL_API_PORT ?? process.env.PORT ?? 3021);
const databaseUrl = process.env.LOUVORVISUAL_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('LOUVORVISUAL_DATABASE_URL é obrigatória para iniciar a API.');
const accessSecret = process.env.LOUVORVISUAL_ACCESS_SECRET;
const mediaDir = process.env.LOUVORVISUAL_MEDIA_DIR;
const config = readApiConfig();
assertProductionConfig(config);
if (process.env.NODE_ENV === 'production' && !accessSecret) throw new Error('LOUVORVISUAL_ACCESS_SECRET é obrigatória em produção.');
if (!mediaDir) throw new Error('LOUVORVISUAL_MEDIA_DIR é obrigatória para iniciar a API.');
// Prisma lê DATABASE_URL. O nome com prefixo evita colisão entre serviços no
// deploy; esta atribuição ocorre somente no processo, nunca é registrada.
process.env.DATABASE_URL = databaseUrl;

const prisma = new PrismaClient();
const identityStore = new PrismaIdentityStore(prisma, new LocalAssetStorage(mediaDir), accessSecret ?? 'development-only-insecure-secret', config.sessionDays);
await identityStore.recoverPartialUploads();
const retention = new PrismaRetentionService(prisma);
const retentionPolicy = { trashDays: config.trashRetentionDays, syncDays: config.syncRetentionDays, sessionDays: config.sessionDays };
await retention.run(retentionPolicy);
setInterval(() => { void retention.run(retentionPolicy).catch((error: unknown) => console.error('Falha no job de retenção', error)); }, 12 * 60 * 60_000).unref();
createApp({ syncStore: new PrismaSyncStore(prisma), identityStore }).listen(port, () => {
  console.log(`API ouvindo em http://localhost:${port}`);
});
