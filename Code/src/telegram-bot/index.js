import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { orchestrate } from '../orchestrator/index.js';
import { transcribeAndAnalyze } from '../agents/transcriber/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, '../../../logs/bot.log');

function logToFile(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// Конвертирует LLM-markdown в Telegram Markdown v1
// LLM пишет **bold** и ## заголовки — они не работают в Telegram v1
function formatReport(text) {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')           // **bold** → *bold*
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')          // ## Заголовок → *Заголовок*
    .replace(/^---+$/gm, '━━━━━━━━━━━━━━━━━━━━━')  // --- → разделитель
    .replace(/!\[[^\]]*\]\([^\)]*\)/g, '')           // убрать ![]() картинки
    .replace(/\[([^\]]*)\]\([^\)]*\)/g, '$1')        // [текст](url) → текст
    .replace(/\n{3,}/g, '\n\n')                      // не более 2 пустых строк
    .trim();
}

// Экранирование для Telegram Markdown v1 — только _ * ` [
function escMd(text) {
  return String(text).replace(/[_*`[]/g, '\\$&');
}

// Главное меню-клавиатура — команды роутятся напрямую
const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: '/report' }],
      [{ text: '/trends' }, { text: '/search' }],
      [{ text: '/settings' }, { text: '/status' }],
    ],
    resize_keyboard: true,
    persistent: true,
  }
};

const ALLOWED_USER_ID = Number(process.env.TELEGRAM_ALLOWED_USER_ID);
logToFile(`Bot starting | ALLOWED_USER_ID=${ALLOWED_USER_ID} | TOKEN_SET=${!!process.env.TELEGRAM_BOT_TOKEN}`);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// In-memory настройки (Supabase в v1.5)
const userSettings = new Map();

function getSettings(userId) {
  if (!userSettings.has(userId)) {
    userSettings.set(userId, {
      topics: ['маркетинг', 'крипта', 'партнёрки'],
      platforms: ['youtube', 'web'],
      depth: 'standard'
    });
  }
  return userSettings.get(userId);
}

// ──────────────────────────────────────────────────────
// Глобальный обработчик ошибок
// ──────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  logToFile(`ERROR in handler [${ctx?.updateType}]: ${err.message}\n${err.stack}`);
  ctx?.reply('❌ Внутренняя ошибка агента. Попробуй ещё раз.').catch(() => {});
});

// ──────────────────────────────────────────────────────
// Auth middleware
// ──────────────────────────────────────────────────────
bot.use((ctx, next) => {
  const userId = ctx.from?.id;
  logToFile(`UPDATE user=${userId} type=${ctx.updateType} text="${ctx.message?.text?.slice(0, 50) || ''}"`);
  if (userId !== ALLOWED_USER_ID) {
    return ctx.reply('⛔ Доступ запрещён.');
  }
  return next();
});

// ──────────────────────────────────────────────────────
// /start
// ──────────────────────────────────────────────────────
bot.start((ctx) => {
  ctx.reply(
    `👁 *Intelligence Agent* запущен\n` +
    `_Твой личный онлайн-разведчик_\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `*Что умею:*\n\n` +
    `🔭 Слежу за трендами — YouTube, TikTok, Web\n` +
    `📊 Строю отчёты о том, что сейчас залетает\n` +
    `💡 Генерирую идеи для контента\n` +
    `🕵 Парсю любые страницы и сайты\n` +
    `🎙 Транскрибирую видео и анализирую хуки\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `*Основные команды:*\n\n` +
    `📋 /report — полный разведывательный отчёт\n` +
    `🔍 /search — быстрый поиск по запросу\n` +
    `📈 /trends — анализ трендов по теме\n` +
    `🕷 /scrape — парсинг страницы по URL\n` +
    `🎙 /transcribe — транскрибация аудио\n` +
    `⚙️ /settings — настройки мониторинга\n\n` +
    `_Или просто напиши свой вопрос_ 👇`,
    { parse_mode: 'Markdown', ...MAIN_KEYBOARD }
  );
});

// ──────────────────────────────────────────────────────
// /help
// ──────────────────────────────────────────────────────
bot.command('help', (ctx) => {
  ctx.reply(
    `❓ *Справка — Intelligence Agent*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📋 */report*\n` +
    `Полный разведывательный отчёт по твоим темам.\n` +
    `_Перебирает YouTube, веб, новости — занимает 30–90 сек._\n\n` +
    `🔍 */search* запрос\n` +
    `Быстрый поиск с источниками через Perplexity.\n` +
    `_Пример:_ \`/search партнёрские программы 2026\`\n\n` +
    `📈 */trends* тема\n` +
    `Что сейчас в тренде по конкретной теме.\n` +
    `_Пример:_ \`/trends крипта\`\n\n` +
    `🕷 */scrape* url\n` +
    `Спарсить страницу и вернуть её текст.\n` +
    `_Пример:_ \`/scrape https://vc.ru/marketing\`\n\n` +
    `🎙 */transcribe* url\n` +
    `Транскрибировать видео или аудио файл.\n` +
    `_Прямая ссылка на mp3/mp4, до 25MB_\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚙️ */settings* — текущие настройки\n` +
    `📌 */set_topics* тема1, тема2 — изменить темы\n` +
    `📱 */set_platforms* youtube, web — платформы\n` +
    `🔍 */set_depth* quick или standard — глубина`,
    { parse_mode: 'Markdown', ...MAIN_KEYBOARD }
  );
});

// ──────────────────────────────────────────────────────
// /status
// ──────────────────────────────────────────────────────
bot.command('status', (ctx) => {
  const s = getSettings(ctx.from.id);
  ctx.reply(
    `🤖 *Статус агента*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🟢 *Онлайн* — версия 0.1.0 MVP\n\n` +
    `🔧 *Подключённые инструменты:*\n` +
    `  • 🔎 Perplexity — поиск и актуальные факты\n` +
    `  • 🕷 Firecrawl — парсинг сайтов\n` +
    `  • 📺 Apify — тренды YouTube\n` +
    `  • 🎙 Whisper — транскрибация аудио\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚙️ *Твои настройки:*\n\n` +
    `📌 *Темы:* ${s.topics.join(' · ')}\n` +
    `📱 *Платформы:* ${s.platforms.join(' · ')}\n` +
    `🔍 *Глубина:* ${s.depth}`,
    { parse_mode: 'Markdown', ...MAIN_KEYBOARD }
  );
});

// ──────────────────────────────────────────────────────
// /settings
// ──────────────────────────────────────────────────────
bot.command('settings', (ctx) => {
  const s = getSettings(ctx.from.id);
  ctx.reply(
    `⚙️ *Настройки мониторинга*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📌 *Темы для отслеживания:*\n` +
    s.topics.map(t => `  • ${t}`).join('\n') + '\n\n' +
    `📱 *Платформы:*\n` +
    s.platforms.map(p => `  • ${p}`).join('\n') + '\n\n' +
    `🔍 *Глубина анализа:* ${s.depth}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `*Как изменить:*\n\n` +
    `📌 Темы: \`/set_topics маркетинг, крипта, арбитраж\`\n` +
    `📱 Платформы: \`/set_platforms youtube, web\`\n` +
    `🔍 Глубина: \`/set_depth quick\` или \`/set_depth standard\``,
    { parse_mode: 'Markdown', ...MAIN_KEYBOARD }
  );
});

// /set_topics
bot.command('set_topics', (ctx) => {
  const raw = ctx.message.text.replace('/set_topics', '').trim();
  if (!raw) return ctx.reply(
    '📌 Укажи темы через запятую:\n`/set_topics маркетинг, крипта, арбитраж`',
    { parse_mode: 'Markdown' }
  );
  const topics = raw.split(',').map(t => t.trim()).filter(Boolean);
  getSettings(ctx.from.id).topics = topics;
  ctx.reply(
    `✅ *Темы обновлены:*\n\n` +
    topics.map(t => `  • ${t}`).join('\n') +
    `\n\n_Следующий /report будет по этим темам_`,
    { parse_mode: 'Markdown' }
  );
});

// /set_platforms
bot.command('set_platforms', (ctx) => {
  const raw = ctx.message.text.replace('/set_platforms', '').trim();
  if (!raw) return ctx.reply(
    '📱 Доступные платформы: `youtube`, `web`\n`/set_platforms youtube, web`',
    { parse_mode: 'Markdown' }
  );
  const platforms = raw.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
  getSettings(ctx.from.id).platforms = platforms;
  ctx.reply(
    `✅ *Платформы обновлены:*\n\n` +
    platforms.map(p => `  • ${p}`).join('\n'),
    { parse_mode: 'Markdown' }
  );
});

// /set_depth
bot.command('set_depth', (ctx) => {
  const raw = ctx.message.text.replace('/set_depth', '').trim().toLowerCase();
  if (!['quick', 'standard'].includes(raw)) {
    return ctx.reply(
      '🔍 Варианты глубины:\n  • `quick` — быстро (15–30 сек)\n  • `standard` — подробно (60–90 сек)',
      { parse_mode: 'Markdown' }
    );
  }
  getSettings(ctx.from.id).depth = raw;
  ctx.reply(
    `✅ *Глубина анализа:* ${raw === 'quick' ? '⚡ быстро' : '🔬 подробно'}`,
    { parse_mode: 'Markdown' }
  );
});

// ──────────────────────────────────────────────────────
// /report — полный отчёт
// ──────────────────────────────────────────────────────
bot.command('report', async (ctx) => {
  const s = getSettings(ctx.from.id);
  logToFile(`/report started for user=${ctx.from.id} topics=${s.topics.join(',')}`);

  const statusMsg = await ctx.reply(
    `⏳ *Запускаю разведку...*\n\n` +
    `📌 *Темы:* ${s.topics.join(', ')}\n` +
    `📱 *Платформы:* ${s.platforms.join(', ')}\n\n` +
    `_Займёт 30–90 секунд_`,
    { parse_mode: 'Markdown' }
  );

  const edit = (text) =>
    ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, text, { parse_mode: 'Markdown' })
      .catch(e => logToFile(`editMsg error: ${e.message}`));

  try {
    await edit('🔭 *Собираю данные...*\n\nОпрашиваю Perplexity, Firecrawl, YouTube...');

    const result = await orchestrate({
      task_id: `${ctx.from.id}_${Date.now()}`,
      user_id: ctx.from.id,
      type: 'report',
      topics: s.topics,
      platforms: s.platforms,
      depth: s.depth
    });

    logToFile(`/report done: ${result.meta.duration_sec}s tools=${result.meta.tools_used.join(',')}`);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    const report = formatReport(result.report);

    const errNote = result.meta.errors.length
      ? `\n\n⚠️ _Недоступно: ${result.meta.errors.map(e => e.split(':')[0]).join(', ')}_`
      : '';
    const meta = `\n\n_⏱ ${result.meta.duration_sec}с · ${result.meta.tools_used.join(', ')}${errNote}_`;
    const fullText = report + meta;

    if (fullText.length <= 4096) {
      await ctx.reply(fullText, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(report.slice(0, 4000) + '...', { parse_mode: 'Markdown' });
      await ctx.reply(meta.trim(), { parse_mode: 'Markdown' });
    }
  } catch (err) {
    logToFile(`/report ERROR: ${err.message}\n${err.stack}`);
    await edit(`❌ *Ошибка при разведке*\n\n\`${err.message}\``).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// /trends
// ──────────────────────────────────────────────────────
bot.command('trends', async (ctx) => {
  const topic = ctx.message.text.replace('/trends', '').trim();
  if (!topic) return ctx.reply(
    '📈 Укажи тему:\n`/trends крипта`\n`/trends TikTok маркетинг`',
    { parse_mode: 'Markdown' }
  );

  const statusMsg = await ctx.reply(
    `📈 _Анализирую тренды:_ *${escMd(topic)}*...`,
    { parse_mode: 'Markdown' }
  );

  try {
    const result = await orchestrate({
      task_id: `${ctx.from.id}_${Date.now()}`,
      user_id: ctx.from.id,
      type: 'trends',
      topics: [topic],
      platforms: ['youtube', 'web'],
      depth: 'quick'
    });

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    const report = formatReport(result.report);
    await ctx.reply(
      report + `\n\n_⏱ ${result.meta.duration_sec}с_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logToFile(`/trends ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      `❌ Ошибка: ${err.message}`
    ).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// /search
// ──────────────────────────────────────────────────────
bot.command('search', async (ctx) => {
  const query = ctx.message.text.replace('/search', '').trim();
  if (!query) return ctx.reply(
    '🔍 Укажи запрос:\n`/search партнёрки 2026`\n`/search YouTube монетизация`',
    { parse_mode: 'Markdown' }
  );

  const statusMsg = await ctx.reply(
    `🔍 _Ищу:_ *${escMd(query)}*...`,
    { parse_mode: 'Markdown' }
  );

  try {
    const answer = await perplexitySearch(query, 700);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(
      `🔍 *${escMd(query)}*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n${formatReport(answer)}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logToFile(`/search ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      `❌ Ошибка: ${err.message}`
    ).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// /scrape
// ──────────────────────────────────────────────────────
bot.command('scrape', async (ctx) => {
  const url = ctx.message.text.replace('/scrape', '').trim();
  if (!url) return ctx.reply(
    '🕷 Укажи URL:\n`/scrape https://vc.ru/marketing`',
    { parse_mode: 'Markdown' }
  );

  const statusMsg = await ctx.reply(`🕷 _Парсю страницу..._`);

  try {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url, formats: ['markdown'] })
    });
    if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
    const data = await response.json();

    const raw = data.data?.markdown || 'Нет данных';
    const content = raw
      .replace(/!\[[^\]]*\]\([^\)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^\)]*\)/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 1800);

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(
      `📄 *Содержимое страницы*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${content}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logToFile(`/scrape ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      `❌ Ошибка: ${err.message}`
    ).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// /transcribe
// ──────────────────────────────────────────────────────
bot.command('transcribe', async (ctx) => {
  const url = ctx.message.text.replace('/transcribe', '').trim();
  if (!url) return ctx.reply(
    '🎙 Укажи прямую ссылку на файл:\n`/transcribe https://example.com/file.mp3`\n\n_Поддерживаются mp3, mp4, wav до 25MB_',
    { parse_mode: 'Markdown' }
  );

  const statusMsg = await ctx.reply('🎙 _Транскрибирую... это займёт 1–2 минуты_', { parse_mode: 'Markdown' });

  try {
    const result = await transcribeAndAnalyze(url);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    const preview = result.transcript.slice(0, 600);
    await ctx.reply(
      `🎙 *Транскрипт*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${preview}${result.transcript.length > 600 ? '...' : ''}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🧠 *Анализ хуков и структуры:*\n\n` +
      `${formatReport(result.analysis)}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logToFile(`/transcribe ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      `❌ Ошибка: ${err.message}`
    ).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// Обычный текст → Perplexity
// ──────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  logToFile(`Plain text query: "${text.slice(0, 80)}"`);
  const statusMsg = await ctx.reply(
    `🔍 _Ищу ответ на твой вопрос..._`,
    { parse_mode: 'Markdown' }
  );

  try {
    const answer = await perplexitySearch(text, 700);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(
      `💬 *Ответ:*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n${formatReport(answer)}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logToFile(`text handler ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      `❌ Ошибка: ${err.message}`
    ).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// Утилиты
// ──────────────────────────────────────────────────────
async function perplexitySearch(query, maxTokens = 700) {
  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: query }],
      max_tokens: maxTokens
    })
  });
  if (!response.ok) throw new Error(`Perplexity HTTP ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || 'Нет ответа';
}

// ──────────────────────────────────────────────────────
// Команды меню Telegram (кнопка «/» в поле ввода)
// ──────────────────────────────────────────────────────
async function registerCommands() {
  await bot.telegram.setMyCommands([
    { command: 'report',      description: '📊 Полный разведывательный отчёт' },
    { command: 'trends',      description: '📈 Тренды по теме — /trends крипта' },
    { command: 'search',      description: '🔍 Быстрый поиск — /search запрос' },
    { command: 'scrape',      description: '🕷 Парсинг страницы — /scrape url' },
    { command: 'transcribe',  description: '🎙 Транскрибация — /transcribe url' },
    { command: 'settings',    description: '⚙️ Настройки мониторинга' },
    { command: 'status',      description: '🤖 Статус агента' },
    { command: 'help',        description: '❓ Справка по командам' },
  ]).catch(e => logToFile(`setMyCommands error: ${e.message}`));
  logToFile('Commands menu registered');
}

// ──────────────────────────────────────────────────────
// Запуск
// ──────────────────────────────────────────────────────
logToFile('Calling bot.launch()...');

await registerCommands();

bot.launch()
  .then(() => logToFile('Bot stopped'))
  .catch(err => logToFile(`bot.launch ERROR: ${err.message}`));

logToFile('Bot polling started');

process.once('SIGINT', () => { logToFile('SIGINT — stopping bot'); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { logToFile('SIGTERM — stopping bot'); bot.stop('SIGTERM'); });
