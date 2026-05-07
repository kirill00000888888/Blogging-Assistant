/**
 * Shared Hugging Face chat-completions (OpenAI-compatible router) — non-streaming.
 * Used by Express /api/chat (JSON mode) and by the Telegram bot.
 */

export const HF_CHAT_URL =
  process.env.HF_CHAT_URL ||
  "https://router.huggingface.co/v1/chat/completions";

export const SYSTEM_PROMPT = `Ты — практичный советник по ведению блогов. Помогаешь с темой, структурой, стилем, контент-планом, частотой публикаций, работой с аудиторией и организацией процесса. Отвечай ясно и по делу; если не хватает деталей — задай 1–2 уточняющих вопроса в конце. Поддерживай русский и английский языки пользователя.`;

export function getHfTimeoutMs() {
  return Number(process.env.HF_TIMEOUT_MS) > 0
    ? Number(process.env.HF_TIMEOUT_MS)
    : 120_000;
}

export function getHfMaxTokens() {
  /** 512 часто обрывает длинные ответы со списками; 1024 — разумный дефолт для бота. */
  return Number(process.env.HF_MAX_TOKENS) > 0
    ? Number(process.env.HF_MAX_TOKENS)
    : 1024;
}

export function getHfModel() {
  return (
    process.env.HF_MODEL || "moonshotai/Kimi-K2-Instruct-0905"
  );
}

export function getHfToken() {
  return process.env.HF_TOKEN || process.env.TOKEN || "";
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
    temperature: 0.6,
  };

  const t0 = Date.now();
  try {
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
      `[hf-chat] status=${hfRes.status}, ${Date.now() - t0}ms, bytes=${text.length}`,
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
        error: data.error?.message || data.message || "Hugging Face API error",
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
      model: data.model || model,
      truncated: Boolean(truncated),
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
