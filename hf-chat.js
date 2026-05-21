/**
 * Shared Hugging Face chat-completions (OpenAI-compatible router) — non-streaming.
 * Used by Express /api/chat (JSON mode) and by the Telegram bot.
 */

export const HF_CHAT_URL =
  process.env.HF_CHAT_URL ||
  "https://router.huggingface.co/v1/chat/completions";

export const SYSTEM_PROMPT = `Ты — практичный советник по ведению блогов. Помогаешь с темой, структурой, стилем, контент-планом, частотой публикаций, работой с аудиторией и организацией процесса.

Правила качества:
- Отвечай на языке пользователя. Если пользователь пишет по-русски, весь ответ должен быть на русском.
- Не вставляй китайский, японский, корейский или случайные английские фрагменты в русский ответ.
- Английские названия платформ и сервисов допустимы: Instagram, Telegram, TikTok, YouTube, Reels, Shorts, Stories.
- Термин "Tone of voice" в русских ответах называй "тон коммуникации" или "тон общения".
- Не оставляй пустые разделы. Если написал заголовок "Хук:", "Боли:", "CTA:", "Кадр:", "Голос:" или похожий раздел, сразу заполни его конкретным содержанием.
- Если пользователь просит структуру, сценарий, контент-план или аудиторию, дай все заявленные блоки, без пропусков.
- Не начинай ответ с уточняющих вопросов, если можно сделать разумные предположения. Сначала дай полезный вариант, а уточнения добавляй только в конце и максимум 2.
- Если используешь нумерованные разделы, нумеруй их последовательно: 1, 2, 3, 4. Не начинай каждый новый раздел с "1.".
- Таблицы используй только если пользователь прямо просит таблицу; иначе отвечай списками.

Отвечай ясно и по делу. Поддерживай русский и английский языки пользователя.`;

export function getHfTimeoutMs() {
  return Number(process.env.HF_TIMEOUT_MS) > 0
    ? Number(process.env.HF_TIMEOUT_MS)
    : 120_000;
}

export function getHfMaxTokens() {
  /** Long content plans need room; Telegram can split long replies safely. */
  return Number(process.env.HF_MAX_TOKENS) > 0
    ? Number(process.env.HF_MAX_TOKENS)
    : 3072;
}

export function getHfTemperature() {
  const value = Number(process.env.HF_TEMPERATURE);
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : 0.45;
}

export function getHfModel() {
  return (
    process.env.HF_MODEL || "moonshotai/Kimi-K2-Instruct-0905"
  );
}

export function getHfToken() {
  return process.env.HF_TOKEN || process.env.TOKEN || "";
}

export function shouldRetryQuality() {
  const value = String(process.env.HF_RETRY_QUALITY ?? "1").toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

export function formatHfApiError(data, fallback = "Hugging Face API error") {
  const raw =
    data?.error?.message ||
    data?.error ||
    data?.message ||
    data?.raw ||
    fallback;
  const message = typeof raw === "string" ? raw : fallback;

  if (/sufficient permissions.*Inference Providers/i.test(message)) {
    return (
      "Hugging Face токен найден, но у него нет разрешения Inference Providers. " +
      "Создайте новый токен в Hugging Face Settings > Access Tokens с правом на inference и замените HF_TOKEN в .env."
    );
  }

  if (/invalid token|unauthorized|authentication/i.test(message)) {
    return (
      "Hugging Face отклонил токен. Проверьте HF_TOKEN в .env или создайте новый токен в настройках Hugging Face."
    );
  }

  return message || fallback;
}

export function formatUpstreamError(err) {
  if (!(err instanceof Error)) return "Сеть или Hugging Face временно недоступны.";
  const chain = [];
  let e = err;
  for (let i = 0; i < 6 && e instanceof Error; i++) {
    chain.push(e.message);
    e = e.cause;
  }
  const joined = chain.join(" · ");
  console.error("[hf-chat] upstream error chain:", joined);

  if (/fetch failed/i.test(joined)) {
    return (
      "Не удалось соединиться с Hugging Face (fetch failed). " +
      "Проверьте интернет; на Linux часто помогает ipv4first / прокси. " +
      "Техническая цепочка: " +
      joined
    );
  }
  return joined || "Сеть или Hugging Face временно недоступны.";
}

export function isAbortOrTimeout(err) {
  let e = err;
  for (let i = 0; i < 3 && e instanceof Error; i++) {
    if (e.name === "AbortError" || e.name === "TimeoutError") return true;
    if (typeof e.message === "string" && /aborted|abort|timeout/i.test(e.message))
      return true;
    e = e.cause;
  }
  return false;
}

const CJK_TEXT_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;
const RUSSIAN_TEXT_RE = /[А-Яа-яЁё]/u;
const IMPORTANT_HEADING_LABELS = [
  "Хук",
  "Боли",
  "Проблема",
  "CTA",
  "Призыв к действию",
  "Вывод",
  "Кадр",
  "Голос",
  "Текст на экране",
  "Тема",
  "Что публиковать",
  "Тип",
  "Тезис 1",
  "Тезис 2",
  "Тезис 3",
  "Пример",
  "Желания",
  "Возражения",
  "Темы контента",
  "Тон коммуникации",
  "Тон общения",
  "Tone of voice",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const IMPORTANT_HEADING_SOURCE = IMPORTANT_HEADING_LABELS
  .map(escapeRegExp)
  .join("|");
const IMPORTANT_HEADING_ONLY_RE = new RegExp(
  `^(?:[-*•]\\s*)?(?:\\*\\*)?\\s*(${IMPORTANT_HEADING_SOURCE})\\s*:?\\s*(?:\\*\\*)?\\s*$`,
  "iu",
);
const IMPORTANT_HEADING_START_RE = new RegExp(
  `^(?:[-*•]\\s*)?(?:\\*\\*)?\\s*(?:${IMPORTANT_HEADING_SOURCE})\\s*:`,
  "iu",
);

function userProbablyWritesRussian(messages) {
  return messages.some(
    (entry) => entry?.role === "user" && RUSSIAN_TEXT_RE.test(entry.content || ""),
  );
}

function findEmptyImportantHeading(text) {
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(IMPORTANT_HEADING_ONLY_RE);
    if (!match) continue;

    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j += 1;

    if (
      j >= lines.length ||
      /^[-_*—\s]+$/.test(lines[j].trim()) ||
      IMPORTANT_HEADING_START_RE.test(lines[j])
    ) {
      return match[1];
    }
  }

  return "";
}

function hasRepeatedOneNumbering(text) {
  const numbers = text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s{0,3}(\d+)\.\s+\S/))
    .filter(Boolean)
    .map((match) => Number(match[1]));

  if (numbers.length < 4) return false;

  const oneCount = numbers.filter((number) => number === 1).length;
  const isSequential = numbers.every(
    (number, index) => index === 0 || number === numbers[index - 1] + 1,
  );

  return oneCount >= 3 && !isSequential;
}

export function getResponseQualityIssue(text, messages = []) {
  if (!text) return "ответ пустой";

  if (CJK_TEXT_RE.test(text)) {
    return "ответ содержит китайские, японские или корейские символы";
  }

  if (
    userProbablyWritesRussian(messages) &&
    /^\s*(?:[-*•]\s*)?(?:\*\*)?\s*Tone of voice\s*:/imu.test(text)
  ) {
    return "в русском ответе использован английский заголовок Tone of voice";
  }

  if (hasRepeatedOneNumbering(text)) {
    return "несколько нумерованных разделов начинаются с 1 вместо последовательной нумерации";
  }

  const emptyHeading = findEmptyImportantHeading(text);
  if (emptyHeading) return `раздел "${emptyHeading}" оставлен без содержания`;

  return "";
}

function buildQualityRetryMessages(messages, issue) {
  return [
    ...messages,
    {
      role: "user",
      content:
        "Предыдущая попытка ответа была отброшена сервером: " +
        `${issue}. Сгенерируй ответ заново. ` +
        "Ответ должен быть строго на языке пользователя, без китайского текста, " +
        "без случайных английских заголовков и без пустых разделов. " +
        "Все заявленные блоки заполни конкретным содержанием. " +
        "Если есть нумерованные разделы, пронумеруй их последовательно: 1, 2, 3, 4.",
    },
  ];
}

async function requestHfCompletion(payload, token, startedAt, label = "main") {
  const hfRes = await fetch(HF_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(getHfTimeoutMs()),
  });

  const text = await hfRes.text();
  console.log(
    `[hf-chat] ${label} status=${hfRes.status}, ${Date.now() - startedAt}ms, bytes=${text.length}`,
  );

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: "Invalid JSON from Hugging Face router.",
      status: hfRes.status,
      detail: text.slice(0, 500),
    };
  }

  if (!hfRes.ok) {
    return {
      ok: false,
      error: formatHfApiError(data),
      status: hfRes.status,
      detail: data,
    };
  }

  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    return {
      ok: false,
      error: "Unexpected response shape from model.",
      detail: data,
    };
  }

  const truncated = choice?.finish_reason === "length";
  if (truncated) {
    console.warn("[hf-chat] reply truncated by max_tokens (finish_reason=length)");
  }

  return {
    ok: true,
    content,
    model: data.model || payload.model,
    truncated: Boolean(truncated),
  };
}

/**
 * @param {Array<{role: string, content: string}>} messages — must include system as [0] if desired
 */
export async function hfCompleteNonStreaming(messages) {
  const token = getHfToken();
  if (!token) {
    return {
      ok: false,
      error:
        "HF_TOKEN is not set. Add it to tokens_env/tokens.env or codebase/.env.",
    };
  }

  const model = getHfModel();
  const max_tokens = getHfMaxTokens();
  const payload = {
    model,
    messages,
    max_tokens,
    temperature: getHfTemperature(),
  };

  const t0 = Date.now();
  try {
    const firstResult = await requestHfCompletion(payload, token, t0);
    if (!firstResult.ok) return firstResult;

    const qualityIssue = getResponseQualityIssue(firstResult.content, messages);
    if (!qualityIssue || !shouldRetryQuality()) return firstResult;

    console.warn(`[hf-chat] quality retry: ${qualityIssue}`);
    try {
      const retryPayload = {
        ...payload,
        messages: buildQualityRetryMessages(messages, qualityIssue),
        temperature: Math.min(getHfTemperature(), 0.35),
      };
      const retryResult = await requestHfCompletion(
        retryPayload,
        token,
        t0,
        "quality-retry",
      );
      if (retryResult.ok) {
        const retryIssue = getResponseQualityIssue(retryResult.content, messages);
        if (retryIssue) {
          console.warn(`[hf-chat] quality retry still suspicious: ${retryIssue}`);
        }
        return {
          ...retryResult,
          qualityRetried: true,
          ...(retryIssue ? { qualityWarning: retryIssue } : {}),
        };
      }
      console.warn(`[hf-chat] quality retry failed: ${retryResult.error}`);
    } catch (retryErr) {
      console.warn("[hf-chat] quality retry request failed:", retryErr);
    }

    return {
      ...firstResult,
      qualityWarning: qualityIssue,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    if (isAbortOrTimeout(err)) {
      console.error(`[hf-chat] timeout/aborted after ${ms}ms`);
      return {
        ok: false,
        error:
          "Превышено время ожидания ответа Hugging Face. Повторите позже или смените HF_MODEL.",
      };
    }
    console.error(`[hf-chat] error after ${ms}ms:`, err);
    return { ok: false, error: formatUpstreamError(err) };
  }
}
