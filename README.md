# Блог-кабинет

Локальный помощник для ведения блога: веб-чат в браузере и Telegram-бот. Оба режима используют Hugging Face OpenAI-compatible router.

## Что внутри

- Веб-интерфейс на Express и обычном HTML/CSS/JS.
- Telegram-бот на Telegraf с историей диалога.
- Общий модуль Hugging Face API в `hf-chat.js`.
- Веб-вкладки: `Чат`, `Сохранено`, `История`.
- Локальное сохранение диалогов и избранных ответов в браузере.
- Базовая валидация сообщений и rate limit для `/api/chat`.

## Требования

- Node.js 20 или новее.
- Hugging Face token с доступом к Inference Providers.
- Для Telegram-бота: токен от `@BotFather`.

## Быстрый запуск веб-версии

```powershell
cd "C:\Users\evstk\OneDrive\Рабочий стол\Новая папка\blogging-assistant"
npm install
Copy-Item .env.example .env
```

Откройте `.env` и замените:

```env
HF_TOKEN=hf_your_token_here
```

Запуск:

```powershell
npm start
```

После запуска откройте:

```text
http://localhost:3000
```

Режим разработки с автоматическим перезапуском сервера:

```powershell
npm run dev
```

## Запуск Telegram-бота

В `.env` заполните:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
```

Потом запустите:

```powershell
npm run telegram
```

## Переменные окружения

Основные:

- `HF_TOKEN` - токен Hugging Face.
- `HF_MODEL` - модель для chat completions.
- `HF_CHAT_URL` - URL роутера Hugging Face.
- `PORT` - порт веб-сервера.
- `HF_STREAM` - `0` для стабильного JSON-режима, `1` для стриминга.
- `HF_TIMEOUT_MS` - таймаут запроса к Hugging Face.
- `HF_MAX_TOKENS` - лимит длины ответа. Для Telegram лучше держать около `3072`, чтобы контент-планы не обрывались.
- `HF_TEMPERATURE` - креативность модели. Для стабильных ответов лучше `0.35`-`0.5`.
- `HF_RETRY_QUALITY` - `1` включает повторную генерацию, если модель ушла в китайский текст, английский заголовок или оставила важный раздел пустым.

Ограничения веб-API:

- `CHAT_MAX_MESSAGES` - максимум сообщений в истории запроса.
- `CHAT_MAX_MESSAGE_CHARS` - максимум символов в одном сообщении.
- `RATE_LIMIT_WINDOW_MS` - окно rate limit.
- `RATE_LIMIT_MAX` - максимум запросов за окно.
- `TRUST_PROXY` - включать только за доверенным reverse proxy.

Telegram:

- `TELEGRAM_BOT_TOKEN` или `BOT_TOKEN` - токен бота.
- `TG_MAX_DIALOG_MESSAGES` - размер истории Telegram-диалога.
- `TG_HANDLER_EXTRA_MS` - запас времени для долгих ответов модели.

## Проверка

```powershell
npm run check
```

Команда проверяет синтаксис основных JS-файлов.

## Структура

```text
blogging-assistant/
  public/
    index.html
    styles.css
    app.js
  hf-chat.js
  server.js
  telegram-bot.js
  .env.example
  package.json
```

## Заметки

- `.env` не должен попадать в git.
- `node_modules/` тоже игнорируется и восстанавливается через `npm install`.
- Для этой веб-версии надежнее держать `HF_STREAM=0`: некоторые модели/провайдеры Hugging Face отдают несовместимый streaming-формат.
- Если Hugging Face долго отвечает, увеличьте `HF_TIMEOUT_MS` или смените `HF_MODEL`.
- Telegram плохо показывает Markdown-таблицы, поэтому бот просит модель отвечать списками и дополнительно очищает `**звездочки**` из ответов.
- Если модель выдала китайский текст, английский `Tone of voice` в русском ответе или пустой `Хук:`, сервер автоматически просит Hugging Face переписать ответ один раз.

## Частая ошибка Hugging Face 403

Если чат пишет, что токен не имеет прав для `Inference Providers`, значит сам токен найден, но создан без нужного разрешения. Создайте новый токен в Hugging Face `Settings > Access Tokens` и включите право на inference / Inference Providers. После замены `HF_TOKEN` в `.env` перезапустите сервер.
