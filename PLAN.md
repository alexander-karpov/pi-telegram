# План: стриминг reasoning-токенов в Telegram

## Статус: v1 реализована (см. `index.ts`)

В коде уже сделано:

- Маршрутизация `message_update` по `assistantMessageEvent.type`
  (`thinking_start | thinking_delta | thinking_end | text_start | text_delta | text_end`).
- `TelegramThinkingBlockState` + `Map<contentIndex, ...>` с накоплением `fullText`.
- Утилита `buildThinkingDisplay()` — заголовок `🧠 Thinking…` / `🧠 Thought` + усечение
  хвостом по ближайшему `\n` (с префиксом `…\n`).
- Троттлинг через `scheduleThinkingFlush` (переиспользует `PREVIEW_THROTTLE_MS = 750ms`).
- Один `sendMessage` на блок при первом флэше + `editMessageText` на последующие, с
  предварительным сравнением `rendered !== block.lastSentText`.
- `safeEditMessageText` ловит `Bad Request: message is not modified`, в т.ч. для
  `flushPreview` (текстовый стрим), — фикс старого бага из исходного PLAN.md.
- Финализация на `thinking_end`, `text_start` (закрывает активный thinking),
  `message_start` (закрывает thinking прошлого assistant-сообщения), `agent_end`,
  `session_shutdown`, `stop` (в abort-ветке).
- Очистка таймеров через `resetThinkingState`.
- Сброс `previewState.pendingText` в `text_start`, чтобы новый текстовый блок не
  «доклеивался» к остаткам предыдущего.
- Защита от пустого/`redacted` thinking: блок без непустого `fullText.trim()` не
  отправляется (ни как новый `sendMessage`, ни как edit), даже на `thinking_end`.
- Сетевые ошибки в `flushThinkingBlock` ловятся и логируются — не валят
  unhandled rejection из `setTimeout`.

## TODO / возможные улучшения (vNext)

Не входит в v1, но имеет смысл прикрутить:

1. **Использовать `partial.content[contentIndex].thinking` вместо `delta`-аккумуляции.**
   Источник правды — сам `partial: AssistantMessage`. Сейчас руками складываем `delta` →
   риск дрейфа при ретраях/повторных событиях. Минимальная замена в `thinking_delta`:
   ```ts
   const partial = streamEvent.partial as AssistantMessage | undefined;
   const block = ensureThinkingBlock(contentIndex);
   const piece = partial?.content?.[contentIndex];
   if (piece && piece.type === "thinking") {
       block.fullText = piece.thinking;
   } else {
       block.fullText += delta;
   }
   ```
   Заодно `thinking_end` упростится (там это уже частично есть через `streamEvent.content`).

2. **Не поднимать ошибки сети, а отображать их в `updateStatus`.**
   Сейчас reasoning-флэш ошибки только `console.error`. Для `flushPreview`/`finalizePreview`
   и `sendQueuedAttachments` тоже стоит унифицировать — обернуть ошибочные ветви в
   `updateStatus(ctx, ...)`. Но `ctx` нужно прокидывать в `flushThinkingBlock` через
   замыкание (либо завести reference в outer scope обработчика).

3. **Обработка 429 (rate limit) от Telegram.**
   `callTelegram` сейчас просто кидает `Error(description)` на `data.ok === false`. Нужно
   читать `parameters.retry_after` (для 429) и:
   - в reasoning: увеличивать локальный троттлинг блока на это время;
   - в text-preview: то же.
   Реализация: новый интерфейс `TelegramApiResponse<T>` с полем `parameters?:
   { retry_after?: number; migrate_to_chat_id?: number }`, в `callTelegram` пробрасывать
   эти параметры наверх через кастомный `TelegramApiError`. Вызывающие — могут sleep'ить.

4. **`🧠 Thought for 12s`** — длительность thinking при финализации.
   Хранить `startedAt: number` в `TelegramThinkingBlockState`, на `thinking_end` считать
   `Date.now() - startedAt` и подмешивать в заголовок `THINKING_HEADER_DONE`. Дёшево,
   информативно (как в opencode/Claude Code).

5. **Тоггл `streamReasoning` (вкл/выкл).**
   В `TelegramConfig` добавить `streamReasoning?: boolean` (default `true`). В
   `message_update` для `thinking_*` ранний `return`, если выключено. Команда
   `/telegram-reasoning on|off` или флаг при `/telegram-setup`.

6. **`redacted: true` блоки.**
   Сейчас они просто игнорируются (т.к. `thinking` обычно пустой). Лучше при детекте
   `partial.content[contentIndex].redacted === true` единократно отправить `🧠 (redacted
   thinking)` и пометить блок `finalized` — пользователь увидит, что модель «думала, но
   вывод закрыт фильтром».

7. **`isAssistantMessage` через нормальную типизацию.**
   Сейчас приведение `(event.message as unknown as { role?: string }).role`. Импортировать
   `AssistantMessage` из `@mariozechner/pi-ai` и использовать `event.message.role ===
   "assistant"`. То же для `extractAssistantText` / `getMessageText`.

8. **Покрыть `assistantMessageEvent` строгим типом.**
   Сейчас `streamEvent` — `Record<string, unknown>` с typeof-проверками. Проще
   импортировать `AssistantMessageEvent` из `@mariozechner/pi-ai` и сделать
   `switch (streamEvent.type)` — typescript автоматически нарратит `delta`/`content`/
   `contentIndex`.

9. **Тул-коллы как отдельные сообщения.**
   `toolcall_start/delta/end` + `tool_execution_*` пробрасывать в Telegram короткими
   сообщениями (`🔧 read /path/x.ts`, `🔧 bash …` + первая строка stdout). Желательно
   тоже как «один блок = одно editable-сообщение». Большая задача — отдельный план.

10. **Inline keyboard `Show full reasoning` для усечённых блоков.**
    При `thinking_end`, если `fullText.length > contentBudget`, к финальному сообщению
    добавлять кнопку, по нажатию слать полный текст файлом (txt). Требует подписку на
    `callback_query` в `pollLoop` — сейчас `allowed_updates: ["message", "edited_message"]`.

## Известные ограничения v1

- Если модель шлёт reasoning без явных `thinking_start`/`thinking_end` (только дельты),
  блок создаётся через `ensureThinkingBlock` и финализируется на `text_start` /
  `message_start` / `agent_end`. Это работает, но заголовок может остаться `Thinking…`
  до самого `agent_end`.
- При длинном reasoning видна только хвостовая часть; полный текст в Telegram не
  сохраняется (но остаётся в pi-сессии).
- Нет ретраев на 429 — длинный reasoning при высокой частоте обновлений может упереться
  в лимит Telegram (раз в секунду на сообщение). Текущий троттлинг 750ms почти всегда
  безопасен, но не гарантированно.

## Тест-сценарии (ручные)

1. **Короткий reasoning** (модель додумала за < 750ms):
   - Ожидание: одно сообщение `🧠 Thought\n<полный текст>`, без промежуточных правок.
2. **Длинный reasoning** (несколько секунд стрима):
   - Ожидание: сначала `🧠 Thinking…\n<начало>`, текст растёт, при переполнении
     показывается хвост с префиксом `…\n`. На завершении — заголовок `🧠 Thought`.
3. **Тул-вуз посередине** (thinking → toolCall → toolResult → thinking → text):
   - Ожидание: два отдельных Telegram-сообщения для двух thinking-блоков, оба со
     статусом `🧠 Thought`. Финальный ответ — третьим сообщением.
4. **`stop` посередине thinking**:
   - Ожидание: Telegram-сообщение остаётся как `🧠 Thinking…\n<то, что успело прийти>`
     (или `🧠 Thought\n…` благодаря финализации в abort-ветке). Никаких ошибок в логах pi.
5. **Несколько ассистент-сообщений в одном агент-цикле** (между tool-use):
   - Ожидание: thinking-блоки прошлого assistant-сообщения финализируются через
     `message_start` следующего, заголовки переходят в `🧠 Thought`.
6. **Reasoning-only ответ без текстового блока**:
   - Ожидание: thinking-сообщение появляется и финализируется на `agent_end`. Финального
     текстового сообщения нет (или приходит "Attached requested file(s)." при наличии
     attachments).
7. **Очень длинный reasoning, забивающий 4096**:
   - Ожидание: усечение хвостом стабильно (никаких `Bad Request: text is too long`).
8. **`message is not modified`**:
   - Принудительно повторить флэш с тем же текстом — должен быть no-op (через
     `lastSentText` сравнение и `safeEditMessageText` как safety net).
