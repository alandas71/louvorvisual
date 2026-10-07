import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { AppError } from '../utils/AppError';

type Schemas = { body?: ZodType; query?: ZodType; params?: ZodType };

export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      // No Express 5, req.query é somente leitura: validar aqui e ler os valores
      // normalizados no handler, com o mesmo esquema.
      if (schemas.query) schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params) as Request['params'];
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new AppError(400, 'VALIDATION_ERROR', 'Dados inválidos.', error.flatten()));
        return;
      }
      next(error);
    }
  };
}
