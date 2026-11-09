// Classificação da política de divulgação de um grupo do Facebook (spec 19). Decide se um grupo
// aceita posts de divulgação, a partir do texto VISÍVEL que a extensão coletou (regras, descrição
// e últimos posts). Função pura e testável; nenhuma leitura interna do Facebook. É só um palpite:
// pessoa ou agente pode corrigir, e um post removido depois também corrige.
import type { FacebookGroupCollected } from "@ofertas/contracts";

export type PostingPolicy = "allowed" | "approval" | "restricted" | "forbidden" | "unknown";

/** Link de loja ou afiliado num texto de post (sinal de que o grupo aceita divulgação na prática). */
const STORE_LINK =
  /amzn\.to|amazon\.com|mercadolivre|mercadolibre|meli\.la|magazineluiza|magalu|shopee|aliexpress|amzn\.com|\/sec\/|afiliad|cupom|🔥|desconto|r\$\s?\d/i;

/** Expressões que indicam que divulgação é proibida. */
const FORBIDDEN = [
  /proibid[oa]s?\s+(a\s+)?divulga/i,
  /n[ãa]o\s+[ée]?\s*permitid[oa]s?\s+(a\s+)?divulga/i,
  /sem\s+divulga[çc]/i,
  /proibid[oa]s?\s+.{0,12}\blinks?\b/i,
  /sem\s+links?\b/i,
  /n[ãa]o\s+.{0,12}\blinks?\b/i,
  /proibid[oa]s?\s+vend/i,
  /sem\s+vendas?\b/i,
  /n[ãa]o\s+.{0,10}spam/i,
  /ser[áa]\s+(removido|banido|exclu[íi]do)/i,
  /somente\s+(assuntos|conte[úu]do)\s+do\s+grupo/i,
];

/** Expressões que indicam divulgação liberada. */
const ALLOWED = [
  /divulga[çc][ãa]o\s+liberad/i,
  /pode\s+divulgar/i,
  /livre\s+divulga/i,
  /grupo\s+de\s+divulga/i,
  /divulgue\s+(seu|[àa]\s+vontade|aqui)/i,
  /libera[do]*\s+.{0,8}divulga/i,
];

/** Expressões de divulgação com condição. */
const RESTRICTED = [
  /dia\s+de\s+divulga/i,
  /divulga[çc][ãa]o\s+(apenas|s[óo]|somente)/i,
  /(apenas|s[óo]|somente)\s+.{0,15}divulga/i,
  /\b1\s+post\s+por\s+dia\b/i,
  /um\s+post\s+por\s+dia/i,
  /(sextas?|s[áa]bados?|domingos?)\s+.{0,15}divulga/i,
];

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

export type PolicyVerdict = {
  policy: PostingPolicy;
  notes: string | null;
  evidence: string[];
};

/**
 * Classifica a política a partir do coletado. Ordem: proibição explícita vence; depois a prática
 * (vários posts de membros com link = aceita); depois condição; depois liberação explícita; senão
 * `unknown` (não recebe post até alguém decidir).
 */
export function classifyGroupPolicy(collected: FacebookGroupCollected): PolicyVerdict {
  const rules = (collected.rules_text ?? "").slice(0, 8000);
  const posts = collected.post_texts ?? [];
  const withLink = posts.filter((t) => STORE_LINK.test(t)).length;
  const evidence: string[] = [];

  const forbidden = firstMatch(rules, FORBIDDEN);
  if (forbidden) {
    return { policy: "forbidden", notes: null, evidence: [`Regras: "${forbidden.trim()}"`] };
  }

  // Prática do grupo: muitos posts de membros com link de loja é o sinal mais forte.
  const manyLinks = posts.length >= 4 && withLink >= Math.max(3, Math.ceil(posts.length / 2));
  if (withLink > 0) evidence.push(`${withLink} de ${posts.length} posts recentes com link de loja`);

  const restricted = firstMatch(rules, RESTRICTED);
  if (restricted) {
    return {
      policy: "restricted",
      notes: restricted.trim(),
      evidence: [`Regras: "${restricted.trim()}"`, ...evidence],
    };
  }

  const allowed = firstMatch(rules, ALLOWED);
  if (allowed) {
    return {
      policy: "allowed",
      notes: null,
      evidence: [`Regras: "${allowed.trim()}"`, ...evidence],
    };
  }
  if (manyLinks) {
    return { policy: "allowed", notes: "Membros divulgam links no feed.", evidence };
  }
  return {
    policy: "unknown",
    notes: null,
    evidence: evidence.length ? evidence : ["Sem sinais claros nas regras nem nos posts."],
  };
}

/** Grupos que podem receber post de divulgação. `unknown`/`forbidden` não. */
export function policyAllowsPosting(policy: PostingPolicy | null | undefined): boolean {
  return policy === "allowed" || policy === "approval" || policy === "restricted";
}
