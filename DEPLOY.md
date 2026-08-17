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
если домен другой. Сертификат можно продлевать без остановки nginx: на порту 80 отдан
webroot `/var/www/certbot` под ACME-челленджи
(`certbot certonly --webroot -w /var/www/certbot -d sentela.org -d www.sentela.org`).

> Для быстрой проверки по `http://IP:3000` без HTTPS добавь в `.env`:
> `COOKIE_SECURE=false` (иначе secure-куки блокируют логин по обычному HTTP).

### Серверные особенности конфига: drop-in каталог `/etc/sentela/nginx.d`

`nginx/sentela.conf` перезаписывается каждым деплоем — **руками на сервере его не править**.
Всё специфичное для конкретного сервера кладётся на хосте в `/etc/sentela/nginx.d`
(каталог создаётся деплоем, монтируется в контейнер read-only):

- `*.locations` — location-блоки, которые включаются **внутрь** основного HTTPS-сервера
  Sentela (например, websocket-эндпоинт соседнего сервиса);
- `*.server` — целые server-блоки http-контекста (например, соседний сайт на том же IP
  со своим сертификатом).

После правки drop-in'ов: `docker exec sentela-nginx nginx -t && docker exec sentela-nginx nginx -s reload`.
Деплой делает это сам (и падает, если `nginx -t` не проходит, оставляя работать старый конфиг).

> xray websocket-инбаунд `/monitor` → `127.0.0.1:10086` (VPN, совмещённый с Sentela)
> уже встроен в стандартный `nginx/sentela.conf` — drop-in для него не нужен.
> На серверах без xray этот location просто отдаёт 502 и ни на что не влияет.

Пример drop-in'а — соседний сайт на том же IP:

```nginx
# /etc/sentela/nginx.d/20-masquerade.server
server {
    listen 443 ssl;
    server_name .example.org;
    ssl_certificate     /etc/monkeyisland/ssl/example.org/fullchain.pem;
    ssl_certificate_key /etc/monkeyisland/ssl/example.org/privatekey.pem;
    location / { root /var/www/html; index index.html; }
}
```

### Миграция со схемы «haproxy на 443» (если раньше nginx жил на 127.0.0.1:8000)

Если на сервере nginx стоял за haproxy (SNI-роутинг, `proxy_protocol`), а теперь nginx
должен слушать 443/80 сам:

1. Перенеси ручные добавки из старого `nginx/sentela.conf` в `/etc/sentela/nginx.d/`
   (location'ы → `*.locations`, отдельные server-блоки → `*.server`; в server-блоках
   замени `listen 127.0.0.1:<порт> ssl ... proxy_protocol` на `listen 443 ssl` и убери
   `real_ip_header proxy_protocol`/`set_real_ip_from` — прокси-слоя больше нет).
   `/monitor` переносить не надо — он теперь в стандартном конфиге.
2. Освободи 443/80: убери `bind *:443` из фронтенда haproxy (остальные его порты можно
   оставить) и перезапусти haproxy, либо останови его совсем, если больше не нужен.
3. Запусти `./deploy.sh` — стандартный конфиг встанет на 443/80, drop-in'ы подхватятся.
4. Проверь: `curl -sI https://sentela.org` (200/302) и `curl -sI http://sentela.org`
   (301 на https).

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
