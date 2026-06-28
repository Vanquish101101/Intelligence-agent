import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { orchestrate } from '../orchestrator/index.js';
import { transcribeAndAnalyze } from '../agents/transcriber/index.js';
import { osintSearch, formatOsintReport } from '../agents/osint/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE  = path.join(__dirname, '../../../logs/bot.log');

function logToFile(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// LLM markdown → Telegram Markdown v1
function formatReport(text) {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^---+$/gm, '━━━━━━━━━━━━━━━━━━━━━')
    .replace(/!\[[^\]]*\]\([^\)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^\)]*\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escMd(text) {
  return String(text).replace(/[_*`[]/g, '\\$&');
}

// ──────────────────────────────────────────────────────
// Cost tracker — session in-memory (Supabase в v1.5)
// ──────────────────────────────────────────────────────
const sessionCosts = new Map(); // userId → { total, requests[] }

function trackCost(userId, cmd, cost_usd, tools = []) {
  if (!sessionCosts.has(userId)) {
    sessionCosts.set(userId, { total: 0, requests: [] });
  }
  const s = sessionCosts.get(userId);
  s.total = Math.round((s.total + cost_usd) * 10000) / 10000;
  s.requests.push({
    cmd,
    cost: cost_usd,
    tools,
    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  });
  if (s.requests.length > 30) s.requests.shift();
}

// ──────────────────────────────────────────────────────
// Keyboard & Settings
// ──────────────────────────────────────────────────────
const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: '/report' }],
      [{ text: '/trends' }, { text: '/search' }],
      [{ text: '/osint' },  { text: '/costs' }],
      [{ text: '/settings' }, { text: '/status' }],
    ],
    resize_keyboard: true,
    persistent: true,
  }
};

const ALLOWED_USER_ID = Number(process.env.TELEGRAM_ALLOWED_USER_ID);
logToFile(`Bot starting | ALLOWED_USER_ID=${ALLOWED_USER_ID} | TOKEN_SET=${!!process.env.TELEGRAM_BOT_TOKEN}`);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const userSettings = new Map();

function getSettings(userId) {
  if (!userSettings.has(userId)) {
    userSettings.set(userId, {
      topics:    ['маркетинг', 'крипта', 'партнёрки'],
      platforms: ['youtube', 'web'],
      depth:     'standard'
    });
  }
  return userSettings.get(userId);
}

// ──────────────────────────────────────────────────────
// Global error handler
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
  if (userId !== ALLOWED_USER_ID) return ctx.reply('⛔ Доступ запрещён.');
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
    `🕵 OSINT — разведка по никнейму, домену, компании\n` +
    `💡 Генерирую идеи для контента\n` +
    `🕸 Парсю любые страницы и сайты\n` +
    `🎙 Транскрибирую видео и анализирую хуки\n` +
    `💰 Показываю траты по каждому запросу\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `*Основные команды:*\n\n` +
    `📋 /report — полный разведывательный отчёт\n` +
    `🔍 /search — быстрый поиск по запросу\n` +
    `📈 /trends — анализ трендов по теме\n` +
    `🕵 /osint — разведка (никнейм, домен, персона)\n` +
    `💰 /costs — таблица трат за сессию\n` +
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
    `_Занимает 30–90 сек (standard) / 2–5 мин (deep)_\n\n` +
    `🔍 */search* запрос\n` +
    `Быстрый поиск с источниками через Perplexity.\n` +
    `_Пример:_ \`/search партнёрские программы 2026\`\n\n` +
    `📈 */trends* тема\n` +
    `Что сейчас в тренде по конкретной теме.\n` +
    `_Пример:_ \`/trends крипта\`\n\n` +
    `🕵 */osint* [тип] цель\n` +
    `OSINT-разведка по открытым источникам.\n` +
    `_Типы:_ \`username\` \`domain\` \`person\` \`company\` \`email\` \`phone\` \`ip\`\n` +
    `_Пример:_ \`/osint username vanquish101\`\n` +
    `_Пример:_ \`/osint domain vc.ru\`\n` +
    `_Пример:_ \`/osint person Иван Петров\`\n\n` +
    `💰 */costs*\n` +
    `Таблица трат по запросам за сессию.\n\n` +
    `🕷 */scrape* url\n` +
    `Спарсить страницу: \`/scrape https://vc.ru/marketing\`\n\n` +
    `🎙 */transcribe* url\n` +
    `Транскрибация аудио/видео (mp3/mp4 до 25MB)\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚙️ */settings* — текущие настройки\n` +
    `📌 */set_topics* тема1, тема2 — изменить темы\n` +
    `📱 */set_platforms* youtube, web — платформы\n` +
    `🔍 */set_depth* quick / standard / deep — глубина`,
    { parse_mode: 'Markdown', ...MAIN_KEYBOARD }
  );
});

// ──────────────────────────────────────────────────────
// /status
// ──────────────────────────────────────────────────────
bot.command('status', (ctx) => {
  const s   = getSettings(ctx.from.id);
  const cs  = sessionCosts.get(ctx.from.id);
  const spent = cs ? `$${cs.total.toFixed(4)}` : '$0.0000';
  ctx.reply(
    `🤖 *Статус агента*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🟢 *Онлайн* — версия 0.2.0 MVP\n\n` +
    `🔧 *Подключённые инструменты:*\n` +
    `  • 🔎 Perplexity — поиск и актуальные факты\n` +
    `  • 🕷 Firecrawl — парсинг сайтов\n` +
    `  • 📺 Apify — тренды YouTube\n` +
    `  • 🎙 Whisper — транскрибация аудио\n` +
    `  • 🕵 OSINT — разведка по открытым источникам\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚙️ *Твои настройки:*\n\n` +
    `📌 *Темы:* ${s.topics.join(' · ')}\n` +
    `📱 *Платформы:* ${s.platforms.join(' · ')}\n` +
    `🔍 *Глубина:* ${s.depth}${s.depth === 'deep' ? ' 🔬' : ''}\n\n` +
    `💰 *Потрачено за сессию:* ${spent}`,
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
    `🔍 *Глубина анализа:* ${s.depth}${s.depth === 'deep' ? ' 🔬' : ''}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `*Как изменить:*\n\n` +
    `📌 Темы: \`/set_topics маркетинг, крипта, арбитраж\`\n` +
    `📱 Платформы: \`/set_platforms youtube, web\`\n` +
    `🔍 Глубина:\n` +
    `  \`/set_depth quick\` — быстро (15–30 сек)\n` +
    `  \`/set_depth standard\` — стандарт (60–90 сек)\n` +
    `  \`/set_depth deep\` — 🔬 глубокий поиск (2–5 мин, sonar-pro + sonnet)`,
    { parse_mode: 'Markdown', ...MAIN_KEYBOARD }
  );
});

bot.command('set_topics', (ctx) => {
  const raw = ctx.message.text.replace('/set_topics', '').trim();
  if (!raw) return ctx.reply('📌 Укажи темы через запятую:\n`/set_topics маркетинг, крипта, арбитраж`', { parse_mode: 'Markdown' });
  const topics = raw.split(',').map(t => t.trim()).filter(Boolean);
  getSettings(ctx.from.id).topics = topics;
  ctx.reply(
    `✅ *Темы обновлены:*\n\n` + topics.map(t => `  • ${t}`).join('\n') + `\n\n_Следующий /report будет по этим темам_`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('set_platforms', (ctx) => {
  const raw = ctx.message.text.replace('/set_platforms', '').trim();
  if (!raw) return ctx.reply('📱 Доступные платформы: `youtube`, `web`\n`/set_platforms youtube, web`', { parse_mode: 'Markdown' });
  const platforms = raw.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
  getSettings(ctx.from.id).platforms = platforms;
  ctx.reply(`✅ *Платформы обновлены:*\n\n` + platforms.map(p => `  • ${p}`).join('\n'), { parse_mode: 'Markdown' });
});

bot.command('set_depth', (ctx) => {
  const raw = ctx.message.text.replace('/set_depth', '').trim().toLowerCase();
  if (!['quick', 'standard', 'deep'].includes(raw)) {
    return ctx.reply(
      `🔍 *Варианты глубины анализа:*\n\n` +
      `  • \`quick\` — ⚡ быстро (15–30 сек)\n` +
      `    Perplexity sonar + краткий отчёт\n\n` +
      `  • \`standard\` — 📊 стандарт (60–90 сек)\n` +
      `    Все инструменты + haiku\n\n` +
      `  • \`deep\` — 🔬 глубокий поиск (2–5 мин)\n` +
      `    Perplexity sonar-pro + sonnet + больше данных`,
      { parse_mode: 'Markdown' }
    );
  }
  getSettings(ctx.from.id).depth = raw;
  const labels = { quick: '⚡ быстро', standard: '📊 стандарт', deep: '🔬 глубокий поиск' };
  ctx.reply(`✅ *Глубина анализа:* ${labels[raw]}\n\n_Deepresearch режим ${raw === 'deep' ? 'включён' : 'выключен'}_`, { parse_mode: 'Markdown' });
});

// ──────────────────────────────────────────────────────
// /costs — таблица трат за сессию
// ──────────────────────────────────────────────────────
bot.command('costs', (ctx) => {
  const cs = sessionCosts.get(ctx.from.id);
  if (!cs || cs.requests.length === 0) {
    return ctx.reply('💰 *Траты за сессию:* $0.0000\n\n_Ни одного запроса ещё не выполнено_', { parse_mode: 'Markdown' });
  }

  const rows = cs.requests.slice(-15).map(r =>
    `${r.time}  ${r.cmd.padEnd(12)}  $${r.cost.toFixed(4)}`
  );

  ctx.reply(
    `💰 *Траты за сессию*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `\`\`\`\nВремя   Команда       Стоимость\n` +
    `────────────────────────────\n` +
    rows.join('\n') + `\n\`\`\`\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 *Итого:* $${cs.total.toFixed(4)}\n` +
    `📊 *Запросов:* ${cs.requests.length}\n\n` +
    `_Расчёт приблизительный. Уточняй в Perplexity / OpenRouter / Apify dashboards._`,
    { parse_mode: 'Markdown' }
  );
});

// ──────────────────────────────────────────────────────
// /report — полный отчёт
// ──────────────────────────────────────────────────────
bot.command('report', async (ctx) => {
  const s = getSettings(ctx.from.id);
  logToFile(`/report started for user=${ctx.from.id} topics=${s.topics.join(',')} depth=${s.depth}`);

  const depthLabel = { quick: '⚡ быстро', standard: '📊 стандарт', deep: '🔬 DEEP' }[s.depth] || s.depth;

  const statusMsg = await ctx.reply(
    `⏳ *Запускаю разведку...*\n\n` +
    `📌 *Темы:* ${s.topics.join(', ')}\n` +
    `📱 *Платформы:* ${s.platforms.join(', ')}\n` +
    `🔍 *Режим:* ${depthLabel}\n\n` +
    `_Займёт ${s.depth === 'deep' ? '2–5 минут' : '30–90 секунд'}_`,
    { parse_mode: 'Markdown' }
  );

  const edit = (text) =>
    ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, text, { parse_mode: 'Markdown' })
      .catch(e => logToFile(`editMsg error: ${e.message}`));

  try {
    await edit('🔭 *Собираю данные...*\n\nОпрашиваю Perplexity, Firecrawl, YouTube...');

    const result = await orchestrate({
      task_id:   `${ctx.from.id}_${Date.now()}`,
      user_id:   ctx.from.id,
      type:      'report',
      topics:    s.topics,
      platforms: s.platforms,
      depth:     s.depth
    });

    logToFile(`/report done: ${result.meta.duration_sec}s cost=$${result.meta.cost_usd} tools=${result.meta.tools_used.join(',')}`);
    trackCost(ctx.from.id, '/report', result.meta.cost_usd, result.meta.tools_used);

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    const report  = formatReport(result.report);
    const errNote = result.meta.errors.length
      ? `\n⚠️ _Недоступно: ${result.meta.errors.map(e => e.split(':')[0]).join(', ')}_`
      : '';
    const meta = `\n\n_⏱ ${result.meta.duration_sec}с · 💰 ~$${result.meta.cost_usd.toFixed(4)} · ${result.meta.tools_used.slice(0, 4).join(', ')}${errNote}_`;

    const fullText = report + meta;

    if (fullText.length <= 4096) {
      await ctx.reply(fullText, { parse_mode: 'Markdown' });
    } else {
      const chunks = chunkText(report, 3900);
      for (let i = 0; i < chunks.length; i++) {
        await ctx.reply(chunks[i] + (i === chunks.length - 1 ? meta : ''), { parse_mode: 'Markdown' });
      }
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
  if (!topic) return ctx.reply('📈 Укажи тему:\n`/trends крипта`\n`/trends TikTok маркетинг`', { parse_mode: 'Markdown' });

  const statusMsg = await ctx.reply(`📈 _Анализирую тренды:_ *${escMd(topic)}*...`, { parse_mode: 'Markdown' });

  try {
    const result = await orchestrate({
      task_id:   `${ctx.from.id}_${Date.now()}`,
      user_id:   ctx.from.id,
      type:      'trends',
      topics:    [topic],
      platforms: ['youtube', 'web'],
      depth:     'quick'
    });

    trackCost(ctx.from.id, '/trends', result.meta.cost_usd, result.meta.tools_used);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    const report = formatReport(result.report);
    await ctx.reply(
      report + `\n\n_⏱ ${result.meta.duration_sec}с · 💰 ~$${result.meta.cost_usd.toFixed(4)}_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logToFile(`/trends ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Ошибка: ${err.message}`).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// /search
// ──────────────────────────────────────────────────────
bot.command('search', async (ctx) => {
  const query = ctx.message.text.replace('/search', '').trim();
  if (!query) return ctx.reply('🔍 Укажи запрос:\n`/search партнёрки 2026`\n`/search YouTube монетизация`', { parse_mode: 'Markdown' });

  const statusMsg = await ctx.reply(`🔍 _Ищу:_ *${escMd(query)}*...`, { parse_mode: 'Markdown' });

  try {
    const { answer, cost } = await perplexitySearch(query, 700);
    trackCost(ctx.from.id, '/search', cost);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(
      `🔍 *${escMd(query)}*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n${formatReport(answer)}\n\n_💰 ~$${cost.toFixed(4)}_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logToFile(`/search ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Ошибка: ${err.message}`).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// /osint — OSINT разведка
// ──────────────────────────────────────────────────────
bot.command('osint', async (ctx) => {
  const args = ctx.message.text.replace('/osint', '').trim();

  if (!args) {
    return ctx.reply(
      `🕵 *OSINT — разведка по открытым источникам*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `*Использование:* \`/osint [тип] цель\`\n\n` +
      `*Типы разведки:*\n` +
      `  👤 \`username\` — поиск никнейма в соцсетях\n` +
      `  🌐 \`domain\` — анализ домена/сайта\n` +
      `  👤 \`person\` — поиск по имени\n` +
      `  🏢 \`company\` — анализ компании\n` +
      `  📧 \`email\` — разведка по email\n` +
      `  📱 \`phone\` — анализ телефона\n` +
      `  🔌 \`ip\` — анализ IP-адреса\n\n` +
      `*Примеры:*\n` +
      `  \`/osint username vanquish101\`\n` +
      `  \`/osint domain vc.ru\`\n` +
      `  \`/osint person Иван Петров\`\n` +
      `  \`/osint company Яндекс\`\n\n` +
      `_Использует Perplexity sonar-pro + Firecrawl. ~$0.012–0.015 за запрос._`,
      { parse_mode: 'Markdown' }
    );
  }

  // Parse: first word may be type, rest is target
  const TYPES = ['username', 'domain', 'person', 'company', 'email', 'phone', 'ip'];
  const parts  = args.split(' ');
  let type, target;

  if (TYPES.includes(parts[0].toLowerCase())) {
    type   = parts[0].toLowerCase();
    target = parts.slice(1).join(' ').trim();
  } else {
    type   = 'person';
    target = args;
  }

  if (!target) {
    return ctx.reply(`❓ Укажи цель для разведки. Пример: \`/osint username vanquish101\``, { parse_mode: 'Markdown' });
  }

  logToFile(`/osint type=${type} target="${target}"`);
  const statusMsg = await ctx.reply(
    `🕵 _OSINT разведка..._\n\n*Тип:* ${type}\n*Цель:* \`${escMd(target)}\`\n\n_Занимает 20–60 секунд_`,
    { parse_mode: 'Markdown' }
  );

  try {
    const result = await osintSearch(target, type);
    trackCost(ctx.from.id, `/osint ${type}`, result.cost_usd, result.tools_used);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    const report = formatOsintReport(result);

    if (report.length <= 4096) {
      await ctx.reply(report, { parse_mode: 'Markdown' });
    } else {
      const chunks = chunkText(report, 3900);
      for (const chunk of chunks) await ctx.reply(chunk, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    logToFile(`/osint ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ OSINT ошибка: ${err.message}`).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// /scrape
// ──────────────────────────────────────────────────────
bot.command('scrape', async (ctx) => {
  const url = ctx.message.text.replace('/scrape', '').trim();
  if (!url) return ctx.reply('🕷 Укажи URL:\n`/scrape https://vc.ru/marketing`', { parse_mode: 'Markdown' });

  const statusMsg = await ctx.reply(`🕷 _Парсю страницу..._`);

  try {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'] })
    });
    if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
    const data = await response.json();

    const raw = data.data?.markdown || 'Нет данных';
    const content = raw.replace(/!\[[^\]]*\]\([^\)]*\)/g, '').replace(/\[([^\]]*)\]\([^\)]*\)/g, '$1').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1800);

    const cost = 0.001;
    trackCost(ctx.from.id, '/scrape', cost);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(
      `📄 *Содержимое страницы*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n${content}\n\n_💰 ~$${cost.toFixed(4)}_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logToFile(`/scrape ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Ошибка: ${err.message}`).catch(() => {});
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
    const cost   = 0.010; // Whisper ~$0.006/min + LLM analysis
    trackCost(ctx.from.id, '/transcribe', cost);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    const preview = result.transcript.slice(0, 600);
    await ctx.reply(
      `🎙 *Транскрипт*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${preview}${result.transcript.length > 600 ? '...' : ''}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🧠 *Анализ хуков и структуры:*\n\n` +
      `${formatReport(result.analysis)}\n\n` +
      `_💰 ~$${cost.toFixed(4)}_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logToFile(`/transcribe ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Ошибка: ${err.message}`).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// Plain text → Perplexity
// ──────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  logToFile(`Plain text query: "${text.slice(0, 80)}"`);
  const statusMsg = await ctx.reply(`🔍 _Ищу ответ на твой вопрос..._`, { parse_mode: 'Markdown' });

  try {
    const { answer, cost } = await perplexitySearch(text, 700);
    trackCost(ctx.from.id, 'текстовый', cost);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(
      `💬 *Ответ:*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n${formatReport(answer)}\n\n_💰 ~$${cost.toFixed(4)}_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logToFile(`text handler ERROR: ${err.message}`);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ Ошибка: ${err.message}`).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────
async function perplexitySearch(query, maxTokens = 700) {
  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: query }], max_tokens: maxTokens })
  });
  if (!response.ok) throw new Error(`Perplexity HTTP ${response.status}`);
  const data = await response.json();
  return {
    answer: data.choices?.[0]?.message?.content || 'Нет ответа',
    cost:   0.003
  };
}

function chunkText(text, maxLen) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start) end = nl;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

// ──────────────────────────────────────────────────────
// Commands menu
// ──────────────────────────────────────────────────────
async function registerCommands() {
  await bot.telegram.setMyCommands([
    { command: 'report',      description: '📊 Полный разведывательный отчёт' },
    { command: 'trends',      description: '📈 Тренды по теме — /trends крипта' },
    { command: 'search',      description: '🔍 Быстрый поиск — /search запрос' },
    { command: 'osint',       description: '🕵 OSINT разведка — /osint domain vc.ru' },
    { command: 'costs',       description: '💰 Таблица трат за сессию' },
    { command: 'scrape',      description: '🕷 Парсинг страницы — /scrape url' },
    { command: 'transcribe',  description: '🎙 Транскрибация — /transcribe url' },
    { command: 'settings',    description: '⚙️ Настройки мониторинга' },
    { command: 'set_depth',   description: '🔬 Глубина: quick / standard / deep' },
    { command: 'status',      description: '🤖 Статус агента' },
    { command: 'help',        description: '❓ Справка по командам' },
  ]).catch(e => logToFile(`setMyCommands error: ${e.message}`));
  logToFile('Commands menu registered');
}

// ──────────────────────────────────────────────────────
// Launch
// ──────────────────────────────────────────────────────
logToFile('Calling bot.launch()...');

await registerCommands();

bot.launch()
  .then(() => logToFile('Bot stopped'))
  .catch(err => logToFile(`bot.launch ERROR: ${err.message}`));

logToFile('Bot polling started');

process.once('SIGINT',  () => { logToFile('SIGINT — stopping bot');  bot.stop('SIGINT');  });
process.once('SIGTERM', () => { logToFile('SIGTERM — stopping bot'); bot.stop('SIGTERM'); });
