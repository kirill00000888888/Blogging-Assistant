import dotenv from "dotenv";
import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import {
  SYSTEM_PROMPT,
  hfCompleteNonStreaming,
} from "./hf-chat.js";

dns.setDefaultResultOrder("ipv4first");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, "..", "tokens_env", "tokens.env") });
dotenv.config({ path: path.join(__dirname, "..", "huggingface_token", "huggingface_token.env") });
dotenv.config({ path: path.join(__dirname, ".env") });

const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || "";

/** HF can take up to HF_TIMEOUT_MS; Telegraf defaults to 90s and kills the handler sooner. */
function telegrafHandlerTimeoutMs() {
  const hfMs =
    Number(process.env.HF_TIMEOUT_MS) > 0
      ? Number(process.env.HF_TIMEOUT_MS)
      : 120_000;
  const extra =
    Number(process.env.TG_HANDLER_EXTRA_MS) > 0
      ? Number(process.env.TG_HANDLER_EXTRA_MS)
      : 120_000;
  return hfMs + extra;
}

/** Команды в меню над полем ввода (⋮ или кнопка «Menu» в клиенте Telegram). */
async function registerBotMenuCommands(bot) {
  const commandList = [
    {
      command: "start",
      description: "Старт — приветствие и новый диалог",
    },
    {
      command: "clear",
      description: "Очистить контекст беседы",
    },
  ];
  try {
    await bot.telegram.setMyCommands(commandList, { language_code: "ru" });
    console.log("[tg] setMyCommands (language_code=ru) OK");
  } catch (e) {
    console.warn("[tg] setMyCommands with ru failed, retry default scope:", e);
    await bot.telegram.setMyCommands(commandList);
    console.log("[tg] setMyCommands (default) OK");
  }
  try {
    await bot.telegram.setChatMenuButton({
      menuButton: { type: "commands" },
    });
  } catch (e) {
    console.warn("[tg] setChatMenuButton:", e);
  }
}

/** Кнопки над полем ввода (ReplyKeyboard). Текст должен совпадать с проверкой ниже. */
const KB_START = "🔄 Старт";
const KB_CLEAR = "🗑 Очистить";

const MAX_DIALOG_MESSAGES = Number(process.env.TG_MAX_DIALOG_MESSAGES) || 24;
const TELEGRAM_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Форматируй ответы для Telegram: не используй Markdown-таблицы, HTML, звездочки для жирного текста и сложную разметку. Контент-планы пиши обычными списками: "День 1", затем пункты "Тип", "Тема", "Что публиковать", "CTA". Если пользователь просит подробный план, дай развернутый ответ, а не 2-3 строки.`;

const sessions = new Map();

function mainReplyKeyboard() {
  return Markup.keyboard([[KB_START, KB_CLEAR]])
    .resize()
    .persistent();
}

async function replyWelcome(ctx) {
  sessions.delete(ctx.chat.id);
  await ctx.reply(
    "Привет! Я советник по ведению блогов (@bloggingassistant_bot). " +
      "Напишите вопрос или тему поста — отвечу кратко и по делу. " +
      "Кнопки внизу — тот же смысл, что и команды /start и /clear.",
    mainReplyKeyboard(),
  );
}

async function replyCleared(ctx) {
  sessions.delete(ctx.chat.id);
  await ctx.reply("Контекст диалога очищен.", mainReplyKeyboard());
}


function trimSession(entries) {
  while (entries.length > MAX_DIALOG_MESSAGES) entries.shift();
}

function buildMessages(history) {
  return [{ role: "system", content: TELEGRAM_SYSTEM_PROMPT }, ...history];
}

function stripInlineMarkdown(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|[\s([{])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[\s([{])_([^_\n]+)_/g, "$1$2")
    .replace(/[ \t]+\n/g, "\n");
}

function parseTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const normalized = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = normalized.split("|").map((cell) => stripInlineMarkdown(cell.trim()));
  return cells.some(Boolean) ? cells : null;
}

function isTableSeparator(line) {
  const cells = parseTableRow(line);
  return Boolean(cells?.length) && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableToList(rows) {
  if (rows.length < 2 || !isTableSeparator(rows[1])) return null;

  const headers = parseTableRow(rows[0]);
  if (!headers?.length) return null;

  const out = [];
  const dataRows = rows.slice(2).map(parseTableRow).filter(Boolean);
  for (const [index, cells] of dataRows.entries()) {
    const title = cells[0] || `${index + 1}`;
    out.push(`${headers[0]} ${title}`);
    for (let i = 1; i < Math.min(headers.length, cells.length); i++) {
      if (cells[i]) out.push(`- ${headers[i]}: ${cells[i]}`);
    }
    out.push("");
  }

  return out.join("\n").trim();
}

function normalizeTelegramReply(text) {
  const lines = text.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const row = parseTableRow(lines[i]);
    const nextIsSeparator = i + 1 < lines.length && isTableSeparator(lines[i + 1]);

    if (row && nextIsSeparator) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && parseTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;

      const converted = tableToList(tableLines);
      if (converted) {
        out.push(converted);
        continue;
      }
      out.push(...tableLines);
      continue;
    }

    out.push(lines[i]);
  }

  return stripInlineMarkdown(out.join("\n"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Telegram message limit — split long replies */
function splitTelegramChunks(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    if (end < text.length) {
      const breakAt = text.lastIndexOf("\n\n", end);
      if (breakAt > i + 500) end = breakAt;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

async function main() {
  if (!BOT_TOKEN) {
    console.error(
      "TELEGRAM_BOT_TOKEN (or BOT_TOKEN) is not set. Use tokens_env/tokens.env.",
    );
    process.exit(1);
  }

  const bot = new Telegraf(BOT_TOKEN, {
    handlerTimeout: telegrafHandlerTimeoutMs(),
  });

  bot.start(async (ctx) => {
    await replyWelcome(ctx);
  });

  bot.command("clear", async (ctx) => {
    await replyCleared(ctx);
  });

  bot.on(message("text"), async (ctx) => {
    const chatId = ctx.chat.id;
    const text = (ctx.message.text || "").trim();
    if (!text) return;

    if (text === KB_START || text === "/start") {
      await replyWelcome(ctx);
      return;
    }
    if (text === KB_CLEAR || text === "/clear") {
      await replyCleared(ctx);
      return;
    }

    let history = sessions.get(chatId);
    if (!history) {
      history = [];
      sessions.set(chatId, history);
    }

    history.push({ role: "user", content: text });
    trimSession(history);

    await ctx.sendChatAction("typing");

    const result = await hfCompleteNonStreaming(buildMessages(history));

    if (!result.ok) {
      await ctx.reply(`Ошибка: ${result.error}`, mainReplyKeyboard());
      history.pop();
      return;
    }

    history.push({ role: "assistant", content: result.content });
    trimSession(history);

    let replyText = normalizeTelegramReply(result.content);
    if (result.truncated) {
      replyText +=
        "\n\n---\nСообщение могло оборваться из-за лимита длины ответа. " +
        "Напишите «продолжи» или увеличьте HF_MAX_TOKENS в настройках бота.";
    }

    const parts = splitTelegramChunks(replyText);
    for (let p = 0; p < parts.length; p++) {
      const last = p === parts.length - 1;
      await ctx.reply(parts[p], last ? mainReplyKeyboard() : undefined);
    }
  });

  bot.catch((err, ctx) => {
    const msg =
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : String(err);
    console.error("[tg] bot error:", msg, err);
    void ctx?.reply(
      "Внутренняя ошибка бота. Попробуйте кнопку «Очистить» или /clear.\n" +
        (process.env.NODE_ENV !== "production"
          ? `\n(debug) ${msg.slice(0, 500)}`
          : ""),
      mainReplyKeyboard(),
    );
  });

  console.log("Telegram blog advisor bot starting (long polling)…");
  await registerBotMenuCommands(bot);
  await bot.launch(() => {
    console.log(
      "Bot is running (@bloggingassistant_bot). Model:",
      process.env.HF_MODEL || "moonshotai/Kimi-K2-Instruct-0905",
    );
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
