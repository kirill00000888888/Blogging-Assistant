import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE = {
  users: {},
  histories: {},
};

function emptyState() {
  return {
    users: {},
    histories: {},
  };
}

export function getStoragePath(baseDir) {
  return process.env.BOT_STORAGE_FILE || path.join(baseDir, "data", "bot-state.json");
}

export async function loadBotState(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users:
        parsed && typeof parsed.users === "object" && parsed.users
          ? parsed.users
          : {},
      histories:
        parsed && typeof parsed.histories === "object" && parsed.histories
          ? parsed.histories
          : {},
    };
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn("[storage] failed to read state, using empty state:", err);
    }
    return emptyState();
  }
}

export async function saveBotState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state || DEFAULT_STATE, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

export function createBotStorage(filePath, options = {}) {
  const maxDialogMessages = Number(options.maxDialogMessages) || 24;
  let state = emptyState();
  let writeChain = Promise.resolve();

  async function init() {
    state = await loadBotState(filePath);
    trimAllHistories();
    await persist();
  }

  function persist() {
    writeChain = writeChain
      .then(() => saveBotState(filePath, state))
      .catch((err) => {
        console.error("[storage] failed to save state:", err);
      });
    return writeChain;
  }

  function trimHistory(chatId) {
    const key = String(chatId);
    const history = state.histories[key] || [];
    state.histories[key] = history.slice(-maxDialogMessages);
    return state.histories[key];
  }

  function trimAllHistories() {
    for (const chatId of Object.keys(state.histories)) {
      trimHistory(chatId);
    }
  }

  async function upsertUser(ctx) {
    const chatId = String(ctx.chat?.id || ctx.from?.id || "");
    if (!chatId) return null;

    const now = new Date().toISOString();
    const previous = state.users[chatId] || {};
    const user = {
      chatId,
      telegramId: String(ctx.from?.id || chatId),
      username: ctx.from?.username || previous.username || "",
      firstName: ctx.from?.first_name || previous.firstName || "",
      lastName: ctx.from?.last_name || previous.lastName || "",
      languageCode: ctx.from?.language_code || previous.languageCode || "",
      createdAt: previous.createdAt || now,
      lastSeenAt: now,
      messageCount: Number(previous.messageCount || 0) + 1,
    };

    state.users[chatId] = user;
    if (!state.histories[chatId]) state.histories[chatId] = [];
    await persist();
    return user;
  }

  async function clearHistory(chatId) {
    state.histories[String(chatId)] = [];
    await persist();
  }

  function getHistory(chatId) {
    return [...(state.histories[String(chatId)] || [])];
  }

  async function setHistory(chatId, history) {
    state.histories[String(chatId)] = Array.isArray(history) ? history : [];
    trimHistory(chatId);
    await persist();
  }

  async function appendMessage(chatId, message) {
    const key = String(chatId);
    if (!state.histories[key]) state.histories[key] = [];
    state.histories[key].push(message);
    trimHistory(key);
    await persist();
    return getHistory(key);
  }

  function getStats() {
    const users = Object.values(state.users);
    const histories = Object.values(state.histories);
    const totalMessages = histories.reduce((sum, history) => sum + history.length, 0);
    const lastSeenAt = users
      .map((user) => user.lastSeenAt)
      .filter(Boolean)
      .sort()
      .at(-1);

    return {
      userCount: users.length,
      activeDialogCount: histories.filter((history) => history.length > 0).length,
      storedMessageCount: totalMessages,
      lastSeenAt: lastSeenAt || "",
      storageFile: filePath,
    };
  }

  return {
    init,
    upsertUser,
    clearHistory,
    getHistory,
    setHistory,
    appendMessage,
    getStats,
  };
}
