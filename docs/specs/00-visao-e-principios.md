# 00 — Visão e princípios

## Objetivo

Operar um canal de ofertas (Instagram + grupos de WhatsApp) **automatizado desde o dia 1**, com rastreamento ponta a ponta (do post/anúncio até a comissão), e que possa ser operado tanto por um humano no painel quanto por um agente de IA rodando na máquina do usuário (Claude, Codex, Gemini, Cursor…).

## Usuários

| Ator                     | Como usa                                                                        |
| ------------------------ | ------------------------------------------------------------------------------- |
| **Operador (humano)**    | Painel web: curadoria, aprovações, métricas, configurações                      |
| **Agente de IA (local)** | Conecta via MCP remoto (ou CLI/REST) e executa as mesmas operações que o painel |
| **Membro do grupo**      | Recebe ofertas no WhatsApp / segue no Instagram (não acessa a plataforma)       |

Inicialmente single-tenant de fato (um negócio), mas **modelado como multi-workspace** desde o início para não travar evolução (sócios, ou virar SaaS).

## Escopo funcional

1. Gestão de grupos e canais (WhatsApp grupos/comunidades/canal, Telegram futuramente, Instagram)
2. Contas de afiliado (Shopee, Mercado Livre, Amazon, Magazine Luiza, …)
3. Pesquisa, validação e histórico de preço de ofertas
4. Publicação automatizada com fila, regras e limites
5. Links próprios com rastreamento (cliques → comissão)
6. Criativos (imagem e vídeo): geração por template, upload, biblioteca, desempenho
7. Anúncios (Meta Ads) com rastreamento de custo por membro e ROI
8. Métricas, funil e financeiro (comissões, gastos, lucro)
9. Growth: diagnóstico de funil, recomendações, experimentos, programa de indicação
10. Interface para agentes: MCP remoto, API REST, CLI

## Princípios de produto (não negociáveis)

1. **API primeiro.** O painel é cliente da API pública. Nenhuma lógica de negócio exclusiva da UI.
2. **Paridade painel ↔ agente.** Uma feature só está "pronta" quando existe na API, no MCP e no painel (o painel pode vir depois, mas a API/MCP não).
3. **A plataforma executa; o agente comanda.** Tudo que precisa rodar continuamente (fila, agendamentos, validação, coleta de preço, rotação de grupos, renderização) roda no servidor. O agente local pode desligar a qualquer momento.
4. **Seguro por padrão.** Toda ação com efeito externo tem prévia (`dry_run`), limites aplicados no servidor, idempotência e trilha de auditoria. Ações sensíveis (gasto, anúncios) exigem aprovação humana conforme política configurável.
5. **Rastreável de ponta a ponta.** Todo link que sai da plataforma passa pelo redirecionador próprio e carrega identificação de canal/campanha/criativo.
6. **Conectores isolados.** Cada plataforma externa (afiliado, WhatsApp, Instagram, Meta Ads) fica atrás de uma interface (adapter). Trocar o provedor de WhatsApp não pode exigir mudar o núcleo.
7. **Respostas enxutas para agentes.** Tools de alto nível, saídas resumidas, erros com código + sugestão de correção.

## Glossário

| Termo                  | Definição                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| **Workspace**          | Unidade de negócio (dados, conexões, limites). Usuários pertencem a workspaces.               |
| **Produto**            | Item de um marketplace (id externo + plataforma).                                             |
| **Oferta**             | Snapshot de um produto num momento: preço, preço original, cupom, validade, link de afiliado. |
| **Canal**              | Destino de publicação: grupo WhatsApp, comunidade, canal WhatsApp, conta Instagram.           |
| **Segmento**           | Agrupamento de canais por nicho (ex.: "casa", "tech").                                        |
| **Publicação (Post)**  | Envio de uma oferta (+criativo) para um canal num horário.                                    |
| **Regra de automação** | Critério que gera publicações automaticamente (ex.: "tech, desconto ≥ 40%, 21h").             |
| **Link rastreado**     | URL curta própria → redireciona ao link de afiliado; registra cliques.                        |
| **Convite rotativo**   | Link fixo de entrada que redireciona para um grupo com vaga.                                  |
| **Criativo**           | Peça visual (imagem/vídeo) com variantes por formato.                                         |
| **Ação sensível**      | Ação que exige aprovação humana conforme política (ex.: criar anúncio).                       |
