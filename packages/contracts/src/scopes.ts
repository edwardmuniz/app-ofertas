export const SCOPES = [
  "offers:read",
  "offers:write",
  "channels:read",
  "channels:write",
  "posts:read",
  "posts:write",
  "links:read",
  "links:write",
  "creatives:read",
  "creatives:write",
  "ads:read",
  "ads:write",
  "metrics:read",
  "growth:read",
  "growth:write",
  "settings:read",
  "settings:write",
  "approvals:decide",
] as const;

export type Scope = (typeof SCOPES)[number];

/** Escopos que podem ser dados a tokens de agente. Decidir aprovações é exclusivo de humanos. */
export const TOKEN_SCOPES = SCOPES.filter((s) => s !== "approvals:decide") as Exclude<
  Scope,
  "approvals:decide"
>[];
export type TokenScope = (typeof TOKEN_SCOPES)[number];

const READ_SCOPES = TOKEN_SCOPES.filter((s) => s.endsWith(":read"));

export const SCOPE_PRESETS = {
  read_only: {
    label: "Somente leitura",
    scopes: READ_SCOPES,
  },
  operation: {
    label: "Operação (ofertas, posts, links, criativos)",
    scopes: [
      ...READ_SCOPES,
      "offers:write",
      "posts:write",
      "links:write",
      "creatives:write",
    ] as TokenScope[],
  },
  full_no_spend: {
    label: "Completo sem gasto (sem anúncios)",
    scopes: TOKEN_SCOPES.filter((s) => s !== "ads:write"),
  },
  full: {
    label: "Completo",
    scopes: TOKEN_SCOPES,
  },
} as const satisfies Record<string, { label: string; scopes: readonly TokenScope[] }>;

export type ScopePreset = keyof typeof SCOPE_PRESETS;

export const ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  owner: SCOPES,
  admin: SCOPES,
  operator: SCOPES.filter((s) => s !== "settings:write"),
  viewer: SCOPES.filter((s) => s.endsWith(":read")),
};
