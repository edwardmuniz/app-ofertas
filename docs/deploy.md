# Deploy em VPS

Tudo roda em Docker numa VPS: Postgres, Redis, API, worker, redirecionador, painel, Caddy (HTTPS automático) e backup diário.

## VPS recomendada

| Item      | Mínimo                 | Recomendado para operação real           |
| --------- | ---------------------- | ---------------------------------------- |
| CPU / RAM | 2 vCPU / 4 GB          | 2–4 vCPU / 8 GB (com Evolution Go junto) |
| Disco     | 40 GB SSD              | 80 GB NVMe                               |
| Sistema   | Ubuntu 24.04 LTS       | idem                                     |
| Região    | **Brasil (São Paulo)** | idem                                     |

Por que Brasil: o número de WhatsApp conecta pelo IP do servidor onde roda a Evolution Go (login de número BR vindo de IP estrangeiro chama atenção), e os cliques nos links curtos ficam mais rápidos.

Opções com datacenter em São Paulo: Hostinger (KVM 2), Vultr, Magalu Cloud, AWS Lightsail. Fora do Brasil (Hetzner, por exemplo) é mais barato, mas tem a desvantagem acima.

## Testar sem domínio

Use o [sslip.io](https://sslip.io): qualquer nome terminado em `<IP>.sslip.io` aponta para esse IP, sem cadastro, e o Caddy consegue o certificado HTTPS normalmente. HTTPS é obrigatório: em produção o cookie de login é `Secure` e não funciona por `http://IP`.

Com a VPS no IP `203.0.113.10`, pule o passo 1 e preencha no `.env`:

```env
APP_DOMAIN=painel.203-0-113-10.sslip.io
API_DOMAIN=api.203-0-113-10.sslip.io
GO_DOMAIN=go.203-0-113-10.sslip.io
API_PUBLIC_URL=https://api.203-0-113-10.sslip.io
REDIRECT_PUBLIC_URL=https://go.203-0-113-10.sslip.io
MESSAGING_WEBHOOK_URL=https://api.203-0-113-10.sslip.io/webhooks/whatsapp
```

Quando o domínio chegar, troque esses valores e suba de novo. Os links curtos já enviados continuam apontando para o endereço do sslip.io, então não envie para grupos de verdade enquanto estiver nesse modo. O número de WhatsApp registra o webhook só ao ser criado: depois de trocar `MESSAGING_WEBHOOK_URL`, remova e conecte o número de novo.

## Passo a passo

1. **DNS:** crie 3 registros A apontando para o IP da VPS: `painel.`, `api.` e `go.` do seu domínio.
2. **Docker:** `curl -fsSL https://get.docker.com | sh`
3. **Código:** `git clone https://github.com/edwardmuniz/app-ofertas.git && cd app-ofertas`
4. **Configuração:** `cp infra/prod/.env.production.example infra/prod/.env` e preencha.
   - `ENCRYPTION_KEY`: use a **mesma** do ambiente onde as contas foram conectadas; se for uma instalação nova, gere com `openssl rand -base64 32`.
   - `POSTGRES_PASSWORD` e `IP_HASH_SALT`: `openssl rand -hex 24` (hex, não base64: a senha entra na URL do banco).
5. **Subir:** `docker compose -f infra/prod/docker-compose.yml --env-file infra/prod/.env up -d --build`
6. Acesse `https://painel.seudominio`, crie a conta (o primeiro cadastro vira dono) e conecte o número.

Atualizar depois: `git pull` e o mesmo comando do passo 5 (as migrations rodam sozinhas antes da API subir).

## Servidor que já tem nginx (portas 80/443 ocupadas)

Quando o servidor é compartilhado e já roda um nginx com certbot, o Caddy não sobe:

1. Suba com o arquivo extra, que desliga o Caddy e abre painel, API e links só em portas locais (8100, 8101 e 8102):
   `docker compose -f infra/prod/docker-compose.yml -f infra/prod/docker-compose.nginx.yml --env-file infra/prod/.env up -d --build`
2. Copie `infra/prod/nginx-ofzap.conf` para `/etc/nginx/conf.d/ofzap.conf` e rode `nginx -t && systemctl reload nginx`.
3. Com os registros A apontando para o IP público do servidor, gere o HTTPS:
   `certbot --nginx -d painel.ofzap.com.br -d api.ofzap.com.br -d go.ofzap.com.br`

Evolution Go compartilhada com outros sistemas: o OfZap só mexe nas instâncias que ele mesmo criou.

## Evolution Go

- **Na mesma VPS (recomendado):** rode a Evolution Go em Docker e use `EVOLUTION_GO_URL=http://IP_PRIVADO_OU_172.17.0.1:PORTA`. Não exponha a porta dela na internet (firewall).
- A Evolution Go chama `MESSAGING_WEBHOOK_URL` (`https://api.seudominio/webhooks/whatsapp`) e baixa as imagens de `API_PUBLIC_URL`, então os dois precisam ser acessíveis por ela.

## Monitoramento e alertas

- **Alertas da plataforma** (número caiu, fila parada, envios falhando): aparecem na Visão geral e são enviados ao _Webhook de alertas_ das Preferências. Para receber no celular, use [ntfy](https://ntfy.sh): instale o app, assine um tópico secreto e cole `https://ntfy.sh/SEU-TOPICO` no campo.
- **Servidor fora do ar / worker parado:** cadastre `https://api.seudominio/v1/status` num monitor externo (UptimeRobot, Healthchecks, Better Stack). Ele responde 503 quando o banco ou o worker param.

## Backup e restauração

O serviço `backup` faz, todo dia às `BACKUP_HOUR` (padrão 4h), um dump do banco e um `.tar.gz` das imagens em `infra/prod/backups/`, mantendo `BACKUP_KEEP_DAYS` dias.

- Backup na hora: `docker compose -f infra/prod/docker-compose.yml exec backup sh /backup.sh now`
- **Cópia fora da VPS** (recomendado): sincronize a pasta com `rclone` para Cloudflare R2/Backblaze B2 num cron do host.
- Restaurar o banco:

  ```bash
  docker compose -f infra/prod/docker-compose.yml stop api worker redirect
  docker compose -f infra/prod/docker-compose.yml exec -T postgres pg_restore -U ofertas -d ofertas --clean --if-exists < infra/prod/backups/db_AAAA-MM-DD_HHMM.dump
  docker compose -f infra/prod/docker-compose.yml start api worker redirect
  ```
- Guarde o `ENCRYPTION_KEY` fora da VPS (gerenciador de senhas): sem ele, as credenciais salvas no backup não abrem.

## Segurança

- Firewall: libere só 22, 80 e 443 (`ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`).
- `ALLOW_SIGNUP=false` (padrão): o primeiro cadastro funciona mesmo assim e vira dono; os demais ficam bloqueados.
- Login limitado a 10 tentativas por e-mail e 20 por IP a cada 15 min. O compose liga `TRUST_PROXY=true` para a API e o redirecionador lerem o IP real atrás do Caddy.
- Postgres e Redis não ficam expostos (só na rede interna do Docker).
