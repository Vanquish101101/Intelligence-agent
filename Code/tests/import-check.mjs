// Quick import test - run: node tests/import-check.mjs
process.stdout.write('START\n');

try {
  process.stdout.write('Loading dotenv...\n');
  const dotenv = await import('dotenv/config');
  process.stdout.write('dotenv OK\n');

  process.stdout.write('Loading telegraf...\n');
  const { Telegraf } = await import('telegraf');
  process.stdout.write('telegraf OK\n');

  process.stdout.write('Loading scout...\n');
  const { scout } = await import('../src/agents/scout/index.js');
  process.stdout.write('scout OK\n');

  process.stdout.write('Loading transcriber...\n');
  const { transcribeAndAnalyze } = await import('../src/agents/transcriber/index.js');
  process.stdout.write('transcriber OK\n');

  process.stdout.write('Loading orchestrator...\n');
  const { orchestrate } = await import('../src/orchestrator/index.js');
  process.stdout.write('orchestrator OK\n');

  process.stdout.write('All imports OK\n');
  process.stdout.write(`OPENAI_KEY set: ${!!process.env.OPENAI_API_KEY}\n`);
  process.stdout.write(`BOT_TOKEN set: ${!!process.env.TELEGRAM_BOT_TOKEN}\n`);
  process.stdout.write(`PERPLEXITY_KEY set: ${!!process.env.PERPLEXITY_API_KEY}\n`);
} catch(e) {
  process.stderr.write(`ERROR: ${e.message}\n${e.stack}\n`);
  process.exit(1);
}
