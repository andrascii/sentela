# Xray за nginx (маскировка VPN под WSS к сайту)

Это **необязательная инфраструктура**, не связанная с кодом Sentela. nginx, который
уже терминирует TLS для `sentela.org`, дополнительно проксирует **секретные
WebSocket-пути** в локальный сервер **Xray** (VLESS over WS). Для внешнего
наблюдателя это обычный HTTPS-трафик к сайту. Приложение Sentela в этом не
участвует — пути идут мимо него.

```
клиент ──WSS──> nginx :443 (TLS) ──┬─ /                         → 127.0.0.1:3000  (Sentela)
                                    ├─ /realtime                 → 127.0.0.1:3001  (realtime WS)
                                    ├─ /<секрет-1>               → 127.0.0.1:10001 (Xray, клиент 1)
                                    └─ /<секрет-2>               → 127.0.0.1:10002 (Xray, клиент 2)
```

## Установка (на сервере)

1. Установи Xray:
   ```bash
   bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
   ```
2. Сгенерируй **свои** секреты для каждого клиента (пример в файлах — замени!):
   ```bash
   openssl rand -hex 12   # ws-путь, напр. /a1b2c3...
   uuidgen                # UUID клиента
   ```
3. Положи конфиг (на основе `config.example.json`) в `/usr/local/etc/xray/config.json`,
   подставив свои порты/пути/UUID. Запусти: `systemctl enable --now xray`.
4. Добавь location-блоки из `nginx-locations.example.conf` в `server { listen 443 }`
   твоего `nginx/sentela.conf` — **выше** `location /` — и перечитай nginx:
   ```bash
   docker compose -f docker-compose.nginx.yml exec nginx nginx -s reload
   # или: nginx -t && nginx -s reload, если nginx ставился вне docker
   ```

## Параметры подключения клиента (VLESS)

| Поле        | Значение                          |
|-------------|-----------------------------------|
| Протокол    | VLESS                             |
| Адрес       | `sentela.org`                     |
| Порт        | `443`                             |
| UUID        | твой UUID клиента                 |
| Encryption  | `none`                            |
| Transport   | `ws`                              |
| Path        | твой секретный путь, напр. `/a1b2…` |
| Host/SNI    | `sentela.org`                     |
| TLS         | включён (рукопожатие с nginx)     |

## Добавить нового клиента

1. Новый `inbound` в `config.json`: новый `port` (напр. 10003), новый `path`, новый UUID.
2. Новый `location` в nginx с тем же путём → `127.0.0.1:10003`.
3. `systemctl restart xray` и reload nginx.

## Замечания

- **Путь = пароль.** Делай его длинным и случайным; короткий легко перебрать/обнаружить.
- **Общий домен — общий риск.** Если домен заблокируют из-за VPN-трафика, ляжет и сайт
  Sentela. Многие выносят VPN на отдельный поддомен.
- **Секреты — вне git.** Реальные `config.json` и nginx-локации с путями/UUID не коммить
  (см. `.gitignore`). В репозитории — только `*.example.*`.
