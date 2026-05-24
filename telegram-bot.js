import dotenv from "dotenv";
import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { createBotStorage, getStoragePath } from "./bot-storage.js";
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
const ALLOWED_TELEGRAM_IDS = new Set(
  String(process.env.ALLOWED_TELEGRAM_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

/** HF can take up to HF_TIMEOUT_MS; Telegraf defaults to 90s and kills the handler sooner. */
function telegrafHandlerTimeoutMs() {
  const hfMs = telegramHfTimeoutMs();
  const extra =
    Number(process.env.TG_HANDLER_EXTRA_MS) > 0
      ? Number(process.env.TG_HANDLER_EXTRA_MS)
      : 120_000;
  return hfMs + extra;
}

function telegramHfTimeoutMs() {
  if (Number(process.env.TG_HF_TIMEOUT_MS) > 0) {
    return Number(process.env.TG_HF_TIMEOUT_MS);
  }

  const globalTimeout =
    Number(process.env.HF_TIMEOUT_MS) > 0
      ? Number(process.env.HF_TIMEOUT_MS)
      : 120_000;
  return Math.max(globalTimeout, 180_000);
}

function telegramHfMaxTokens() {
  if (Number(process.env.TG_HF_MAX_TOKENS) > 0) {
    return Number(process.env.TG_HF_MAX_TOKENS);
  }

  const globalMax =
    Number(process.env.HF_MAX_TOKENS) > 0
      ? Number(process.env.HF_MAX_TOKENS)
      : 3072;
  return Math.min(globalMax, 2048);
}

/** Команды в меню над полем ввода (⋮ или кнопка «Menu» в клиенте Telegram). */
async function registerBotMenuCommands(bot) {
  const commandList = [
    {
      command: "start",
      description: "Старт и описание возможностей",
    },
    {
      command: "help",
      description: "Список команд чат-бота",
    },
    {
      command: "plan",
      description: "Контент-план для блога",
    },
    {
      command: "ideas",
      description: "Идеи публикаций",
    },
    {
      command: "post",
      description: "Структура поста",
    },
    {
      command: "video",
      description: "Сценарий короткого видео",
    },
    {
      command: "audience",
      description: "Анализ аудитории блога",
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
const KB_PLAN = "📅 План";
const KB_IDEAS = "💡 Идеи";
const KB_POST = "✍️ Пост";
const KB_VIDEO = "🎬 Видео";
const KB_AUDIENCE = "👥 Аудитория";

const MAX_DIALOG_MESSAGES = Number(process.env.TG_MAX_DIALOG_MESSAGES) || 24;
const TELEGRAM_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Форматируй ответы для Telegram: не используй Markdown-таблицы, HTML, звездочки для жирного текста и сложную разметку. Контент-планы пиши обычными списками: "День 1", затем пункты "Тип", "Тема", "Что публиковать", "CTA". Если пользователь просит подробный план, дай развернутый ответ, а не 2-3 строки.

Для русских запросов используй только русские заголовки: "тон коммуникации" вместо "Tone of voice", "призыв к действию" или "CTA" вместо случайных английских формулировок. Не оставляй строку "Хук:" или "Боли:" пустой перед следующим разделом. Если делаешь нумерованные разделы, пиши 1, 2, 3, 4, а не каждый раз 1.

Для Telegram отвечай компактно: если пользователь не просит "подробно", уложись примерно в 1200-2500 знаков, дай самое полезное и в конце предложи написать "продолжи" для расширения.`;

const storage = createBotStorage(getStoragePath(__dirname), {
  maxDialogMessages: MAX_DIALOG_MESSAGES,
});

function isAllowedTelegramUser(ctx) {
  if (ALLOWED_TELEGRAM_IDS.size === 0) return true;
  const ids = [ctx.from?.id, ctx.chat?.id].map((id) => String(id || ""));
  return ids.some((id) => ALLOWED_TELEGRAM_IDS.has(id));
}

async function ensureAccess(ctx) {
  if (isAllowedTelegramUser(ctx)) {
    await storage.upsertUser(ctx);
    return true;
  }

  await ctx.reply(
    "Доступ к боту ограничен. Передайте администратору ваш Telegram ID: " +
      `${ctx.from?.id || ctx.chat?.id || "не удалось определить"}.`,
  );
  return false;
}

function mainReplyKeyboard() {
  return Markup.keyboard([
    [KB_PLAN, KB_IDEAS],
    [KB_POST, KB_VIDEO],
    [KB_AUDIENCE],
    [KB_START, KB_CLEAR],
  ])
    .resize()
    .persistent();
}

async function replyWelcome(ctx) {
  await storage.clearHistory(ctx.chat.id);
  await ctx.reply(
    "Привет! Я чат-бот для создания и ведения блогов.\n\n" +
      "Я помогаю составлять контент-планы, искать темы, готовить структуру постов, сценарии коротких видео и разбирать аудиторию.\n\n" +
      "Команды:\n" +
      "/plan тема — контент-план\n" +
      "/ideas тема — идеи публикаций\n" +
      "/post тема — структура поста\n" +
      "/video идея — сценарий видео\n" +
      "/audience ниша — аудитория блога\n" +
      "/clear — очистить историю\n\n" +
      "Можно просто написать тему блога обычным сообщением.",
    mainReplyKeyboard(),
  );
}

async function replyHelp(ctx) {
  await ctx.reply(
    "Возможности чат-бота:\n\n" +
      "/plan тема — составить план публикаций на 7 дней\n" +
      "/ideas тема — придумать 20 идей и рубрик\n" +
      "/post тема — собрать структуру поста\n" +
      "/video идея — подготовить сценарий Reels/TikTok/Shorts\n" +
      "/audience ниша — описать боли, желания и возражения аудитории\n" +
      "/clear — начать новый диалог\n\n" +
      "Пример: /plan блог фитнес-тренера для женщин 25-40",
    mainReplyKeyboard(),
  );
}

async function replyCleared(ctx) {
  await storage.clearHistory(ctx.chat.id);
  await ctx.reply("Контекст диалога очищен.", mainReplyKeyboard());
}


function trimSession(entries) {
  while (entries.length > MAX_DIALOG_MESSAGES) entries.shift();
}

function buildMessages(history) {
  return [{ role: "system", content: TELEGRAM_SYSTEM_PROMPT }, ...history];
}

function commandTemplate(command, value) {
  const subject = value || "[укажите тему]";
  const templates = {
    plan:
      `Составь контент-план на 7 дней для блога на тему: ${subject}. ` +
      "Для каждого дня дай: тип контента, тему, хук, что публиковать и CTA.",
    ideas:
      `Придумай 20 тем для блога на тему: ${subject}. ` +
      "Раздели идеи на рубрики: экспертное, личное, продающее и вовлекающее.",
    post:
      `Напиши структуру поста на тему: ${subject}. ` +
      "Дай хук, проблему, 3 тезиса, пример, вывод и CTA.",
    video:
      `Сделай сценарий короткого видео по идее: ${subject}. ` +
      "Дай хук, кадры, текст на экране, голос и CTA.",
    audience:
      `Разбери аудиторию блога в нише: ${subject}. ` +
      "Опиши боли, желания, возражения, подходящие темы контента и тон коммуникации.",
  };
  return templates[command] || value;
}

function parseScenarioText(text) {
  const normalized = text.trim();
  const commandMatch = normalized.match(/^\/(plan|ideas|post|video|audience)(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (commandMatch) {
    return commandTemplate(commandMatch[1].toLowerCase(), (commandMatch[2] || "").trim());
  }

  const buttonMap = new Map([
    [KB_PLAN, "plan"],
    [KB_IDEAS, "ideas"],
    [KB_POST, "post"],
    [KB_VIDEO, "video"],
    [KB_AUDIENCE, "audience"],
  ]);
  const buttonCommand = buttonMap.get(normalized);
  if (buttonCommand) return commandTemplate(buttonCommand, "");

  return normalized;
}

function stripInlineMarkdown(text) {
  return text
    .replace(/^#{1,6}\s*/gm, "")
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

async function withTyping(ctx, run) {
  await ctx.sendChatAction("typing");
  const interval = setInterval(() => {
    void ctx.sendChatAction("typing").catch(() => {});
  }, 4500);

  try {
    return await run();
  } finally {
    clearInterval(interval);
  }
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

  await storage.init();

  bot.start(async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    await replyWelcome(ctx);
  });

  bot.command("clear", async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    await replyCleared(ctx);
  });

  bot.command("help", async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    await replyHelp(ctx);
  });

  bot.on(message("text"), async (ctx) => {
    const chatId = ctx.chat.id;
    const text = (ctx.message.text || "").trim();
    if (!text) return;
    if (!(await ensureAccess(ctx))) return;

    if (text === KB_START || text === "/start") {
      await replyWelcome(ctx);
      return;
    }
    if (text === KB_CLEAR || text === "/clear") {
      await replyCleared(ctx);
      return;
    }
    if (text === "/help") {
      await replyHelp(ctx);
      return;
    }

    let history = storage.getHistory(chatId);
    const outgoingText = parseScenarioText(text);
    history = await storage.appendMessage(chatId, {
      role: "user",
      content: outgoingText,
    });

    const result = await withTyping(ctx, () =>
      hfCompleteNonStreaming(buildMessages(history), {
        maxTokens: telegramHfMaxTokens(),
        timeoutMs: telegramHfTimeoutMs(),
      }),
    );

    if (!result.ok) {
      await ctx.reply(`Ошибка: ${result.error}`, mainReplyKeyboard());
      history.pop();
      await storage.setHistory(chatId, history);
      return;
    }

    history = await storage.appendMessage(chatId, {
      role: "assistant",
      content: result.content,
    });

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
