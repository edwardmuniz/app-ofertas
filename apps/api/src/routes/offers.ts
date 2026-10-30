import { CREDENTIAL_FIELDS, FAKE_CATEGORIES } from "@ofertas/connectors";
import {
  AffiliateAccount,
  ConnectAffiliateAccountInput,
  CreateOfferLinkInput,
  FindSimilarInput,
  ListOffersQuery,
  Offer,
  OfferCandidate,
  OfferDetail,
  OfferLink,
  OfferPage,
  SavedSearch,
  SaveOfferInput,
  SearchOffersInput,
  SearchOffersResult,
  UpdateOfferStatusInput,
  UpsertSavedSearchInput,
  ValidateOfferResult,
} from "@ofertas/contracts";
import {
  type Ctx,
  connectAffiliateAccount,
  createOfferLink,
  type Deps,
  findSimilarOffers,
  getOffer,
  listAffiliateAccounts,
  listOffers,
  listSavedSearches,
  saveOffer,
  searchOffers,
  setAffiliateAccountStatus,
  setOfferStatus,
  upsertSavedSearch,
  validateOffer,
} from "@ofertas/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireActor } from "../auth";
import { errors, MutationResult, mutationOpts, mutationSchema } from "./common";

const IdParams = z.object({ id: z.uuid() });

/** Contas de afiliado, busca, curadoria, validação e buscas salvas. */
export const offerRoutes: FastifyPluginAsyncZod<{ deps: Deps }> = async (app, { deps }) => {
  const ctx = (req: Parameters<typeof requireActor>[0]): Ctx => ({
    ...deps,
    actor: requireActor(req),
  });

  // ── Contas de afiliado ─────────────────────────────────────────
  app.get(
    "/affiliate-accounts",
    {
      schema: { tags: ["afiliados"], response: { 200: z.array(AffiliateAccount), ...errors } },
    },
    async (req) => listAffiliateAccounts(ctx(req)),
  );
  app.get(
    "/affiliate-accounts/platforms",
    {
      schema: {
        tags: ["afiliados"],
        description: "Campos de credencial por plataforma e categorias do catálogo simulado.",
      },
    },
    async () => ({ credential_fields: CREDENTIAL_FIELDS, fake_categories: FAKE_CATEGORIES }),
  );
  app.post(
    "/affiliate-accounts",
    {
      schema: {
        tags: ["afiliados"],
        description: "Conecta uma conta (só pelo painel). Testa as credenciais antes de salvar.",
        body: ConnectAffiliateAccountInput,
        ...mutationSchema,
        response: { 200: MutationResult(AffiliateAccount), ...errors },
      },
    },
    async (req) => connectAffiliateAccount(ctx(req), req.body, mutationOpts(req)),
  );
  app.patch(
    "/affiliate-accounts/:id",
    {
      schema: {
        tags: ["afiliados"],
        params: IdParams,
        body: z.object({ status: z.enum(["active", "disabled"]) }),
        ...mutationSchema,
        response: { 200: MutationResult(AffiliateAccount), ...errors },
      },
    },
    async (req) =>
      setAffiliateAccountStatus(ctx(req), req.params.id, req.body.status, mutationOpts(req)),
  );

  // ── Busca ──────────────────────────────────────────────────────
  app.post(
    "/offers/search",
    {
      schema: {
        tags: ["ofertas"],
        description:
          "Busca nas plataformas conectadas. Não cria ofertas; use POST /offers para salvar.",
        body: SearchOffersInput,
        response: { 200: SearchOffersResult, ...errors },
      },
    },
    async (req) => searchOffers(ctx(req), req.body),
  );
  app.get(
    "/offers/similar",
    {
      schema: {
        tags: ["ofertas"],
        querystring: FindSimilarInput,
        response: {
          200: z.object({
            reference: z.object({
              product_id: z.string(),
              title: z.string(),
              price: z.number().nullable(),
            }),
            items: z.array(OfferCandidate),
          }),
          ...errors,
        },
      },
    },
    async (req) => findSimilarOffers(ctx(req), req.query),
  );

  // ── Curadoria ──────────────────────────────────────────────────
  app.get(
    "/offers",
    {
      schema: {
        tags: ["ofertas"],
        querystring: ListOffersQuery,
        response: { 200: OfferPage, ...errors },
      },
    },
    async (req) => listOffers(ctx(req), req.query),
  );
  app.post(
    "/offers",
    {
      schema: {
        tags: ["ofertas"],
        description: "Salva um produto como oferta (consulta o preço atual antes).",
        body: SaveOfferInput,
        ...mutationSchema,
        response: { 200: MutationResult(Offer), ...errors },
      },
    },
    async (req) => saveOffer(ctx(req), req.body, mutationOpts(req)),
  );
  app.get(
    "/offers/:id",
    { schema: { tags: ["ofertas"], params: IdParams, response: { 200: OfferDetail, ...errors } } },
    async (req) => getOffer(ctx(req), req.params.id),
  );
  app.post(
    "/offers/:id/status",
    {
      schema: {
        tags: ["ofertas"],
        params: IdParams,
        body: UpdateOfferStatusInput.omit({ offer_id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(Offer), ...errors },
      },
    },
    async (req) =>
      setOfferStatus(ctx(req), { ...req.body, offer_id: req.params.id }, mutationOpts(req)),
  );
  app.post(
    "/offers/:id/validate",
    {
      schema: {
        tags: ["ofertas"],
        params: IdParams,
        ...mutationSchema,
        response: { 200: MutationResult(ValidateOfferResult), ...errors },
      },
    },
    async (req) => validateOffer(ctx(req), req.params.id, mutationOpts(req)),
  );
  app.post(
    "/offers/:id/links",
    {
      schema: {
        tags: ["ofertas"],
        description: "Gera link de afiliado com sub-ids dentro de um link rastreado próprio.",
        params: IdParams,
        body: CreateOfferLinkInput.omit({ offer_id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(OfferLink), ...errors },
      },
    },
    async (req) =>
      createOfferLink(ctx(req), { ...req.body, offer_id: req.params.id }, mutationOpts(req)),
  );

  // ── Buscas salvas ──────────────────────────────────────────────
  app.get(
    "/saved-searches",
    { schema: { tags: ["ofertas"], response: { 200: z.array(SavedSearch), ...errors } } },
    async (req) => listSavedSearches(ctx(req)),
  );
  app.post(
    "/saved-searches",
    {
      schema: {
        tags: ["ofertas"],
        body: UpsertSavedSearchInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(SavedSearch), ...errors },
      },
    },
    async (req) => upsertSavedSearch(ctx(req), req.body, mutationOpts(req)),
  );
  app.patch(
    "/saved-searches/:id",
    {
      schema: {
        tags: ["ofertas"],
        params: IdParams,
        body: UpsertSavedSearchInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(SavedSearch), ...errors },
      },
    },
    async (req) =>
      upsertSavedSearch(ctx(req), { ...req.body, id: req.params.id }, mutationOpts(req)),
  );
};
