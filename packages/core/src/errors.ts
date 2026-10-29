import type { ErrorCode, ErrorResponse } from "@ofertas/contracts";

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  FORBIDDEN_SCOPE: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ACTION_BLOCKED: 403,
  LIMIT_EXCEEDED: 429,
  PROVIDER_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export type AppErrorOptions = { hint?: string; details?: Record<string, unknown> };

/** Erro de negócio com código estável. REST e MCP convertem para o mesmo JSON. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }

  toJSON(): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
