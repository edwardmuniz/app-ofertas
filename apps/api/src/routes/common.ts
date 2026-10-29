import { ErrorResponse } from "@ofertas/contracts";
import type { MutationOptions } from "@ofertas/core";
import { z } from "zod";

export const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
};

/** Opções de mutação na REST: ?dry_run=true, header Idempotency-Key e X-Audit-Reason. */
export const MutationQuery = z.object({
  dry_run: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});
export const MutationHeaders = z.object({
  "idempotency-key": z.string().min(8).max(200).optional(),
  "x-audit-reason": z.string().max(500).optional(),
});

export const MutationResult = <T extends z.ZodType>(result: T) =>
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("done"), result }),
    z.object({ status: z.literal("dry_run"), preview: z.unknown() }),
    z.object({
      status: z.literal("pending_approval"),
      approval_id: z.string(),
      preview: z.unknown(),
    }),
  ]);

export function mutationOpts(req: {
  query: z.infer<typeof MutationQuery>;
  headers: z.infer<typeof MutationHeaders>;
}): MutationOptions {
  return {
    dryRun: req.query.dry_run,
    idempotencyKey: req.headers["idempotency-key"],
    reason: req.headers["x-audit-reason"],
  };
}

/** Esquema comum das rotas que alteram algo. */
export const mutationSchema = { querystring: MutationQuery, headers: MutationHeaders };
