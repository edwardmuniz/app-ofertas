#!/usr/bin/env bash
# Atualiza o OfZap no servidor: baixa o código novo, refaz a imagem e reinicia os serviços.
# Uso (de qualquer pasta): bash /caminho/do/repo/infra/prod/update.sh
# Banco, imagens e o .env são mantidos. As migrations rodam sozinhas ao subir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ ! -f infra/prod/.env ]; then
  echo "Falta o arquivo infra/prod/.env (veja docs/deploy.md)." >&2
  exit 1
fi

# Servidor com nginx próprio (sem Caddy): usa o arquivo extra.
FILES=(-f infra/prod/docker-compose.yml)
if [ -f /etc/nginx/conf.d/ofzap.conf ]; then
  FILES+=(-f infra/prod/docker-compose.nginx.yml)
fi
compose() { docker compose "${FILES[@]}" --env-file infra/prod/.env "$@"; }

before="$(git rev-parse --short HEAD)"
echo "==> Baixando o código novo"
git pull --ff-only
after="$(git rev-parse --short HEAD)"
if [ "$before" = "$after" ] && [ "${1:-}" != "--force" ]; then
  echo "Já está na versão mais nova ($after). Para refazer mesmo assim: $0 --force"
  exit 0
fi
git log --oneline "$before..$after" 2>/dev/null || true

echo "==> Montando a imagem"
compose build

echo "==> Reiniciando os serviços"
compose up -d --remove-orphans

echo "==> Limpando imagens antigas"
docker image prune -f >/dev/null

echo "==> Conferindo a saúde"
for _ in $(seq 1 30); do
  if status="$(compose exec -T api node -e "fetch('http://localhost:3001/v1/status').then(r=>r.text()).then(t=>{console.log(t);process.exit(t.includes('\"ok\":true')?0:1)}).catch(()=>process.exit(1))" 2>/dev/null)"; then
    echo "$status"
    echo "OK: OfZap atualizado para $after."
    exit 0
  fi
  sleep 2
done
echo "A API não respondeu em 60 s. Veja os registros com:" >&2
echo "  docker compose ${FILES[*]} --env-file infra/prod/.env logs --tail 50 api worker migrate" >&2
exit 1
