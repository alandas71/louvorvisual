import type { NextFunction, Request, Response } from 'express';
import type { RequestWithId } from './requestId';
import { AppError } from '../utils/AppError';
import { IdentityError } from '../modules/identity/in-memory-identity-store';

export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'NOT_FOUND', `Rota não encontrada: ${req.method} ${req.path}`));
}

/** Erros do leitor de corpo do Express chegam com `type`; não são falhas internas. */
function fromBodyParser(error: unknown): AppError | null {
  const type = (error as { type?: unknown } | null)?.type;
  if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Requisição acima do limite.');
  if (type === 'entity.parse.failed') return new AppError(400, 'VALIDATION_ERROR', 'JSON inválido.');
  return null;
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  let appError = error instanceof AppError ? error : error instanceof IdentityError ? new AppError(error.status, error.code as import('../utils/AppError').ErrorCode, error.message) : fromBodyParser(error);
  const requestId = (req as RequestWithId).requestId;
  if (!appError) {
    console.error(`[${requestId}] erro não tratado`, error);
    appError = new AppError(500, 'INTERNAL_ERROR', 'Erro interno.');
  }
  res.status(appError.statusCode).json({
    error: { code: appError.code, message: appError.message, ...(appError.details === undefined ? {} : { details: appError.details }) },
    requestId,
  });
}
