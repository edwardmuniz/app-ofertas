# 11 — Links e rastreamento

Base do produto: sem isso não há métrica de grupo, criativo, anúncio ou growth.

## Redirecionador

- Domínio próprio curto, ex.: `go.<dominio>/<slug>` (slug base62, 6–8 chars).
- `GET /<slug>` → registra clique (assíncrono, não bloqueia) → `302` para `destination_url`.
- Latência alvo p95 < 50 ms (cache do slug em Redis).
- Link inativo/expirado → `fallback_url` (ex.: página "oferta encerrada, veja outras" ou o próprio grupo).
- Destino pode ser **trocado** sem mudar o slug (ex.: oferta expirou → substituta).
- Detecção básica de bots/preview (WhatsApp/Instagram fazem prefetch para gerar preview): marcar `is_bot` por user-agent e não contar como clique humano.
- **Implementado** em `apps/redirect`: cache do slug no Redis (5 min; slug inexistente 1 min), cliques em buffer gravados em lote a cada 1 s, IP salvo só como hash com `IP_HASH_SALT`, parâmetros `src`, `ref`, `ad` e `utm_*` guardados no clique. `HEAD` conta como robô. Slugs personalizados são gravados em minúsculas; `entrar`, `bio`, `l`, `api` etc. são reservados.

## Granularidade

Um `tracked_link` por **(oferta × canal × post)**. Links avulsos para bio/story/anúncio com `campaign`.

## Sub-IDs nos links de afiliado

Quando o conector suporta, o link de destino carrega sub-ids para fechar a atribuição com a comissão:

| Posição | Valor                     | Ex.                |
| ------- | ------------------------- | ------------------ |
| sub1    | origem                    | `wa`, `ig`, `ads`  |
| sub2    | canal/campanha (id curto) | `g3`, `bio`, `c12` |
| sub3    | post ou anúncio           | `p8f2a`            |
| sub4    | criativo                  | `cr91`             |
| sub5    | experimento/braço         | `e4a`              |

Amazon: usar **tracking IDs** distintos por origem (limitado) + nosso redirect para o resto.

## Atribuição

1. **Clique → canal/post/criativo**: direto pelo `tracked_link`.
2. **Comissão → link**: pelos sub-ids no relatório de conversões da plataforma (fase financeiro).
3. Sem sub-ids: atribuição estimada proporcional aos cliques do período (marcada como `estimated`).

## Convite rotativo

- `go.<dominio>/entrar/<slug-segmento>` → escolhe grupo do segmento com vaga (`member_count < member_limit - margem`), estratégia `fill_first` (padrão) ou `round_robin`.
- Redireciona para o link de convite do WhatsApp do grupo escolhido; registra a "intenção de entrada" (para o funil).
- Quando todos lotam: evento `segment.full` → recomendação "criar novo grupo" (ou criação automática se o provedor permitir).
- Parâmetros `?src=ig_bio`, `?ref=<membro>` (indicação), `?ad=<id>` gravados no clique.
- **Editar** (painel: Convites › Editar; API `PATCH /v1/invite-links/:id`; MCP `update_invite_link`): nome, segmento, distribuição, reserva de vagas, destino quando lotar e pausar. O link (slug) não muda, para não quebrar o que já foi divulgado.

## Critérios de aceite

- Criar link, redirecionar, contar cliques humanos vs bot.
- Trocar destino sem quebrar o link.
- Estatísticas por link/canal/período via API e MCP (`get_link_stats`).
- Convite rotativo funcionando com 2+ grupos de teste.
