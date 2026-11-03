# 14 — Criativos (imagem e vídeo)

Dois caminhos, disponíveis para o agente (MCP/CLI):

> **Painel (02/11/2026):** a tela Criativos saiu do painel. Vídeos, carrosséis e criativos estáticos agora são feitos pelo agente local. A API e as tools MCP continuam, e os cards de preço seguem saindo nos envios. A identidade visual (brand kit) passou para **Preferências**. A tela volta a ser pensada junto com os anúncios (Meta Ads).

- **A) Gerar no servidor por template** — `generate_creative(offer_id, template, formats, variations)`.
- **B) Criar fora e subir** — o agente gera na máquina do usuário (modelos de imagem, ffmpeg, Remotion, editor) e envia via upload.

## Brand kit

Logo, paleta, fontes, marca d'água, tom de voz, selos padrão. Lido por templates e exposto ao agente (`get_brand_kit`, resource `workspace://brand-kit`) para que criativos externos sigam a mesma identidade.

## Formatos

| Formato      | Dimensão  | Uso                              |
| ------------ | --------- | -------------------------------- |
| `wa_image`   | 1080×1080 | Imagem no grupo                  |
| `feed_4x5`   | 1080×1350 | Feed IG / anúncio                |
| `square_1x1` | 1080×1080 | Feed / anúncio                   |
| `story_9x16` | 1080×1920 | Story / Reels / anúncio vertical |

Vídeo: MP4 H.264 + AAC, 30 fps, 6–60 s (reels/anúncios), ≤ 100 MB no upload inicial. Conversão automática para os formatos pedidos (resize/crop com área segura).

## Templates

### Imagem (Satori → PNG)

- `card_preco`: a foto do produto ocupa a maior parte do card (cerca de 60% da altura no 1:1); título em até 2 linhas com altura fixa (título longo é cortado, sem invadir o preço), preço "de/por", % OFF, selo, chamada e marca no topo.
- `cupom_destaque`: foco no cupom.
- `comparativo`: produto + histórico ("menor preço em 90 dias").
- `colagem_achadinhos`: 3–4 produtos.

### Vídeo (Remotion)

- `slideshow_oferta`: fotos do produto com zoom/pan, preço animado, CTA final ("link no grupo/DM").
- `top5_achadinhos`: sequência de 5 ofertas.
- `contagem_regressiva`: oferta relâmpago com timer.
- Trilha de áudio de biblioteca livre de direitos; legenda queimada opcional.

Cada template declara `params_schema` (Zod/JSON Schema) → o agente descobre via `list_creative_templates` o que pode customizar (cores, textos, ordem, duração…).

Render roda no worker (`render-image`, `render-video`); vídeo é assíncrono: `generate_creative` retorna `creative_id` com status `rendering` e o agente consulta `get_creative`.

## Upload

```
request_upload(filename, mime, size_bytes)           → { upload_id, put_url, expires_at, headers }
PUT direto no storage (curl / CLI / navegador)
complete_upload(upload_id, offer_id?, title?, tags?, ai_generated?)
   → valida, extrai metadados (dimensão, duração), gera variantes/prévias
   → { creative_id, variants[], preview_url, validation }
```

Alternativas: `import_media_from_url(url, ...)`, CLI `ofertas upload <arquivo> --offer <id>`, base64 inline ≤ 2 MB.

Depois do PUT, o destino do arquivo define a chamada:

- **Criativo de post:** `complete_upload` (acima).
- **Imagem para um campo de endereço** (logo e capa da vitrine, foto do grupo, foto da oferta): `publish_image(upload_id)` / `POST /v1/creatives/uploads/:id/publish` → `{ url }` público e permanente (assinado por ~10 anos). No painel, todo campo de imagem tem **Enviar imagem** (com prévia) além de colar um endereço.
- **Vídeo para as redes:** `submit_video` (spec 18).

Imagens nossas (`/media` assinado) são lidas direto do armazenamento quando o servidor precisa delas (foto do grupo, foto da oferta), sem passar pela rede. Uploads não concluídos somem em 1 dia.

## Validação por destino

`validate_creative(creative_id, destination)` checa: proporção, resolução mínima, duração, tamanho, codec, área segura (texto fora das bordas de UI do story), proporção de texto (recomendação para anúncios). Retorna lista de problemas com `hint` de correção. Corrigível automaticamente quando possível (`auto_fix: true` → crop/resize/transcode).

## Prévia para agentes multimodais

- Imagem: PNG reduzido (≤ 512 px).
- Vídeo: **contact sheet** (grade com 6–9 frames) + primeiro frame + duração.
- URLs assinadas com validade curta, retornadas em `generate_creative`, `complete_upload`, `get_creative`.

Permite o ciclo: gerar → ver → ajustar parâmetros → gerar de novo.

## Biblioteca

- Busca por oferta, tags, formato, origem, status.
- **Remover** (`DELETE /v1/creatives/:id`, `delete_creative`): apaga o criativo, os registros e os arquivos (no S3 ou no disco). Posts agendados com ele passam a gerar o card na hora, ou a usar a foto do produto. A galeria do painel foi removida (ver nota no topo).
- Versões e variantes (para A/B).
- Desempenho por criativo (`creative_stats_daily`): uso em posts/anúncios, cliques, CTR, conversões.
- **Fadiga**: CTR em queda > X% vs. primeiros dias → recomendação "gerar variações".

## Conformidade

- Campo `ai_generated`; quando `true` e destino Meta, aplicar rótulo de IA quando exigido.
- Imagens de produto vêm do marketplace (uso para divulgação de afiliado); não usar marcas/pessoas de forma enganosa.
- Nunca exibir preço diferente do validado (preço no criativo é re-checado antes da publicação; se mudou, o criativo é regenerado ou o post é bloqueado).

## Implementação (Fase 4)

- **Render:** Satori não desenha emoji sem imagens extras, então os templates usam só texto e formas; o selo da oferta vai sem emoji. A raiz usa `box-sizing: border-box` (sem isso o Satori soma o padding à largura).
- **URLs assinadas:** `/media/:id?e=<expira>&s=<hmac>`, validade de 30 dias arredondada para o dia (URL estável para o WhatsApp). Prévias valem 7 dias. Uploads: `PUT /uploads/:id?e&s`, válido por 15 min, conteúdo conferido pelos bytes (PNG, JPEG ou WebP).
- **Armazenamento:** disco local (`MEDIA_DIR`) ou **S3**, quando `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` e `AWS_S3_BUCKET` estão definidos (`AWS_REGION` é opcional: a região é descoberta pelo bucket). A assinatura AWS (SigV4) é feita no próprio código, sem SDK. Com S3, os arquivos antigos do disco continuam sendo lidos e sobem para o bucket quando forem enviados.
- **Imagem enviada ao WhatsApp:** com S3, a Evolution Go recebe um link pré-assinado do bucket, válido por 1 dia e gerado na hora do envio. Funciona mesmo com a API em `localhost`. Sem S3, recebe a URL `/media`, e aí **`API_PUBLIC_URL` precisa ser acessível pela Evolution Go**. O painel continua usando `/media`.
- **Importação por URL:** só http(s) públicos; IPs internos (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7) bloqueados, inclusive após redirecionamento; limite de 10 MB.
- **CLI:** `pnpm ofertas --help`. Login salvo em `~/.ofertas/config.json` (ou `OFERTAS_URL` + `OFERTAS_TOKEN`). As ações aparecem na auditoria com origem `cli`.

## Critérios de aceite

- Fase imagem: brand kit, 2 templates de imagem, geração por oferta, upload por URL pré-assinada, prévia, uso em post de WhatsApp.
- Fase vídeo: 1–2 templates Remotion, render assíncrono, contact sheet, upload de vídeo com transcode, uso em Reels.
