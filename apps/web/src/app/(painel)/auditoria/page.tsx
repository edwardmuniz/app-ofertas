"use client";

import type { AuditEntry, AuditPage } from "@ofertas/contracts";
import { useCallback, useEffect, useState } from "react";
import { Chip, Empty, Loading, LoadingButton, PageHeader, Tag, type Tone } from "@/components/ui";
import { api, fmtDate } from "@/lib/api";

const ORIGIN_LABEL: Record<string, string> = {
  web: "Painel",
  rest: "API",
  mcp: "Agente (MCP)",
  cli: "CLI",
  worker: "Sistema",
};

const RESULT: Record<string, { label: string; tone: Tone }> = {
  ok: { label: "Feito", tone: "positive" },
  error: { label: "Erro", tone: "negative" },
  pending_approval: { label: "Aguardando aprovação", tone: "warning" },
};

/** Ações mais comuns em português; as demais aparecem com o código técnico. */
const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Entrou no painel",
  "auth.signup": "Criou a conta",
  "affiliates.connect": "Conectou conta de afiliado",
  "affiliates.enable": "Ativou conta de afiliado",
  "affiliates.disable": "Desativou conta de afiliado",
  "offers.save": "Salvou oferta",
  "offers.approve": "Aprovou oferta",
  "offers.reject": "Rejeitou oferta",
  "offers.validate": "Validou oferta",
  "offers.create_link": "Gerou link de oferta",
  "offers.harvest": "Busca salva rodou",
  "saved_searches.create": "Salvou busca",
  "saved_searches.update": "Editou busca salva",
  "posts.schedule": "Agendou publicações",
  "posts.send": "Publicou no grupo",
  "posts.cancel": "Cancelou publicação",
  "posts.delete_sent": "Apagou mensagem enviada",
  "rules.create": "Criou regra automática",
  "rules.update": "Editou regra automática",
  "templates.create": "Criou modelo de mensagem",
  "templates.update": "Editou modelo de mensagem",
  "links.create": "Criou link",
  "links.update": "Editou link",
  "invites.create": "Criou convite",
  "invites.update": "Editou convite",
  "channels.update": "Editou grupo",
  "channels.set_admin_only": "Mudou “só admins enviam”",
  "segments.create": "Criou segmento",
  "segments.update": "Editou segmento",
  "segments.delete": "Apagou segmento",
  "whatsapp.create_account": "Conectou número",
  "whatsapp.logout": "Desconectou número",
  "whatsapp.remove_account": "Removeu número",
  "whatsapp.sync_groups": "Importou grupos",
  "groups.create": "Criou grupo",
  "groups.update": "Editou dados do grupo",
  "groups.update_settings": "Mudou configurações do grupo",
  "groups.reset_invite": "Gerou novo link de convite",
  "groups.join": "Entrou em grupo",
  "groups.leave": "Saiu de grupo",
  "groups.create_community": "Criou comunidade",
  "groups.community_link": "Ligou grupos à comunidade",
  "groups.community_unlink": "Desligou grupos da comunidade",
  "groups.participants.add": "Adicionou participante",
  "groups.participants.remove": "Removeu participante",
  "groups.participants.promote": "Promoveu a admin",
  "groups.participants.demote": "Tirou admin",
  "team.upsert": "Salvou número da equipe",
  "team.delete": "Removeu número da equipe",
  "creatives.generate": "Gerou card",
  "creatives.import": "Importou criativo",
  "creatives.request_upload": "Pediu envio de imagem",
  "creatives.complete_upload": "Enviou imagem",
  "creatives.update_brand_kit": "Mudou a identidade visual",
  "workspace.update_preferences": "Mudou preferências",
  "tokens.create": "Criou token de agente",
  "tokens.revoke": "Revogou token de agente",
};

export default function AuditoriaPage() {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (next?: string) => {
      const q = new URLSearchParams({ limit: "30" });
      if (origin) q.set("origin", origin);
      if (next) q.set("cursor", next);
      const page = await api<AuditPage>(`/audit-log?${q}`);
      setItems((prev) => (next ? [...(prev ?? []), ...page.items] : page.items));
      setCursor(page.next_cursor);
    },
    [origin],
  );

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Auditoria"
        subtitle="Tudo o que pessoas, agentes e o sistema fizeram no workspace"
      />
      <div className="flex flex-wrap gap-2">
        <Chip on={origin === ""} onClick={() => setOrigin("")}>
          Todas
        </Chip>
        {Object.entries(ORIGIN_LABEL).map(([k, v]) => (
          <Chip key={k} on={origin === k} onClick={() => setOrigin(k)}>
            {v}
          </Chip>
        ))}
      </div>

      <section className="card overflow-x-auto">
        {!items ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty>Nenhuma ação registrada{origin ? " com essa origem" : ""}.</Empty>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 font-normal">Quando</th>
                <th className="py-2 font-normal">Quem</th>
                <th className="py-2 font-normal">Origem</th>
                <th className="py-2 font-normal">Ação</th>
                <th className="py-2 font-normal">Motivo</th>
                <th className="py-2 font-normal">Resultado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="py-2 whitespace-nowrap">{fmtDate(a.created_at)}</td>
                  <td className="py-2">{a.actor_label}</td>
                  <td className="py-2">{ORIGIN_LABEL[a.origin] ?? a.origin}</td>
                  <td className="py-2" title={a.action}>
                    {ACTION_LABEL[a.action] ?? (
                      <span className="font-mono text-xs">{a.action}</span>
                    )}
                  </td>
                  <td className="py-2 text-neutral-500">{a.reason ?? "—"}</td>
                  <td className="py-2">
                    <Tag tone={RESULT[a.result]?.tone ?? "neutral"} dot>
                      {RESULT[a.result]?.label ?? a.result}
                    </Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor && (
          <LoadingButton
            variant="btn-ghost"
            className="mt-4"
            busy={more}
            onClick={async () => {
              setMore(true);
              await load(cursor);
              setMore(false);
            }}
          >
            Carregar mais
          </LoadingButton>
        )}
      </section>
    </div>
  );
}
