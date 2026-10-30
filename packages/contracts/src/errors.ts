import { z } from "zod";

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "FORBIDDEN_SCOPE",
  "NOT_FOUND",
  "CONFLICT",
  "LIMIT_EXCEEDED",
  "ACTION_BLOCKED",
  "IDEMPOTENCY_CONFLICT",
  "NOT_CONFIGURED",
  "PROVIDER_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorResponse = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    hint: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
