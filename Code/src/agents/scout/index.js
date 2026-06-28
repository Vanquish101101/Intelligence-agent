import 'dotenv/config';

const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const APIFY_TOKEN    = process.env.APIFY_TOKEN;
const FIRECRAWL_KEY  = process.env.FIRECRAWL_API_KEY;

// Cost estimates per API call (USD)
export const SCOUT_COSTS = {
  'perplexity':     0.003,   // sonar standard
  'perplexity-deep': 0.012,  // sonar-pro (deep research mode)
  'apify-youtube':  0.020,   // Apify actor run
  'firecrawl':      0.002,   // Firecrawl search
};

export async function scout(topics = [], platforms = ['youtube', 'web'], depth = 'standard') {
  const topicsStr = topics.join(', ') || 'тренды маркетинг';
  const isDeep = depth === 'deep';
  const results = { data: {}, tools_used: [], errors: [], cost_usd: 0 };

  const tasks = [
    { name: 'perplexity', fn: () => searchPerplexity(topicsStr, depth) },
    platforms.includes('youtube') && { name: 'apify-youtube', fn: () => searchYouTube(topics, isDeep) },
    platforms.includes('web')     && { name: 'firecrawl',     fn: () => searchFirecrawl(topicsStr, isDeep) },
  ].filter(Boolean);

  await Promise.allSettled(
    tasks.map(async ({ name, fn }) => {
      try {
        results.data[name] = await fn();
        results.tools_used.push(name);
        // Track cost: deep perplexity costs more
        const costKey = (name === 'perplexity' && isDeep) ? 'perplexity-deep' : name;
        results.cost_usd += SCOUT_COSTS[costKey] ?? 0.002;
      } catch (err) {
        results.errors.push(`${name}: ${err.message}`);
      }
    })
  );

  return results;
}

async function searchPerplexity(query, depth) {
  const isDeep  = depth === 'deep';
  const isQuick = depth === 'quick';
  const maxTokens = isDeep ? 1800 : isQuick ? 500 : 900;
  const model     = isDeep ? 'sonar-pro' : 'sonar';

  // Deep research uses an extended, structured prompt
  const deepSystemMsg = {
    role: 'system',
    content: 'Ты — аналитик-разведчик уровня эксперта. Проводи глубокое исследование: ищи конкретные цифры, называй имена и события, давай источники. Никаких общих фраз — только факты.'
  };

  const userContent = isDeep
    ? `DEEP RESEARCH MODE. Тема: "${query}".\n\nПроведи исчерпывающий анализ:\n1. Актуальные тренды (последние 7–30 дней) с конкретными цифрами\n2. Ключевые игроки и их действия\n3. Почему это важно сейчас — причины хайпа\n4. Прогноз на ближайшие 2–4 недели\n5. Конкретные возможности для контента и маркетинга\n\nДай максимально детальный ответ с источниками.`
    : `Найди актуальные тренды и горячие темы по запросу: "${query}".\nЧто сейчас обсуждают? Какой контент залетает? Какие форматы работают?\nДай конкретные факты с источниками. По-русски.`;

  const messages = isDeep
    ? [deepSystemMsg, { role: 'user', content: userContent }]
    : [{ role: 'user', content: userContent }];

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
  };

  if (isDeep) {
    body.search_recency_filter = 'month';
  }

  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) throw new Error(`Perplexity HTTP ${response.status}`);
  const data = await response.json();

  return {
    summary:   data.choices?.[0]?.message?.content || '',
    citations: data.citations || [],
    model
  };
}

async function searchYouTube(topics, isDeep) {
  const query   = topics.join(' ') || 'тренды маркетинг';
  const maxRes  = isDeep ? 10 : 5;

  const runResp = await fetch(
    `https://api.apify.com/v2/acts/streamers~youtube-scraper/runs?token=${APIFY_TOKEN}&memory=256`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchQueries: [query],
        maxResults:    maxRes,
        dateFilter:    'week',
        sortingOrder:  'relevance'
      })
    }
  );

  if (!runResp.ok) throw new Error(`Apify run start HTTP ${runResp.status}`);
  const runData = await runResp.json();
  const runId   = runData.data?.id;
  if (!runId) throw new Error('No run ID from Apify');

  return await pollApifyRun(runId, 120000, maxRes);
}

async function pollApifyRun(runId, maxWaitMs, limit = 5) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await delay(6000);

    const resp   = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    const data   = await resp.json();
    const status = data.data?.status;

    if (status === 'SUCCEEDED') {
      const datasetId = data.data?.defaultDatasetId;
      const itemsResp = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=${limit}`
      );
      const items = await itemsResp.json();

      return items.map(v => ({
        title:       v.title || '',
        views:       v.viewCount  || 0,
        likes:       v.likeCount  || 0,
        url:         v.url        || '',
        channel:     v.channelName || '',
        description: (v.description || '').slice(0, 200)
      }));
    }

    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      throw new Error(`Apify actor ${status}`);
    }
  }

  throw new Error('Apify run timeout');
}

async function searchFirecrawl(query, isDeep) {
  const limit = isDeep ? 8 : 5;

  const response = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIRECRAWL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      limit,
      lang: 'ru',
      scrapeOptions: { formats: ['markdown'] }
    })
  });

  if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
  const data = await response.json();

  return (data.data || []).map(item => ({
    title:   item.title || '',
    url:     item.url   || '',
    content: cleanMarkdown(item.markdown || item.description || '').slice(0, isDeep ? 600 : 400)
  }));
}

function cleanMarkdown(text) {
  return text
    .replace(/!\[[^\]]*\]\([^\)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^\)]*\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
