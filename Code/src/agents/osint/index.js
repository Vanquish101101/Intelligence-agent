import 'dotenv/config';

const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;

// OSINT search types with deep Perplexity queries
// Source: awesome-osint-arsenal methodology (SOCMINT, GEOINT, domain recon)
const OSINT_QUERIES = {
  username: (t) => `Найди все публичные профили пользователя с ником "${t}" в социальных сетях: ВКонтакте, Telegram, YouTube, TikTok, Instagram, Twitter/X, GitHub, Reddit, TenChat. Укажи найденные URL профилей, количество подписчиков и краткое описание активности. Ищи только в открытых источниках.`,
  email:    (t) => `OSINT по email "${t}": найди связанные аккаунты в социальных сетях, публичные регистрации на сервисах, упоминания на форумах и в открытых базах. Информация о домене: компания, владелец. Только открытые источники.`,
  domain:   (t) => `OSINT анализ домена "${t}": история и дата регистрации, технологический стек сайта (CMS, фреймворки), связанные домены и субдомены, социальные профили компании, ключевые сотрудники по открытым источникам, упоминания в СМИ и отзывы.`,
  person:   (t) => `OSINT поиск по имени "${t}": публичные профили в соцсетях (ВКонтакте, LinkedIn, Telegram), профессиональная информация (должность, место работы), упоминания в новостях, публичные проекты и выступления. Только открытые данные.`,
  company:  (t) => `OSINT анализ компании "${t}": юридические данные из открытых реестров (ИНН/ОГРН для РФ), ключевые руководители, технологический стек, конкуренты, отзывы сотрудников (HH, Glassdoor), публикации и новости, соцсети и каналы. Только открытые источники.`,
  phone:    (t) => `OSINT по номеру телефона "${t}": регион и мобильный оператор, упоминания на публичных форумах, досках объявлений (Авито, Циан), связанные аккаунты в мессенджерах по открытым данным. Только публичная информация.`,
  ip:       (t) => `OSINT анализ IP-адреса "${t}": геолокация (страна, город, провайдер), ASN и диапазон сети, репутация (попадание в blacklists), связанные домены и хосты, публичная информация о хостинге.`,
};

// Cost estimates per operation (USD)
export const OSINT_COSTS = {
  'perplexity-deep': 0.012,
  'platform-check':  0.003,
  'site-scrape':     0.001,
};

export async function osintSearch(target, type = 'person') {
  const results = {
    type,
    target,
    data: {},
    tools_used: [],
    errors: [],
    cost_usd: 0
  };

  const tasks = [
    { name: 'perplexity-deep', fn: () => deepOsintSearch(target, type) },
  ];

  if (type === 'username') {
    tasks.push({ name: 'platform-check', fn: () => checkPlatforms(target) });
  }

  if (type === 'domain') {
    tasks.push({ name: 'site-scrape', fn: () => scrapeDomain(target) });
  }

  await Promise.allSettled(
    tasks.map(async ({ name, fn }) => {
      try {
        results.data[name] = await fn();
        results.tools_used.push(name);
        results.cost_usd += OSINT_COSTS[name] || 0.005;
      } catch (err) {
        results.errors.push(`${name}: ${err.message}`);
      }
    })
  );

  return results;
}

async function deepOsintSearch(target, type) {
  const query = OSINT_QUERIES[type]?.(target) ?? OSINT_QUERIES.person(target);

  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{ role: 'user', content: query }],
      max_tokens: 1500,
      search_recency_filter: 'month'
    })
  });

  if (!response.ok) throw new Error(`Perplexity HTTP ${response.status}`);
  const data = await response.json();
  return {
    summary: data.choices?.[0]?.message?.content || '',
    citations: data.citations || []
  };
}

async function checkPlatforms(username) {
  const platforms = [
    { name: 'VK',       url: `https://vk.com/${username}` },
    { name: 'Telegram', url: `https://t.me/${username}` },
    { name: 'GitHub',   url: `https://github.com/${username}` },
  ];

  const found = [];
  await Promise.allSettled(
    platforms.map(async ({ name, url }) => {
      try {
        const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${FIRECRAWL_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ url, formats: ['markdown'] })
        });
        if (!resp.ok) return;
        const d = await resp.json();
        const content = d.data?.markdown || '';
        const notFound = ['404', 'не существует', 'page not found', 'does not exist', 'no such user'].some(
          s => content.toLowerCase().includes(s)
        );
        if (!notFound && content.length > 200) {
          found.push({
            platform: name,
            url,
            snippet: content.replace(/!\[.*?\]\(.*?\)/g, '').slice(0, 200)
          });
        }
      } catch {}
    })
  );
  return found;
}

async function scrapeDomain(domain) {
  const url = domain.startsWith('http') ? domain : `https://${domain}`;
  const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIRECRAWL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url, formats: ['markdown'] })
  });
  if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
  const d = await response.json();
  return {
    title:   d.data?.metadata?.title || '',
    content: (d.data?.markdown || '').replace(/!\[.*?\]\(.*?\)/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 800)
  };
}

export function formatOsintReport(osintResult) {
  const { type, target, data, tools_used, errors, cost_usd } = osintResult;

  const typeLabels = {
    username: '👤 Никнейм',
    email:    '📧 Email',
    domain:   '🌐 Домен',
    person:   '👤 Персона',
    company:  '🏢 Компания',
    phone:    '📱 Телефон',
    ip:       '🔌 IP-адрес',
  };

  let report = `🕵 *OSINT — ${typeLabels[type] || type}:* \`${target}\`\n\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (data['perplexity-deep']?.summary) {
    report += `🔍 *Разведка по открытым источникам:*\n\n`;
    report += data['perplexity-deep'].summary
      .replace(/\*\*(.+?)\*\*/gs, '*$1*')
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, 1500);
    report += '\n\n';
    if (data['perplexity-deep'].citations?.length) {
      report += `📎 *Источники:* ${data['perplexity-deep'].citations.slice(0, 3).join(' · ')}\n\n`;
    }
  }

  if (Array.isArray(data['platform-check'])) {
    report += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    if (data['platform-check'].length > 0) {
      report += `✅ *Найдено на платформах:*\n\n`;
      for (const p of data['platform-check']) {
        report += `• *${p.platform}:* ${p.url}\n`;
      }
    } else {
      report += `⚪ *Профили на VK / Telegram / GitHub не обнаружены*\n`;
    }
    report += '\n';
  }

  if (data['site-scrape']?.content) {
    report += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    if (data['site-scrape'].title) report += `_${data['site-scrape'].title}_\n\n`;
    report += `🌐 *Контент сайта:*\n${data['site-scrape'].content.slice(0, 600)}\n\n`;
  }

  if (errors.length > 0) {
    report += `⚠️ _Ошибки: ${errors.map(e => e.split(':')[0]).join(', ')}_\n\n`;
  }

  report += `━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `_💰 ~$${cost_usd.toFixed(3)} · 🛠 ${tools_used.join(', ')}_`;

  return report;
}
