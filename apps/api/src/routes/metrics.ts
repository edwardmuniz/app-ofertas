import {
  Alert,
  Funnel,
  ListAlertsQuery,
  MetricsBreakdown,
  MetricsBreakdownQuery,
  MetricsPeriodQuery,
  PerformanceSummary,
  PublicStatus,
  SeasonalCalendar,
  SeasonalCalendarQuery,
  SystemStatus,
} from "@ofertas/contracts";
import {
  type Ctx,
  type Deps,
  getFunnel,
  getMetricsBreakdown,
  getPerformanceSummary,
  getPublicStatus,
  getSeasonalCalendar,
  getSystemStatus,
  listAlerts,
} from "@ofertas/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireActor } from "../auth";
import { errors } from "./common";

/** Métricas, alertas, status e calendário sazonal. */
export const metricsRoutes: FastifyPluginAsyncZod<{ deps: Deps }> = async (app, { deps }) => {
  const ctx = (req: Parameters<typeof requireActor>[0]): Ctx => ({
    ...deps,
    actor: requireActor(req),
  });

  app.get(
    "/metrics/summary",
    {
      schema: {
        tags: ["métricas"],
        querystring: MetricsPeriodQuery,
        response: { 200: PerformanceSummary, ...errors },
      },
    },
    async (req) => getPerformanceSummary(ctx(req), req.query),
  );
  app.get(
    "/metrics/funnel",
    {
      schema: {
        tags: ["métricas"],
        querystring: MetricsPeriodQuery,
        response: { 200: Funnel, ...errors },
      },
    },
    async (req) => getFunnel(ctx(req), req.query),
  );
  app.get(
    "/metrics/breakdown",
    {
      schema: {
        tags: ["métricas"],
        querystring: MetricsBreakdownQuery,
        response: { 200: MetricsBreakdown, ...errors },
      },
    },
    async (req) => getMetricsBreakdown(ctx(req), req.query),
  );
  app.get(
    "/alerts",
    {
      schema: {
        tags: ["sistema"],
        querystring: ListAlertsQuery,
        response: { 200: z.object({ items: z.array(Alert) }), ...errors },
      },
    },
    async (req) => ({ items: await listAlerts(ctx(req), req.query) }),
  );
  app.get(
    "/system/status",
    { schema: { tags: ["sistema"], response: { 200: SystemStatus, ...errors } } },
    async (req) => getSystemStatus(ctx(req)),
  );
  app.get(
    "/growth/calendar",
    {
      schema: {
        tags: ["growth"],
        querystring: SeasonalCalendarQuery,
        response: { 200: SeasonalCalendar, ...errors },
      },
    },
    async (req) => getSeasonalCalendar(ctx(req), req.query),
  );
  // Público (sem login): para monitores externos. 503 quando banco ou worker estão fora.
  app.get(
    "/status",
    {
      schema: {
        tags: ["sistema"],
        response: { 200: PublicStatus, 503: PublicStatus },
      },
    },
    async (_req, reply) => {
      const s = await getPublicStatus(deps);
      return reply.code(s.ok ? 200 : 503).send(s);
    },
  );
};
