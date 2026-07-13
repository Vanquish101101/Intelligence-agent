import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { orchestrate } from '../orchestrator/index.js';
import { transcribeAndAnalyze } from '../agents/transcriber/index.js';
import { osintSearch, formatOsintReport } from '../agents/osint/index.js';
import { getSettings, saveSettings, updateSetting } from '../db/userSettings.js';
import { redisConnect, getRedis } from '../db/redis.js';
import { getSupabase } from '../db/supabase.js';
import { notifyAgent4 } from '../handoff/agent4Handoff.js';
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

// Убирает все Markdown-символы для fallback-отправки
function stripMd(text) {
  return text.replace(/[*_`\[\]]/g, '');
}

function escMd(text) {
  return String(text).replace(/[_*`[]/g, '\\$&');
}

// Отправляет с Markdown, при 400-ошибке повторяет без форматирования
async function safeSend(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
  } catch (err) {
    if (err.response?.error_code === 400 || err.message?.includes('parse entities')) {
      logToFile(`Markdown parse error — retrying as plain text`);
      return ctx.reply(stripMd(text), extra);
    }
    throw err;
  }
}

// Редактирует сообщение с Markdown, при 400 — plain text, при других ошибках — отправляет новым сообщением
async function safeEdit(ctx, msgId, text) {
  try {
    return await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, { parse_mode: 'Markdown' });
  } catch (err) {
    if (err.response?.error_code === 400 || err.message?.includes('parse entities')) {
      return ctx.telegram.editMessageText(ctx.chat.id, msgId, null, stripMd(text)).catch(() => {});
    }
    logToFile(`editMsg error (falling back to new message): ${err.message}`);
    return safeSend(ctx, text);
  }
}

// Повторяет sendChatAction('typing') каждые 4 сек пока не остановлен
function keepTyping(ctx) {
  ctx.sendChatAction('typing').catch(() => {});
  const timer = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);
  return () => clearInterval(timer);
}

// ──────────────────────────────────────────────────────
// Cost tracker — session in-memory (Supabase в v1.5)
// ──────────────────────────────────────────────────────
const sessionCosts = new Map(); // userId → { total, requests[] }

// ──────────────────────────────────────────────────────
// Wizard state — content creation settings (in-memory)
// ──────────────────────────────────────────────────────
const wizardState = new Map(); // userId → { mode, step, use_trends, project, networks, content_type, format, style }

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
      [{ text: '/settings' }, { text: '/topics' }],
      [{ text: '/mode' }, { text: '/status' }],
    ],
    resize_keyboard: true,
    persistent: true,
  }
};

// Inline-клавиатура выбора режима (показывается при /start и /mode)
const MODE_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🔍 Получить информацию', callback_data: 'mode_info' },
        { text: '🎬 Создать контент',     callback_data: 'mode_content' },
      ],
      [
        { text: '🚀 Создать и опубликовать', callback_data: 'mode_publish' },
      ]
    ]
  }
};

// Меню выбора/переключения тем мониторинга (2026-07-13, по прямому запросу
// пользователя — раньше темы менялись только текстовой командой
// /set_topics, без визуального меню). Тот же паттерн toggle-кнопок с ✅/⬜,
// что и мультивыбор соцсетей у Content creation agent's wizard —
// перерисовка того же сообщения на каждый клик (editMessageReplyMarkup),
// без накопления новых сообщений в чате. Каталог — фиксированный список
// часто нужных тем; свободная тема, которой нет в списке, по-прежнему
// добавляется через /set_topics (кнопки его не заменяют, а дополняют).
const TOPIC_CATALOG = [
  'маркетинг',
  'инвестиции в РФ',
  'тренды и контент соцсетей',
  'крипта',
  'партнёрки',
  'арбитраж трафика',
];

function buildTopicsKeyboard(selected) {
  const mark = (topic) => (selected.includes(topic) ? '✅ ' : '⬜ ') + topic;
  const rows = [];
  for (let i = 0; i < TOPIC_CATALOG.length; i += 2) {
    const pair = TOPIC_CATALOG.slice(i, i + 2).map((topic) => ({
      text: mark(topic),
      callback_data: `topic_toggle_${TOPIC_CATALOG.indexOf(topic)}`
    }));
    rows.push(pair);
  }
  rows.push([{ text: '✅ Готово', callback_data: 'topic_done' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Wizard keyboards — 6-шаговый диалог настройки контента (шаг 1 — опора на
// тренды, добавлен 2026-07-10 по запросу пользователя: явный выбор вместо
// угадывания по свободному тексту описания, см. Content creation agent/
// Code/src/enrichment/enrichWithTrends.js).
const WIZARD_TRENDS_KB = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🔥 На основе трендов', callback_data: 'wiz_trends_yes' },
        { text: '📝 Просто по описанию', callback_data: 'wiz_trends_no' },
      ]
    ]
  }
};

// Мультивыбор сетей (2026-07-12, по прямому запросу пользователя — раньше
// можно было выбрать только одну сеть на весь запрос) — клавиатура строится
// динамически (buildNetworkKeyboard) и перерисовывается после каждого тычка,
// показывая ✅ у уже выбранных сетей; отдельная кнопка "Готово" завершает
// шаг, доступна только когда выбрана хотя бы одна сеть.
const NETWORK_CODES = ['instagram', 'youtube', 'tiktok', 'telegram', 'vk', 'whatsapp', 'ok'];

function buildNetworkKeyboard(selected) {
  const mark = (code) => (selected.includes(code) ? '✅ ' : '') + NETWORK_LABELS[code];
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: mark('instagram'), callback_data: 'wiz_nettoggle_instagram' },
          { text: mark('youtube'),   callback_data: 'wiz_nettoggle_youtube' },
          { text: mark('tiktok'),    callback_data: 'wiz_nettoggle_tiktok' },
        ],
        [
          { text: mark('telegram'), callback_data: 'wiz_nettoggle_telegram' },
          { text: mark('vk'),       callback_data: 'wiz_nettoggle_vk' },
          { text: mark('whatsapp'), callback_data: 'wiz_nettoggle_whatsapp' },
        ],
        [
          { text: mark('ok'), callback_data: 'wiz_nettoggle_ok' },
        ],
        [
          { text: selected.length ? `➡️ Готово (${selected.length})` : '➡️ Готово (выбери хотя бы одну)', callback_data: 'wiz_netdone' },
        ]
      ]
    }
  };
}

// Два PostMyPost-проекта на аккаунте (2026-07-12, по прямому указанию
// пользователя): "Marketing" (351825, реклама/маркетинг) и "Project CORE"
// (347765, личный информационный канал) — каждый со своими подключёнными
// соцсетями на стороне PostMyPost. Код проекта ('marketing'/'core') уходит
// в wizard.project, Агент 4 резолвит его в реальный numeric project_id
// (см. Content creation agent/Code/src/index.js).
const WIZARD_PROJECT_KB = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📢 Marketing',    callback_data: 'wiz_proj_marketing' },
        { text: '🏠 Project CORE', callback_data: 'wiz_proj_core' },
      ]
    ]
  }
};

const WIZARD_TYPE_KB = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📝 Пост',      callback_data: 'wiz_type_post' },
        { text: '🎬 Видео',     callback_data: 'wiz_type_video' },
        { text: '🖼 Фото',      callback_data: 'wiz_type_photo' },
      ],
      [
        { text: '🎵 Аудио',    callback_data: 'wiz_type_audio' },
        { text: '🎞 Reels',    callback_data: 'wiz_type_reels' },
        { text: '🧵 Карусель', callback_data: 'wiz_type_carousel' },
      ]
    ]
  }
};

const WIZARD_FORMAT_KB = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📱 9:16 вертикаль',   callback_data: 'wiz_fmt_916' },
        { text: '🖥 16:9 горизонталь', callback_data: 'wiz_fmt_169' },
      ],
      [
        { text: '⬜ 1:1 квадрат',     callback_data: 'wiz_fmt_11' },
        { text: '📄 4:5 портрет',      callback_data: 'wiz_fmt_45' },
        { text: '📝 Только текст',     callback_data: 'wiz_fmt_text' },
      ]
    ]
  }
};

const WIZARD_STYLE_KB = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🎓 Экспертный',      callback_data: 'wiz_style_expert' },
        { text: '😄 Развлекательный', callback_data: 'wiz_style_fun' },
      ],
      [
        { text: '📚 Образовательный', callback_data: 'wiz_style_edu' },
        { text: '💰 Продающий',       callback_data: 'wiz_style_sales' },
      ],
      [
        { text: '🔥 Провокационный',  callback_data: 'wiz_style_provo' },
        { text: '🤝 Нативный',        callback_data: 'wiz_style_native' },
      ]
    ]
  }
};

// Метки для отображения выборов wizard'а
const NETWORK_LABELS = {
  instagram: '📸 Instagram', youtube: '▶️ YouTube', tiktok: '🎵 TikTok',
  telegram: '✈️ Telegram',  vk: '🔵 ВКонтакте',   whatsapp: '💚 WhatsApp', ok: '👥 Одноклассники'
};
const PROJECT_LABELS = { marketing: '📢 Marketing', core: '🏠 Project CORE' };
const TYPE_LABELS = {
  post: '📝 Пост', video: '🎬 Видео',    photo: '🖼 Фото',
  audio: '🎵 Аудио', reels: '🎞 Reels', carousel: '🧵 Карусель'
};
const FORMAT_LABELS = {
  '916': '📱 9:16', '169': '🖥 16:9', '11': '⬜ 1:1', '45': '📄 4:5', 'text': '📝 Текст'
};
const STYLE_LABELS = {
  expert: '🎓 Экспертный', fun: '😄 Развлекательный', edu: '📚 Образовательный',
  sales: '💰 Продающий',   provo: '🔥 Провокационный', native: '🤝 Нативный'
};

const ALLOWED_USER_ID = Number(process.env.TELEGRAM_ALLOWED_USER_ID);
logToFile(`Bot starting | ALLOWED_USER_ID=${ALLOWED_USER_ID} | TOKEN_SET=${!!process.env.TELEGRAM_BOT_TOKEN}`);

// Подключаем Redis (non-blocking) и запускаем оба subscriber'а
redisConnect().then(() => {
  subscribeToAgent2Notifications();
  subscribeToAgent4Notifications();
}).catch(() => {});

// Слушаем канал notifications:agent1 — Агент 2 уведомляет о проблемах с передачей Агенту 3
async function subscribeToAgent2Notifications() {
  try {
    const sub = getRedis().duplicate();
    // Listeners must be added before connect() to avoid unhandled error events
    sub.on('error', (err) => logToFile(`[Redis sub] ${err.message}`));
    sub.on('message', (_channel, msg) => {
      try {
        // Агент 2 публикует поле "event" (см. Deep parsing agent/Code/src/queue/index.js
        // notifyAgent1), а не "type" — раньше здесь читалось несуществующее event.type,
        // из-за чего в логах всегда было "type=?", а пользователь вообще не узнавал о
        // деградации доставки Агенту 3 (уведомление только логировалось в файл).
        const payload = JSON.parse(msg);
        logToFile(`[Agent2→Agent1] notification: event=${payload.event || '?'} job=${payload.job_id || '?'}`);
        if (!Number.isFinite(ALLOWED_USER_ID)) return;
        if (Number.isFinite(payload.telegram_id) && payload.telegram_id !== ALLOWED_USER_ID) {
          logToFile(`[Agent2→Agent1] skipping event for telegram_id=${payload.telegram_id} (expected ${ALLOWED_USER_ID})`);
          return;
        }
        // payload.buffered добавлен Агентом 2 2026-07-10 (см. Deep parsing agent
        // /Code/src/router/index.js, ensureJobRow) — честный сигнал вместо
        // всегда-заявленного "данные не потеряны": раньше резервная запись в
        // agent3_handoff_queue сама могла молча провалиться (нарушение
        // внешнего ключа), а пользователь всё равно видел успокаивающий
        // текст. buffered===false — редкий, но реальный случай истинной
        // потери; buffered===true/undefined — обычный ожидаемый путь.
        const bufferNote = payload.buffered === false
          ? '⚠️ Резервная запись тоже не удалась — данные, скорее всего, потеряны. Нужна ручная проверка.'
          : 'Данные не потеряны — Агент 2 сохранил их в очередь, Агент 3 заберёт при следующем плановом опросе.';
        const text = `⚠️ Агент 2 сообщает о проблеме с передачей данных Агенту 3.\n\n` +
          `Job: ${payload.job_id || 'неизвестно'}\n` +
          `Причина: ${payload.reason || 'не указана'}\n\n` +
          bufferNote;
        bot.telegram.sendMessage(ALLOWED_USER_ID, text)
          .catch((err) => logToFile(`[Agent2→Agent1] failed to forward notification to Telegram: ${err.message}`));
      } catch {}
    });
    await sub.connect();
    await sub.subscribe('notifications:agent1');
    logToFile('[Redis] Subscribed to notifications:agent1');
  } catch (err) {
    logToFile(`[Redis] Agent2 subscribe failed (non-fatal): ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────
// Agent 4 → Agent 1 обратный канал
// Redis: notifications:agent1_from_agent4 (быстрый слой)
// Supabase: content_creation_agent.agent1_delivery_queue (надёжный catch-up)
// ──────────────────────────────────────────────────────

function formatPublishReport(report) {
  if (!report) return '';
  const arr = Array.isArray(report) ? report : [report];
  const lines = arr.map(r => {
    const icon = r.status === 'success' ? '✅' : '❌';
    const reasonStr = r.reason ? ` (${r.reason})` : '';
    return `  • ${r.network || '?'} — ${icon} ${r.status === 'success' ? 'Опубликовано' : 'Ошибка'}${reasonStr}`;
  });
  const notConfigured = arr.some(r => r.reason === 'PostMyPost not configured');
  const hint = notConfigured ? `\n_⚙️ Публикация не подключена — для активации обратитесь к администратору (нужны PostMyPost credentials)._` : '';
  return `📤 *Публикация:*\n${lines.join('\n')}${hint}\n\n`;
}

function formatAgent4Message(messageType, payload) {
  try {
    switch (messageType) {
      case 'content_ready': {
        // camelCase-поля как отправляет Агент 4 (contentType, sizeBytes, downloadUrl).
        // networks/project (2026-07-12) заменили одиночный network — мультивыбор сетей.
        const { project, networks, contentType, description, text, sizeBytes, costUsd, downloadUrl, publishReport } = payload;
        const sizeStr = sizeBytes ? ` (~${(sizeBytes / 1024).toFixed(0)} КБ)` : '';
        const costStr = costUsd  ? ` · $${Number(costUsd).toFixed(4)}` : '';
        const networksStr = Array.isArray(networks) && networks.length ? networks.join(', ') : '—';
        return (
          `🎬 *Контент готов!*\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📂 Проект: *${project || '—'}*\n` +
          `📱 Соцсети: *${networksStr}*\n` +
          `🎨 Тип: *${contentType || '—'}*\n` +
          `✏️ Описание: ${description ? description.slice(0, 200) : '—'}\n` +
          `📦 Размер:${sizeStr || ' —'}${costStr}\n\n` +
          (text ? `📝 *Текст контента:*\n${text.slice(0, 800)}${text.length > 800 ? '...' : ''}\n\n` : '') +
          (downloadUrl ? `🔗 [Скачать файл](${downloadUrl})\n\n` : '') +
          (publishReport ? formatPublishReport(publishReport) : '') +
          `━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `_Агент 4 сгенерировал контент по твоему wizard-запросу._`
        );
      }
      case 'quota_warning': {
        // Поля как отправляет Агент 4: totalUsageBytes, userUsageBytes, limitBytes, items[]
        const { totalUsageBytes, userUsageBytes, limitBytes, items = [] } = payload;
        const usedGb  = userUsageBytes  ? `${(userUsageBytes  / 1e9).toFixed(2)} ГБ` : '—';
        const limitGb = limitBytes      ? `${(limitBytes       / 1e9).toFixed(1)} ГБ` : '10 ГБ';
        const oldest  = items[0];
        return (
          `⚠️ *Хранилище Агента 4 почти заполнено*\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📊 Твои файлы: *${usedGb}* из ${limitGb}\n` +
          (totalUsageBytes ? `📦 Всего в bucket: ${(totalUsageBytes / 1e9).toFixed(2)} ГБ\n` : '') +
          (oldest ? `📅 Самый старый файл: ${new Date(oldest.created_at).toLocaleDateString('ru-RU')} (${oldest.type || '?'})\n` : '') +
          `\n_Агент 4 не может сохранить новый контент — хранилище R2 переполнено._\n\n` +
          `Нажми кнопку ниже, чтобы удалить самый старый файл и освободить место.`
        );
      }
      case 'moderation_request': {
        // downloadUrl — рабочая presigned-ссылка (добавлена Агентом 4); r2Url — внутренний ключ
        const { wizard, downloadUrl, r2Url } = payload;
        const netStr  = wizard?.networks?.length ? `📱 *${wizard.networks.join(', ')}*` : '';
        const typeStr = wizard?.content_type ? ` · ${wizard.content_type}` : '';
        return (
          `🛂 *Запрос на модерацию*\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `${netStr}${typeStr}\n` +
          (wizard?.description ? `✏️ ${wizard.description.slice(0, 200)}\n\n` : '\n') +
          (downloadUrl ? `🔗 [Просмотреть файл](${downloadUrl})\n\n` : (r2Url ? `🔗 R2: \`${r2Url}\`\n\n` : '')) +
          `_Контент сгенерирован. Подтверди или отклони публикацию:_`
        );
      }
      default:
        return (
          `📬 *Уведомление от Агента 4*\n\n` +
          `Тип: \`${messageType}\`\n\n` +
          `\`\`\`\n${JSON.stringify(payload, null, 2).slice(0, 400)}\n\`\`\``
        );
    }
  } catch {
    return `📬 Уведомление от Агента 4 (тип: ${messageType})`;
  }
}

function getAgent4Keyboard(messageType, payload) {
  try {
    if (messageType === 'quota_warning') {
      const contentId = payload?.items?.[0]?.id;
      if (!contentId) return null;
      return { inline_keyboard: [[
        { text: '✅ Удалить старое', callback_data: `cqa_qd_${contentId}` },
        { text: '❌ Отмена',         callback_data: `cqr_qd_${contentId}` },
      ]] };
    }
    if (messageType === 'moderation_request') {
      const contentId = payload?.generatedContentId;
      if (!contentId) return null;
      return { inline_keyboard: [[
        { text: '✅ Опубликовать', callback_data: `cqa_pm_${contentId}` },
        { text: '❌ Отклонить',    callback_data: `cqr_pm_${contentId}` },
      ]] };
    }
    return null;
  } catch { return null; }
}

async function sendAgent4MessageToUser(messageType, payload) {
  const text     = formatAgent4Message(messageType, payload);
  const keyboard = getAgent4Keyboard(messageType, payload);
  const extra    = { parse_mode: 'Markdown' };
  if (keyboard) extra.reply_markup = keyboard;
  try {
    await bot.telegram.sendMessage(ALLOWED_USER_ID, text, extra);
  } catch (err) {
    logToFile(`[Agent4→Agent1] Markdown send failed, retrying plain: ${err.message}`);
    const plainExtra = keyboard ? { reply_markup: keyboard } : {};
    await bot.telegram.sendMessage(ALLOWED_USER_ID, stripMd(text), plainExtra)
      .catch((e) => logToFile(`[Agent4→Agent1] plain send also failed: ${e.message}`));
  }
}

async function subscribeToAgent4Notifications() {
  try {
    const sub = getRedis().duplicate();
    sub.on('error', (err) => logToFile(`[Redis sub agent4] ${err.message}`));
    sub.on('message', (_channel, msg) => {
      try {
        const envelope = JSON.parse(msg);
        // Агент 4 шлёт обёртку {event, telegram_id, message_type, timestamp, payload, queue_id}
        // payload — реальные данные; раньше сюда передавался весь envelope и поля не совпадали
        logToFile(`[Agent4→Agent1] redis event=${envelope.event || '?'} type=${envelope.message_type} tid=${envelope.telegram_id}`);
        const eventTid = Number(envelope.telegram_id);
        if (!Number.isFinite(ALLOWED_USER_ID) || eventTid !== ALLOWED_USER_ID) {
          logToFile(`[Agent4→Agent1] skipping event for telegram_id=${eventTid} (expected ${ALLOWED_USER_ID})`);
          return;
        }
        sendAgent4MessageToUser(envelope.message_type, envelope.payload ?? {})
          .catch((e) => logToFile(`[Agent4→Agent1] send failed: ${e.message}`));
      } catch {}
    });
    await sub.connect();
    await sub.subscribe('notifications:agent1_from_agent4');
    logToFile('[Redis] Subscribed to notifications:agent1_from_agent4');
  } catch (err) {
    logToFile(`[Redis] Agent4 subscribe failed (non-fatal): ${err.message}`);
  }
}

// catch-up: сюда попадают сообщения, пропущенные Redis-слоем (перезапуск бота и т.п.)
// Читает только items старше 5 минут, чтобы не дублировать доставку Redis-пути
const _deliveredAgent4Ids = new Set();

async function pollAgent4DeliveryQueue() {
  try {
    const db = getSupabase();
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await db
      .schema('content_creation_agent')
      .from('agent1_delivery_queue')
      .select('id, telegram_id, message_type, payload')
      .eq('status', 'pending')
      .lt('created_at', cutoff)
      .limit(10);

    if (error) { logToFile(`[Agent4 poll] ${error.message}`); return; }
    if (!data?.length) return;

    for (const item of data) {
      if (_deliveredAgent4Ids.has(item.id)) continue;
      _deliveredAgent4Ids.add(item.id);
      if (_deliveredAgent4Ids.size > 500) {
        _deliveredAgent4Ids.delete(_deliveredAgent4Ids.values().next().value);
      }

      if (Number.isFinite(ALLOWED_USER_ID)) {
        await sendAgent4MessageToUser(item.message_type, item.payload ?? {});
      }

      await db
        .schema('content_creation_agent')
        .from('agent1_delivery_queue')
        .update({ status: 'delivered', last_attempt_at: new Date().toISOString() })
        .eq('id', item.id);

      logToFile(`[Agent4 poll] delivered ${item.id} type=${item.message_type}`);
    }
  } catch (err) {
    logToFile(`[Agent4 poll] error: ${err.message}`);
  }
}

// Запускает 7-шаговый wizard настройки контента
async function startWizard(ctx, mode) {
  wizardState.set(ctx.from.id, { mode, step: 1, use_trends: null, project: null, networks: [], content_type: null, format: null, style: null });
  await safeSend(ctx,
    `🪄 *Настройка контента — Шаг 1 из 7*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🔥 *Опираться на актуальные тренды, или создать просто по описанию?*\n\n` +
    `_"На основе трендов" — Агент 1 и Агент 2 сначала найдут и разберут свежую информацию по теме, ` +
    `Агент 4 сгенерирует контент с её учётом (может занять пару минут). ` +
    `"Просто по описанию" — контент сразу по твоим настройкам, без обращения к другим агентам._`,
    WIZARD_TRENDS_KB
  );
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

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
bot.start(async (ctx) => {
  wizardState.delete(ctx.from.id); // сбрасываем незавершённый wizard при /start
  await ctx.reply(
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
  await ctx.reply(
    '━━━━━━━━━━━━━━━━━━━━━\n\n🎯 *Выбери режим работы:*',
    { parse_mode: 'Markdown', ...MODE_KEYBOARD }
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
bot.command('status', async (ctx) => {
  const s   = await getSettings(ctx.from.id);
  const cs  = sessionCosts.get(ctx.from.id);
  const spent = cs ? `$${cs.total.toFixed(4)}` : '$0.0000';
  ctx.reply(
    `🤖 *Статус агента*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🟢 *Онлайн* — версия 0.2.6\n\n` +
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
bot.command('settings', async (ctx) => {
  const s = await getSettings(ctx.from.id);
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
    `📌 Темы: команда /topics (меню) или \`/set_topics маркетинг, крипта, арбитраж\`\n` +
    `📱 Платформы: \`/set_platforms youtube, web\`\n` +
    `🔍 Глубина:\n` +
    `  \`/set_depth quick\` — быстро (15–30 сек)\n` +
    `  \`/set_depth standard\` — стандарт (60–90 сек)\n` +
    `  \`/set_depth deep\` — 🔬 глубокий поиск (2–5 мин, sonar-pro + sonnet)`,
    { parse_mode: 'Markdown', ...MAIN_KEYBOARD }
  );
});

bot.command('set_topics', async (ctx) => {
  const raw = ctx.message.text.replace('/set_topics', '').trim();
  if (!raw) return ctx.reply('📌 Укажи темы через запятую:\n`/set_topics маркетинг, крипта, арбитраж`', { parse_mode: 'Markdown' });
  const topics = raw.split(',').map(t => t.trim()).filter(Boolean);
  await updateSetting(ctx.from.id, 'topics', topics);
  ctx.reply(
    `✅ *Темы обновлены:*\n\n` + topics.map(t => `  • ${t}`).join('\n') + `\n\n_Следующий /report будет по этим темам_`,
    { parse_mode: 'Markdown' }
  );
});

// /topics — меню выбора/переключения тем (2026-07-13), альтернатива
// текстовой команде /set_topics для тем из фиксированного каталога.
bot.command('topics', async (ctx) => {
  const s = await getSettings(ctx.from.id);
  await ctx.reply(
    `📌 *Темы мониторинга*\n\n` +
    `Нажимай, чтобы включить/выключить тему, затем «Готово». ` +
    `Своей темы нет в списке? Добавь через \`/set_topics тема1, тема2\`.`,
    { parse_mode: 'Markdown', ...buildTopicsKeyboard(s.topics) }
  );
});

bot.action(/^topic_toggle_(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  const topic = TOPIC_CATALOG[idx];
  if (!topic) return ctx.answerCbQuery('⚠️ Неизвестная тема');

  const s = await getSettings(ctx.from.id);
  const current = s.topics ?? [];
  const updated = current.includes(topic)
    ? current.filter((t) => t !== topic)
    : [...current, topic];
  await updateSetting(ctx.from.id, 'topics', updated);

  await ctx.answerCbQuery(current.includes(topic) ? `⬜ ${topic}` : `✅ ${topic}`);
  await ctx.editMessageReplyMarkup(buildTopicsKeyboard(updated).reply_markup).catch(() => {});
});

bot.action('topic_done', async (ctx) => {
  const s = await getSettings(ctx.from.id);
  await ctx.answerCbQuery('✅ Сохранено');
  const label = (s.topics ?? []).length ? s.topics.join(' · ') : '(пусто — добавь через /set_topics)';
  await ctx.editMessageText(`📌 *Темы мониторинга сохранены:*\n\n${label}`, { parse_mode: 'Markdown' }).catch(() => {});
});

bot.command('set_platforms', async (ctx) => {
  const raw = ctx.message.text.replace('/set_platforms', '').trim();
  if (!raw) return ctx.reply('📱 Доступные платформы: `youtube`, `web`\n`/set_platforms youtube, web`', { parse_mode: 'Markdown' });
  const platforms = raw.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
  await updateSetting(ctx.from.id, 'platforms', platforms);
  ctx.reply(`✅ *Платформы обновлены:*\n\n` + platforms.map(p => `  • ${p}`).join('\n'), { parse_mode: 'Markdown' });
});

bot.command('set_depth', async (ctx) => {
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
  await updateSetting(ctx.from.id, 'depth', raw);
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
  const s = await getSettings(ctx.from.id);
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

  const edit = (text) => safeEdit(ctx, statusMsg.message_id, text);
  const stopTyping = keepTyping(ctx);

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

    stopTyping();
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
      await safeSend(ctx, fullText);
    } else {
      const chunks = chunkText(report, 3900);
      for (let i = 0; i < chunks.length; i++) {
        await safeSend(ctx, chunks[i] + (i === chunks.length - 1 ? meta : ''));
      }
    }
  } catch (err) {
    stopTyping();
    logToFile(`/report ERROR: ${err.message}\n${err.stack}`);
    await edit(`❌ *Ошибка при разведке*\n\n\`${err.message}\``);
  }
});

// ──────────────────────────────────────────────────────
// /trends
// ──────────────────────────────────────────────────────
bot.command('trends', async (ctx) => {
  const topic = ctx.message.text.replace('/trends', '').trim();
  if (!topic) return safeSend(ctx, '📈 Укажи тему:\n`/trends крипта`\n`/trends TikTok маркетинг`');

  const stopTyping = keepTyping(ctx);
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

    stopTyping();
    trackCost(ctx.from.id, '/trends', result.meta.cost_usd, result.meta.tools_used);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await safeSend(ctx,
      formatReport(result.report) + `\n\n_⏱ ${result.meta.duration_sec}с · 💰 ~$${result.meta.cost_usd.toFixed(4)}_`
    );
  } catch (err) {
    stopTyping();
    logToFile(`/trends ERROR: ${err.message}`);
    await safeEdit(ctx, statusMsg.message_id, `❌ Ошибка: ${err.message}`);
  }
});

// ──────────────────────────────────────────────────────
// /search
// ──────────────────────────────────────────────────────
bot.command('search', async (ctx) => {
  const query = ctx.message.text.replace('/search', '').trim();
  if (!query) return safeSend(ctx, '🔍 Укажи запрос:\n`/search партнёрки 2026`\n`/search YouTube монетизация`');

  const stopTyping = keepTyping(ctx);
  const statusMsg = await ctx.reply(`🔍 _Ищу:_ *${escMd(query)}*...`, { parse_mode: 'Markdown' });

  try {
    const { answer, cost } = await perplexitySearch(query, 700);
    stopTyping();
    trackCost(ctx.from.id, '/search', cost);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await safeSend(ctx,
      `🔍 *${escMd(query)}*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n${formatReport(answer)}\n\n_💰 ~$${cost.toFixed(4)}_`
    );
  } catch (err) {
    stopTyping();
    logToFile(`/search ERROR: ${err.message}`);
    await safeEdit(ctx, statusMsg.message_id, `❌ Ошибка: ${err.message}`);
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
  const stopTyping = keepTyping(ctx);
  const statusMsg = await ctx.reply(
    `🕵 _OSINT разведка..._\n\n*Тип:* ${type}\n*Цель:* \`${escMd(target)}\`\n\n_Занимает 20–60 секунд_`,
    { parse_mode: 'Markdown' }
  );

  try {
    const result = await osintSearch(target, type);
    stopTyping();
    trackCost(ctx.from.id, `/osint ${type}`, result.cost_usd, result.tools_used);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    const report = formatOsintReport(result);

    if (report.length <= 4096) {
      await safeSend(ctx, report);
    } else {
      const chunks = chunkText(report, 3900);
      for (const chunk of chunks) await safeSend(ctx, chunk);
    }
  } catch (err) {
    stopTyping();
    logToFile(`/osint ERROR: ${err.message}`);
    await safeEdit(ctx, statusMsg.message_id, `❌ OSINT ошибка: ${err.message}`);
  }
});

// ──────────────────────────────────────────────────────
// /scrape
// ──────────────────────────────────────────────────────
bot.command('scrape', async (ctx) => {
  const url = ctx.message.text.replace('/scrape', '').trim();
  if (!url) return ctx.reply('🕷 Укажи URL:\n`/scrape https://vc.ru/marketing`', { parse_mode: 'Markdown' });

  const stopTyping = keepTyping(ctx);
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

    stopTyping();
    const cost = 0.001;
    trackCost(ctx.from.id, '/scrape', cost);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await safeSend(ctx,
      `📄 *Содержимое страницы*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n${content}\n\n_💰 ~$${cost.toFixed(4)}_`
    );
  } catch (err) {
    stopTyping();
    logToFile(`/scrape ERROR: ${err.message}`);
    await safeEdit(ctx, statusMsg.message_id, `❌ Ошибка: ${err.message}`);
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

  const stopTyping = keepTyping(ctx);
  const statusMsg = await ctx.reply('🎙 _Транскрибирую... это займёт 1–2 минуты_', { parse_mode: 'Markdown' });

  try {
    const result = await transcribeAndAnalyze(url);
    stopTyping();
    const cost = 0.010;
    trackCost(ctx.from.id, '/transcribe', cost);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    const preview = result.transcript.slice(0, 600);
    await safeSend(ctx,
      `🎙 *Транскрипт*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${preview}${result.transcript.length > 600 ? '...' : ''}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🧠 *Анализ хуков и структуры:*\n\n` +
      `${formatReport(result.analysis)}\n\n` +
      `_💰 ~$${cost.toFixed(4)}_`
    );
  } catch (err) {
    stopTyping();
    logToFile(`/transcribe ERROR: ${err.message}`);
    await safeEdit(ctx, statusMsg.message_id, `❌ Ошибка: ${err.message}`);
  }
});

// ──────────────────────────────────────────────────────
// /mode — выбор режима работы агента
// ──────────────────────────────────────────────────────
bot.command('mode', async (ctx) => {
  const s = await getSettings(ctx.from.id);
  const current = s.mode || 'info';
  const labels = {
    info:    '🔍 Получить информацию',
    content: '🎬 Создать контент',
    publish: '🚀 Создать и опубликовать'
  };
  const label = labels[current] || labels.info;
  await ctx.reply(
    `🎯 *Режим работы*\n\nТекущий: *${label}*\n\nВыбери режим:`,
    { parse_mode: 'Markdown', ...MODE_KEYBOARD }
  );
});

// ──────────────────────────────────────────────────────
// Обработчики инлайн-кнопок выбора режима
// ──────────────────────────────────────────────────────
bot.action('mode_info', async (ctx) => {
  await ctx.answerCbQuery('✅ Режим выбран');
  await updateSetting(ctx.from.id, 'mode', 'info');
  wizardState.delete(ctx.from.id);
  await safeSend(ctx,
    '🔍 *Режим: Предоставление информации*\n\n' +
    'Под капотом работают Агенты 1 + 2 + 3:\n' +
    '• Агент 1 — поиск и сбор данных\n' +
    '• Агент 2 — глубокий парсинг источников\n' +
    '• Агент 3 — анализ и синтез отчёта\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━\n\n' +
    '_Используй /report для полного отчёта или /search для быстрого поиска._',
    MAIN_KEYBOARD
  );
});

bot.action('mode_content', async (ctx) => {
  await ctx.answerCbQuery('🎬 Создать контент');
  await updateSetting(ctx.from.id, 'mode', 'content');
  await startWizard(ctx, 'content');
});

bot.action('mode_publish', async (ctx) => {
  await ctx.answerCbQuery('🚀 Создать и опубликовать');
  await updateSetting(ctx.from.id, 'mode', 'publish');
  await startWizard(ctx, 'publish');
});

// ──────────────────────────────────────────────────────
// Wizard: шаги 1–6 (step 7 обрабатывается в bot.on('text'))
// ──────────────────────────────────────────────────────

// Шаг 1 → опора на тренды (да/нет)
bot.action(/^wiz_trends_(yes|no)$/, async (ctx) => {
  const useTrends = ctx.match[1] === 'yes';
  const wiz = wizardState.get(ctx.from.id);
  if (!wiz) return ctx.answerCbQuery('⏰ Сессия истекла — выбери режим снова через /mode');
  wiz.use_trends = useTrends;
  wiz.step = 2;
  await ctx.answerCbQuery(useTrends ? '🔥 На основе трендов' : '📝 Просто по описанию');
  await safeSend(ctx,
    `✅ ${useTrends ? '🔥 Опираемся на актуальные тренды' : '📝 Создаём просто по описанию'}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📂 *Шаг 2 из 7 — С каким проектом PostMyPost работаем?*`,
    WIZARD_PROJECT_KB
  );
});

// Шаг 2 → проект PostMyPost (2026-07-12 — на аккаунте два проекта, см.
// WIZARD_PROJECT_KB выше)
bot.action(/^wiz_proj_(.+)$/, async (ctx) => {
  const project = ctx.match[1];
  const wiz = wizardState.get(ctx.from.id);
  if (!wiz) return ctx.answerCbQuery('⏰ Сессия истекла — выбери режим снова через /mode');
  wiz.project = project;
  wiz.step = 3;
  await ctx.answerCbQuery(PROJECT_LABELS[project] || project);
  await safeSend(ctx,
    `✅ Проект: *${PROJECT_LABELS[project] || project}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📱 *Шаг 3 из 7 — Для каких соцсетей создаём контент?*\n` +
    `_Можно выбрать несколько — жми по каждой нужной, затем "Готово"._`,
    buildNetworkKeyboard(wiz.networks)
  );
});

// Шаг 3 → мультивыбор сетей (2026-07-12) — каждый тычок переключает сеть в
// wiz.networks и перерисовывает ту же клавиатуру с обновлёнными галочками,
// не создавая новое сообщение (editMessageReplyMarkup) — иначе чат
// захламлялся бы клавиатурой на каждый клик.
bot.action(/^wiz_nettoggle_(.+)$/, async (ctx) => {
  const network = ctx.match[1];
  const wiz = wizardState.get(ctx.from.id);
  if (!wiz) return ctx.answerCbQuery('⏰ Сессия истекла — выбери режим снова через /mode');
  const idx = wiz.networks.indexOf(network);
  if (idx === -1) {
    wiz.networks.push(network);
  } else {
    wiz.networks.splice(idx, 1);
  }
  await ctx.answerCbQuery(NETWORK_LABELS[network] || network);
  await ctx.editMessageReplyMarkup(buildNetworkKeyboard(wiz.networks).reply_markup).catch(() => {});
});

bot.action('wiz_netdone', async (ctx) => {
  const wiz = wizardState.get(ctx.from.id);
  if (!wiz) return ctx.answerCbQuery('⏰ Сессия истекла — выбери режим снова через /mode');
  if (wiz.networks.length === 0) {
    return ctx.answerCbQuery('⚠️ Выбери хотя бы одну соцсеть');
  }
  wiz.step = 4;
  await ctx.answerCbQuery('✅ Сети выбраны');
  const networksLabel = wiz.networks.map((n) => NETWORK_LABELS[n] || n).join(', ');
  await safeSend(ctx,
    `✅ Соцсети: *${networksLabel}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🎨 *Шаг 4 из 7 — Тип контента:*`,
    WIZARD_TYPE_KB
  );
});

// Шаг 4 → тип контента
bot.action(/^wiz_type_(.+)$/, async (ctx) => {
  const type = ctx.match[1];
  const wiz = wizardState.get(ctx.from.id);
  if (!wiz) return ctx.answerCbQuery('⏰ Сессия истекла — выбери режим снова через /mode');
  wiz.content_type = type;
  wiz.step = 5;
  await ctx.answerCbQuery(TYPE_LABELS[type] || type);
  await safeSend(ctx,
    `✅ Тип: *${TYPE_LABELS[type] || type}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📐 *Шаг 5 из 7 — Формат / соотношение сторон:*`,
    WIZARD_FORMAT_KB
  );
});

// Шаг 5 → формат
bot.action(/^wiz_fmt_(.+)$/, async (ctx) => {
  const fmt = ctx.match[1];
  const wiz = wizardState.get(ctx.from.id);
  if (!wiz) return ctx.answerCbQuery('⏰ Сессия истекла — выбери режим снова через /mode');
  wiz.format = fmt;
  wiz.step = 6;
  await ctx.answerCbQuery(FORMAT_LABELS[fmt] || fmt);
  await safeSend(ctx,
    `✅ Формат: *${FORMAT_LABELS[fmt] || fmt}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✍️ *Шаг 6 из 7 — Стиль подачи:*`,
    WIZARD_STYLE_KB
  );
});

// Шаг 6 → стиль
bot.action(/^wiz_style_(.+)$/, async (ctx) => {
  const style = ctx.match[1];
  const wiz = wizardState.get(ctx.from.id);
  if (!wiz) return ctx.answerCbQuery('⏰ Сессия истекла — выбери режим снова через /mode');
  wiz.style = style;
  wiz.step = 7;
  await ctx.answerCbQuery(STYLE_LABELS[style] || style);
  await safeSend(ctx,
    `✅ Стиль: *${STYLE_LABELS[style] || style}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💬 *Шаг 7 из 7 — Опиши задачу:*\n\n` +
    `_Напиши свободное описание — о чём контент, ключевая идея, важные детали._`
  );
});

// ──────────────────────────────────────────────────────
// Переключатель модерации перед публикацией
// ──────────────────────────────────────────────────────
bot.action('toggle_moderation', async (ctx) => {
  const s = await getSettings(ctx.from.id);
  const newVal = !(s.moderation_mode || false);
  await updateSetting(ctx.from.id, 'moderation_mode', newVal);
  await ctx.answerCbQuery(newVal ? '✅ Модерация включена' : '⬜ Автопилот (без подтверждения)');
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [[
      { text: newVal ? '✅ Модерация перед публикацией: ВКЛ' : '⬜ Модерация перед публикацией: ВЫКЛ',
        callback_data: 'toggle_moderation' }
    ]]
  }).catch(() => {});
});

// ──────────────────────────────────────────────────────
// Канал согласия пользователя → Агент 4 (пункт G)
// cqa_qd_<uuid>  approve quota_deletion
// cqr_qd_<uuid>  reject  quota_deletion
// cqa_pm_<uuid>  approve publish_moderation
// cqr_pm_<uuid>  reject  publish_moderation
// ──────────────────────────────────────────────────────
bot.action(/^(cqa|cqr)_(qd|pm)_([0-9a-f-]{36})$/, async (ctx) => {
  const [, action, type, contentId] = ctx.match;
  const decision     = action === 'cqa' ? 'approved' : 'rejected';
  const decisionType = type   === 'qd'  ? 'quota_deletion' : 'publish_moderation';

  await ctx.answerCbQuery(decision === 'approved' ? '✅ Принято' : '❌ Отклонено');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  const db = getSupabase();

  let queueId = null;
  try {
    const { data, error } = await db
      .from('agent4_consent_queue')
      .insert({
        telegram_id:          ALLOWED_USER_ID,
        generated_content_id: contentId,
        decision_type:        decisionType,
        decision,
        status:               'pending'
      })
      .select('id')
      .single();
    if (error) throw error;
    queueId = data?.id ?? null;
    logToFile(`[consent] INSERT ok id=${queueId} type=${decisionType} decision=${decision}`);
  } catch (err) {
    logToFile(`[consent] INSERT failed: ${err.message}`);
  }

  try {
    await getRedis().publish('notifications:agent4_from_agent1', JSON.stringify({
      event:                'decision_ready',
      queue_id:             queueId,
      telegram_id:          ALLOWED_USER_ID,
      generated_content_id: contentId,
      decision_type:        decisionType,
      decision,
      timestamp:            new Date().toISOString()
    }));
    logToFile(`[consent] Redis published decision=${decision} type=${decisionType} content=${contentId}`);
  } catch (err) {
    logToFile(`[consent] Redis publish failed (non-fatal): ${err.message}`);
  }

  const label = decision === 'approved'
    ? (decisionType === 'quota_deletion' ? '🗑 Старый файл будет удалён.' : '🚀 Публикация запущена.')
    : (decisionType === 'quota_deletion' ? '✖️ Удаление отменено.' : '✖️ Публикация отклонена.');
  await bot.telegram.sendMessage(ALLOWED_USER_ID, label)
    .catch((e) => logToFile(`[consent] label send failed: ${e.message}`));
});

// ──────────────────────────────────────────────────────
// Plain text — wizard шаг 7 или Perplexity
// ──────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  // Wizard шаг 7 — свободное описание задачи
  const wiz = wizardState.get(ctx.from.id);
  if (wiz && wiz.step === 7) {
    wizardState.delete(ctx.from.id);
    const wizardSettings = {
      project:      wiz.project,
      networks:     wiz.networks,
      content_type: wiz.content_type,
      format:       wiz.format,
      style:        wiz.style,
      description:  text,
      use_trends:   wiz.use_trends,
    };
    await updateSetting(ctx.from.id, 'wizard', wizardSettings);

    // Push-хендофф Агенту 4 (2026-07-10, основной путь пробуждения для MVP —
    // см. "Content creation agent/Доработки для Агентов 1 и 3 (передать).md",
    // раздел D). Fire-and-forget: пользователь не должен ждать сеть/БД перед
    // тем, как увидеть подтверждение сохранённых настроек.
    notifyAgent4(ctx.from.id, wiz.mode, wizardSettings)
      .catch((err) => logToFile(`[agent4Handoff] notifyAgent4 failed: ${err.message}`));

    // "На основе трендов" (2026-07-10, по прямому указанию пользователя):
    // запрос должен реально что-то делать, а не молча деградировать — если
    // выбор сделан, здесь и сейчас запускается настоящий поиск+анализ по
    // теме задачи (тот же orchestrate(), что и у /trends), который
    // естественным путём пишет в intelligence_agent.search_results и
    // маршрутизирует тяжёлые находки Агенту 2 (routeToAgent2 внутри
    // orchestrate). Агент 4 подхватит результат через свой MCP-запрос к
    // Агенту 3 с ретраями (см. Content creation agent/Code/src/enrichment/
    // enrichWithTrends.js) — это может занять пару минут, отдельно
    // предупреждён пользователь текстом ниже. Fire-and-forget: не блокирует
    // подтверждение wizard'а.
    if (wiz.use_trends) {
      orchestrate({
        task_id:   `${ctx.from.id}_wizard_${Date.now()}`,
        user_id:   ctx.from.id,
        type:      'trends',
        topics:    [text],
        platforms: ['youtube', 'web'],
        depth:     'quick'
      }).catch((err) => logToFile(`[wizard] trend search failed (non-fatal, Агент 4 продолжит без обогащения): ${err.message}`));
    }

    const modeLabel = wiz.mode === 'publish' ? '🚀 Создать и опубликовать' : '🎬 Создать контент';
    const trendsLabel = wiz.use_trends ? '🔥 На основе трендов' : '📝 Просто по описанию';
    const waitNote = wiz.use_trends
      ? '⏳ *Агент 4 получил задачу.* Сначала Агент 1 и Агент 2 найдут и разберут свежую информацию по теме — это может занять пару минут, затем начнётся генерация.'
      : '⏳ *Агент 4 получил задачу и начинает генерацию контента.*\nОжидай уведомления — обычно занимает меньше минуты.';
    const summary =
      `✅ *Настройки контента сохранены!*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎯 *Режим:* ${modeLabel}\n` +
      `🔥 *Подход:* ${trendsLabel}\n` +
      `📂 *Проект:* ${PROJECT_LABELS[wiz.project] || wiz.project}\n` +
      `📱 *Соцсети:* ${wiz.networks.map((n) => NETWORK_LABELS[n] || n).join(', ')}\n` +
      `🎨 *Тип:* ${TYPE_LABELS[wiz.content_type] || wiz.content_type}\n` +
      `📐 *Формат:* ${FORMAT_LABELS[wiz.format] || wiz.format}\n` +
      `✍️ *Стиль:* ${STYLE_LABELS[wiz.style] || wiz.style}\n` +
      `💬 *Задача:* ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      waitNote;

    if (wiz.mode === 'publish') {
      const s = await getSettings(ctx.from.id);
      const modOn = s.moderation_mode || false;
      await safeSend(ctx, summary, {
        reply_markup: {
          inline_keyboard: [[
            { text: modOn ? '✅ Модерация перед публикацией: ВКЛ' : '⬜ Модерация перед публикацией: ВЫКЛ',
              callback_data: 'toggle_moderation' }
          ]]
        }
      });
    } else {
      await safeSend(ctx, summary, MAIN_KEYBOARD);
    }
    return;
  }

  logToFile(`Plain text query: "${text.slice(0, 80)}"`);
  const stopTyping = keepTyping(ctx);
  const statusMsg = await ctx.reply(`🔍 _Ищу ответ на твой вопрос..._`, { parse_mode: 'Markdown' });

  try {
    const { answer, cost } = await perplexitySearch(text, 700);
    stopTyping();
    trackCost(ctx.from.id, 'текстовый', cost);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await safeSend(ctx,
      `💬 *Ответ:*\n\n━━━━━━━━━━━━━━━━━━━━━\n\n${formatReport(answer)}\n\n_💰 ~$${cost.toFixed(4)}_`
    );
  } catch (err) {
    stopTyping();
    logToFile(`text handler ERROR: ${err.message}`);
    await safeEdit(ctx, statusMsg.message_id, `❌ Ошибка: ${err.message}`);
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
    { command: 'topics',      description: '📌 Меню выбора/переключения тем' },
    { command: 'set_depth',   description: '🔬 Глубина: quick / standard / deep' },
    { command: 'mode',        description: '🎯 Режим: Информация / Создание контента' },
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

// Polling Agent 4 delivery queue каждые 5 минут (catch-up для пропущенных Redis-событий)
setInterval(() => pollAgent4DeliveryQueue().catch(() => {}), 5 * 60 * 1000);
// первый прогон сразу при старте — подбираем всё, что накопилось пока бот был выключен
pollAgent4DeliveryQueue().catch(() => {});

bot.launch()
  .then(() => logToFile('Bot stopped'))
  .catch(err => logToFile(`bot.launch ERROR: ${err.message}`));

logToFile('Bot polling started');

process.once('SIGINT',  () => { logToFile('SIGINT — stopping bot');  bot.stop('SIGINT');  });
process.once('SIGTERM', () => { logToFile('SIGTERM — stopping bot'); bot.stop('SIGTERM'); });
