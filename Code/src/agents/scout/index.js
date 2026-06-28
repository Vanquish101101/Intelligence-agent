import 'dotenv/config';

const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;

export async function scout(topics = [], platforms = ['youtube', 'web'], depth = 'standard') {
  const topicsStr = topics.join(', ') || 'тренды маркетинг';
  const results = { data: {}, tools_used: [], errors: [] };

  const tasks = [
    { name: 'perplexity', fn: () => searchPerplexity(topicsStr, depth) },
    platforms.includes('youtube') && { name: 'apify-youtube', fn: () => searchYouTube(topics) },
    platforms.includes('web') && { name: 'firecrawl', fn: () => searchFirecrawl(topicsStr) },
  ].filter(Boolean);

  await Promise.allSettled(
    tasks.map(async ({ name, fn }) => {
      try {
        results.data[name] = await fn();
        results.tools_used.push(name);
      } catch (err) {
        results.errors.push(`${name}: ${err.message}`);
      }
    })
  );

  return results;
}

async function searchPerplexity(query, depth) {
  const maxTokens = depth === 'quick' ? 500 : 900;

  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{
        role: 'user',
        content: `Найди актуальные тренды и горячие темы по запросу: "${query}".
Что сейчас обсуждают? Какой контент залетает? Какие форматы работают?
Дай конкретные факты с источниками. По-русски.`
      }],
      max_tokens: maxTokens
    })
  });

  if (!response.ok) throw new Error(`Perplexity HTTP ${response.status}`);
  const data = await response.json();

  return {
    summary: data.choices?.[0]?.message?.content || '',
    citations: data.citations || []
  };
}

async function searchYouTube(topics) {
  const query = topics.join(' ') || 'тренды маркетинг';

  // Actor: streamers/youtube-scraper (91K users, 97.9% success rate)
  const runResp = await fetch(
    `https://api.apify.com/v2/acts/streamers~youtube-scraper/runs?token=${APIFY_TOKEN}&memory=256`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchQueries: [query],
        maxResults: 5,
        dateFilter: 'week',
        sortingOrder: 'relevance'
      })
    }
  );

  if (!runResp.ok) throw new Error(`Apify run start HTTP ${runResp.status}`);
  const runData = await runResp.json();
  const runId = runData.data?.id;
  if (!runId) throw new Error('No run ID from Apify');

  return await pollApifyRun(runId, 120000);
}

async function pollApifyRun(runId, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await delay(6000);

    const resp = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    const data = await resp.json();
    const status = data.data?.status;

    if (status === 'SUCCEEDED') {
      const datasetId = data.data?.defaultDatasetId;
      const itemsResp = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=5`
      );
      const items = await itemsResp.json();

      return items.map(v => ({
        title: v.title || '',
        views: v.viewCount || 0,
        likes: v.likeCount || 0,
        url: v.url || '',
        channel: v.channelName || '',
        description: (v.description || '').slice(0, 200)
      }));
    }

    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      throw new Error(`Apify actor ${status}`);
    }
  }

  throw new Error('Apify run timeout after 60s');
}

async function searchFirecrawl(query) {
  const response = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIRECRAWL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      limit: 5,
      lang: 'ru',
      scrapeOptions: { formats: ['markdown'] }
    })
  });

  if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
  const data = await response.json();

  return (data.data || []).map(item => ({
    title: item.title || '',
    url: item.url || '',
    content: cleanMarkdown(item.markdown || item.description || '').slice(0, 400)
  }));
}

function cleanMarkdown(text) {
  return text
    .replace(/!\[[^\]]*\]\([^\)]*\)/g, '')       // remove image tags ![...]()
    .replace(/\[([^\]]*)\]\([^\)]*\)/g, '$1')    // [text](url) → text
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
