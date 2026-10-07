import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type RequestWithId = Request & { requestId: string };

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  (req as RequestWithId).requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
