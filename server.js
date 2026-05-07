import dotenv from "dotenv";
import dns from "node:dns";
import express from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  SYSTEM_PROMPT,
  formatUpstreamError,
  getHfMaxTokens,
  getHfModel,
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
/** Set to 0/false to force non-streaming (more compatible if proxies/Brave break SSE). */
const HF_STREAM =
  process.env.HF_STREAM !== "0" &&
  process.env.HF_STREAM !== "false" &&
  process.env.HF_STREAM !== "off";

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/chat", async (req, res) => {
  if (!getHfToken()) {
    res.status(500).json({
      error:
        "HF_TOKEN is not set. Add it to tokens_env/tokens.env or codebase/.env.",
    });
    return;
  }

  const { messages: incoming, stream: clientWantsStream } = req.body || {};
  if (!Array.isArray(incoming) || incoming.length === 0) {
    res.status(400).json({ error: "Expected non-empty messages array." });
    return;
  }

  const wantStream = Boolean(clientWantsStream) && HF_STREAM;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...incoming.map((m) => ({
      role: m.role,
      content: String(m.content ?? ""),
    })),
  ];

  const payload = {
    model: HF_MODEL,
    messages,
    max_tokens: HF_MAX_TOKENS,
    temperature: 0.6,
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
          error:
            data.error?.message || data.message || "Hugging Face API error",
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
