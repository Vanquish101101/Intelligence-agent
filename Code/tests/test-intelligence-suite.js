/**
 * Комплексный тест Intelligence Agent
 * Тестирует все 10 сценариев онлайн-разведки
 * Выводит результат в терминал + отправляет в Telegram
 */
import 'dotenv/config';
import { scout } from '../src/agents/scout/index.js';
import { orchestrate } from '../src/orchestrator/index.js';
import { transcribeAndAnalyze } from '../src/agents/transcriber/index.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALLOWED_USER_ID;
const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;
const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;

// ──────────────────────────────────────────────
// Telegram helpers
// ──────────────────────────────────────────────

// Для структурных сообщений с Markdown
async function tgMd(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: chunk, parse_mode: 'Markdown' })
    }).catch(e => { console.error('TG send error:', e.message); return null; });
    if (r && !r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error('TG Markdown error:', err.description, '— sending as plain');
      await tgPlain(chunk);
    }
    await delay(800);
  }
}

// Для контента из внешних источников — без parse_mode
async function tgPlain(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: chunk })
    }).catch(e => console.error('TG send error:', e.message));
    await delay(800);
  }
}

// Отправляет заголовок Markdown + контент plain text
async function tgResult(header, content) {
  await tgMd(header);
  if (content) await tgPlain(content);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function divider(char = '━', len = 40) { return char.repeat(len); }

// ──────────────────────────────────────────────
// Test runner
// ──────────────────────────────────────────────
const allResults = [];

async function runTest(num, name, fn) {
  const line = `\n${'═'.repeat(60)}\n🧪 ТЕСТ ${num}: ${name}\n${'═'.repeat(60)}`;
  console.log(line);

  const start = Date.now();
  try {
    const result = await fn();
    const sec = Math.round((Date.now() - start) / 1000);
    const preview = typeof result === 'string'
      ? result.slice(0, 600)
      : JSON.stringify(result, null, 2).slice(0, 600);

    console.log(`✅ УСПЕХ за ${sec}с`);
    console.log(preview);
    allResults.push({ num, name, status: '✅', sec, preview });
    return result;
  } catch (err) {
    const sec = Math.round((Date.now() - start) / 1000);
    console.log(`❌ ОШИБКА за ${sec}с: ${err.message}`);
    allResults.push({ num, name, status: '❌', sec, error: err.message });
    return null;
  }
}

// ──────────────────────────────────────────────
// Прямой вызов Perplexity
// ──────────────────────────────────────────────
async function perplexityDirect(query, maxTokens = 700) {
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PERPLEXITY_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: query }],
      max_tokens: maxTokens
    })
  });
  if (!r.ok) throw new Error(`Perplexity HTTP ${r.status}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content || 'нет ответа';
}

// ──────────────────────────────────────────────
// Прямой вызов Firecrawl Scrape
// ──────────────────────────────────────────────
async function firecrawlScrape(url) {
  const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${FIRECRAWL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: ['markdown'] })
  });
  if (!r.ok) throw new Error(`Firecrawl scrape HTTP ${r.status}`);
  const d = await r.json();
  return (d.data?.markdown || d.data?.content || 'пусто').slice(0, 800);
}

// ──────────────────────────────────────────────
// Прямой вызов Firecrawl Search
// ──────────────────────────────────────────────
async function firecrawlSearch(query) {
  const r = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${FIRECRAWL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: 4, scrapeOptions: { formats: ['markdown'] } })
  });
  if (!r.ok) throw new Error(`Firecrawl search HTTP ${r.status}`);
  const d = await r.json();
  const items = d.data || [];
  return items.map(i => `• ${i.title}\n  ${(i.markdown || i.description || '').slice(0, 250)}`).join('\n\n');
}

// ──────────────────────────────────────────────
// Apify YouTube прямо
// ──────────────────────────────────────────────
async function apifyYouTubeDirect(query) {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  const runR = await fetch(
    `https://api.apify.com/v2/acts/streamers~youtube-scraper/runs?token=${APIFY_TOKEN}&memory=256`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchQueries: [query], maxResults: 5, sortingOrder: 'relevance' })
    }
  );
  if (!runR.ok) throw new Error(`Apify start HTTP ${runR.status}`);
  const runData = await runR.json();
  const runId = runData.data?.id;
  if (!runId) throw new Error('No run ID');

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await delay(8000);
    const pollR = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    const pollD = await pollR.json();
    const status = pollD.data?.status;
    if (status === 'SUCCEEDED') {
      const dsId = pollD.data?.defaultDatasetId;
      const itemsR = await fetch(`https://api.apify.com/v2/datasets/${dsId}/items?token=${APIFY_TOKEN}&limit=5`);
      const items = await itemsR.json();
      return items.map(v => `• "${v.title}" | 👁 ${(v.viewCount||0).toLocaleString()} | ${v.channelName}`).join('\n');
    }
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new Error(`Apify actor ${status}`);
    console.log(`  [Apify] статус: ${status}...`);
  }
  throw new Error('Apify: timeout 120s');
}

// ──────────────────────────────────────────────
// MAIN — 10 тестов
// ──────────────────────────────────────────────
async function main() {
  const startAll = Date.now();

  console.log(`\n${'█'.repeat(60)}`);
  console.log('  INTELLIGENCE AGENT — ПОЛНЫЙ ТЕСТ (10 сценариев)');
  console.log(`${'█'.repeat(60)}\n`);

  await tgMd(
    `🧪 *ТЕСТ INTELLIGENCE AGENT*\n` +
    `_Запускаю 10 сценариев онлайн-разведки_\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Полные результаты появятся через 3-5 минут`
  );

  // ── ТЕСТ 1: Perplexity — партнёрки ──
  const t1 = await runTest(1, 'Perplexity: партнёрские программы крипта 2026',
    () => perplexityDirect('Топ партнёрские программы в крипте 2026 — какие комиссии, какие платформы, что сейчас работает?')
  );

  // ── ТЕСТ 2: Perplexity — YouTube тренды ──
  const t2 = await runTest(2, 'Perplexity: YouTube тренды маркетинг',
    () => perplexityDirect('Какие YouTube-видео по теме маркетинг и монетизация набирают больше всего просмотров в 2026? Конкретные темы и форматы.')
  );

  // ── ТЕСТ 3: Firecrawl — scrape страницы ──
  const t3 = await runTest(3, 'Firecrawl Scrape: vc.ru/marketing',
    () => firecrawlScrape('https://vc.ru/marketing')
  );

  // ── ТЕСТ 4: Firecrawl Search — арбитраж трафика ──
  const t4 = await runTest(4, 'Firecrawl Search: арбитраж трафика 2026',
    () => firecrawlSearch('арбитраж трафика топ схемы 2026')
  );

  // ── ТЕСТ 5: Apify YouTube ──
  const t5 = await runTest(5, 'Apify YouTube: крипто партнёрки (ждём до 120с)',
    () => apifyYouTubeDirect('crypto affiliate marketing 2026')
  );

  // ── ТЕСТ 6: Scout (все инструменты) ──
  const t6 = await runTest(6, 'Scout Agent: все инструменты — маркетинг + партнёрки',
    async () => {
      const r = await scout(['маркетинг', 'партнёрки'], ['youtube', 'web'], 'quick');
      return `Инструменты: ${r.tools_used.join(', ')}\nОшибки: ${r.errors.join(' | ') || 'нет'}\n` +
        `Perplexity: ${r.data.perplexity?.summary?.slice(0,300) || 'нет'}\n` +
        `YouTube videos: ${r.data['apify-youtube']?.length || 0}\n` +
        `Firecrawl items: ${r.data.firecrawl?.length || 0}`;
    }
  );

  // ── ТЕСТ 7: Orchestrator — полный отчёт ──
  const t7 = await runTest(7, 'Orchestrator: полный разведывательный отчёт',
    async () => {
      const r = await orchestrate({
        task_id: 'test_007', type: 'report',
        topics: ['маркетинг', 'крипта', 'партнёрки'],
        platforms: ['youtube', 'web'], depth: 'standard'
      });
      return `[${r.meta.duration_sec}с | ${r.meta.tools_used.join(',')} | errors: ${r.meta.errors.length}]\n\n${r.report}`;
    }
  );

  // ── ТЕСТ 8: Orchestrator — тренды TikTok ──
  const t8 = await runTest(8, 'Orchestrator: тренды TikTok маркетинг',
    async () => {
      const r = await orchestrate({
        task_id: 'test_008', type: 'trends',
        topics: ['TikTok маркетинг вирусный контент'],
        platforms: ['web'], depth: 'quick'
      });
      return `[${r.meta.duration_sec}с]\n\n${r.report}`;
    }
  );

  // ── ТЕСТ 9: Transcriber — аудио-транскрибация ──
  // Используем короткий публичный MP3 для теста
  const SAMPLE_AUDIO = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
  const t9 = await runTest(9, 'Transcriber: транскрибация аудио (Whisper)',
    () => transcribeAndAnalyze(SAMPLE_AUDIO, 'тест')
  );

  // ── ТЕСТ 10: Perplexity — монетизация контента (свободный текстовый запрос) ──
  const t10 = await runTest(10, 'Free text: монетизация YouTube-канала схемы 2026',
    () => perplexityDirect(
      'Как монетизировать YouTube-канал по маркетингу в 2026? Дай конкретные схемы: партнёрки, курсы, инфопродукты. Числа по доходу если есть.',
      800
    )
  );

  // ──────────────────────────────────────────────
  // СВОДНЫЙ ОТЧЁТ
  // ──────────────────────────────────────────────
  const totalSec = Math.round((Date.now() - startAll) / 1000);

  console.log(`\n${'█'.repeat(60)}`);
  console.log('  СВОДНЫЙ РЕЗУЛЬТАТ ТЕСТИРОВАНИЯ');
  console.log(`${'█'.repeat(60)}`);

  const ok = allResults.filter(r => r.status === '✅').length;
  const fail = allResults.filter(r => r.status === '❌').length;

  for (const r of allResults) {
    const err = r.error ? ` → ${r.error}` : '';
    console.log(`${r.status} Тест ${r.num} [${r.sec}с]: ${r.name}${err}`);
  }

  console.log(`\n📊 Итого: ${ok} успешно / ${fail} ошибок / ${totalSec}с`);

  // ──────────────────────────────────────────────
  // Отправка в Telegram
  // ──────────────────────────────────────────────
  console.log('\n📨 Отправляю результаты в Telegram...');

  // 1. Сводная таблица
  let summary = `🤖 *ОТЧЁТ ТЕСТИРОВАНИЯ INTELLIGENCE AGENT*\n`;
  summary += `_${new Date().toLocaleString('ru-RU')}_\n\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━\n`;
  summary += `*СВОДНАЯ ТАБЛИЦА ${ok} успешно / ${fail} ошибок*\n\n`;
  for (const r of allResults) {
    summary += `${r.status} *Тест ${r.num}* [${r.sec}с] ${r.name}\n`;
    if (r.error) summary += `   ↳ ${r.error.slice(0, 80)}\n`;
    summary += '\n';
  }
  summary += `━━━━━━━━━━━━━━━━━━━━━\n⏱ Время: ${totalSec}с`;
  await tgMd(summary);

  // 2. Тест 1 — Perplexity партнёрки
  await tgResult(
    `🔎 *ТЕСТ 1 — Perplexity: Партнёрки крипта*\n━━━━━━━━━━━━━━━━━━━━━`,
    t1 ? t1.slice(0, 1800) : '❌ Не выполнен'
  );

  // 3. Тест 2 — YouTube тренды
  await tgResult(
    `📺 *ТЕСТ 2 — Perplexity: YouTube тренды*\n━━━━━━━━━━━━━━━━━━━━━`,
    t2 ? t2.slice(0, 1800) : '❌ Не выполнен'
  );

  // 4. Тест 3 — Firecrawl scrape
  await tgResult(
    `🕷 *ТЕСТ 3 — Firecrawl Scrape: vc.ru/marketing*\n━━━━━━━━━━━━━━━━━━━━━`,
    t3 ? t3.slice(0, 1800) : '❌ Не выполнен'
  );

  // 5. Тест 4 — Firecrawl search
  await tgResult(
    `🔍 *ТЕСТ 4 — Firecrawl Search: Арбитраж трафика*\n━━━━━━━━━━━━━━━━━━━━━`,
    t4 ? t4.slice(0, 1800) : '❌ Не выполнен'
  );

  // 6. Тест 5 — Apify
  if (t5) {
    await tgResult(
      `📺 *ТЕСТ 5 — Apify YouTube: Крипто партнёрки*\n━━━━━━━━━━━━━━━━━━━━━`,
      t5.slice(0, 1800)
    );
  } else {
    const failR = allResults.find(r => r.num === 5);
    await tgMd(`❌ *ТЕСТ 5 — Apify YouTube*\n\n_Ошибка:_ ${failR?.error || 'timeout'}`);
  }

  // 7. Тест 6 — Scout summary
  await tgResult(
    `🕵 *ТЕСТ 6 — Scout Agent (все инструменты)*\n━━━━━━━━━━━━━━━━━━━━━`,
    t6 ? t6.slice(0, 1500) : '❌ Не выполнен'
  );

  // 8. Тест 7 — полный отчёт
  await tgResult(
    `📊 *ТЕСТ 7 — ПОЛНЫЙ РАЗВЕДЫВАТЕЛЬНЫЙ ОТЧЁТ*\n━━━━━━━━━━━━━━━━━━━━━`,
    t7 ? t7.slice(0, 3500) : '❌ Не выполнен'
  );

  // 9. Тест 8 — тренды TikTok
  await tgResult(
    `📈 *ТЕСТ 8 — Тренды: TikTok маркетинг*\n━━━━━━━━━━━━━━━━━━━━━`,
    t8 ? t8.slice(0, 1800) : '❌ Не выполнен'
  );

  // 10. Тест 9 — транскрибатор
  if (t9) {
    await tgMd(`🎙 *ТЕСТ 9 — Transcriber (Whisper)*\n━━━━━━━━━━━━━━━━━━━━━`);
    await tgPlain(`Транскрипт:\n${(t9.transcript || '').slice(0, 600)}\n\nАнализ хуков:\n${(t9.analysis || '').slice(0, 800)}`);
  } else {
    const failR = allResults.find(r => r.num === 9);
    await tgMd(`❌ *ТЕСТ 9 — Transcriber (Whisper)*\n\n_Ошибка:_ ${failR?.error || 'нет данных'}`);
  }

  // 11. Тест 10 — монетизация
  await tgResult(
    `💰 *ТЕСТ 10 — Монетизация YouTube 2026*\n━━━━━━━━━━━━━━━━━━━━━`,
    t10 ? t10.slice(0, 1800) : '❌ Не выполнен'
  );

  // Финальное сообщение
  const broken = allResults.filter(r => r.status === '❌');
  let finalMsg = `✅ *ТЕСТИРОВАНИЕ ЗАВЕРШЕНО*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
  if (broken.length === 0) {
    finalMsg += `🎉 Все ${ok} тестов прошли успешно!`;
  } else {
    finalMsg += `⚠️ *Требуют внимания (${broken.length}):*\n\n`;
    for (const r of broken) {
      finalMsg += `❌ Тест ${r.num}: ${r.name}\n↳ ${(r.error || '').slice(0, 120)}\n\n`;
    }
  }
  finalMsg += `\n⏱ Общее время: ${totalSec}с`;
  await tgMd(finalMsg);

  console.log('\n✅ Все результаты отправлены в Telegram');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
