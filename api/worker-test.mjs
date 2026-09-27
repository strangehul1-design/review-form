// Проверка сервера отзывов без Cloudflare и без настоящего Telegram:
//   node api/worker-test.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import worker from './worker.js';

/* Заглушка Telegram: запоминает, что пришло, и отвечает как настоящий API */
const sent = [];
let tgFails = new Set();
const fake = http.createServer(async (req, res) => {
  const body = await new Response(req, { headers: { 'content-type': req.headers['content-type'] } }).formData();
  const chat = body.get('chat_id');
  sent.push({ path: req.url, chat, text: body.get('text'), mode: body.get('parse_mode') });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(tgFails.has(chat) ? { ok: false, description: 'Forbidden: bot was blocked by the user' } : { ok: true }));
});
await new Promise(r => fake.listen(0, r));

const SITE = 'https://strangehul1-design.github.io';
const env = {
  ALLOWED_ORIGINS: SITE,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_CHAT_ID: '111, 222',
  TELEGRAM_API_BASE: `http://127.0.0.1:${fake.address().port}`,
};
const good = { rating: '5', text: 'Сделали быстро и в срок. <b>Спасибо</b> & всё', name: 'Анна', publish: '1', website: '', t: '8000' };

async function submit(fields, { origin = SITE, e = env, path = '/submit', method = 'POST' } = {}) {
  sent.length = 0;
  const init = { method, headers: origin ? { Origin: origin } : {} };
  if (method === 'POST') init.body = new URLSearchParams(fields);
  const res = await worker.fetch(new Request('https://w.example' + path, init), e);
  return { status: res.status, cors: res.headers.get('Access-Control-Allow-Origin'), body: await res.json().catch(() => null) };
}

// 1. нормальный отзыв уходит обоим получателям, HTML экранирован
let r = await submit(good);
assert.equal(r.status, 200);
assert.deepEqual(r.body, { ok: true, delivered: ['telegram'] });
assert.equal(r.cors, SITE);
assert.deepEqual(sent.map(s => s.chat).sort(), ['111', '222']);
assert.equal(sent[0].path, '/botTEST/sendMessage');
assert.equal(sent[0].mode, 'HTML');
assert.match(sent[0].text, /&lt;b&gt;Спасибо&lt;\/b&gt; &amp; всё/);
assert.match(sent[0].text, /★★★★★ 5 из 5/);
assert.match(sent[0].text, /можно опубликовать в канале/);
console.log('--- сообщение в Telegram ---\n' + sent[0].text + '\n---');

// 2. без галочки публикации; без отметок и сайта этих строк нет
r = await submit({ ...good, publish: '', rating: '3' });
assert.match(sent[0].text, /★★★☆☆ 3 из 5/);
assert.match(sent[0].text, /не публиковать/);
assert.doesNotMatch(sent[0].text, /Понравилось|Сайт:/);

// 2а. отметки и сайт: чужие отметки отбрасываются, сайт экранируется
r = await submit({ ...good, liked: 'Сроки,Взлом,Общение', site: 'asiyatort.ru/<x>' });
assert.match(sent[0].text, /<b>Понравилось:<\/b> сроки, общение\r?\n/);
assert.match(sent[0].text, /<b>Сайт:<\/b> asiyatort\.ru\/&lt;x&gt;/);
console.log('--- с отметками и сайтом ---\n' + sent[0].text + '\n---');

// 2б. оценка 1-2 - те же отметки означают «не понравилось», оценка 3 - ещё «понравилось»
r = await submit({ ...good, rating: '2', liked: 'Сроки' });
assert.match(sent[0].text, /<b>Не понравилось:<\/b> сроки/);
r = await submit({ ...good, rating: '3', liked: 'Сроки' });
assert.match(sent[0].text, /<b>Понравилось:<\/b> сроки/);
assert.doesNotMatch(sent[0].text, /Не понравилось/);

// 3. боты: ловушка и слишком быстро — ответ "ok", но ничего не отправлено
for (const trap of [{ website: 'http://spam' }, { t: '500' }, { t: '' }]) {
  r = await submit({ ...good, ...trap });
  assert.deepEqual(r.body, { ok: true }, JSON.stringify(trap));
  assert.equal(sent.length, 0);
}

// 4. неполные данные
for (const bad of [{ rating: '0' }, { rating: '6' }, { rating: 'x' }, { text: 'коротко' }, { name: ' ' }]) {
  r = await submit({ ...good, ...bad });
  assert.equal(r.status, 400, JSON.stringify(bad));
  assert.equal(sent.length, 0);
}

// 5. чужой сайт
r = await submit(good, { origin: 'https://evil.example' });
assert.equal(r.status, 403);
assert.equal(sent.length, 0);

// 6. один получатель заблокировал бота — всё равно доставлено
tgFails = new Set(['111']);
r = await submit(good);
assert.equal(r.body.ok, true);
// оба заблокировали — форма узнает об ошибке и предложит запасной путь
tgFails = new Set(['111', '222']);
r = await submit(good);
assert.equal(r.status, 502);
assert.equal(r.body.ok, false);
tgFails = new Set();

// 7. секреты не заданы — честная ошибка
r = await submit(good, { e: { ...env, TELEGRAM_BOT_TOKEN: '' } });
assert.equal(r.status, 502);

// 8. проверка «жив ли», предварительный запрос браузера, чужие адреса
assert.deepEqual((await submit(null, { method: 'GET', path: '/' })).body, { ok: true, service: 'reviews' });
const pre = await worker.fetch(new Request('https://w.example/submit', { method: 'OPTIONS', headers: { Origin: SITE } }), env);
assert.equal(pre.status, 204);
assert.equal((await submit(good, { path: '/other' })).status, 404);

fake.close();
console.log('Все проверки сервера отзывов прошли');
