# Деплой Sentela на сервер

Деплой в одну команду — `./deploy.sh`. Скрипт копирует исходники на сервер (tar по SSH)
и поднимает Docker Compose (приложение + воркер + PostgreSQL, опционально Caddy для HTTPS).
Если на сервере нет Docker — ставит его автоматически. Дополнительных утилит (rsync и т.п.)
не требуется.

## Что нужно на сервере
- Linux + доступ по **SSH** под root (лучше по ключу)
- открытые порты: `3000` (или `80`/`443`, если включаешь HTTPS)
- Docker (поставится автоматически, если его нет)

## Где собирается образ
По умолчанию (`BUILD_MODE=local`) образ **собирается на твоей машине** (нужен Docker
Desktop) и передаётся на сервер готовым — серверу не нужны RAM/CPU под сборку. Это
спасает маленькие VPS, где `next build` уходит в своп на часы.

Если сервер мощный (≥ 2 ГБ RAM) и хочешь собирать на нём — поставь в `.deploy.env`
`BUILD_MODE=remote` (тогда нужен swap при < 1.5 ГБ RAM).

Архитектура сервера для локальной сборки задаётся `SERVER_ARCH` (по умолчанию `amd64`).

**Docker ставить вручную не нужно** — если его нет, `deploy.sh` сам установит
Docker + Compose v2 через официальный скрипт `get.docker.com`. (Нужен `curl` или
`wget` на сервере; деплой под non-root требует sudo/root-доступа.)

## Первый деплой

```bash
# 1. Настрой подключение к серверу
cp .deploy.env.example .deploy.env
nano .deploy.env          # SERVER_HOST, SERVER_USER, REMOTE_DIR, SSH_PORT

# 2. Запусти — на первом прогоне создастся .env на сервере и скрипт остановится
./deploy.sh

# 3. Заполни секреты на сервере
ssh root@SERVER 'nano /srv/sentela/.env'
#   JWT_SECRET   — длинная случайная строка:  openssl rand -hex 32
#   APP_BASE_URL — публичный адрес (https://sentela.org или http://IP:3000)
#   TELEGRAM_BOT_TOKEN — токен бота (для алертов), опционально

# 4. Запусти ещё раз — соберёт образ и поднимет контейнеры
./deploy.sh
```

Готово. Приложение поднято на порту **3000**. Дальше любой **повторный деплой** —
просто `./deploy.sh`. База данных хранится в Docker-томе и переживает редеплои.

## HTTPS (отдельный слой nginx + ваш сертификат)

HTTPS вынесен в отдельный файл `docker-compose.nginx.yml` — nginx терминирует TLS
вашим сертификатом и проксирует на приложение (`127.0.0.1:3000`).

1. Положи сертификат и ключ на сервер:
   ```
   /etc/monkeyisland/ssl/sentela.org/fullchain.pem
   /etc/monkeyisland/ssl/sentela.org/privatekey.pem
   ```
2. В серверном `.env`: `APP_BASE_URL=https://sentela.org`
3. Запусти nginx-слой на сервере (после того как приложение поднято через `./deploy.sh`):
   ```bash
   cd /srv/sentela
   docker compose -f docker-compose.nginx.yml up -d
   ```
   nginx слушает 80/443 (`network_mode: host`), редиректит HTTP→HTTPS и проксирует на app.

Домен `sentela.org` и пути к сертификату прописаны в `nginx/sentela.conf` — поправь там,
если домен другой. Сертификат продлеваешь сам (выпуск на другом сервере + копирование сюда).

> Для быстрой проверки по `http://IP:3000` без HTTPS добавь в `.env`:
> `COOKIE_SECURE=false` (иначе secure-куки блокируют логин по обычному HTTP).

## Прод-настройки безопасности
- **`JWT_SECRET`** — обязательно поменяй на случайный (`openssl rand -hex 32`).
- **`ALLOW_PRIVATE_TARGETS`** — оставь `false` (блокирует мониторинг внутренних/служебных адресов).
- Порт `3000` на сервере лучше закрыть фаерволом, если используешь HTTPS через Caddy.
- Пароль внутренней БД (`edgepulse_password`) не виден снаружи (порт PostgreSQL не публикуется),
  но при желании поменяй его в `docker-compose.yml` (3 места) и пересобери.

## Полезные команды на сервере

```bash
cd /opt/sentela
docker compose ps                 # статус
docker compose logs -f app        # логи приложения
docker compose logs -f worker     # логи воркера (проверки/алерты)
docker compose down               # остановить (данные БД сохраняются)
docker compose up -d --build      # пересобрать и поднять
```
