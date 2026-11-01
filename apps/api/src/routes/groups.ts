import {
  Channel,
  CreateCommunityInput,
  CreateGroupInput,
  CreateGroupResult,
  GroupDetails,
  JoinGroupInput,
  JoinGroupResult,
  LinkCommunityGroupsInput,
  LinkCommunityGroupsResult,
  ManageParticipantsInput,
  ManageParticipantsResult,
  TeamContact,
  UpdateGroupInput,
  UpdateGroupSettingsInput,
  UpsertTeamContactInput,
} from "@ofertas/contracts";
import {
  type Ctx,
  createCommunity,
  createGroup,
  type Deps,
  deleteTeamContact,
  getGroup,
  joinGroup,
  leaveGroup,
  linkCommunityGroups,
  listTeamContacts,
  manageGroupParticipants,
  resetGroupInvite,
  updateGroup,
  updateGroupSettings,
  upsertTeamContact,
} from "@ofertas/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireActor } from "../auth";
import { errors, MutationResult, mutationOpts, mutationSchema } from "./common";

const IdParams = z.object({ id: z.uuid() });
const tags = ["grupos"];

/** Gestão de grupos do WhatsApp (criar, editar, configurações, participantes, comunidades). */
export const groupRoutes: FastifyPluginAsyncZod<{ deps: Deps }> = async (app, { deps }) => {
  const ctx = (req: Parameters<typeof requireActor>[0]): Ctx => ({
    ...deps,
    actor: requireActor(req),
  });

  // ── Números da equipe ──────────────────────────────────────────
  app.get(
    "/team-contacts",
    { schema: { tags, response: { 200: z.array(TeamContact), ...errors } } },
    async (req) => listTeamContacts(ctx(req)),
  );
  app.post(
    "/team-contacts",
    {
      schema: {
        tags,
        body: UpsertTeamContactInput,
        ...mutationSchema,
        response: { 200: MutationResult(TeamContact), ...errors },
      },
    },
    async (req) => upsertTeamContact(ctx(req), req.body, mutationOpts(req)),
  );
  app.delete(
    "/team-contacts/:id",
    {
      schema: {
        tags,
        params: IdParams,
        ...mutationSchema,
        response: {
          200: MutationResult(z.object({ deleted: z.literal(true), id: z.string() })),
          ...errors,
        },
      },
    },
    async (req) => deleteTeamContact(ctx(req), req.params.id, mutationOpts(req)),
  );

  // ── Criar, entrar, comunidades (por número) ────────────────────
  app.post(
    "/whatsapp/accounts/:id/groups",
    {
      schema: {
        tags,
        params: IdParams,
        body: CreateGroupInput.omit({ account_id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(CreateGroupResult), ...errors },
      },
    },
    async (req) =>
      createGroup(ctx(req), { ...req.body, account_id: req.params.id }, mutationOpts(req)),
  );
  app.post(
    "/whatsapp/accounts/:id/join",
    {
      schema: {
        tags,
        params: IdParams,
        body: JoinGroupInput,
        ...mutationSchema,
        response: { 200: MutationResult(JoinGroupResult), ...errors },
      },
    },
    async (req) => joinGroup(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
  app.post(
    "/whatsapp/accounts/:id/communities",
    {
      schema: {
        tags,
        params: IdParams,
        body: CreateCommunityInput.omit({ account_id: true }),
        ...mutationSchema,
        response: { 200: MutationResult(Channel), ...errors },
      },
    },
    async (req) =>
      createCommunity(ctx(req), { ...req.body, account_id: req.params.id }, mutationOpts(req)),
  );

  // ── Um grupo ───────────────────────────────────────────────────
  app.get(
    "/channels/:id/group",
    { schema: { tags, params: IdParams, response: { 200: GroupDetails, ...errors } } },
    async (req) => getGroup(ctx(req), req.params.id),
  );
  app.patch(
    "/channels/:id/group",
    {
      schema: {
        tags,
        params: IdParams,
        body: UpdateGroupInput,
        ...mutationSchema,
        response: { 200: MutationResult(Channel), ...errors },
      },
    },
    async (req) => updateGroup(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
  app.post(
    "/channels/:id/group/settings",
    {
      schema: {
        tags,
        params: IdParams,
        body: UpdateGroupSettingsInput,
        ...mutationSchema,
        response: { 200: MutationResult(Channel), ...errors },
      },
    },
    async (req) => updateGroupSettings(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
  app.post(
    "/channels/:id/group/invite-reset",
    {
      schema: {
        tags,
        params: IdParams,
        ...mutationSchema,
        response: { 200: MutationResult(Channel), ...errors },
      },
    },
    async (req) => resetGroupInvite(ctx(req), req.params.id, mutationOpts(req)),
  );
  app.post(
    "/channels/:id/group/participants",
    {
      schema: {
        tags,
        params: IdParams,
        body: ManageParticipantsInput,
        ...mutationSchema,
        response: { 200: MutationResult(ManageParticipantsResult), ...errors },
      },
    },
    async (req) => manageGroupParticipants(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
  app.post(
    "/channels/:id/group/leave",
    {
      schema: {
        tags,
        params: IdParams,
        ...mutationSchema,
        response: {
          200: MutationResult(z.object({ channel: Channel, scheduled_posts_canceled: z.number() })),
          ...errors,
        },
      },
    },
    async (req) => leaveGroup(ctx(req), req.params.id, mutationOpts(req)),
  );
  app.post(
    "/channels/:id/community/groups",
    {
      schema: {
        tags,
        params: IdParams,
        body: LinkCommunityGroupsInput,
        ...mutationSchema,
        response: { 200: MutationResult(LinkCommunityGroupsResult), ...errors },
      },
    },
    async (req) => linkCommunityGroups(ctx(req), req.params.id, req.body, mutationOpts(req)),
  );
};
