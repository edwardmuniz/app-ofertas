# 91 — Riscos e decisões em aberto

## Decisões

| ID  | Decisão                            | Proposta                                                                                                    | Status       |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------ |
| D1  | Stack                              | TypeScript full-stack: Fastify + Next.js + Postgres/Drizzle + Redis/BullMQ + R2/MinIO + Satori/Remotion     | **Decidido** |
| D2  | Auth do painel                     | Implementação própria simples: email+senha (scrypt) + sessão em cookie httpOnly; tokens de API para agentes | **Decidido** |
| D3  | Provedor WhatsApp                  | **Evolution Go** (EvolutionAPI em Go, baseada em whatsmeow) self-hosted atrás de adapter                    | **Decidido** |
| D4  | Hospedagem                         | VPS com Docker Compose no MVP (ex.: Hetzner/Contabo/DigitalOcean), R2 para storage                          | Aberta       |
| D5  | Domínio                            | Domínio curto para redirect (`go.`) separado do painel (`app.`)                                             | Aberta       |
| D6  | Geração de copy por IA no servidor | Opcional; provedor configurável (agente local já pode escrever a copy)                                      | Aberta       |
| D7  | Nome do produto / repositório      | —                                                                                                           | Aberta       |

## Riscos

| Risco                                                                                         | Impacto                        | Mitigação                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Banimento do número de WhatsApp** (API não oficial)                                         | Alto: para a operação          | Grupos "só admins", limites e jitter, múltiplos números, admin reserva, monitor de saúde, adapter trocável                      |
| **APIs de afiliado limitadas** (ML, Magalu; acesso PA-API Amazon condicionado a vendas)       | Médio                          | Começar pela Shopee; aceitar links manuais; `capabilities` por conector                                                         |
| **Termos dos programas de afiliado** (encurtadores, exibição de preço, uso em anúncios/marca) | Alto: perda de comissões/conta | Revisar termos de cada programa antes da fase; marcar restrições por conector (ex.: desativar redirect para Amazon se proibido) |
| **Revisão de app na Meta** (Instagram e Ads) demora                                           | Médio: atrasa fases 6 e 10     | Criar app e pedir permissões já na fase 3                                                                                       |
| **Prefetch/preview gera cliques falsos**                                                      | Baixo                          | Filtro de bots por UA, deduplicação por IP/tempo                                                                                |
| **Preço no criativo desatualizado**                                                           | Médio: reclamação/termos       | Revalidar antes de enviar; regenerar ou bloquear                                                                                |
| **LGPD**                                                                                      | Médio                          | Hash de identificadores, política de privacidade, retenção                                                                      |
| **Agente executar ação errada em massa**                                                      | Médio                          | `dry_run`, limites no servidor, aprovação, idempotência, auditoria, desfazer                                                    |

## A verificar (pesquisa antes da fase correspondente)

- [ ] Shopee Affiliate Open API: acesso para afiliado BR, endpoints de busca/link/sub-ids/relatórios, limites de taxa.
- [ ] Evolution Go: versão atual, endpoints de grupos, suporte a comunidades e canais, webhooks de participantes, envio de mídia.
- [ ] WhatsApp Cloud API: estado atual do suporte a grupos.
- [ ] Amazon Associados BR: regras sobre encurtadores/redirect e uso da PA-API (ou sucessora).
- [ ] Mercado Livre e Magalu: existência de API de afiliados / geração de link.
- [ ] Instagram Graph API: permissões para publicação, private replies e tempo de revisão.
- [ ] Meta: rótulo de conteúdo gerado por IA em anúncios.
