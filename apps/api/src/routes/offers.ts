import { CREDENTIAL_FIELDS, FAKE_CATEGORIES } from "@ofertas/connectors";
import {
  AffiliateAccount,
  ConnectAffiliateAccountInput,
  CreateOfferLinkInput,
  FindSimilarInput,
  GenerateOfferCopyInput,
  ImportOfferFromLinkInput,
  ListOffersQuery,
  ListStoreCouponsQuery,
  Offer,
  OfferCandidate,
  OfferCategory,
  OfferDetail,
  OfferFromLinkInput,
  OfferLink,
  OfferLinkPreview,
  OfferPage,
  SavedSearch,
  SaveOfferInput,
  SearchOffersInput,
  SearchOffersResult,
  SetOfferCopyInput,
  SetOfferCouponInput,
  StoreCoupon,
  UpdateAffiliateAccountInput,
  UpdateOfferPricesInput,
  UpdateOfferStatusInput,
  UpsertSavedSearchInput,
  UpsertStoreCouponInput,
  ValidateOfferResult,
} from "@ofertas/contracts";
import {
  type Ctx,
  connectAffiliateAccount,
  createOfferLink,
  type Deps,
  deleteAffiliateAccount,
  deleteStoreCoupon,
  findSimilarOffers,
  generateOfferCopy,
  getOffer,
  importOfferFromLink,
  listAffiliateAccounts,
  listOfferCategories,
  listOffers,
  listSavedSearches,
  listStoreCoupons,
  previewOfferFromLink,
  requestFeedSync,
  saveOffer,
  searchOffers,
  setAffiliateAccountStatus,
  setOfferCopy,
  setOfferCoupon,
  setOfferStatus,
  updateAffiliateAccount,
  updateOfferPrices,
  upsertSavedSearch,
  upsertStoreCoupon,
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
  app.put(
    "/affiliate-accounts/:id",
    {
      schema: {
        tags: ["afiliados"],
        description:
          "Edita nome e credenciais (só pelo painel). Credenciais em branco mantêm as atuais; as novas são testadas.",
        params: IdParams,
        body: UpdateAffiliateAccountInput,
        ...mutationSchema,
        response: { 200: MutationResult(AffiliateAccount), ...errors },
      },
    },
    async (req) => updateAffiliateAccount(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
  app.delete(
    "/affiliate-accounts/:id",
    {
      schema: {
        tags: ["afiliados"],
        description:
          "Remove a conta (só pelo painel). Ofertas e publicações ficam; o catálogo do feed é apagado.",
        params: IdParams,
        ...mutationSchema,
        response: {
          200: MutationResult(
            z.object({ id: z.string(), deleted: z.literal(true), offers_detached: z.number() }),
          ),
          ...errors,
        },
      },
    },
    async (req) => deleteAffiliateAccount(ctx(req), req.params.id, mutationOpts(req)),
  );
  app.post(
    "/affiliate-accounts/:id/feed-sync",
    {
      schema: {
        tags: ["afiliados"],
        description: "Pede nova importação do feed de produtos (contas em modo feed).",
        params: IdParams,
        ...mutationSchema,
        response: { 200: MutationResult(AffiliateAccount), ...errors },
      },
    },
    async (req) => requestFeedSync(ctx(req), req.params.id, mutationOpts(req)),
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
    "/offers/categories",
    {
      schema: {
        tags: ["ofertas"],
        description: "Categorias para filtrar a busca (do catálogo do feed, com contagem).",
        response: { 200: z.array(OfferCategory), ...errors },
      },
    },
    async (req) => listOfferCategories(ctx(req)),
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
  app.post(
    "/offers/from-link/preview",
    {
      schema: {
        tags: ["ofertas"],
        description:
          "Abre um link de produto (inclusive link curto de afiliado) e devolve título, foto e preço encontrados. Não grava nada.",
        body: OfferFromLinkInput,
        response: { 200: OfferLinkPreview, ...errors },
      },
    },
    async (req) => previewOfferFromLink(ctx(req), req.body),
  );
  app.post(
    "/offers/from-link",
    {
      schema: {
        tags: ["ofertas"],
        description:
          "Cria uma oferta a partir de um link colado, com título, foto e preço conferidos. O link colado vira o destino dos links curtos.",
        body: ImportOfferFromLinkInput,
        ...mutationSchema,
        response: { 200: MutationResult(Offer), ...errors },
      },
    },
    async (req) => importOfferFromLink(ctx(req), req.body, mutationOpts(req)),
  );
  app.get(
    "/offers/:id",
    { schema: { tags: ["ofertas"], params: IdParams, response: { 200: OfferDetail, ...errors } } },
    async (req) => getOffer(ctx(req), req.params.id),
  );
  app.patch(
    "/offers/:id/prices",
    {
      schema: {
        tags: ["ofertas"],
        params: IdParams,
        body: UpdateOfferPricesInput,
        ...mutationSchema,
        response: { 200: MutationResult(Offer), ...errors },
      },
    },
    async (req) => updateOfferPrices(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
  app.put(
    "/offers/:id/coupon",
    {
      schema: {
        tags: ["ofertas"],
        params: IdParams,
        body: SetOfferCouponInput,
        ...mutationSchema,
        response: { 200: MutationResult(Offer), ...errors },
      },
    },
    async (req) => setOfferCoupon(ctx(req), req.params.id, req.body, mutationOpts(req)),
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

  // ── Texto da mensagem ──────────────────────────────────────────
  app.post(
    "/offers/:id/copy/generate",
    {
      schema: {
        tags: ["ofertas"],
        description:
          "Gera chamada, descrição e fechamento com IA (Gemini) e salva na oferta. Só humanos (painel). dry_run mostra sem salvar.",
        params: IdParams,
        body: GenerateOfferCopyInput,
        ...mutationSchema,
        response: { 200: MutationResult(Offer), ...errors },
      },
    },
    async (req) => generateOfferCopy(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
  app.put(
    "/offers/:id/copy",
    {
      schema: {
        tags: ["ofertas"],
        description: "Salva o texto da mensagem da oferta (null volta ao modelo padrão).",
        params: IdParams,
        body: SetOfferCopyInput,
        ...mutationSchema,
        response: { 200: MutationResult(Offer), ...errors },
      },
    },
    async (req) => setOfferCopy(ctx(req), req.params.id, req.body, mutationOpts(req)),
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
  app.get(
    "/coupons",
    {
      schema: {
        tags: ["ofertas"],
        querystring: ListStoreCouponsQuery,
        response: { 200: z.array(StoreCoupon), ...errors },
      },
    },
    async (req) => listStoreCoupons(ctx(req), req.query),
  );
  app.post(
    "/coupons",
    {
      schema: {
        tags: ["ofertas"],
        body: UpsertStoreCouponInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(StoreCoupon), ...errors },
      },
    },
    async (req) => upsertStoreCoupon(ctx(req), req.body, mutationOpts(req)),
  );
  app.put(
    "/coupons/:id",
    {
      schema: {
        tags: ["ofertas"],
        params: IdParams,
        body: UpsertStoreCouponInput.omit({ id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(StoreCoupon), ...errors },
      },
    },
    async (req) =>
      upsertStoreCoupon(ctx(req), { ...req.body, id: req.params.id }, mutationOpts(req)),
  );
  app.delete(
    "/coupons/:id",
    {
      schema: {
        tags: ["ofertas"],
        params: IdParams,
        ...mutationSchema,
        response: {
          200: MutationResult(
            z.object({ deleted: z.literal(true), scheduled_posts_canceled: z.number() }),
          ),
          ...errors,
        },
      },
    },
    async (req) => deleteStoreCoupon(ctx(req), req.params.id, mutationOpts(req)),
  );
};
