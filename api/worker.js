/* ═══════════════════════════════════════════
   Серверная часть формы отзывов — Cloudflare Worker.
   Устроена как у сайта «ТОРТ по любви»: форма на GitHub Pages
   шлёт отзыв сюда, отсюда он уходит в Telegram-бота.

   Маршруты:
     POST /submit — отзыв с формы → Telegram
     GET  /       — проверка, что сервер жив

   Секретов в коде нет и быть не должно. Ключи задаются командой
   `wrangler secret put ИМЯ`, см. README.md:
     TELEGRAM_BOT_TOKEN — токен бота от @BotFather
     TELEGRAM_CHAT_ID   — куда слать отзывы; несколько чатов через запятую
   ═══════════════════════════════════════════ */

const MIN_TEXT = 10;        // грубая защита от пустых отзывов; в самой форме минимум строже
const MIN_FILL_MS = 3000;   // быстрее 3 секунд форму заполняют только боты

// Отметки «что понравилось» — те же, что в форме. Остальное отбрасываем.
const LIKED = ['Сроки', 'Дизайн', 'Общение', 'Результат'];

const escHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ── CORS: принимаем отзывы только со своих сайтов ── */
function cors(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || ''),
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status, headers) => new Response(JSON.stringify(data), {
  status: status || 200,
  headers: { ...(headers || {}), 'Content-Type': 'application/json; charset=utf-8' },
});

/* ── Telegram ── */
function recipients(env) {
  return String(env.TELEGRAM_CHAT_ID || '')
    .split(/[,;\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Одно сообщение всем получателям. Доставлено, если принял хоть один. */
async function sendTelegram(env, html) {
  const chats = recipients(env);
  if (!env.TELEGRAM_BOT_TOKEN || !chats.length) {
    throw new Error('telegram: не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID');
  }
  /* Адрес API вынесен в переменную, чтобы тест мог направить запросы
     на локальную заглушку. В бою используется настоящий api.telegram.org. */
  const host = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

  async function deliverTo(chat) {
    const msg = new FormData();
    msg.append('chat_id', chat);
    msg.append('parse_mode', 'HTML');
    msg.append('disable_web_page_preview', 'true');
    msg.append('text', html.slice(0, 4000));
    const res = await fetch(`${host}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', body: msg });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`чат ${chat}: ${data.description || res.status}`);
  }

  const results = await Promise.allSettled(chats.map(deliverTo));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? `${chats[i]}: ${r.reason?.message || r.reason}` : null))
    .filter(Boolean);
  if (failed.length === chats.length) throw new Error('telegram: ' + failed.join('; '));
  return { failedChats: failed };
}

/* ── POST /submit ── */
async function handleSubmit(request, env, headers) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Не удалось прочитать форму' }, 400, headers);
  }
  const field = k => String(form.get(k) || '').trim();

  // Ловушки для ботов: скрытое поле и слишком быстрое заполнение. Делаем вид, что всё прошло.
  if (field('website')) return json({ ok: true }, 200, headers);
  if (Number(field('t')) < MIN_FILL_MS) return json({ ok: true }, 200, headers);

  const rating = Math.round(Number(field('rating')));
  const text = field('text').slice(0, 2000);
  const name = field('name').slice(0, 80);
  const publish = Boolean(field('publish'));
  const liked = LIKED.filter(v => field('liked').split(',').map(s => s.trim()).includes(v));
  const site = field('site').slice(0, 200);
  if (!(rating >= 1 && rating <= 5) || text.length < MIN_TEXT || !name) {
    return json({ ok: false, error: 'Не хватает оценки, текста или имени' }, 400, headers);
  }

  const rows = [
    ['Оценка', `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} ${rating} из 5`],
    liked.length ? ['Понравилось', liked.join(', ').toLowerCase()] : null,
    ['Отзыв', text],
    ['Имя', name],
    site ? ['Сайт', site] : null,
    ['Публикация', publish ? 'можно опубликовать в канале' : 'не публиковать'],
  ].filter(Boolean);
  const html = ['<b>⭐ Новый отзыв</b>', '']
    .concat(rows.map(([k, v]) => `<b>${escHtml(k)}:</b> ${escHtml(v)}`))
    .concat(['', '<i>Форма отзывов</i>'])
    .join('\n');

  try {
    await sendTelegram(env, html);
    return json({ ok: true, delivered: ['telegram'] }, 200, headers);
  } catch (err) {
    console.error(err);
    // Форма покажет запасной путь: готовое сообщение в Telegram или на почту
    return json({ ok: false, error: 'Не удалось доставить отзыв' }, 502, headers);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const headers = cors(origin, allowed);
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method === 'GET' && pathname === '/') return json({ ok: true, service: 'reviews' }, 200, headers);
    if (request.method !== 'POST' || pathname !== '/submit') return json({ ok: false, error: 'Not found' }, 404, headers);

    // Чужой сайт слать отзывы не сможет
    if (origin && !allowed.includes(origin)) return json({ ok: false, error: 'origin' }, 403, headers);

    return handleSubmit(request, env, headers);
  },
};
