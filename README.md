# Форма отзывов

Страница: https://strangehul1-design.github.io/review-form/

Позже форма встанет в портфолио под контактами. Пока это отдельная страница.

## Как работает

Так же, как заявки на сайте «ТОРТ по любви» до переезда на свой хостинг:

1. человек ставит оценку, пишет отзыв и нажимает «Отправить отзыв»;
2. форма отправляет его на сервер в Cloudflare (`api/worker.js`);
3. сервер пересылает отзыв в Telegram-бота;
4. если сервер или Telegram не ответили, форма не теряет текст и предлагает отправить его готовым сообщением в Telegram или на почту.

Токен бота хранится только в секретах Cloudflare. На странице и в репозитории его нет.

## Файлы

```
index.html            форма
api/worker.js         сервер: принимает отзыв и шлёт в Telegram
api/wrangler.toml     настройки сервера, без секретов
api/worker-test.mjs   проверка сервера с подставным Telegram: node api/worker-test.mjs
```

## Подключение сервера (один раз)

```bash
cd api
npx wrangler login
npx wrangler deploy
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

- `TELEGRAM_BOT_TOKEN` - токен бота. Вводится в консоли, в файлы не попадает.
- `TELEGRAM_CHAT_ID` - твой ID в Telegram (узнать у @userinfobot). Несколько получателей - через запятую.
- Бот может писать только тем, кто нажал у него «Start».

`wrangler deploy` выдаст адрес вида `https://digital-reviews.ИМЯ.workers.dev`.
Его нужно вписать в `index.html` в `ENDPOINT` с `/submit` на конце.

Проверка: открыть адрес сервера в браузере, там должно быть `{"ok":true,"service":"reviews"}`.

## Защита от спама

- отзывы принимаются только со страниц `strangehul1-design.github.io` (`ALLOWED_ORIGINS` в `wrangler.toml`);
- скрытое поле-ловушка: его заполняют только боты;
- форму нельзя отправить быстрее чем за 3 секунды после открытия;
- длина текста и имени ограничена.
