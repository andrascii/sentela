# Sentela — нагрузочный генератор (сравнение CDN)

Шлёт **реальный** трафик на боевые эндпоинты Sentela (origin или домен за CDN),
чтобы оценить, как разные CDN ведут себя под нагрузкой, **до** запуска рекламы.
Не синтетический ping — повторяет то, что делает браузер живого пользователя:

- **Анонимные заходы** (основная масса, как трафик с рекламы): `/`, `/pricing`,
  `/login`, `/register`, `/about`, `/status/<slug>` + их `/_next/static/*` JS/CSS.
- **Авторизованные сессии**: логин → `/dashboard` + RSC-переходы (`?_rsc=`, заголовок
  `RSC: 1`) по `/dashboard/incidents`, `/dashboard/monitors/<id>` и т.д.
- **WebSocket** `/realtime` — пул живых соединений, как открытые вкладки дашборда.
- **POST** — настоящий логин (с переиспользованием cookie) + опциональный дешёвый
  POST-пробинг для проверки проброса POST через CDN.

Сам себя регулирует под целевую **полосу (Мбит/с)**, которая идёт по **суточной
кривой**: утром ниже, днём больше, вечером пик. Считает перцентили задержек,
коды ответов, попадания в кэш CDN, статистику WebSocket — пишет всё в JSONL,
чтобы построить графики за пару дней.

> ⚠️ Запускай **только против своих доменов**. Это генератор нагрузки —
> по сути управляемый DoS по своей инфраструктуре. Задай `ALLOWED_HOSTS`.

## Требования

- Node.js ≥ 18 на **отдельном** сервере (не на origin!), желательно ближе к
  аудитории и с аплинком ≥ `MAX_MBPS × число CDN`. Для 150 Мбит/с на 1 цель
  хватает скромной VPS; для сравнения 3 CDN сразу нужен канал ~450 Мбит/с.
- Пара **выделенных тестовых аккаунтов** в приложении (для dashboard + WS).
  Не используй живые аккаунты клиентов.

## Быстрый старт

```bash
cd loadtest
npm install --omit=dev          # ставит только ws

# 1) Посмотреть суточную кривцу нагрузки (ничего не шлёт):
MODE=schedule MIN_MBPS=50 MAX_MBPS=150 TZ_OFFSET_HOURS=3 node load-test.mjs

# 2) Дымовой тест — один функциональный проход по каждой цели (GET+ассеты+логин+WS):
cp config.example.env config.env && nano config.env   # впиши TARGETS, TEST_ACCOUNTS, ALLOWED_HOSTS
set -a; . ./config.env; set +a
MODE=smoke node load-test.mjs

# 3) Боевой прогон:
node load-test.mjs
```

Остановить: `Ctrl-C`, либо `touch ./STOP` (мягко сольёт нагрузку), либо
`systemctl stop` под systemd.

## Сравнение нескольких CDN

Перечисли все домены в `TARGETS` — **каждый получает свой независимый бюджет
Мбит/с и отдельные метрики**, то есть нагрузка на все CDN одинаковая (честное
сравнение). В консоли и в JSONL каждая строка помечена `host`.

```bash
TARGETS=https://top661743905.mwscdn.ru,https://cdn2.example.ru node load-test.mjs
```

Хочешь полностью изолировать CDN друг от друга (чтобы один тормозящий CDN не
влиял на учёт другого) — запусти по отдельному процессу/инстансу на каждый CDN с
одинаковым конфигом и сравни логи.

## Как читать метрики

Строка в консоли (раз в `METRICS_INTERVAL_SEC`):

```
[18:42:10] top661743905.mwscdn.ru  118.4/120.0 Mbps  31.5 rps  page p95=240ms p99=520ms  asset p95=90ms  2xx=940 4xx=12 5xx=0 err=1  ws=40(ok 4/4)  cache h/m/u=812/120/20
```

| Поле | Что значит | На что смотреть при выборе CDN |
|---|---|---|
| `actual/target Mbps` | фактическая / целевая полоса | держит ли CDN целевую полосу |
| `page p95/p99` | задержка полной загрузки страницы | главный показатель «живости» |
| `asset p95` | задержка статики `/_next/static` | скорость отдачи из кэша edge |
| `2xx/4xx/5xx/err` | коды и сетевые ошибки | рост 5xx/err под нагрузкой = плохо |
| `ws` | активные WS и доля успешных коннектов | стабильность WebSocket через CDN |
| `cache h/m/u` | hit / miss / unknown | кэширует ли CDN статику (нужно включить кэш в CDN) |

Полные данные (по классам запросов, ttfb, типам ошибок) — в
`logs/loadtest-YYYY-MM-DD.jsonl`, одна JSON-строка на интервал на цель. Пример
быстрой сводки:

```bash
# средний page p95 и доля 5xx по каждому хосту за сутки
cat logs/*.jsonl | jq -r '[.host, .by_class.page.p95, .status."5xx", .actual_mbps] | @tsv'
```

## Деплой одной командой (рекомендуется)

`deploy.sh` сам зальёт скрипт на сервер-генератор, поставит Node.js (если нет),
зависимости и systemd-сервис. С локальной машины:

```bash
cd loadtest
cp .deploy.env.example .deploy.env && nano .deploy.env   # SERVER_HOST, SSH_PORT, SSH_KEY…
cp config.example.env config.env && nano config.env      # TARGETS, ALLOWED_HOSTS, TEST_ACCOUNTS
./deploy.sh
```

После этого заходишь на сервер и **включаешь** нагрузку:

```bash
ssh root@<SERVER_HOST>
systemctl start sentela-loadtest        # включить
journalctl -u sentela-loadtest -f       # смотреть метрики
systemctl stop  sentela-loadtest        # выключить
```

- Локальный `config.env` при каждом `./deploy.sh` заливается на сервер (правишь
  настройки в одном месте). Если локального нет — на сервере берётся серверный.
- `./deploy.sh --start` — залить и сразу запустить (если `config.env` заполнен;
  скрипт не даст стартовать с пустыми `TARGETS`/`ALLOWED_HOSTS`, чтобы сервис не
  ушёл в рестарт-цикл).
- Повторный `./deploy.sh` обновляет код на месте; перезапусти сервис, чтобы
  подхватить: `systemctl restart sentela-loadtest`.
- `Restart=always` поднимет процесс после падения/перезагрузки. Суточная кривая
  нагрузки идёт по часам сама — отдельный крон не нужен.

### Вручную (без deploy.sh)

См. шапку `sentela-loadtest.service`. Кратко:

```bash
sudo useradd -r -s /usr/sbin/nologin loadtest 2>/dev/null || true
sudo cp -r loadtest /opt/sentela-loadtest
sudo chown -R loadtest:loadtest /opt/sentela-loadtest
cd /opt/sentela-loadtest
sudo -u loadtest npm install --omit=dev
sudo -u loadtest cp config.example.env config.env
sudo -u loadtest nano config.env          # set TARGETS, TEST_ACCOUNTS, ALLOWED_HOSTS
sudo cp sentela-loadtest.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sentela-loadtest
journalctl -u sentela-loadtest -f
```

## Безопасность origin (важно)

Скрипт намеренно щадит твой backend, потому что цель — мерить **CDN/сеть**, а не
ронять origin:

- **Логины ограничены**: cookie переиспользуется (`LOGIN_REFRESH_SEC`), поэтому
  дорогой bcrypt на origin вызывается редко. Не повышай частоту логинов бездумно.
- **POST-пробинг** использует несуществующие email → быстрый 401 без bcrypt.
- **register по умолчанию не дёргается** (создавал бы мусорные строки в БД).
- **heartbeat по умолчанию выключен** (пишет в БД). Включай только с реальными
  токенами тестовых мониторов.
- `ALLOWED_HOSTS`, `MAX_CONCURRENCY`, `MAX_SOCKETS` — предохранители.

Начни консервативно (`MAX_MBPS=60`, `WS_TARGET=10`), посмотри на origin (CPU, БД,
`docker stats`), затем поднимай. Помни: основную полосу даёт отдача статики —
это нагрузка на **CDN/сеть**, а не на origin.

## Все параметры

См. комментарии в `config.example.env`. Самое частое:

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `TARGETS` | — | список базовых URL (через запятую) |
| `MIN_MBPS` / `MAX_MBPS` | 50 / 150 | полоса на цель (нижняя ночь/утро, верхняя вечер) |
| `TZ_OFFSET_HOURS` | local | часовой пояс аудитории (Москва = 3) |
| `TEST_ACCOUNTS` | — | `email:pass,...` для dashboard + WS |
| `AUTH_FRACTION` | 0.2 | доля авторизованных заходов |
| `WS_TARGET` | 40 | постоянные WS-соединения на цель |
| `MONITOR_IDS` / `STATUS_PROJECTS` | — | реальные id для достоверных путей |
| `MAX_CONCURRENCY` | 400 | потолок одновременных заходов на цель |
| `DURATION_SEC` | 0 | 0 = до остановки |
