const logEl = document.getElementById("log");
const formEl = document.getElementById("form");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const clearBtn = document.getElementById("clear");
const statusEl = document.getElementById("status");

/** @type {{ role: 'user' | 'assistant', content: string }[]} */
let messages = [];

function appendBubble(role, text, isError = false) {
  const div = document.createElement("div");
  div.className = `bubble ${isError ? "error" : role}`;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div;
}

function appendAssistantBubble() {
  const div = document.createElement("div");
  div.className = "bubble assistant";
  div.textContent = "";
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div;
}

function setLoading(loading, label = "Запрос к модели…") {
  sendBtn.disabled = loading;
  inputEl.disabled = loading;
  statusEl.textContent = loading ? label : "";
}

/**
 * @param {Response} response
 * @param {HTMLElement} bubble
 * @returns {Promise<string>}
 */
async function readSseDeltas(response, bubble) {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const dec = new TextDecoder();
  let carry = "";
  let full = "";
  let firstToken = true;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += dec.decode(value, { stream: true });

    let nl;
    while ((nl = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, nl).replace(/\r$/, "");
      carry = carry.slice(nl + 1);

      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trimStart();
      if (raw === "[DONE]") continue;

      try {
        const j = JSON.parse(raw);
        const piece = j.choices?.[0]?.delta?.content;
        if (typeof piece === "string" && piece.length > 0) {
          full += piece;
          bubble.textContent = full;
          logEl.scrollTop = logEl.scrollHeight;
          if (firstToken) {
            firstToken = false;
            statusEl.textContent = "Печатает…";
          }
        }
      } catch {
        /* ignore malformed chunk */
      }
    }
  }

  return full;
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  appendBubble("user", text);
  messages.push({ role: "user", content: text });
  inputEl.value = "";
  setLoading(true, "Подключаемся…");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, stream: true }),
      signal: AbortSignal.timeout(130_000),
    });

    const ct = res.headers.get("content-type") || "";

    if (!res.ok) {
      messages.pop();
      logEl.removeChild(logEl.lastElementChild);
      const data = await res.json().catch(() => ({}));
      const err =
        typeof data.error === "string" ? data.error : "Ошибка от сервера";
      appendBubble("assistant", err, true);
      return;
    }

    if (ct.includes("text/event-stream")) {
      const bubble = appendAssistantBubble();
      const full = await readSseDeltas(res, bubble);

      if (!full.trim()) {
        bubble.remove();
        appendBubble(
          "assistant",
          "Пустой ответ от модели. Попробуйте ещё раз.",
          true,
        );
        return;
      }

      messages.push({ role: "assistant", content: full });
      return;
    }

    const data = await res.json().catch(() => ({}));
    const reply = typeof data.content === "string" ? data.content : "";
    if (!reply) {
      messages.pop();
      logEl.removeChild(logEl.lastElementChild);
      appendBubble("assistant", "Неожиданный ответ сервера.", true);
      return;
    }
    appendBubble("assistant", reply);
    messages.push({ role: "assistant", content: reply });
  } catch (err) {
    messages.pop();
    if (logEl.lastElementChild) logEl.removeChild(logEl.lastElementChild);
    let msg =
      err instanceof Error ? err.message : "Сеть недоступна";
    if (/fetch failed/i.test(msg)) {
      msg =
        "Браузер не смог связаться с сервером (fetch failed). Проверьте, что `./run.sh` запущен и открыт тот же localhost:порт.";
    }
    appendBubble("assistant", msg, true);
  } finally {
    setLoading(false);
    inputEl.focus();
  }
});

clearBtn.addEventListener("click", () => {
  messages = [];
  logEl.innerHTML = "";
  inputEl.focus();
});
