/**
 * Полный тест агента — симуляция запроса реального пользователя
 * Запуск: node tests/test-full-flow.js
 */
import 'dotenv/config';
import { scout } from '../src/agents/scout/index.js';
import { orchestrate } from '../src/orchestrator/index.js';

const LINE = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const log = (label, text) => console.log(`\n${LINE}\n[${label}]\n${LINE}\n${text}\n`);

async function runTest() {
  console.log('\n🤖 Intelligence Agent — Тест полного цикла');
  console.log('👤 Симуляция: пользователь отправил /report\n');

  // === ШАГ 1: Scout — сбор данных ===
  console.log('📡 ШАГ 1: Агент-разведчик собирает данные...');
  const scoutStart = Date.now();

  let scoutResult;
  try {
    scoutResult = await scout(
      ['маркетинг', 'крипта', 'партнёрки'],
      ['youtube', 'web'],
      'standard'
    );

    log('SCOUT РЕЗУЛЬТАТ', JSON.stringify({
      tools_used: scoutResult.tools_used,
      errors: scoutResult.errors,
      perplexity_preview: scoutResult.data?.perplexity?.summary?.slice(0, 300),
      youtube_count: scoutResult.data?.['apify-youtube']?.length,
      firecrawl_count: scoutResult.data?.firecrawl?.length
    }, null, 2));

    console.log(`✅ Scout: ${Math.round((Date.now() - scoutStart) / 1000)}с | Инструменты: ${scoutResult.tools_used.join(', ')} | Ошибки: ${scoutResult.errors.join(', ') || 'нет'}`);
  } catch (err) {
    console.error(`❌ Scout упал: ${err.message}`);
    process.exit(1);
  }

  // === ШАГ 2: Orchestrate — полный цикл ===
  console.log('\n🧠 ШАГ 2: Оркестратор формирует отчёт...');
  const orchStart = Date.now();

  try {
    const result = await orchestrate({
      task_id: 'test_001',
      user_id: 1064521326,
      type: 'report',
      topics: ['маркетинг', 'крипта', 'партнёрки'],
      platforms: ['youtube', 'web'],
      depth: 'standard'
    });

    log('ФИНАЛЬНЫЙ ОТЧЁТ (как получит пользователь в Telegram)', result.report);
    log('МЕТА', JSON.stringify(result.meta, null, 2));

    console.log(`✅ Оркестратор: ${result.meta.duration_sec}с | Инструменты: ${result.meta.tools_used.join(', ')}`);
    if (result.meta.errors.length) console.log(`⚠️  Ошибки: ${result.meta.errors.join(', ')}`);

  } catch (err) {
    console.error(`❌ Оркестратор упал: ${err.message}`);
  }

  // === ШАГ 3: /search симуляция ===
  console.log('\n🔍 ШАГ 3: Симуляция /search партнёрские программы 2025...');
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: 'партнёрские программы 2025 — топ ниши' }],
        max_tokens: 400
      })
    });
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content;
    log('/search ОТВЕТ', answer || 'Нет ответа');
    console.log('✅ /search работает');
  } catch (err) {
    console.error(`❌ /search: ${err.message}`);
  }

  // === ШАГ 4: /trends симуляция ===
  console.log('\n📊 ШАГ 4: Симуляция /trends крипта...');
  try {
    const result = await orchestrate({
      task_id: 'test_002',
      user_id: 1064521326,
      type: 'trends',
      topics: ['крипта'],
      platforms: ['youtube', 'web'],
      depth: 'quick'
    });
    log('/trends ОТВЕТ', result.report);
    console.log(`✅ /trends работает | ${result.meta.duration_sec}с`);
  } catch (err) {
    console.error(`❌ /trends: ${err.message}`);
  }

  console.log('\n🏁 Тест завершён.\n');
}

runTest().catch(console.error);
