#!/usr/bin/env bash
#
# Sentela load generator — деплой нагрузочного скрипта на сервер одной командой.
#   ./deploy.sh            — залить и подготовить сервер (НЕ запускает тест)
#   ./deploy.sh --start    — то же + сразу включить (нужен заполненный config.env)
#   ./deploy.sh --no-start — гарантированно не запускать
#
# Что делает: копирует loadtest/ на сервер (tar по SSH), ставит Node.js (если нет),
# npm-зависимости, заводит systemd-сервис sentela-loadtest. После этого ты заходишь
# на сервер и включаешь:  systemctl start sentela-loadtest
#
# Настройки подключения — в файле .deploy.env (см. .deploy.env.example).
set -eo pipefail
cd "$(dirname "$0")"

# ── флаги ────────────────────────────────────────────────────────────────────
AUTOSTART="${AUTOSTART:-no}"
for arg in "$@"; do
  case "$arg" in
    --start)    AUTOSTART="yes" ;;
    --no-start) AUTOSTART="no" ;;
    *) echo "Неизвестный флаг: $arg"; exit 1 ;;
  esac
done

# ── конфиг подключения ───────────────────────────────────────────────────────
CONF=".deploy.env"
if [ ! -f "$CONF" ]; then
  echo "❌ Нет файла $CONF. Создай из шаблона и заполни:"
  echo "   cp .deploy.env.example .deploy.env && nano .deploy.env"
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "./$CONF"; set +a

: "${SERVER_HOST:?Укажи SERVER_HOST в .deploy.env}"
SERVER_USER="${SERVER_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/sentela-loadtest}"
SSH_PORT="${SSH_PORT:-22}"
SERVICE_USER="${SERVICE_USER:-loadtest}"
NODE_MAJOR="${NODE_MAJOR:-20}"

SSH_OPTS=(-p "$SSH_PORT" -o StrictHostKeyChecking=accept-new)
SCP_OPTS=(-P "$SSH_PORT" -o StrictHostKeyChecking=accept-new)
# ssh не раскрывает ~ в пути к ключу — делаем это сами.
[ -n "${SSH_KEY:-}" ] && SSH_KEY="${SSH_KEY/#\~/$HOME}"
[ -n "${SSH_KEY:-}" ] && { SSH_OPTS+=(-i "$SSH_KEY"); SCP_OPTS+=(-i "$SSH_KEY"); }
TARGET="${SERVER_USER}@${SERVER_HOST}"
ssh_run() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

echo "→ Сервер: ${TARGET}, каталог: ${REMOTE_DIR}, сервис-пользователь: ${SERVICE_USER}"

# ── 1. Node.js + системный пользователь + каталог ────────────────────────────
echo "→ Проверяю Node.js (нужен ≥18) и готовлю окружение …"
ssh_run "NODE_MAJOR='$NODE_MAJOR' SERVICE_USER='$SERVICE_USER' REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -e
SUDO=""; SUDOE=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; SUDOE="sudo -E"; fi

need_node=1
if command -v node >/dev/null 2>&1; then
  v=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "${v:-0}" -ge 18 ] 2>/dev/null; then need_node=0; fi
fi

if [ "$need_node" -eq 1 ]; then
  echo "  → Node.js не найден или старый — ставлю Node ${NODE_MAJOR}.x (NodeSource) …"
  if ! command -v curl >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -y && $SUDO apt-get install -y curl;
    elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y curl;
    elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y curl; fi
  fi
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDOE bash -
    $SUDO apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO bash -
    $SUDO dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO bash -
    $SUDO yum install -y nodejs
  else
    echo "  ❌ Неизвестный пакетный менеджер. Поставь Node.js ≥18 вручную и запусти деплой снова."
    exit 1
  fi
fi
echo "  ✓ Node $(node --version)"

# Системный пользователь под сервис (без логина).
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  $SUDO useradd -r -s /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null || true
  echo "  ✓ Создан пользователь $SERVICE_USER"
fi

$SUDO mkdir -p "$REMOTE_DIR"
REMOTE
echo "✓ Окружение готово."

# ── 2. Копирую исходники (tar по SSH) ────────────────────────────────────────
echo "→ Копирую файлы нагрузочного скрипта …"
# config.env и .deploy.env исключены, чтобы не затирать настройки на сервере.
tar -czf - \
  --exclude='./node_modules' \
  --exclude='./logs' \
  --exclude='./config.env' \
  --exclude='./.deploy.env' \
  --exclude='./STOP' \
  --exclude='./.git' \
  --exclude='./.DS_Store' \
  --exclude='./*.log' \
  . | ssh_run "tar -xzf - -C '$REMOTE_DIR'"
echo "✓ Файлы скопированы."

# ── 3. config.env: локальный имеет приоритет, иначе создаём из шаблона ────────
if [ -f "config.env" ]; then
  echo "→ Заливаю локальный config.env на сервер …"
  scp "${SCP_OPTS[@]}" config.env "$TARGET:$REMOTE_DIR/config.env" >/dev/null
  echo "✓ config.env обновлён из локального."
else
  ssh_run "test -f '$REMOTE_DIR/config.env' || cp '$REMOTE_DIR/config.example.env' '$REMOTE_DIR/config.env'"
  echo "ℹ Локального config.env нет — на сервере используется config.env (создан из шаблона при первом деплое)."
fi

# ── 4. Зависимости + права + systemd-сервис ──────────────────────────────────
echo "→ Ставлю npm-зависимости и регистрирую systemd-сервис …"
START_OUT=$(ssh_run "AUTOSTART='$AUTOSTART' SERVICE_USER='$SERVICE_USER' REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -e
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
cd "$REMOTE_DIR"

$SUDO npm install --omit=dev --no-fund --no-audit >/dev/null
$SUDO chown -R "$SERVICE_USER":"$SERVICE_USER" "$REMOTE_DIR"

# Подставляем реальные пути/пользователя в unit (на случай нестандартного REMOTE_DIR).
$SUDO sed -e "s#/opt/sentela-loadtest#${REMOTE_DIR}#g" \
          -e "s/^User=.*/User=${SERVICE_USER}/" \
          -e "s/^Group=.*/Group=${SERVICE_USER}/" \
          "$REMOTE_DIR/sentela-loadtest.service" \
  | $SUDO tee /etc/systemd/system/sentela-loadtest.service >/dev/null
$SUDO systemctl daemon-reload
$SUDO systemctl enable sentela-loadtest >/dev/null 2>&1 || true

# Готов ли config.env (иначе сервис упал бы в рестарт-цикл — load-test.mjs требует ALLOWED_HOSTS).
READY=0
if grep -qE '^[[:space:]]*TARGETS=.+' config.env && grep -qE '^[[:space:]]*ALLOWED_HOSTS=.+' config.env; then READY=1; fi

if [ "$AUTOSTART" = "yes" ] && [ "$READY" = "1" ]; then
  $SUDO systemctl restart sentela-loadtest
  echo "STARTED"
elif [ "$AUTOSTART" = "yes" ] && [ "$READY" = "0" ]; then
  echo "START_SKIPPED_CONFIG_INCOMPLETE"
fi
echo "READY=$READY"
REMOTE
)
echo "✓ Зависимости установлены, сервис зарегистрирован."

# ── 5. Итог + подсказки ──────────────────────────────────────────────────────
SSH_HINT="ssh ${SSH_OPTS[*]} $TARGET"
echo ""
echo "✅ Деплой завершён."
if echo "$START_OUT" | grep -q "STARTED"; then
  echo "🚀 Нагрузочное тестирование ЗАПУЩЕНО (--start, config.env заполнен)."
  echo "   Логи:  $SSH_HINT 'journalctl -u sentela-loadtest -f'"
  echo "   Стоп:  $SSH_HINT 'systemctl stop sentela-loadtest'"
else
  if echo "$START_OUT" | grep -q "START_SKIPPED_CONFIG_INCOMPLETE"; then
    echo "⚠️  --start пропущен: в config.env не заданы TARGETS и/или ALLOWED_HOSTS."
  fi
  if echo "$START_OUT" | grep -q "READY=0"; then
    echo "⚠️  config.env не заполнен. Сначала укажи TARGETS и ALLOWED_HOSTS (и TEST_ACCOUNTS для WS):"
    echo "      $SSH_HINT 'nano $REMOTE_DIR/config.env'"
  fi
  echo ""
  echo "Чтобы включить нагрузку — зайди на сервер и запусти сервис:"
  echo "      $SSH_HINT"
  echo "      systemctl start sentela-loadtest        # включить"
  echo "      journalctl -u sentela-loadtest -f       # смотреть метрики"
  echo "      systemctl stop  sentela-loadtest        # выключить"
fi
echo ""
echo "Совет: настрой config.env ЛОКАЛЬНО (cp config.example.env config.env), и при"
echo "следующем ./deploy.sh он зальётся на сервер автоматически."
