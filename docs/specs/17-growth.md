# 17 — Growth

A plataforma **mede, diagnostica, recomenda e testa**. O humano ou o agente decide e aplica. Recomendações nunca se aplicam sozinhas sem passar pela política de aprovação.

## 1. Diagnóstico

`get_growth_diagnosis(period)` retorna:
- funil com a etapa gargalo ([16](16-metricas-e-financeiro.md)),
- 3–5 principais insights com evidência numérica,
- recomendações abertas ordenadas por impacto estimado.

## 2. Motor de recomendações (regras no servidor)

Worker `growth-engine` roda diariamente (e por evento) e cria `recommendation` com `rationale`, `evidence` e `suggested_action` (uma chamada de API pronta, ex.: `upsert_automation_rule {...}`).

| Regra                 | Gatilho                                                                | Ação sugerida                                    |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| Horário subutilizado  | > 30% dos cliques numa janela que recebe < 15% dos envios              | Ajustar janelas das regras                       |
| Categoria forte       | Categoria com CTR/comissão ≥ 2× média e volume suficiente              | Criar segmento/grupo dedicado                    |
| Excesso de frequência | Saídas pós-envio acima do normal ou queda de CTR com aumento de volume | Reduzir `max_por_dia`                            |
| Grupo lotando         | Segmento com < 10% de vagas                                            | Criar novo grupo                                 |
| Fadiga de criativo    | CTR caiu > 40% vs. primeiros 3 dias                                    | Gerar variações                                  |
| Anúncio caro          | Custo por membro > 2× média 7d                                         | Pausar / trocar criativo                         |
| Ofertas expirando     | > 20% das ofertas expiram antes do envio                               | Reduzir antecedência da fila / validar mais cedo |
| Data sazonal          | Evento em ≤ 21 dias                                                    | Plano de campanha sazonal                        |
| Retenção baixa        | Saídas em 48h > X% das entradas                                        | Ajustar boas-vindas / frequência / qualidade     |

`apply_recommendation(id)` executa a `suggested_action` (respeitando escopo, limites e aprovação). `dismiss_recommendation(id, reason)` alimenta o motor para não repetir.

## 3. Experimentos

- `create_experiment(name, hypothesis, variable, arms[], metric, duration)`.
- Variáveis: horário, template de copy, criativo, frequência, selo.
- Alocação: alternância por envio ou por grupo (grupos equivalentes); `experiment_arm_id` gravado no post e no sub-id `sub5`.
- `get_experiment_result` com métrica por braço, intervalo de confiança simples e veredito (`vencedor`, `inconclusivo`, `rodar mais`).
- Histórico de aprendizados vira parte das preferências do workspace (`settings.learnings`) — lido por agentes.

## 4. Biblioteca de estratégias (playbooks)

Ativáveis no painel/MCP; cada um cria a configuração necessária e acompanha métricas próprias:

| Playbook                | O que configura                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| **Indicação**           | Link de convite por membro (`?ref=`), ranking, mensagem periódica no grupo, prêmio/sorteio     |
| **Grupos por nicho**    | Segmentos + convites rotativos + regras por nicho                                              |
| **Grupo VIP**           | Grupo com ofertas antecipadas/cupons exclusivos (critério: indicação ou engajamento)           |
| **Comentário → DM**     | Posts IG com palavra-chave ([13](13-instagram.md))                                             |
| **Reels de achadinhos** | Agenda de vídeos `top5_achadinhos` semanais                                                    |
| **Collab**              | Registro de parcerias com outros perfis + link rastreado por parceiro                          |
| **Campanha sazonal**    | Pré-aquecimento (lista de espera), grupo temporário, cronograma de envios, criativos temáticos |

## 5. Calendário sazonal

`season_event` pré-carregado (BR): Dia do Consumidor (15/03), Dia das Mães, 6.6, Dia dos Namorados, 7.7, Dia dos Pais, 9.9, Dia das Crianças, 10.10, **11.11**, **Black Friday (última sexta de novembro)** + Cyber Monday, 12.12, Natal. `get_seasonal_calendar` retorna próximas datas com checklist sugerido.

## Critérios de aceite

- Fase growth 1: diagnóstico + 4 regras (horário, frequência, grupo lotando, data sazonal) + aplicar/dispensar.
- Fase growth 2: experimentos A/B de horário e copy; playbook de indicação.
