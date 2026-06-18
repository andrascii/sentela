"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface TypeDef {
  value: string;
  label: string;
  hint: string;
  urlLabel: string;
  desc: string;
}

const TYPES: TypeDef[] = [
  {
    value: "http",
    label: "HTTP(S)",
    hint: "https://example.com/health",
    urlLabel: "URL",
    desc: "Делает GET-запрос к URL, проверяет код ответа и измеряет задержку. «Доступен», если код < 400 (или совпадает с «ожидаемыми кодами»). Для сайтов и health-эндпоинтов.",
  },
  {
    value: "api",
    label: "API",
    hint: "https://api.example.com/v1/status",
    urlLabel: "URL",
    desc: "Расширенный HTTP: задаёте метод, заголовки (в т.ч. авторизацию), тело и проверки содержимого ответа (тело содержит строку, JSON-поле равно значению и т.д.). Для мониторинга REST API.",
  },
  {
    value: "tcp",
    label: "TCP",
    hint: "db.example.com:5432",
    urlLabel: "Хост:порт",
    desc: "Открывает TCP-соединение к хосту:порту и меряет время подключения. «Доступен», если порт принимает соединение. Для баз данных, очередей и любых TCP-сервисов.",
  },
  {
    value: "dns",
    label: "DNS",
    hint: "example.com",
    urlLabel: "Хост",
    desc: "Резолвит DNS-запись выбранного типа (A/AAAA/MX/TXT/CNAME/NS). Можно задать ожидаемое значение — поймает подмену или ошибку DNS. Только запрос к DNS, без подключения к серверу.",
  },
  {
    value: "ssl",
    label: "SSL/TLS",
    hint: "example.com",
    urlLabel: "Хост",
    desc: "Делает TLS-рукопожатие (порт 443) и читает сертификат: срок действия, версию TLS, цепочку. Предупреждает заранее об истечении. Следит за самим HTTPS-сертификатом (не за доменом).",
  },
  {
    value: "ping",
    label: "Ping",
    hint: "example.com",
    urlLabel: "Хост / IP",
    desc: "Шлёт ICMP-пакеты (ping), меряет потери пакетов и среднюю задержку. «Доступен», если пакеты доходят. Базовая проверка «жив ли хост».",
  },
  {
    value: "heartbeat",
    label: "Heartbeat",
    hint: "",
    urlLabel: "",
    desc: "Наоборот: ваша задача/крон сами пингуют выданный URL по расписанию. Если сигнал перестаёт приходить — монитор падает. Для бэкапов, кронов и фоновых задач без публичного адреса.",
  },
  {
    value: "domain",
    label: "Домен",
    hint: "example.com",
    urlLabel: "Домен",
    desc: "Проверяет срок РЕГИСТРАЦИИ доменного имени через RDAP (аналог WHOIS) и предупреждает до истечения. Это не сертификат, а само доменное имя — если оно истечёт, сайт перестанет резолвиться.",
  },
  {
    value: "blacklist",
    label: "Blacklist",
    hint: "1.2.3.4",
    urlLabel: "IP / хост",
    desc: "Проверяет, не попал ли IP или домен в DNS-блоклисты (DNSBL, напр. Spamhaus). Важно для почтовых серверов и репутации IP.",
  },
  {
    value: "postgres",
    label: "PostgreSQL",
    hint: "",
    urlLabel: "",
    desc: "Подключается к PostgreSQL по строке подключения и выполняет запрос (по умолчанию SELECT 1), меряет задержку. Проверяет, что БД жива и отвечает. Строка подключения хранится в секрете.",
  },
  {
    value: "mysql",
    label: "MySQL",
    hint: "",
    urlLabel: "",
    desc: "То же, что PostgreSQL, но для MySQL/MariaDB: подключается по строке подключения и выполняет проверочный запрос.",
  },
  {
    value: "redis",
    label: "Redis",
    hint: "cache.example.com:6379",
    urlLabel: "Хост:порт",
    desc: "Подключается к Redis и выполняет PING (с AUTH, если задан пароль). Проверяет доступность кэша или брокера.",
  },
  {
    value: "smtp",
    label: "SMTP",
    hint: "mail.example.com:25",
    urlLabel: "Хост:порт",
    desc: "Подключается к SMTP-серверу (почта), читает приветствие 220 и отвечает EHLO. Проверяет, что почтовый сервер принимает соединения.",
  },
];

const INTERVALS = [
  { value: 60, label: "60 секунд" },
  { value: 300, label: "5 минут" },
  { value: 900, label: "15 минут" },
];

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const DNS_TYPES = ["A", "AAAA", "MX", "TXT", "CNAME", "NS"];
const TLS_VERSIONS = ["TLSv1.1", "TLSv1.2", "TLSv1.3"];

const ASSERTION_TYPES = [
  { value: "body_contains", label: "Тело содержит" },
  { value: "json_equals", label: "JSON-поле равно" },
  { value: "json_exists", label: "JSON-поле существует" },
  { value: "header_contains", label: "Заголовок содержит" },
];

interface AssertionRow {
  type: string;
  path: string;
  name: string;
  value: string;
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
  }
  return out;
}

function parseExpectedStatus(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);
}

function hostFrom(connString: string): string {
  try {
    return new URL(connString).host || "(db)";
  } catch {
    return "(db)";
  }
}

export function AddMonitorForm({
  minIntervalSeconds,
  groups = [],
}: {
  minIntervalSeconds: number;
  groups?: string[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [type, setType] = useState("http");
  const [groupName, setGroupName] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(Math.max(300, minIntervalSeconds));
  const [failThreshold, setFailThreshold] = useState(2);
  const [telegramChatId, setTelegramChatId] = useState("");

  // http / api
  const [expectedStatusText, setExpectedStatusText] = useState("");
  const [method, setMethod] = useState("GET");
  const [headersText, setHeadersText] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [assertions, setAssertions] = useState<AssertionRow[]>([]);
  // dns
  const [dnsRecordType, setDnsRecordType] = useState("A");
  const [dnsExpected, setDnsExpected] = useState("");
  // ssl
  const [minTlsVersion, setMinTlsVersion] = useState("");
  const [verifyChain, setVerifyChain] = useState(false);
  // ping
  const [pingCount, setPingCount] = useState(3);
  // domain
  const [warnDays, setWarnDays] = useState(30);
  // blacklist
  const [rblZonesText, setRblZonesText] = useState("");
  // db
  const [dbUrl, setDbUrl] = useState("");
  const [dbQuery, setDbQuery] = useState("");
  // redis
  const [redisPassword, setRedisPassword] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const activeType = TYPES.find((t) => t.value === type)!;
  const isHttpLike = type === "http" || type === "api";
  const isApi = type === "api";
  const isDb = type === "postgres" || type === "mysql";
  const bodyAllowed = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  function addAssertion() {
    setAssertions((a) => [...a, { type: "body_contains", path: "", name: "", value: "" }]);
  }
  function updateAssertion(i: number, patch: Partial<AssertionRow>) {
    setAssertions((a) => a.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function removeAssertion(i: number) {
    setAssertions((a) => a.filter((_, idx) => idx !== i));
  }

  function buildConfig(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    if (isHttpLike) {
      const expected = parseExpectedStatus(expectedStatusText);
      if (expected.length > 0) c.expectedStatus = expected;
    }
    if (isApi) {
      c.method = method;
      const headers = parseHeaders(headersText);
      if (Object.keys(headers).length > 0) c.headers = headers;
      if (bodyAllowed && bodyText.trim()) c.body = bodyText;
      const cleanAssertions = assertions
        .map((a) => ({
          type: a.type,
          path: a.path.trim() || undefined,
          name: a.name.trim() || undefined,
          value: a.value.trim() || undefined,
        }))
        .filter((a) => {
          if (a.type === "body_contains") return !!a.value;
          if (a.type === "header_contains") return !!a.name && !!a.value;
          if (a.type === "json_equals") return !!a.path && !!a.value;
          return !!a.path;
        });
      if (cleanAssertions.length > 0) c.assertions = cleanAssertions;
    }
    if (type === "dns") {
      c.dnsRecordType = dnsRecordType;
      if (dnsExpected.trim()) c.dnsExpected = dnsExpected.trim();
    }
    if (type === "ssl") {
      if (minTlsVersion) c.minTlsVersion = minTlsVersion;
      if (verifyChain) c.verifyChain = true;
    }
    if (type === "ping") c.pingCount = pingCount;
    if (type === "domain") c.warnDays = warnDays;
    if (type === "blacklist") {
      const zones = rblZonesText
        .split(/[\s,]+/)
        .map((z) => z.trim())
        .filter(Boolean);
      if (zones.length > 0) c.rblZones = zones;
    }
    if (isDb) {
      c.dbUrl = dbUrl.trim();
      if (dbQuery.trim()) c.dbQuery = dbQuery.trim();
    }
    if (type === "redis" && redisPassword) c.redisPassword = redisPassword;
    return c;
  }

  function effectiveUrl(): string {
    if (type === "heartbeat") return "(push)";
    if (isDb) return hostFrom(dbUrl);
    return url;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/monitors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          url: effectiveUrl(),
          type,
          intervalSeconds,
          failThreshold,
          groupName,
          telegramChatId,
          config: buildConfig(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Не удалось создать монитор");
        setLoading(false);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Ошибка сети — попробуйте ещё раз");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-5 p-7">
      <div>
        <label className="label" htmlFor="name">
          Название
        </label>
        <input
          id="name"
          className="input"
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Production API"
        />
      </div>

      <div>
        <label className="label">Тип проверки</label>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {TYPES.map((t) => (
            <button
              type="button"
              key={t.value}
              onClick={() => setType(t.value)}
              className={`rounded-lg border px-2 py-2 text-sm font-medium transition ${
                type === t.value
                  ? "border-brand-500 bg-brand-500/10 text-white"
                  : "border-ink-500 bg-ink-900/50 text-slate-300 hover:border-brand-500/50"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Что делает выбранный тип проверки */}
        <div className="mt-3 flex gap-3 rounded-lg border border-brand-500/25 bg-brand-500/[0.06] px-4 py-3">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            className="mt-0.5 shrink-0 text-brand-300"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
            <path d="M12 11v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <circle cx="12" cy="7.8" r="0.4" fill="currentColor" stroke="currentColor" strokeWidth="1.1" />
          </svg>
          <p className="text-sm leading-relaxed text-slate-300">
            <span className="font-semibold text-white">{activeType.label}.</span>{" "}
            {activeType.desc}
          </p>
        </div>
      </div>

      {/* Target — hidden for heartbeat and db (db uses a connection string) */}
      {type !== "heartbeat" && !isDb && (
        <div>
          <label className="label" htmlFor="url">
            {activeType.urlLabel}
          </label>
          <input
            id="url"
            className="input font-mono"
            required
            maxLength={500}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={activeType.hint}
          />
          <p className="mt-1.5 text-xs text-slate-500">Например: {activeType.hint}</p>
        </div>
      )}

      {type === "heartbeat" && (
        <p className="rounded-lg border border-ink-600/70 bg-ink-900/40 px-4 py-3 text-sm text-slate-400">
          Heartbeat — «выключатель мёртвого человека». После создания вы получите URL, который
          ваша задача/крон должны пинговать по расписанию. Если пинги прекратятся — монитор
          станет недоступным. Ссылка появится на странице монитора.
        </p>
      )}

      {/* HTTP / API: expected status */}
      {isHttpLike && (
        <div>
          <label className="label" htmlFor="expected">
            Ожидаемые коды ответа <span className="text-slate-500">(необязательно)</span>
          </label>
          <input
            id="expected"
            className="input font-mono"
            value={expectedStatusText}
            onChange={(e) => setExpectedStatusText(e.target.value)}
            placeholder="200, 401"
          />
          <p className="mt-1.5 text-xs text-slate-500">
            Через запятую. Укажите <code className="text-slate-400">401</code>, если такой код —
            ожидаемое поведение. Пусто — доступным считается любой код &lt; 400.
          </p>
        </div>
      )}

      {/* API extras */}
      {isApi && (
        <div className="space-y-5 rounded-xl border border-ink-600/70 bg-ink-900/30 p-5">
          <p className="text-sm font-semibold text-white">Параметры API-запроса</p>
          <div>
            <label className="label" htmlFor="method">HTTP-метод</label>
            <select id="method" className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
              {HTTP_METHODS.map((m) => (<option key={m} value={m}>{m}</option>))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="headers">
              Заголовки <span className="text-slate-500">(Имя: значение, по строке)</span>
            </label>
            <textarea id="headers" className="input font-mono" rows={3} value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder={"Authorization: Bearer xxx\nContent-Type: application/json"} />
          </div>
          {bodyAllowed && (
            <div>
              <label className="label" htmlFor="body">Тело запроса</label>
              <textarea id="body" className="input font-mono" rows={3} value={bodyText}
                onChange={(e) => setBodyText(e.target.value)} placeholder='{"ping": true}' />
            </div>
          )}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="label mb-0">Проверки содержимого ответа</label>
              <button type="button" onClick={addAssertion} className="text-xs text-brand-300 hover:underline">
                + Добавить проверку
              </button>
            </div>
            <div className="space-y-2">
              {assertions.map((a, i) => (
                <div key={i} className="flex flex-col gap-2 rounded-lg border border-ink-600/70 bg-ink-900/40 p-2.5 sm:flex-row sm:items-center">
                  <select className="input sm:w-52" value={a.type} onChange={(e) => updateAssertion(i, { type: e.target.value })}>
                    {ASSERTION_TYPES.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
                  </select>
                  {(a.type === "json_equals" || a.type === "json_exists") && (
                    <input className="input font-mono" placeholder="путь, напр. data.status" value={a.path}
                      onChange={(e) => updateAssertion(i, { path: e.target.value })} />
                  )}
                  {a.type === "header_contains" && (
                    <input className="input font-mono" placeholder="имя заголовка" value={a.name}
                      onChange={(e) => updateAssertion(i, { name: e.target.value })} />
                  )}
                  {a.type !== "json_exists" && (
                    <input className="input font-mono" placeholder="значение" value={a.value}
                      onChange={(e) => updateAssertion(i, { value: e.target.value })} />
                  )}
                  <button type="button" onClick={() => removeAssertion(i)} className="shrink-0 px-2 text-sm text-red-300 hover:underline">✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* DNS */}
      {type === "dns" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="dnsType">Тип записи</label>
            <select id="dnsType" className="input" value={dnsRecordType} onChange={(e) => setDnsRecordType(e.target.value)}>
              {DNS_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="dnsExpected">Ожидаемое значение <span className="text-slate-500">(необязательно)</span></label>
            <input id="dnsExpected" className="input font-mono" value={dnsExpected}
              onChange={(e) => setDnsExpected(e.target.value)} placeholder="напр. 93.184.216.34" />
          </div>
        </div>
      )}

      {/* SSL */}
      {type === "ssl" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="minTls">Минимальная версия TLS</label>
            <select id="minTls" className="input" value={minTlsVersion} onChange={(e) => setMinTlsVersion(e.target.value)}>
              <option value="">Не проверять</option>
              {TLS_VERSIONS.map((v) => (<option key={v} value={v}>{v}</option>))}
            </select>
          </div>
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-slate-300">
            <input type="checkbox" checked={verifyChain} onChange={(e) => setVerifyChain(e.target.checked)}
              className="h-4 w-4 rounded border-ink-500 bg-ink-900" />
            Проверять цепочку сертификатов
          </label>
        </div>
      )}

      {/* Ping */}
      {type === "ping" && (
        <div>
          <label className="label" htmlFor="pingCount">Количество пакетов</label>
          <input id="pingCount" type="number" min={1} max={10} className="input w-32" value={pingCount}
            onChange={(e) => setPingCount(Number(e.target.value))} />
        </div>
      )}

      {/* Domain */}
      {type === "domain" && (
        <div>
          <label className="label" htmlFor="warnDays">Предупреждать за (дней до истечения)</label>
          <input id="warnDays" type="number" min={1} max={365} className="input w-32" value={warnDays}
            onChange={(e) => setWarnDays(Number(e.target.value))} />
        </div>
      )}

      {/* Blacklist */}
      {type === "blacklist" && (
        <div>
          <label className="label" htmlFor="rbl">RBL-зоны <span className="text-slate-500">(через пробел; пусто — по умолчанию)</span></label>
          <input id="rbl" className="input font-mono" value={rblZonesText} onChange={(e) => setRblZonesText(e.target.value)}
            placeholder="zen.spamhaus.org bl.spamcop.net" />
        </div>
      )}

      {/* DB connection */}
      {isDb && (
        <div className="space-y-4 rounded-xl border border-ink-600/70 bg-ink-900/30 p-5">
          <div>
            <label className="label" htmlFor="dbUrl">Строка подключения <span className="text-slate-500">(хранится в секрете)</span></label>
            <input id="dbUrl" className="input font-mono" required value={dbUrl} onChange={(e) => setDbUrl(e.target.value)}
              placeholder={type === "postgres" ? "postgres://user:pass@host:5432/db" : "mysql://user:pass@host:3306/db"} />
          </div>
          <div>
            <label className="label" htmlFor="dbQuery">Проверочный запрос</label>
            <input id="dbQuery" className="input font-mono" value={dbQuery} onChange={(e) => setDbQuery(e.target.value)}
              placeholder="SELECT 1" />
          </div>
        </div>
      )}

      {/* Redis password */}
      {type === "redis" && (
        <div>
          <label className="label" htmlFor="redisPw">Пароль Redis <span className="text-slate-500">(необязательно, секрет)</span></label>
          <input id="redisPw" type="password" className="input font-mono" value={redisPassword}
            onChange={(e) => setRedisPassword(e.target.value)} placeholder="••••••" />
        </div>
      )}

      {/* Group */}
      <div>
        <label className="label" htmlFor="group">
          Группа <span className="text-slate-500">(необязательно)</span>
        </label>
        <input id="group" className="input" list="group-list" maxLength={80} value={groupName}
          onChange={(e) => setGroupName(e.target.value)} placeholder="напр. Продакшен / API / Базы данных" />
        <datalist id="group-list">
          {groups.map((g) => (<option key={g} value={g} />))}
        </datalist>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="interval">
            {type === "heartbeat" ? "Ожидаемый период сигнала" : "Интервал проверки"}
          </label>
          <select id="interval" className="input" value={intervalSeconds}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))}>
            {INTERVALS.map((i) => {
              const disabled = i.value < minIntervalSeconds;
              return (
                <option key={i.value} value={i.value} disabled={disabled}>
                  {i.label}{disabled ? " — нужен апгрейд" : ""}
                </option>
              );
            })}
          </select>
          <p className="mt-1.5 text-xs text-slate-500">Минимум {minIntervalSeconds / 60} мин на вашем тарифе.</p>
        </div>

        <div>
          <label className="label" htmlFor="threshold">Подтверждать падение после</label>
          <select id="threshold" className="input" value={failThreshold} onChange={(e) => setFailThreshold(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n} {n === 1 ? "неудачной проверки" : "неудачных проверок подряд"}</option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-slate-500">Защита от ложных срабатываний.</p>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="telegram">
          Telegram chat ID <span className="text-slate-500">(необязательно)</span>
        </label>
        <input id="telegram" className="input font-mono" maxLength={64} value={telegramChatId}
          onChange={(e) => setTelegramChatId(e.target.value)} placeholder="123456789" />
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button type="submit" disabled={loading} className="btn-primary">
          {loading ? "Создание…" : "Создать монитор"}
        </button>
        <Link href="/dashboard" className="btn-ghost">Отмена</Link>
      </div>
    </form>
  );
}
