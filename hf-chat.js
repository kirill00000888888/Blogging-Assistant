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

export function shouldUseLocalFallback() {
  const value = String(process.env.LOCAL_FALLBACK ?? "1").toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

function isCreditLimitError(message) {
  return /depleted your monthly included credits|purchase pre-paid credits|subscribe to pro/i.test(
    message || "",
  );
}

function extractLastUserText(messages) {
  const lastUser = [...messages].reverse().find((entry) => entry?.role === "user");
  return String(lastUser?.content || "")
    .replace(/^Тон ответа:[^\n]+\n\n/i, "")
    .replace(/^Глубина:[^\n]+\n/i, "")
    .replace(/^Формат:[^\n]+\n/i, "")
    .replace(/^Не используй Markdown-таблицы[^\n]+\n/i, "")
    .trim();
}

function cleanTopic(text) {
  return text
    .replace(/^Составь контент-план на 7 дней для блога(?: на тему)?:/i, "")
    .replace(/^Придумай 20 тем для блога(?: на тему)?:/i, "")
    .replace(/^Напиши структуру поста(?: на тему)?:/i, "")
    .replace(/^Сделай сценарий короткого видео по идее:/i, "")
    .replace(/^Разбери аудиторию блога в нише:/i, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

function detectLocalScenario(text) {
  if (/контент-план|план на 7 дней|\/plan/i.test(text)) return "plan";
  if (/20 тем|идеи|рубрики|\/ideas/i.test(text)) return "ideas";
  if (/структур[ау] поста|хук, проблему|\/post/i.test(text)) return "post";
  if (/сценарий короткого видео|reels|tiktok|shorts|\/video/i.test(text)) return "video";
  if (/аудитори[яю]|боли|желания|возражения|\/audience/i.test(text)) return "audience";
  return "general";
}

export function buildLocalFallbackReply(messages, reason = "") {
  const userText = extractLastUserText(messages);
  const topic = cleanTopic(userText) || "выбранная тема блога";
  const scenario = detectLocalScenario(userText);
  const note =
    "Демонстрационный режим: внешний AI-сервис временно недоступен" +
    (reason ? ` (${reason})` : "") +
    ". Ниже резервный шаблон ответа для проверки работы чат-бота.\n\n";

  if (scenario === "plan") {
    return `${note}Контент-план на 7 дней: ${topic}

День 1
- Тип: экспертный пост
- Тема: главная проблема аудитории в теме "${topic}"
- Хук: "Почему у большинства не получается решить эту задачу с первого раза"
- Что публиковать: короткое объяснение проблемы и 3 практических совета
- CTA: написать в комментариях свой главный вопрос

День 2
- Тип: личный пост
- Тема: ваш опыт или путь в этой нише
- Хук: "Что я понял после первых ошибок"
- Что публиковать: история, выводы, полезный урок
- CTA: подписаться, чтобы следить за продолжением

День 3
- Тип: вовлекающий контент
- Тема: частые мифы и заблуждения
- Хук: "3 мифа, которые мешают двигаться быстрее"
- Что публиковать: список мифов и короткие опровержения
- CTA: выбрать миф, который встречается чаще всего

День 4
- Тип: обучающий пост
- Тема: пошаговая инструкция для новичка
- Хук: "С чего начать, если вы пока ничего не понимаете"
- Что публиковать: 5 простых шагов
- CTA: сохранить пост

День 5
- Тип: продающий пост
- Тема: как ваша помощь решает задачу аудитории
- Хук: "Когда стоит обратиться за помощью"
- Что публиковать: проблема, решение, результат
- CTA: написать в личные сообщения

День 6
- Тип: короткое видео
- Тема: быстрый совет по теме "${topic}"
- Хук: "Попробуйте это сегодня"
- Что публиковать: один прием, пример, итог
- CTA: отправить видео другу

День 7
- Тип: итоговый пост
- Тема: подборка лучших мыслей недели
- Хук: "Что важно запомнить"
- Что публиковать: 5 выводов и следующий шаг
- CTA: выбрать тему для следующей недели`;
  }

  if (scenario === "ideas") {
    return `${note}Идеи публикаций для темы: ${topic}

Экспертное:
1. Главные ошибки новичков
2. Пошаговый старт за 7 дней
3. Разбор частого вопроса аудитории
4. Чек-лист перед началом
5. Мифы и реальность

Личное:
6. Почему вы выбрали эту тему
7. История первой ошибки
8. Что изменилось в вашем подходе
9. День из вашей работы
10. Ваши принципы

Продающее:
11. Кому полезна ваша услуга или продукт
12. Как проходит работа с вами
13. До и после
14. Частые возражения
15. Что входит в результат

Вовлекающее:
16. Опрос по главной проблеме
17. "Выберите вариант"
18. Разбор ситуации подписчика
19. Мини-тест
20. Вопрос недели`;
  }

  if (scenario === "post") {
    return `${note}Структура поста: ${topic}

Хук:
"Большинство ошибок в этой теме появляются не из-за лени, а из-за неправильного первого шага."

Проблема:
Аудитория хочет результата, но не понимает, с чего начать и как не потратить время впустую.

Тезис 1:
Сначала нужно определить конкретную цель, а не пытаться сделать все сразу.

Тезис 2:
Лучше двигаться маленькими действиями и регулярно проверять результат.

Тезис 3:
Контент должен отвечать на реальные вопросы аудитории, а не просто заполнять ленту.

Пример:
Если блог посвящен теме "${topic}", первый пост может объяснить одну частую ошибку и дать простой способ ее исправить.

Вывод:
Хороший пост не обязан быть длинным. Он должен решать одну понятную задачу.

CTA:
"Сохраните пост и напишите, какую тему разобрать следующей."`;
  }

  if (scenario === "video") {
    return `${note}Сценарий короткого видео: ${topic}

Хук:
"Не начинайте с этого, если хотите нормальный результат."

Кадр 1:
Вы в кадре, коротко называете ошибку.
Текст на экране: "Ошибка новичков"
Голос: "Чаще всего люди начинают не с анализа аудитории, а с хаотичных публикаций."

Кадр 2:
Покажите список или экран с планом.
Текст на экране: "Сначала: цель, аудитория, рубрики"
Голос: "Сначала определите, кому вы пишете и какой результат хотите получить."

Кадр 3:
Покажите пример темы.
Текст на экране: "1 пост = 1 задача"
Голос: "Каждый пост должен отвечать на один конкретный вопрос."

CTA:
"Сохраните видео и напишите тему, для которой нужен контент-план."`;
  }

  if (scenario === "audience") {
    return `${note}Анализ аудитории для ниши: ${topic}

Боли:
- нет понятного плана действий;
- страшно ошибиться и потерять время;
- сложно выбрать между разными советами;
- не хватает примеров и простого объяснения.

Желания:
- получить быстрый и понятный старт;
- видеть реальные примеры;
- понимать, что делать дальше;
- получить поддержку и уверенность.

Возражения:
- "У меня не получится";
- "Это слишком сложно";
- "У меня нет времени";
- "Я уже пробовал, не помогло".

Темы контента:
- ошибки новичков;
- пошаговые инструкции;
- разборы ситуаций;
- личный опыт;
- ответы на частые вопросы.

Тон коммуникации:
спокойный, понятный, уверенный, без давления и сложных терминов.`;
  }

  return `${note}Краткая рекомендация по теме: ${topic}

1. Определите цель публикации: привлечь внимание, объяснить, вовлечь или продать.
2. Сформулируйте главный вопрос аудитории.
3. Сделайте один сильный хук в начале.
4. Дайте 3-5 полезных тезисов.
5. Завершите конкретным призывом к действию.

Для более точного результата используйте команды: /plan, /ideas, /post, /video или /audience.`;
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

  if (isCreditLimitError(message)) {
    return (
      "У аккаунта Hugging Face закончились бесплатные кредиты Inference Providers. " +
      "Пополните кредиты, смените токен или включите локальный демонстрационный режим LOCAL_FALLBACK=1."
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

async function requestHfCompletion(
  payload,
  token,
  startedAt,
  label = "main",
  timeoutMs = getHfTimeoutMs(),
) {
  const hfRes = await fetch(HF_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
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
    const error = formatHfApiError(data);
    return {
      ok: false,
      error,
      status: hfRes.status,
      detail: data,
      creditLimit: isCreditLimitError(
        typeof data?.error === "string" ? data.error : data?.error?.message || data?.message || error,
      ),
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
export async function hfCompleteNonStreaming(messages, options = {}) {
  const token = getHfToken();
  if (!token) {
    return {
      ok: false,
      error:
        "HF_TOKEN is not set. Add it to tokens_env/tokens.env or codebase/.env.",
    };
  }

  const model = getHfModel();
  const max_tokens =
    Number(options.maxTokens) > 0 ? Number(options.maxTokens) : getHfMaxTokens();
  const timeoutMs =
    Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : getHfTimeoutMs();
  const payload = {
    model,
    messages,
    max_tokens,
    temperature: getHfTemperature(),
  };

  const t0 = Date.now();
  try {
    const firstResult = await requestHfCompletion(
      payload,
      token,
      t0,
      "main",
      timeoutMs,
    );
    if (!firstResult.ok) {
      if (firstResult.creditLimit && shouldUseLocalFallback()) {
        return {
          ok: true,
          content: buildLocalFallbackReply(messages, "закончились кредиты Hugging Face"),
          model: "local-fallback",
          fallback: true,
        };
      }
      return firstResult;
    }

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
        timeoutMs,
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
          `Hugging Face не успел ответить за ${Math.round(timeoutMs / 1000)} сек. ` +
          "Это обычно очередь, перегруженная модель или слишком длинный ответ. " +
          "Повторите позже, попросите короче или смените HF_MODEL.",
      };
    }
    console.error(`[hf-chat] error after ${ms}ms:`, err);
    return { ok: false, error: formatUpstreamError(err) };
  }
}
