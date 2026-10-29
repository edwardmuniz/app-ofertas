# 13 — Instagram

Via **Instagram Graph API** (conta Profissional/Business ou Creator), app próprio na Meta com revisão de permissões. [VERIFICAR permissões necessárias e tempo de revisão — iniciar cedo]

## Funcionalidades

### Publicação

- Feed (imagem, carrossel), **Reels** e **Stories** a partir de criativos da biblioteca.
- Agendamento pela mesma fila de publicação (`post` com `channel.type = ig_account`).
- Legenda com template + hashtags + identificação de publicidade (`#publi` / parceria paga quando aplicável).
- Link: Instagram não permite link clicável na legenda → usar **link na bio**, **sticker de link no story** e **DM automática**.

### DM automática por comentário (principal alavanca)

- Post configurado com palavra-chave (ex.: "EU QUERO").
- Webhook de comentário → se casar palavra-chave → **resposta privada (private reply)** com o link rastreado da oferta + resposta pública curta ("te mandei no direct 😉").
- Limites e regras da Meta para mensagens (janela de 24h, 1 private reply por comentário) [VERIFICAR].
- Métricas: comentários → DMs enviadas → cliques → entradas no grupo.

### Link na bio

- Página própria `go.<dominio>/bio` (lista de ofertas do dia + botão "Entrar no grupo" via convite rotativo).
- Atualizada automaticamente com as últimas ofertas publicadas.

### Métricas

- Insights por mídia (alcance, impressões, salvamentos, compartilhamentos, plays) e por conta (seguidores).
- Cruzamento com nossos cliques (link da bio, DMs, story).

## Critérios de aceite

- Conectar conta IG via OAuth da Meta.
- Publicar imagem e reels agendados a partir de criativos.
- DM automática por palavra-chave funcionando com link rastreado.
- Página de bio dinâmica.
