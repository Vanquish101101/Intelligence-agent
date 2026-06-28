import 'dotenv/config';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scout } from '../agents/scout/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

// Model selection by depth
const MODELS = {
  quick:    { id: 'anthropic/claude-haiku-4-5', maxTokens: 900,  cost: 0.002 },
  standard: { id: 'anthropic/claude-haiku-4-5', maxTokens: 1800, cost: 0.004 },
  deep:     { id: 'anthropic/claude-sonnet-4-6', maxTokens: 3000, cost: 0.020 },
};

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
  const { report, model_used } = await generateReport(task, scoutResult, algorithm);

  // 4. Calculate total costs
  const modelCfg = MODELS[depth] || MODELS.standard;
  const llmCost  = modelCfg.cost;
  const totalCost = Math.round((scoutResult.cost_usd + llmCost) * 1000) / 1000;

  const costBreakdown = {};
  for (const tool of scoutResult.tools_used) {
    const key = (tool === 'perplexity' && depth === 'deep') ? 'perplexity-deep' : tool;
    const costs = { perplexity: 0.003, 'perplexity-deep': 0.012, 'apify-youtube': 0.020, firecrawl: 0.002 };
    costBreakdown[tool] = costs[key] ?? 0.002;
  }
  costBreakdown['llm-analysis'] = llmCost;

  return {
    task_id,
    status: 'completed',
    report,
    meta: {
      tools_used:     [...scoutResult.tools_used, 'llm-analysis'],
      errors:         scoutResult.errors,
      duration_sec:   Math.round((Date.now() - startTime) / 1000),
      cost_usd:       totalCost,
      cost_breakdown: costBreakdown,
      depth,
      model_used
    }
  };
}

async function generateReport(task, scoutResult, algorithm) {
  const { topics = [], type = 'report', depth = 'standard' } = task;
  const topicsStr = topics.join(', ') || 'общий мониторинг трендов';
  const isDeep    = depth === 'deep';
  const isQuick   = type === 'trends' || depth === 'quick';

  const dataBlock  = buildDataBlock(scoutResult, isDeep);
  const errorsBlock = scoutResult.errors.length
    ? `\nНЕДОСТУПНЫЕ ИСТОЧНИКИ: ${scoutResult.errors.join(' | ')}`
    : '';

  const depthNote = isDeep
    ? '\nРЕЖИМ: DEEP RESEARCH — предоставь максимально детальный анализ с конкретными фактами, именами, цифрами и причинно-следственными связями.'
    : '';

  const prompt = `Ты — аналитик-разведчик. Составь ${isQuick ? 'краткий' : 'полный'} отчёт о трендах для Telegram.${depthNote}

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

Составь отчёт строго в формате ниже. Будь конкретным — числа, названия, факты важнее общих слов.${isDeep ? ' В deep-режиме расширяй каждый блок: 5+ трендов, детальные объяснения хуков.' : ''}

📊 *ОТЧЁТ РАЗВЕДЧИКА — ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}*${isDeep ? ' 🔬 DEEP' : ''}
━━━━━━━━━━━━━━━━━━━━━

🔥 *ТОП ТРЕНДЫ:*

1. *[название тренда]* — почему залетело: [объяснение хука]
2. *[название тренда]* — хук: [что зацепило аудиторию]
3. *[название тренда]* — [ключевое наблюдение]${isDeep ? '\n4. *[название]* — [глубокий анализ]\n5. *[название]* — [анализ]' : ''}

━━━━━━━━━━━━━━━━━━━━━

📱 *ПО ПЛАТФОРМАМ:*

🎬 *YouTube:* [топ тема/видео + метрики если есть]
🌐 *Web:* [горячие темы из новостей/блогов]${isDeep ? '\n📊 *Анализ:* [детальный разбор по каждой платформе]' : ''}

━━━━━━━━━━━━━━━━━━━━━

💡 *ИДЕИ ДЛЯ КОНТЕНТА:*

• *[Название идеи]* — формат: [тип контента], почему сработает: [объяснение]
• *[Название идеи]* — формат: [тип], почему: [объяснение]
• *[Название идеи]* — формат: [тип], почему: [объяснение]${isDeep ? '\n• *[Идея 4]* — [подробный план реализации]\n• *[Идея 5]* — [подробный план]' : ''}

━━━━━━━━━━━━━━━━━━━━━

⚠️ *ВАЖНО ПРОВЕРИТЬ:*

• [что требует уточнения или вызывает сомнения]
━━━━━━━━━━━━━━━━━━━━━`;

  const modelCfg = MODELS[isQuick ? 'quick' : (isDeep ? 'deep' : 'standard')];

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vanquish.intelligence-agent',
      'X-Title':      'Intelligence Agent'
    },
    body: JSON.stringify({
      model:      modelCfg.id,
      messages:   [{ role: 'user', content: prompt }],
      max_tokens: modelCfg.maxTokens
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM error ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  return {
    report:     data.choices?.[0]?.message?.content || '❌ Не удалось сформировать отчёт',
    model_used: modelCfg.id
  };
}

function buildDataBlock(scoutResult, isDeep) {
  const parts = [];

  if (scoutResult.data.perplexity) {
    const p = scoutResult.data.perplexity;
    const label = p.model === 'sonar-pro' ? '[PERPLEXITY DEEP — детальный анализ]' : '[PERPLEXITY — актуальные факты]';
    parts.push(`${label}\n${p.summary}`);
    if (p.citations?.length) {
      parts.push(`Источники: ${p.citations.slice(0, 5).join(', ')}`);
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
      const slice = isDeep ? items : items.slice(0, 4);
      const lines = slice.map(i => `• ${i.title}\n  ${i.content.slice(0, isDeep ? 500 : 200)}`).join('\n');
      parts.push(`[WEB — тематические статьи]\n${lines}`);
    }
  }

  return parts.join('\n\n') || 'Данные не собраны.';
}

function formatNum(n) {
  if (!n || isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}K`;
  return String(n);
}
