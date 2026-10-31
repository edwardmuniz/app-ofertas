// Calendário sazonal do varejo brasileiro: datas calculadas por ano (sem tabela).
import {
  type SeasonalCalendar,
  SeasonalCalendarQuery,
  type SeasonalEvent,
} from "@ofertas/contracts";
import { workspaces } from "@ofertas/db";
import { eq } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, now } from "./context";
import { localDate } from "./tz";

const DAY = 86_400_000;

type Def = {
  key: string;
  name: string;
  date: (year: number) => Date;
  /** Dias de duração além do dia principal */
  extraDays?: number;
  prepDays: number;
  importance: SeasonalEvent["importance"];
  focus: string[];
  checklist: string[];
};

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
/** n-ésimo dia da semana (0 = domingo) do mês. */
const nthWeekday = (y: number, m: number, weekday: number, n: number) => {
  const first = utc(y, m, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utc(y, m, 1 + offset + (n - 1) * 7);
};
const lastWeekday = (y: number, m: number, weekday: number) => {
  const last = utc(y, m + 1, 0);
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return utc(y, m, last.getUTCDate() - back);
};
const blackFriday = (y: number) => lastWeekday(y, 11, 5);

const BASE_CHECKLIST = [
  "Criar busca salva com as palavras-chave da data e desconto mínimo.",
  "Preparar criativos (card de preço) com headline da data.",
  "Agendar esquenta: 1 post/dia por grupo na semana anterior.",
];

const DEFS: Def[] = [
  {
    key: "dia_do_consumidor",
    name: "Dia do Consumidor",
    date: (y) => utc(y, 3, 15),
    extraDays: 0,
    prepDays: 14,
    importance: "medium",
    focus: ["eletrônicos", "casa", "beleza"],
    checklist: BASE_CHECKLIST,
  },
  {
    key: "dia_das_maes",
    name: "Dia das Mães",
    date: (y) => nthWeekday(y, 5, 0, 2),
    prepDays: 21,
    importance: "high",
    focus: ["beleza", "perfumes", "eletroportáteis", "moda", "joias"],
    checklist: [...BASE_CHECKLIST, "Montar listas temáticas (presentes até R$ 100, R$ 200...)."],
  },
  {
    key: "6_6",
    name: "6.6 (Shopee)",
    date: (y) => utc(y, 6, 6),
    prepDays: 7,
    importance: "medium",
    focus: ["cupons Shopee", "casa", "acessórios"],
    checklist: [...BASE_CHECKLIST, "Avisar no grupo sobre cupons da meia-noite."],
  },
  {
    key: "dia_dos_namorados",
    name: "Dia dos Namorados",
    date: (y) => utc(y, 6, 12),
    prepDays: 14,
    importance: "medium",
    focus: ["perfumes", "eletrônicos", "moda", "experiências"],
    checklist: BASE_CHECKLIST,
  },
  {
    key: "7_7",
    name: "7.7 (Shopee)",
    date: (y) => utc(y, 7, 7),
    prepDays: 7,
    importance: "medium",
    focus: ["cupons Shopee"],
    checklist: BASE_CHECKLIST,
  },
  {
    key: "dia_dos_pais",
    name: "Dia dos Pais",
    date: (y) => nthWeekday(y, 8, 0, 2),
    prepDays: 21,
    importance: "high",
    focus: ["ferramentas", "eletrônicos", "esporte", "churrasco"],
    checklist: [...BASE_CHECKLIST, "Montar listas temáticas de presentes por faixa de preço."],
  },
  {
    key: "9_9",
    name: "9.9 (Shopee)",
    date: (y) => utc(y, 9, 9),
    prepDays: 7,
    importance: "medium",
    focus: ["cupons Shopee"],
    checklist: BASE_CHECKLIST,
  },
  {
    key: "dia_das_criancas",
    name: "Dia das Crianças",
    date: (y) => utc(y, 10, 12),
    prepDays: 21,
    importance: "high",
    focus: ["brinquedos", "games", "livros infantis"],
    checklist: [...BASE_CHECKLIST, "Separar ofertas por idade (0–3, 4–7, 8+)."],
  },
  {
    key: "10_10",
    name: "10.10 (Shopee)",
    date: (y) => utc(y, 10, 10),
    prepDays: 7,
    importance: "medium",
    focus: ["cupons Shopee"],
    checklist: BASE_CHECKLIST,
  },
  {
    key: "11_11",
    name: "11.11",
    date: (y) => utc(y, 11, 11),
    prepDays: 10,
    importance: "high",
    focus: ["cupons Shopee", "eletrônicos", "casa"],
    checklist: [
      ...BASE_CHECKLIST,
      "Reforçar captação de membros: convite no bio e stories na semana anterior.",
    ],
  },
  {
    key: "black_friday",
    name: "Black Friday",
    date: blackFriday,
    extraDays: 0,
    prepDays: 45,
    importance: "high",
    focus: ["eletrônicos", "eletrodomésticos", "smartphones", "casa", "games"],
    checklist: [
      "Abrir grupos extras antes (o grupo atual lota) e incluir no convite rotativo.",
      "Criar buscas salvas por categoria com desconto mínimo de 30%.",
      "Acompanhar histórico de preço: marcar ofertas com preço inflado antes da BF.",
      "Aumentar o ritmo gradualmente (esquenta) sem passar dos limites anti-banimento.",
      "Preparar cards com headline BLACK FRIDAY e cupons em destaque.",
      "Conferir alertas e número de reserva conectado antes da quinta-feira.",
      "Na madrugada de sexta: regras automáticas ligadas e alguém de plantão nas aprovações.",
    ],
  },
  {
    key: "cyber_monday",
    name: "Cyber Monday",
    date: (y) => new Date(blackFriday(y).getTime() + 3 * DAY),
    prepDays: 7,
    importance: "medium",
    focus: ["eletrônicos", "informática", "games"],
    checklist: ["Repostar as ofertas que mais tiveram cliques na BF (se o preço se manteve)."],
  },
  {
    key: "12_12",
    name: "12.12",
    date: (y) => utc(y, 12, 12),
    prepDays: 7,
    importance: "medium",
    focus: ["cupons Shopee", "presentes de Natal"],
    checklist: BASE_CHECKLIST,
  },
  {
    key: "natal",
    name: "Natal",
    date: (y) => utc(y, 12, 25),
    prepDays: 30,
    importance: "high",
    focus: ["brinquedos", "eletrônicos", "perfumes", "decoração"],
    checklist: [
      ...BASE_CHECKLIST,
      'Avisar prazos de entrega ("chega antes do Natal") nas ofertas.',
      "Listas de presentes por faixa de preço e por pessoa (mãe, pai, criança, amigo secreto).",
    ],
  },
];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Datas sazonais entre hoje (inclusive eventos em andamento) e hoje + `days`. */
export function seasonalEvents(today: string, days: number): SeasonalEvent[] {
  const t0 = new Date(`${today}T00:00:00Z`).getTime();
  const year = new Date(t0).getUTCFullYear();
  const out: SeasonalEvent[] = [];
  for (const y of [year, year + 1]) {
    for (const def of DEFS) {
      const date = def.date(y);
      const end = new Date(date.getTime() + (def.extraDays ?? 0) * DAY);
      const daysUntil = Math.round((date.getTime() - t0) / DAY);
      if (end.getTime() < t0 || daysUntil > days) continue;
      const prep = new Date(date.getTime() - def.prepDays * DAY);
      out.push({
        key: def.key,
        name: def.name,
        date: ymd(date),
        end_date: def.extraDays ? ymd(end) : null,
        importance: def.importance,
        days_until: daysUntil,
        prep_start: ymd(prep),
        phase: daysUntil <= 0 ? "live" : t0 >= prep.getTime() ? "prepare" : "future",
        focus: def.focus,
        checklist: def.checklist,
      });
    }
  }
  return out.sort((a, b) => a.days_until - b.days_until);
}

export async function getSeasonalCalendar(
  ctx: Ctx,
  raw: SeasonalCalendarQuery = {},
): Promise<SeasonalCalendar> {
  requireScope(ctx.actor, "growth:read");
  const q = SeasonalCalendarQuery.parse(raw);
  const [ws] = await ctx.db
    .select({ tz: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.actor.workspaceId));
  const today = localDate(now(ctx), ws?.tz ?? "America/Sao_Paulo");
  return { today, events: seasonalEvents(today, q.days) };
}
