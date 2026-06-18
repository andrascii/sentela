#!/usr/bin/env bash
#
# Sentela — деплой на сервер одной командой: ./deploy.sh
# Копирует исходники на сервер (tar по SSH) и поднимает Docker Compose.
# Настройки подключения — в файле .deploy.env (см. .deploy.env.example).
#
set -eo pipefail
cd "$(dirname "$0")"

CONF=".deploy.env"
if [ ! -f "$CONF" ]; then
  echo "❌ Нет файла $CONF. Создай его из шаблона и заполни:"
  echo "   cp .deploy.env.example .deploy.env && nano .deploy.env"
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "./$CONF"; set +a

: "${SERVER_HOST:?Укажи SERVER_HOST в .deploy.env}"
SERVER_USER="${SERVER_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/sentela}"
SSH_PORT="${SSH_PORT:-22}"
# local  = собрать образ на этой машине и передать готовый (надёжно для маленьких VPS);
# remote = собирать на сервере (нужно ~1.5 ГБ RAM на сервере).
BUILD_MODE="${BUILD_MODE:-local}"
SERVER_ARCH="${SERVER_ARCH:-amd64}"   # архитектура сервера: amd64 (большинство VPS) или arm64

SSH_OPTS=(-p "$SSH_PORT" -o StrictHostKeyChecking=accept-new)
SCP_OPTS=(-P "$SSH_PORT" -o StrictHostKeyChecking=accept-new)
[ -n "${SSH_KEY:-}" ] && { SSH_OPTS+=(-i "$SSH_KEY"); SCP_OPTS+=(-i "$SSH_KEY"); }
TARGET="${SERVER_USER}@${SERVER_HOST}"
ssh_run() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

echo "→ Проверяю Docker на ${TARGET} …"
if ! ssh_run 'command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1'; then
  echo "→ Docker/Compose не найдены — устанавливаю на сервере (get.docker.com) …"
  if ! ssh_run 'set -e
    if command -v curl >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh;
    elif command -v wget >/dev/null 2>&1; then wget -qO- https://get.docker.com | sh;
    else echo "Нет curl/wget — установи один из них"; exit 1; fi
    systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true'; then
    echo "❌ Не удалось установить Docker автоматически."
    echo "   Поставь вручную и запусти деплой снова:  curl -fsSL https://get.docker.com | sh"
    exit 1
  fi
  if ! ssh_run 'docker compose version >/dev/null 2>&1'; then
    echo "❌ Docker установлен, но 'docker compose' недоступен (нет compose-плагина или демон не запущен)."
    exit 1
  fi
  echo "✓ Docker установлен и запущен."
fi

echo "→ Создаю каталог ${REMOTE_DIR} …"
ssh_run "mkdir -p '$REMOTE_DIR'"

echo "→ Копирую исходники (tar по SSH) …"
# tar есть и на macOS, и на любом Linux — не требует установки rsync.
# .env и .deploy.env исключены, поэтому секреты на сервере не перезатираются.
tar -czf - \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./.next' \
  --exclude='./.env' \
  --exclude='./.deploy.env' \
  --exclude='./.DS_Store' \
  --exclude='./*.log' \
  . | ssh_run "tar -xzf - -C '$REMOTE_DIR'"

echo "→ Проверяю .env на сервере …"
if ! ssh_run "test -f '$REMOTE_DIR/.env'"; then
  ssh_run "cp '$REMOTE_DIR/.env.example' '$REMOTE_DIR/.env'"
  echo ""
  echo "⚠️  На сервере создан $REMOTE_DIR/.env из шаблона — ЗАПОЛНИ секреты и запусти деплой снова:"
  echo "      ssh ${SSH_OPTS[*]} $TARGET 'nano $REMOTE_DIR/.env'"
  echo "    Обязательно: JWT_SECRET (длинная случайная строка), APP_BASE_URL."
  echo "    Для HTTPS: задай DOMAIN и APP_BASE_URL=https://<DOMAIN>."
  echo "    Подсказка для JWT_SECRET:  openssl rand -hex 32"
  exit 2
fi

if [ "$BUILD_MODE" = "remote" ]; then
  echo "→ Сборка на сервере (docker compose up -d --build) …"
  echo "  ⏳ 2–5 минут; нужно ~1.5 ГБ RAM на сервере (на маленьком VPS добавь swap)."
  ssh_run "cd '$REMOTE_DIR' && docker compose up -d --build --remove-orphans"
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "❌ Для режима BUILD_MODE=local нужен Docker на этой машине (Docker Desktop)."
    echo "   Либо поставь Docker, либо собери на сервере: BUILD_MODE=remote ./deploy.sh"
    exit 1
  fi
  echo "→ Собираю образ локально под linux/${SERVER_ARCH} (серверу не нужны RAM/CPU под сборку) …"
  echo "  ⏳ Первый раз может занять несколько минут (сборка под архитектуру сервера)."
  # --provenance=false → обычный single-arch образ (без attestation-манифеста),
  # чище и быстрее грузится. Отдельный тег, чтобы не затирать локальный sentela:latest.
  docker build --provenance=false --platform "linux/${SERVER_ARCH}" -t sentela:deploy .
  IMG_TMP="${TMPDIR:-/tmp}/sentela-deploy-img.tar.gz"
  echo "→ Сохраняю образ в архив …"
  docker save sentela:deploy | gzip > "$IMG_TMP"
  echo "  размер: $(du -h "$IMG_TMP" | cut -f1)"
  echo "→ Копирую образ на сервер (scp — виден прогресс) …"
  scp "${SCP_OPTS[@]}" "$IMG_TMP" "$TARGET:/tmp/sentela-img.tar.gz"
  rm -f "$IMG_TMP"
  echo "→ Загружаю образ и запускаю на сервере …"
  ssh_run "gunzip -c /tmp/sentela-img.tar.gz | docker load && rm -f /tmp/sentela-img.tar.gz && docker tag sentela:deploy sentela:latest && cd '$REMOTE_DIR' && docker compose up -d --remove-orphans"
fi

echo "→ Статус контейнеров:"
ssh_run "cd '$REMOTE_DIR' && docker compose ps"

echo ""
echo "✅ Деплой приложения завершён.  App: http://${SERVER_HOST}:3000"
echo "   HTTPS (nginx, отдельный слой) — выполни на сервере:"
echo "     1) положи серт:  /etc/monkeyisland/ssl/sentela.org/{fullchain,privatekey}.pem"
echo "     2) docker compose -f docker-compose.nginx.yml up -d"
