# 18 — Audiência orgânica

Objetivo: sair do zero até grupos ativos sem anúncio. As ofertas viram **conteúdo** para redes (TikTok, Reels, Shorts, Pinterest, status do WhatsApp), todo conteúdo leva para a **vitrine** do workspace, e a vitrine leva para os grupos pelo convite rotativo. Cada etapa é medida por canal de origem.

Tudo é por workspace: o dono valida na própria operação e, depois, cada cliente do OfZap tem a sua vitrine, os seus perfis e os seus números.

```
conteúdo (vídeo, carrossel, pin, status) ──► vitrine (ofzap/@marca?src=tiktok) ──► convite rotativo ──► grupo
                                                   └──► oferta (link de afiliado)
```

## 1. Vitrine

Página pública do workspace no domínio dos links (`REDIRECT_PUBLIC_URL`): **`/@<slug>`**. O `@` separa o espaço de nomes dos links curtos (que não aceitam `@`).

- **Conteúdo:** foto, nome e frase da marca; um botão "Entrar no grupo" por convite rotativo escolhido (ex.: um por nicho); ofertas aprovadas recentes (as melhores por nota, até 24, aprovadas nos últimos 3 dias e não expiradas), com foto, preço, preço "De", desconto e Pix.
- **Origem:** `?src=tiktok` (ou `instagram`, `youtube`, `pinterest`, `whatsapp`...) é repassado ao botão do grupo (`/entrar/<convite>?src=…&via=vitrine`) e gravado em cada clique.
- **Oferta:** o botão leva **direto** ao link de afiliado (Amazon proíbe esconder o destino); o clique é contado por um aviso em segundo plano (`navigator.sendBeacon` para `POST /@<slug>/c`), sem atrasar a navegação.
- **Visitas:** cada abertura da página grava um clique `page_view` (robôs separados, como nos links).
- Página leve, sem JavaScript de terceiros, cache de 60 s por vitrine; `noindex` até a fase de SEO.
- **Personalização** (`design`, painel › Vitrine › Aparência e conteúdo): cor principal (botões e selos; o texto do botão fica branco ou escuro conforme o contraste), fundo e texto; imagem de capa; texto do botão do grupo; até 6 links extras (só http/https); até 6 ofertas em **destaque** fixadas no topo enquanto aprovadas; modo "automático" (destaques + melhores recentes) ou "só destaques"; título da seção; separar por categoria; quantidade máxima (4–48); aviso do rodapé. Alteração parcial: só os campos enviados mudam.
- **Configuração** (painel › Vitrine, API e MCP): endereço (`slug`, 3–30 letras minúsculas, números, `-` ou `_`, único entre workspaces), título, frase, foto, convites exibidos (ordem), ativa ou pausada. Escopo `growth:write`.

## 2. Medição (Audiência)

`get_audience_stats(period)` / `GET /v1/audience/stats`:

- **Por origem (`src`):** visitas na vitrine, cliques em "Entrar" (vindos da vitrine ou direto no convite), cliques em ofertas da vitrine. Sem `src` = "direto".
- **Grupos:** entradas, saídas e saldo por dia (avisos do WhatsApp). O WhatsApp não informa por qual link a pessoa entrou, então a entrada **não é atribuída** a uma origem; a comparação é feita por período (cliques em "Entrar" por origem × entradas no mesmo período).
- **Taxas:** visita → clique no grupo; clique no grupo → entrada (geral).

## 3. Estúdio de conteúdo

O servidor monta, **sem IA**, o carrossel a partir das ofertas aprovadas. O agente local (MCP) ou a pessoa no painel faz a parte criativa.

- **Carrossel** (1080×1350): capa, uma imagem por oferta e fechamento.
- **Vídeo:** não é montado no servidor (o vídeo simples com ffmpeg ficou fraco e foi removido em 02/11/2026). O agente local faz o vídeo na máquina do usuário com **HyperFrames** (HTML + GSAP → MP4, Apache 2.0), sem gastar créditos da plataforma, e envia para aprovação (seção 3.1).
- **Não** reaproveita vídeos das lojas (são de marcas ou de outros criadores: risco de denúncia e fora das regras da Amazon). Sem áudio: as redes colocam música no app.
- Amazon com uma só foto salva busca a galeria da página (`image_urls` do kit). Fotos WebP do Mercado Livre são pedidas em JPEG (o desenho não lê WebP).
- **Fluxo do carrossel:** `get_content_kit` (ofertas aprovadas dos últimos 7 dias, com fotos, preços, link da bio e `recently_used` para variar) → `create_content` (tipo, ofertas na ordem, frase de abertura, fechamento, legenda e hashtags; sem legenda, o sistema monta uma com a lista e "link na bio") → o worker monta (fila, até 3 tentativas) → `get_content`/`list_contents` com os arquivos → a pessoa posta → `mark_content_posted` (redes).
- **Carrossel diário** (Preferências › `studio_daily`, desligado por padrão): a partir das 8h do fuso do workspace, uma vez por dia, um carrossel com até 5 das melhores ofertas ainda não usadas nos últimos 3 dias.
- **Painel:** Audiência › Conteúdo, com abas **Aprovar**, **Para postar** (pronto e ainda não postado), **Postados** e **Todos** (abre na primeira com algo a fazer). Postagem manual por enquanto: montar carrossel (escolher ofertas, frase e legenda), ver, baixar (`?dl=` no link do arquivo), copiar a legenda com hashtags e marcar onde postou. A rota de arquivos aceita pedido por partes (vídeo no iPhone).
- **Postagem automática:** fica para depois (YouTube e Pinterest têm API simples; TikTok e Instagram exigem conta comercial e aprovação de app).

### 3.1 Vídeo do agente local, com aprovação

1. `get_content_kit` traz, além das ofertas, o `video_brief`: formato (1080×1920, 30 fps, 5 a 90 s, até 100 MB), margens que as redes cobrem (topo 180, base 380, direita 160, esquerda 60 px), cores e nome da marca, endereço da vitrine e o passo a passo do HyperFrames (`init --resolution portrait`, roteiro, `lint`/`check`, `render`).
2. O agente renderiza o MP4 e envia: `request_upload` (`video/mp4`, até 100 MB) → PUT do arquivo → `submit_video` (upload, ofertas na ordem, frase de abertura, legenda e hashtags; capa opcional por outro upload).
3. O servidor confere os bytes (MP4 de verdade, vertical 9:16, duração) sem ffmpeg e cria o conteúdo `video` com status **`pending_review`**. Cada upload vale uma vez.
4. No painel (Audiência › Conteúdo), os vídeos aguardando aprovação aparecem primeiro, com o player: **Aprovar** (vira `ready`) ou **Recusar** com o motivo (`rejected` + `review_note`). O agente lê o motivo em `list_contents status=rejected` e manda outro.
5. **Só pessoas aprovam:** `review_content` existe na API e no MCP, mas responde `FORBIDDEN` para tokens de agente. Dá para mudar de ideia: **reprovar** um aprovado (pronto → recusado) ou **aprovar** um recusado.
6. Aprovado, segue como os demais: baixar, copiar a legenda, postar manualmente e `mark_content_posted` (`undo` desmarca uma rede marcada por engano). A postagem e o agendamento direto nas redes ficam para depois.

**Pontos de falha tratados:**

- **Preço mudou:** o conteúdo guarda o preço de cada oferta quando foi feito (`offer_prices`); `warnings` avisa, antes de aprovar ou postar, oferta que saiu ou mudou de preço.
- **Envio repetido:** reusar um upload já concluído devolve `CONFLICT` com o `content_id` criado (o agente não precisa reenviar).
- **Codec:** só H.264 (`avc1`/`avc3`); HEVC e outros não tocam no navegador e várias redes recusam.
- **Espaço:** `delete_content` apaga o conteúdo e os arquivos; uploads não concluídos somem em 1 dia (worker). Recusados/falhos não contam como "usados recentemente" no kit.
- **Vídeo grande:** com S3, o player recebe um link assinado do bucket (pedido por partes direto); download continua pela API.
- **Vídeos antigos do servidor:** a migração 0018 os coloca em aprovação; os que estavam na fila viram "falhou".

## 4. Status do WhatsApp (próxima etapa)

Publicar algumas ofertas por dia no status do número, com o convite. Depende de a Evolution Go publicar status ([VERIFICAR]).

## Critérios de aceite (vitrine + medição)

- Configurar a vitrine pelo painel e abrir `/@slug` no celular: botão do grupo e ofertas do dia.
- `?src=tiktok` aparece nas visitas, nos cliques em "Entrar" e nos cliques em ofertas.
- Slug repetido, reservado ou inválido é recusado com mensagem clara.
- Vitrine pausada ou inexistente mostra página amigável (404).
- API e MCP para ler/alterar a vitrine e ler as estatísticas.
