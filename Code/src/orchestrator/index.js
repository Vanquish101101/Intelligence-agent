import 'dotenv/config';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scout } from '../agents/scout/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const ANALYSIS_MODEL = 'anthropic/claude-haiku-4-5';

export async function orchestrate(task) {
  const startTime = Date.now();
  const { task_id, topics = [], platforms, depth = 'standard', type = 'report' } = task;

  // 1. Read routing algorithm
  let algorithm = '';
  try {
    algorithm = await readFile(join(__dirname, 'algorithm.md'), 'utf8');
  } catch {
    algorithm = 'Анализируй данные и составь структурированный отчёт о трендах.';
  }

  // 2. Scout phase — collect data from all sources
  const scoutResult = await scout(topics, platforms || ['youtube', 'web'], depth);

  // 3. Generate report via LLM
  const report = await generateReport(task, scoutResult, algorithm);

  return {
    task_id,
    status: 'completed',
    report,
    meta: {
      tools_used: scoutResult.tools_used,
      errors: scoutResult.errors,
      duration_sec: Math.round((Date.now() - startTime) / 1000)
    }
  };
}

async function generateReport(task, scoutResult, algorithm) {
  const { topics = [], type = 'report' } = task;
  const topicsStr = topics.join(', ') || 'общий мониторинг трендов';

  const dataBlock = buildDataBlock(scoutResult);
  const errorsBlock = scoutResult.errors.length
    ? `\nНЕДОСТУПНЫЕ ИСТОЧНИКИ: ${scoutResult.errors.join(' | ')}`
    : '';

  const isQuick = type === 'trends' || task.depth === 'quick';

  const prompt = `Ты — аналитик-разведчик. Составь ${isQuick ? 'краткий' : 'полный'} отчёт о трендах для Telegram.

ВАЖНО — ФОРМАТ ТЕКСТА:
- Используй *одинарные звёздочки* для выделения жирным: *текст* (НЕ **двойные**)
- НЕ используй заголовки с ## или ### — только эмодзи и *жирный текст*
- НЕ используй --- разделители — только ━━━━━━━━━━━━━━━━━━━━━
- Названия/темы в пунктах списка — выделяй жирным через *звёздочки*

ТЕМА ЗАПРОСА: ${topicsStr}

АЛГОРИТМ:
${algorithm}

СОБРАННЫЕ ДАННЫЕ:
${dataBlock}${errorsBlock}

Составь отчёт строго в формате ниже. Будь конкретным — числа, названия, факты важнее общих слов.

📊 *ОТЧЁТ РАЗВЕДЧИКА — ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}*
━━━━━━━━━━━━━━━━━━━━━

🔥 *ТОП ТРЕНДЫ:*

1. *[название тренда]* — почему залетело: [объяснение хука]
2. *[название тренда]* — хук: [что зацепило аудиторию]
3. *[название тренда]* — [ключевое наблюдение]

━━━━━━━━━━━━━━━━━━━━━

📱 *ПО ПЛАТФОРМАМ:*

🎬 *YouTube:* [топ тема/видео + метрики если есть]
🌐 *Web:* [горячие темы из новостей/блогов]

━━━━━━━━━━━━━━━━━━━━━

💡 *ИДЕИ ДЛЯ КОНТЕНТА:*

• *[Название идеи]* — формат: [тип контента], почему сработает: [объяснение]
• *[Название идеи]* — формат: [тип], почему: [объяснение]
• *[Название идеи]* — формат: [тип], почему: [объяснение]

━━━━━━━━━━━━━━━━━━━━━

⚠️ *ВАЖНО ПРОВЕРИТЬ:*

• [что требует уточнения или вызывает сомнения]
━━━━━━━━━━━━━━━━━━━━━`;

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vanquish.intelligence-agent',
      'X-Title': 'Intelligence Agent'
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1800
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM error ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '❌ Не удалось сформировать отчёт';
}

function buildDataBlock(scoutResult) {
  const parts = [];

  if (scoutResult.data.perplexity) {
    const p = scoutResult.data.perplexity;
    parts.push(`[PERPLEXITY — актуальные факты]\n${p.summary}`);
    if (p.citations?.length) {
      parts.push(`Источники: ${p.citations.slice(0, 3).join(', ')}`);
    }
  }

  if (scoutResult.data['apify-youtube']) {
    const videos = scoutResult.data['apify-youtube'];
    if (videos.length > 0) {
      const lines = videos.map(v =>
        `• ${v.title} | 👁 ${formatNum(v.views)} | 👍 ${formatNum(v.likes)} | ${v.channel}`
      ).join('\n');
      parts.push(`[YOUTUBE — топ видео за неделю]\n${lines}`);
    }
  }

  if (scoutResult.data.firecrawl) {
    const items = scoutResult.data.firecrawl;
    if (items.length > 0) {
      const lines = items.map(i => `• ${i.title}\n  ${i.content.slice(0, 200)}`).join('\n');
      parts.push(`[WEB — тематические статьи]\n${lines}`);
    }
  }

  return parts.join('\n\n') || 'Данные не собраны.';
}

function formatNum(n) {
  if (!n || isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
