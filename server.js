import dotenv from "dotenv";
import dns from "node:dns";
import express from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
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
/** Streaming is opt-in because some HF providers return incompatible SSE chunks. */
const HF_STREAM =
  process.env.HF_STREAM === "1" ||
  process.env.HF_STREAM === "true" ||
  process.env.HF_STREAM === "on";

const app = express();
const rateBuckets = new Map();

if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

app.use(express.json({ limit: "512kb" }));
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
