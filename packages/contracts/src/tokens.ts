import { z } from "zod";
import { SCOPE_PRESETS, type ScopePreset, TOKEN_SCOPES } from "./scopes";

const presetKeys = Object.keys(SCOPE_PRESETS) as [ScopePreset, ...ScopePreset[]];

export const CreateTokenInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    preset: z.enum(presetKeys).optional(),
    scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).optional(),
    expires_in_days: z.number().int().min(1).max(365).optional(),
  })
  .refine((v) => v.preset || v.scopes, { message: "Informe preset ou scopes." });
export type CreateTokenInput = z.infer<typeof CreateTokenInput>;

export const ApiToken = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
export type ApiToken = z.infer<typeof ApiToken>;

export const CreatedToken = ApiToken.extend({
  token: z.string().describe("Valor do token. Exibido apenas uma vez."),
});
export type CreatedToken = z.infer<typeof CreatedToken>;
