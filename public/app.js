const LEGACY_MESSAGES_KEY = "blog-workshop.messages";
const CONVERSATIONS_KEY = "blog-workshop.conversations.v2";
const ACTIVE_CONVERSATION_KEY = "blog-workshop.activeConversation.v2";
const SAVED_KEY = "blog-workshop.saved.v1";
const SETTINGS_KEY = "blog-workshop.settings.v1";

let maxInputChars = 4000;

const logEl = document.getElementById("log");
const emptyStateEl = document.getElementById("emptyState");
const formEl = document.getElementById("form");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const clearBtn = document.getElementById("clear");
const continueBtn = document.getElementById("continue");
const exportBtn = document.getElementById("exportChat");
const newChatBtn = document.getElementById("newChat");
const statusEl = document.getElementById("status");
const counterEl = document.getElementById("counter");
const contextBadgeEl = document.getElementById("contextBadge");
const messageCountEl = document.getElementById("messageCount");
const modelStatusEl = document.getElementById("modelStatus");
const savedCountEl = document.getElementById("savedCount");
const historyCountEl = document.getElementById("historyCount");
const activeTitleEl = document.getElementById("activeTitle");
const savedStatEl = document.getElementById("savedStat");
const savedListEl = document.getElementById("savedList");
const historyListEl = document.getElementById("historyList");
const savedSearchEl = document.getElementById("savedSearch");
const historySearchEl = document.getElementById("historySearch");
const formatSelectEl = document.getElementById("formatSelect");
const promptButtons = document.querySelectorAll("[data-prompt]");
const toneButtons = document.querySelectorAll("[data-tone]");
const depthButtons = document.querySelectorAll("[data-depth]");
const viewTabs = document.querySelectorAll("[data-view]");
const viewPanes = document.querySelectorAll(".view-pane");

const settings = loadSettings();
let conversations = loadConversations();
let savedItems = loadSavedItems();
let activeConversationId =
  localStorage.getItem(ACTIVE_CONVERSATION_KEY) || conversations[0]?.id;

if (!getConversation(activeConversationId)) {
  activeConversationId = conversations[0]?.id || createConversation().id;
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      tone: parsed.tone || "практичный",
      depth: parsed.depth || "нормально",
      format: parsed.format || "обычным структурированным списком",
    };
  } catch {
    return {
      tone: "практичный",
      depth: "нормально",
      format: "обычным структурированным списком",
    };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadConversations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONVERSATIONS_KEY) || "[]");
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .filter((item) => item?.id && Array.isArray(item.messages))
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    }
  } catch {
    /* fall through to legacy import */
  }

  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_MESSAGES_KEY) || "[]");
    if (Array.isArray(legacy) && legacy.length > 0) {
      const now = Date.now();
      return [
        {
          id: uid("chat"),
          title: getTitleFromMessages(legacy) || "Первый диалог",
          messages: legacy.slice(-30),
          createdAt: now,
          updatedAt: now,
        },
      ];
    }
  } catch {
    /* ignore invalid legacy state */
  }

  const now = Date.now();
  return [
    {
      id: uid("chat"),
      title: "Новый диалог",
      messages: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function loadSavedItems() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item?.id && typeof item.content === "string")
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  } catch {
    return [];
  }
}

function persist() {
  conversations.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations.slice(0, 60)));
  localStorage.setItem(ACTIVE_CONVERSATION_KEY, activeConversationId);
  localStorage.setItem(SAVED_KEY, JSON.stringify(savedItems.slice(0, 200)));
}

function getConversation(id) {
  return conversations.find((item) => item.id === id);
}

function activeConversation() {
  let conversation = getConversation(activeConversationId);
  if (!conversation) {
    conversation = createConversation();
    activeConversationId = conversation.id;
  }
  return conversation;
}

function createConversation(title = "Новый диалог") {
  const now = Date.now();
  const conversation = {
    id: uid("chat"),
    title,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  conversations.unshift(conversation);
  activeConversationId = conversation.id;
  persist();
  return conversation;
}

function getTitleFromMessages(messages) {
  const firstUser = messages.find((message) => message.role === "user");
  const source = firstUser?.content || "";
  const clean = source
    .replace(/^Тон ответа:[^\n]+\n\n/i, "")
    .replace(/^Глубина:[^\n]+\n/i, "")
    .replace(/^Формат:[^\n]+\n/i, "")
    .trim();
  if (!clean) return "";
  return clean.length > 54 ? `${clean.slice(0, 54)}...` : clean;
}

function touchConversation(conversation) {
  conversation.updatedAt = Date.now();
  if (!conversation.title || conversation.title === "Новый диалог") {
    conversation.title = getTitleFromMessages(conversation.messages) || "Новый диалог";
  }
  conversation.messages = conversation.messages.slice(-30);
}

function formatDate(ts) {
  if (!ts) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

function appendInline(parent, text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      parent.appendChild(strong);
      continue;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.appendChild(code);
      continue;
    }
    parent.appendChild(document.createTextNode(part));
  }
}

function renderMarkdown(container, text) {
  container.textContent = "";

  const lines = text.split(/\r?\n/);
  let listEl = null;
  let codeEl = null;

  function closeList() {
    listEl = null;
  }

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      closeList();
      if (codeEl) {
        codeEl = null;
      } else {
        const pre = document.createElement("pre");
        codeEl = document.createElement("code");
        pre.appendChild(codeEl);
        container.appendChild(pre);
      }
      continue;
    }

    if (codeEl) {
      codeEl.textContent += `${line}\n`;
      continue;
    }

    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading) {
      closeList();
      const h = document.createElement("h3");
      appendInline(h, heading[1]);
      container.appendChild(h);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) {
      if (!listEl || listEl.tagName !== "UL") {
        listEl = document.createElement("ul");
        container.appendChild(listEl);
      }
      const li = document.createElement("li");
      appendInline(li, bullet[1]);
      listEl.appendChild(li);
      continue;
    }

    const numbered = line.match(/^\s*\d+\.\s+(.+)/);
    if (numbered) {
      if (!listEl || listEl.tagName !== "OL") {
        listEl = document.createElement("ol");
        container.appendChild(listEl);
      }
      const li = document.createElement("li");
      appendInline(li, numbered[1]);
      listEl.appendChild(li);
      continue;
    }

    closeList();
    if (!line.trim()) {
      const spacer = document.createElement("div");
      spacer.className = "line-spacer";
      container.appendChild(spacer);
      continue;
    }

    const p = document.createElement("p");
    appendInline(p, line);
    container.appendChild(p);
  }
}

async function copyText(text, button) {
  await navigator.clipboard.writeText(text);
  if (!button) return;
  const label = button.textContent;
  button.textContent = "скопировано";
  window.setTimeout(() => {
    button.textContent = label;
  }, 1300);
}

function isSaved(content) {
  return savedItems.some((item) => item.content === content);
}

function saveAnswer(content) {
  if (isSaved(content)) return;
  const conversation = activeConversation();
  savedItems.unshift({
    id: uid("save"),
    content,
    sourceTitle: conversation.title || "Диалог",
    createdAt: Date.now(),
  });
  persist();
  renderSaved();
  updateChrome();
}

function deleteSaved(id) {
  savedItems = savedItems.filter((item) => item.id !== id);
  persist();
  renderSaved();
  renderLog();
  updateChrome();
}

function makeBubble(role, text, { isError = false, streaming = false } = {}) {
  const article = document.createElement("article");
  article.className = `bubble ${isError ? "error" : role}`;
  article.dataset.copyText = text;

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  const label = document.createElement("span");
  label.textContent = isError ? "ошибка" : role === "user" ? "вы" : "кабинет";
  meta.appendChild(label);

  const actions = document.createElement("div");
  actions.className = "bubble-actions";

  if (role === "assistant" && !isError) {
    const saveBtn = document.createElement("button");
    saveBtn.className = "copy-btn";
    saveBtn.type = "button";
    saveBtn.textContent = isSaved(text) ? "сохранено" : "сохранить";
    saveBtn.disabled = isSaved(text);
    saveBtn.addEventListener("click", () => {
      saveAnswer(text);
      saveBtn.textContent = "сохранено";
      saveBtn.disabled = true;
    });
    actions.appendChild(saveBtn);
  }

  if (!isError) {
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "копировать";
    copyBtn.addEventListener("click", () =>
      copyText(article.dataset.copyText || content.innerText, copyBtn),
    );
    actions.appendChild(copyBtn);
  }

  if (actions.children.length > 0) meta.appendChild(actions);

  const content = document.createElement("div");
  content.className = "bubble-content";
  if (streaming || role === "user" || isError) {
    content.textContent = text;
  } else {
    renderMarkdown(content, text);
  }

  article.append(meta, content);
  logEl.appendChild(article);
  logEl.scrollTop = logEl.scrollHeight;

  return { article, content };
}

function renderLog() {
  const existing = [...logEl.querySelectorAll(".bubble")];
  for (const node of existing) node.remove();

  const conversation = activeConversation();
  for (const message of conversation.messages) {
    makeBubble(message.role, message.content);
  }
  updateChrome();
  logEl.scrollTop = logEl.scrollHeight;
}

function setView(view) {
  viewTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  viewPanes.forEach((pane) => pane.classList.toggle("active", pane.id === `${view}View`));
  if (view === "saved") renderSaved();
  if (view === "history") renderHistory();
}

function setLoading(loading, label = "Запрос к модели...") {
  sendBtn.disabled = loading;
  continueBtn.disabled = loading;
  inputEl.disabled = loading;
  statusEl.textContent = loading ? label : "";
}

function updateChrome() {
  const conversation = activeConversation();
  const inputLength = inputEl.value.length;
  counterEl.textContent = `${inputLength} / ${maxInputChars}`;
  counterEl.classList.toggle("warn", inputLength > maxInputChars * 0.9);
  contextBadgeEl.textContent = `тон: ${settings.tone} · глубина: ${settings.depth}`;
  messageCountEl.textContent = `${conversation.messages.length} сообщений`;
  savedCountEl.textContent = savedItems.length;
  historyCountEl.textContent = conversations.length;
  activeTitleEl.textContent = conversation.title || "Новый диалог";
  savedStatEl.textContent = savedItems.length;
  emptyStateEl.hidden = conversation.messages.length > 0;
  continueBtn.hidden = conversation.messages.at(-1)?.role !== "assistant";
}

function setPrompt(prompt) {
  inputEl.value = prompt;
  inputEl.focus();
  inputEl.setSelectionRange(prompt.length, prompt.length);
  updateChrome();
  setView("chat");
}

function buildOutgoingText(text) {
  return [
    `Тон ответа: ${settings.tone}.`,
    `Глубина: ${settings.depth}.`,
    `Формат: ${settings.format}.`,
    "Не используй Markdown-таблицы, если можно ответить списком.",
    "",
    text,
  ].join("\n");
}

async function sendMessage(text) {
  if (!text.trim()) return;

  const conversation = activeConversation();
  const outgoing = buildOutgoingText(text.trim());
  const visibleUserText = text.trim();

  makeBubble("user", visibleUserText);
  conversation.messages.push({ role: "user", content: visibleUserText });
  touchConversation(conversation);
  persist();
  updateChrome();

  inputEl.value = "";
  setLoading(true, "Подключаемся...");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          ...conversation.messages.slice(0, -1),
          { role: "user", content: outgoing },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(130_000),
    });

    if (!res.ok) {
      conversation.messages.pop();
      touchConversation(conversation);
      persist();
      const data = await res.json().catch(() => ({}));
      const err =
        typeof data.error === "string" ? data.error : "Ошибка от сервера";
      makeBubble("assistant", err, { isError: true });
      return;
    }

    const data = await res.json().catch(() => ({}));
    const reply = typeof data.content === "string" ? data.content : "";
    if (!reply) {
      conversation.messages.pop();
      touchConversation(conversation);
      persist();
      makeBubble("assistant", "Неожиданный ответ сервера.", {
        isError: true,
      });
      return;
    }
    makeBubble("assistant", reply);
    conversation.messages.push({ role: "assistant", content: reply });
    touchConversation(conversation);
    persist();
  } catch (err) {
    conversation.messages.pop();
    touchConversation(conversation);
    persist();
    let msg = err instanceof Error ? err.message : "Сеть недоступна";
    if (/fetch failed/i.test(msg)) {
      msg =
        "Браузер не смог связаться с сервером. Проверьте, что npm start запущен и открыт тот же localhost:порт.";
    }
    makeBubble("assistant", msg, { isError: true });
  } finally {
    setLoading(false);
    renderHistory();
    updateChrome();
    inputEl.focus();
  }
}

function renderSaved() {
  const query = savedSearchEl.value.trim().toLowerCase();
  const items = savedItems.filter((item) => {
    const haystack = `${item.content} ${item.sourceTitle}`.toLowerCase();
    return !query || haystack.includes(query);
  });

  savedListEl.textContent = "";
  if (items.length === 0) {
    savedListEl.appendChild(emptyCard("Сохраненных ответов пока нет", "Нажми «сохранить» у удачного ответа в чате."));
    return;
  }

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "library-card";

    const head = document.createElement("div");
    head.className = "library-card-head";
    const title = document.createElement("strong");
    title.textContent = item.sourceTitle || "Ответ";
    const date = document.createElement("span");
    date.textContent = formatDate(item.createdAt);
    head.append(title, date);

    const body = document.createElement("div");
    body.className = "library-body";
    renderMarkdown(body, item.content);

    const actions = document.createElement("div");
    actions.className = "library-actions";
    actions.append(
      actionButton("Копировать", (button) => copyText(item.content, button)),
      actionButton("Вставить в чат", () => {
        inputEl.value = item.content.slice(0, maxInputChars);
        setView("chat");
        inputEl.focus();
        updateChrome();
      }),
      actionButton("Удалить", () => deleteSaved(item.id), "danger"),
    );

    card.append(head, body, actions);
    savedListEl.appendChild(card);
  }
}

function renderHistory() {
  const query = historySearchEl.value.trim().toLowerCase();
  const items = conversations.filter((conversation) => {
    const haystack = `${conversation.title} ${conversation.messages
      .map((message) => message.content)
      .join(" ")}`.toLowerCase();
    return !query || haystack.includes(query);
  });

  historyListEl.textContent = "";
  if (items.length === 0) {
    historyListEl.appendChild(emptyCard("Диалоги не найдены", "Создай новый чат или измени поисковый запрос."));
    return;
  }

  for (const conversation of items) {
    const card = document.createElement("article");
    card.className = `history-card ${
      conversation.id === activeConversationId ? "active" : ""
    }`;

    const head = document.createElement("div");
    head.className = "library-card-head";
    const title = document.createElement("strong");
    title.textContent = conversation.title || "Новый диалог";
    const date = document.createElement("span");
    date.textContent = formatDate(conversation.updatedAt);
    head.append(title, date);

    const preview = document.createElement("p");
    preview.className = "history-preview";
    preview.textContent =
      conversation.messages.find((message) => message.role === "user")?.content ||
      "Пустой диалог";

    const actions = document.createElement("div");
    actions.className = "library-actions";
    actions.append(
      actionButton("Открыть", () => {
        activeConversationId = conversation.id;
        persist();
        renderLog();
        setView("chat");
      }),
      actionButton("Удалить", () => deleteConversation(conversation.id), "danger"),
    );

    card.append(head, preview, actions);
    historyListEl.appendChild(card);
  }
}

function emptyCard(title, text) {
  const card = document.createElement("div");
  card.className = "empty-card";
  const h = document.createElement("strong");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  card.append(h, p);
  return card;
}

function actionButton(label, handler, variant = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mini-btn ${variant}`;
  button.textContent = label;
  button.addEventListener("click", () => handler(button));
  return button;
}

function deleteConversation(id) {
  conversations = conversations.filter((conversation) => conversation.id !== id);
  if (conversations.length === 0) createConversation();
  if (activeConversationId === id) activeConversationId = conversations[0].id;
  persist();
  renderHistory();
  renderLog();
}

function clearConversation() {
  const conversation = activeConversation();
  conversation.messages = [];
  conversation.title = "Новый диалог";
  touchConversation(conversation);
  persist();
  renderLog();
  inputEl.focus();
}

function exportConversation() {
  const conversation = activeConversation();
  if (conversation.messages.length === 0) {
    statusEl.textContent = "В диалоге пока нечего экспортировать.";
    return;
  }

  const text = conversation.messages
    .map((message) => `${message.role === "user" ? "Вы" : "Кабинет"}:\n${message.content}`)
    .join("\n\n---\n\n");
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(conversation.title || "blog-chat")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  await sendMessage(inputEl.value);
});

clearBtn.addEventListener("click", clearConversation);

newChatBtn.addEventListener("click", () => {
  createConversation();
  renderLog();
  renderHistory();
  setView("chat");
  inputEl.focus();
});

continueBtn.addEventListener("click", async () => {
  await sendMessage("Продолжи с того места, где остановился.");
});

exportBtn.addEventListener("click", exportConversation);

inputEl.addEventListener("input", updateChrome);
savedSearchEl.addEventListener("input", renderSaved);
historySearchEl.addEventListener("input", renderHistory);
formatSelectEl.addEventListener("change", () => {
  settings.format = formatSelectEl.value;
  saveSettings();
});

for (const tab of viewTabs) {
  tab.addEventListener("click", () => setView(tab.dataset.view));
}

for (const button of promptButtons) {
  button.addEventListener("click", () => {
    promptButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    setPrompt(button.dataset.prompt || "");
  });
}

for (const button of toneButtons) {
  button.classList.toggle("active", button.dataset.tone === settings.tone);
  button.addEventListener("click", () => {
    toneButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    settings.tone = button.dataset.tone || "практичный";
    saveSettings();
    updateChrome();
  });
}

for (const button of depthButtons) {
  button.classList.toggle("active", button.dataset.depth === settings.depth);
  button.addEventListener("click", () => {
    depthButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    settings.depth = button.dataset.depth || "нормально";
    saveSettings();
    updateChrome();
  });
}

async function loadMeta() {
  try {
    const res = await fetch("/api/meta");
    const meta = await res.json();
    modelStatusEl.textContent = `модель: ${meta.model}`;
    maxInputChars = Number(meta.maxMessageChars) || maxInputChars;
    inputEl.maxLength = maxInputChars;
    updateChrome();
  } catch {
    modelStatusEl.textContent = "модель: локально";
  }
}

formatSelectEl.value = settings.format;
persist();
renderLog();
renderSaved();
renderHistory();
updateChrome();
void loadMeta();
