import dotenv from "dotenv";
import dns from "node:dns";
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { getStoragePath, loadBotState } from "./bot-storage.js";
import {
  SYSTEM_PROMPT,
  formatHfApiError,
  formatUpstreamError,
  getHfMaxTokens,
  getHfModel,
  getHfTemperature,
  getHfTimeoutMs,
  getHfToken,
  hfCompleteNonStreaming,
  HF_CHAT_URL,
  isAbortOrTimeout,
  shouldUseLocalFallback,
} from "./hf-chat.js";

/** Prefer IPv4 first — fixes many Linux setups where IPv6 to cloud APIs times out ("fetch failed"). */
dns.setDefaultResultOrder("ipv4first");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, "..", "tokens_env", "tokens.env") });
dotenv.config({
  path: path.join(__dirname, "..", "huggingface_token", "huggingface_token.env"),
});
dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = Number(process.env.PORT) || 3000;
const HF_MODEL = getHfModel();
const HF_TIMEOUT_MS = getHfTimeoutMs();
const HF_MAX_TOKENS = getHfMaxTokens();
const HF_TEMPERATURE = getHfTemperature();
const CHAT_MAX_MESSAGES = Number(process.env.CHAT_MAX_MESSAGES) || 30;
const CHAT_MAX_MESSAGE_CHARS =
  Number(process.env.CHAT_MAX_MESSAGE_CHARS) || 4000;
const RATE_LIMIT_WINDOW_MS =
  Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 25;
const WEB_ADMIN_LOGIN = process.env.WEB_ADMIN_LOGIN || "admin";
const WEB_ADMIN_PASSWORD = process.env.WEB_ADMIN_PASSWORD || "admin";
const SESSION_SECRET =
  process.env.WEB_SESSION_SECRET || crypto.randomBytes(24).toString("hex");
const SESSION_COOKIE = "blog_panel_session";
const BOT_STORAGE_FILE = getStoragePath(__dirname);
/** Streaming is opt-in because some HF providers return incompatible SSE chunks. */
const HF_STREAM =
  process.env.HF_STREAM === "1" ||
  process.env.HF_STREAM === "true" ||
  process.env.HF_STREAM === "on";

const app = express();
const rateBuckets = new Map();
const sessions = new Map();
const botScenarios = [
  {
    command: "/plan",
    title: "Контент-план",
    description: "Проверяет генерацию плана по команде /plan.",
    example: "/plan тестовая тема",
  },
  {
    command: "/ideas",
    title: "Идеи публикаций",
    description: "Проверяет генерацию списка идей по команде /ideas.",
    example: "/ideas тестовая тема",
  },
  {
    command: "/post",
    title: "Структура поста",
    description: "Проверяет структуру ответа по команде /post.",
    example: "/post тестовая тема",
  },
  {
    command: "/video",
    title: "Сценарий видео",
    description: "Проверяет сценарный формат ответа по команде /video.",
    example: "/video тестовая идея",
  },
  {
    command: "/audience",
    title: "Анализ аудитории",
    description: "Проверяет аналитический формат ответа по команде /audience.",
    example: "/audience тестовая ниша",
  },
];

if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

app.use(express.json({ limit: "512kb" }));

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join("=") || "");
  }
  return cookies;
}

function signSessionId(id) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(id)
    .digest("hex");
}

function createSession(login) {
  const id = crypto.randomUUID();
  sessions.set(id, {
    login,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  });
  return `${id}.${signSessionId(id)}`;
}

function getSession(req) {
  const cookie = parseCookies(req)[SESSION_COOKIE];
  if (!cookie) return null;

  const [id, signature] = cookie.split(".");
  if (!id || !signature || signature !== signSessionId(id)) return null;

  const session = sessions.get(id);
  if (!session) return null;
  session.lastSeenAt = Date.now();
  return { id, ...session };
}

function setSessionCookie(res, value) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (session) {
    req.session = session;
    next();
    return;
  }

  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Требуется вход в веб-панель." });
    return;
  }

  res.redirect("/login");
}

function loginPage(error = "") {
  return `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Вход в Bot Control Panel</title>
    <link rel="stylesheet" href="/login.css" />
  </head>
  <body>
    <main class="login-shell">
      <form class="login-card" method="post" action="/login">
        <span class="login-mark">Бот</span>
        <h1>Bot Control Panel</h1>
        <p>Авторизуйтесь для доступа к диагностике, тестовым запросам, настройкам и журналу проверок.</p>
        ${error ? `<div class="login-error">${error}</div>` : ""}
        <label>
          Логин
          <input name="login" autocomplete="username" required />
        </label>
        <label>
          Пароль
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Войти</button>
      </form>
    </main>
  </body>
</html>`;
}

app.use("/login.css", express.static(path.join(__dirname, "public", "login.css")));
app.use(express.urlencoded({ extended: false }));

app.get("/login", (req, res) => {
  if (getSession(req)) {
    res.redirect("/");
    return;
  }
  res.type("html").send(loginPage());
});

app.post("/login", (req, res) => {
  const login = String(req.body?.login || "");
  const password = String(req.body?.password || "");
  if (login !== WEB_ADMIN_LOGIN || password !== WEB_ADMIN_PASSWORD) {
    res.status(401).type("html").send(loginPage("Неверный логин или пароль."));
    return;
  }

  setSessionCookie(res, createSession(login));
  res.redirect("/");
});

app.post("/api/logout", (req, res) => {
  const session = getSession(req);
  if (session) sessions.delete(session.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/session", requireAuth, (req, res) => {
  res.json({ login: req.session.login });
});

app.get("/api/admin/overview", requireAuth, async (req, res) => {
  const state = await loadBotState(BOT_STORAGE_FILE);
  const histories = Object.values(state.histories || {});
  const users = Object.values(state.users || {});
  const lastSeenAt = users
    .map((user) => user.lastSeenAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  res.json({
    product: "Telegram bot runtime",
    panelRole: "Техническая панель администратора для диагностики, тестов и контроля сценариев",
    aiRole:
      "Вспомогательный модуль генерации рекомендаций. Основная логика системы: команды, сценарии, история и пользовательские диалоги.",
    telegramUsers:
      "Пользователи авторизуются через собственный Telegram-аккаунт. Бот получает chat_id и ведет отдельную историю для каждого чата.",
    scaling:
      "Для большого числа пользователей сессии разделяются по chat_id. В этой версии пользователи и история сохраняются в JSON-файл; для промышленной версии можно заменить его на базу данных.",
    ai: {
      provider: "Hugging Face Inference Providers",
      model: HF_MODEL,
      url: HF_CHAT_URL,
      tokenConfigured: Boolean(getHfToken()),
      localFallback: shouldUseLocalFallback(),
      timeoutMs: HF_TIMEOUT_MS,
      maxTokens: HF_MAX_TOKENS,
      temperature: HF_TEMPERATURE,
    },
    web: {
      login: WEB_ADMIN_LOGIN,
      maxMessages: CHAT_MAX_MESSAGES,
      maxMessageChars: CHAT_MAX_MESSAGE_CHARS,
      rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
      rateLimitMax: RATE_LIMIT_MAX,
    },
    telegram: {
      userCount: users.length,
      activeDialogCount: histories.filter((history) => history.length > 0).length,
      storedMessageCount: histories.reduce(
        (sum, history) => sum + history.length,
        0,
      ),
      lastSeenAt: lastSeenAt || "",
      storageFile: BOT_STORAGE_FILE,
      accessMode:
        String(process.env.ALLOWED_TELEGRAM_IDS || "").trim()
          ? "restricted"
          : "public",
    },
    scenarios: botScenarios,
  });
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

function getClientKey(req) {
  return req.ip || req.socket.remoteAddress || "local";
}

function checkRateLimit(req) {
  if (RATE_LIMIT_MAX <= 0) return { ok: true };

  const now = Date.now();
  const key = getClientKey(req);
  const bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.startedAt > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return { ok: true };
  }

  bucket.count += 1;
  if (bucket.count <= RATE_LIMIT_MAX) return { ok: true };

  const retryAfterMs = Math.max(
    0,
    RATE_LIMIT_WINDOW_MS - (now - bucket.startedAt),
  );
  return { ok: false, retryAfterMs };
}

function normalizeIncomingMessages(incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return { error: "Expected non-empty messages array." };
  }
  if (incoming.length > CHAT_MAX_MESSAGES) {
    return {
      error: `Too many messages. Maximum is ${CHAT_MAX_MESSAGES}.`,
    };
  }

  const messages = [];
  for (const [index, message] of incoming.entries()) {
    if (!message || typeof message !== "object") {
      return { error: `Message ${index + 1} must be an object.` };
    }

    const role = message.role;
    if (role !== "user" && role !== "assistant") {
      return {
        error: `Message ${index + 1} has unsupported role.`,
      };
    }

    const content = String(message.content ?? "").trim();
    if (!content) {
      return { error: `Message ${index + 1} is empty.` };
    }
    if (content.length > CHAT_MAX_MESSAGE_CHARS) {
      return {
        error: `Message ${index + 1} is too long. Maximum is ${CHAT_MAX_MESSAGE_CHARS} characters.`,
      };
    }

    messages.push({ role, content });
  }

  return { messages };
}

app.get("/api/meta", (_req, res) => {
  res.json({
    model: HF_MODEL,
    maxTokens: HF_MAX_TOKENS,
    temperature: HF_TEMPERATURE,
    stream: HF_STREAM,
    maxMessages: CHAT_MAX_MESSAGES,
    maxMessageChars: CHAT_MAX_MESSAGE_CHARS,
  });
});

app.post("/api/chat", async (req, res) => {
  const limited = checkRateLimit(req);
  if (!limited.ok) {
    res.setHeader(
      "Retry-After",
      String(Math.ceil(limited.retryAfterMs / 1000)),
    );
    res.status(429).json({
      error: "Слишком много запросов подряд. Подождите немного и попробуйте снова.",
    });
    return;
  }

  if (!getHfToken()) {
    res.status(500).json({
      error:
        "HF_TOKEN is not set. Add it to .env, tokens_env/tokens.env, or huggingface_token/huggingface_token.env.",
    });
    return;
  }

  const { messages: incoming, stream: clientWantsStream } = req.body || {};
  const normalized = normalizeIncomingMessages(incoming);
  if (normalized.error) {
    res.status(400).json({ error: normalized.error });
    return;
  }

  const wantStream = Boolean(clientWantsStream) && HF_STREAM;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...normalized.messages,
  ];

  const payload = {
    model: HF_MODEL,
    messages,
    max_tokens: HF_MAX_TOKENS,
    temperature: HF_TEMPERATURE,
    ...(wantStream ? { stream: true } : {}),
  };

  const t0 = Date.now();
  try {
    console.log(
      `[chat] HF request start: model=${HF_MODEL}, stream=${Boolean(wantStream)}, messages=${messages.length}, max_tokens=${HF_MAX_TOKENS}`,
    );

    if (wantStream) {
      const hfRes = await fetch(HF_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getHfToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HF_TIMEOUT_MS),
      });

      if (!hfRes.ok) {
        const text = await hfRes.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text.slice(0, 500) };
        }
        res.status(hfRes.status).json({
          error: formatHfApiError(data),
          detail: data,
        });
        return;
      }
      if (!hfRes.body) {
        res.status(502).json({ error: "Empty stream from Hugging Face." });
        return;
      }

      try {
        const nodeStream = Readable.fromWeb(hfRes.body);
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        nodeStream.on("error", (e) => {
          console.error("[chat] stream error:", e);
          if (!res.writableEnded) res.end();
        });
        res.on("close", () => {
          nodeStream.destroy();
        });
        nodeStream.pipe(res);
        nodeStream.on("end", () => {
          console.log(`[chat] HF stream done: ${Date.now() - t0}ms`);
        });
      } catch (streamErr) {
        console.error("[chat] stream setup failed:", streamErr);
        if (!res.headersSent) {
          res.status(502).json({
            error: formatUpstreamError(streamErr),
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    const jsonResult = await hfCompleteNonStreaming(messages);
    if (!jsonResult.ok) {
      const st = jsonResult.status && jsonResult.status >= 400 ? jsonResult.status : 502;
      res.status(st).json({
        error: jsonResult.error,
        ...(jsonResult.detail ? { detail: jsonResult.detail } : {}),
      });
      return;
    }

    res.json({
      content: jsonResult.content,
      model: jsonResult.model || HF_MODEL,
    });
  } catch (err) {
    const ms = Date.now() - t0;
    const aborted = isAbortOrTimeout(err);
    console.error(`[chat] HF error after ${ms}ms:`, aborted ? "timeout/aborted" : err);

    if (aborted) {
      res.status(504).json({
        error:
          "Превышено время ожидания ответа Hugging Face (очередь или сеть). Повторите через минуту или смените HF_MODEL в .env.",
      });
      return;
    }

    res.status(502).json({
      error: formatUpstreamError(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Blog advisor UI: http://localhost:${PORT}`);
  console.log(
    `Using model: ${HF_MODEL} (max_tokens=${HF_MAX_TOKENS}, stream=${HF_STREAM ? "on" : "off"})`,
  );
});
