// src/handoff/agent4Handoff.js
// Push-уведомление Агенту 4 о готовности wizard-запроса пользователя.
// Точное зеркало уже реализованного и проверенного паттерна Агент 3 → Агент 4
// (Information analysis agent/Code/src/handoff/agent4Handoff.js) — два слоя:
// Redis pub/sub (быстрый, best-effort) + Supabase (надёжный, с ретраями).
// Вызывается из telegram-bot/index.js fire-and-forget сразу после сохранения
// settings.wizard (шаг 5 диалога).

import { createHash } from 'crypto';
import { getRedis } from '../db/redis.js';
import { getSupabase } from '../db/supabase.js';

const AGENT4_CHANNEL = 'notifications:agent4';
const RETRY_DELAYS_MS = [500, 2000, 8000];

async function withRetry(fn, delays = RETRY_DELAYS_MS) {
  let lastErr;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < delays.length) {
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
  }
  throw lastErr;
}

export function wizardHash({ network, content_type, format, style, description }) {
  return createHash('sha256')
    .update(`${network}|${content_type}|${format}|${style}|${description}`)
    .digest('hex');
}

export async function notifyAgent4(telegramId, mode, wizard) {
  const hash = wizardHash(wizard);

  // Надёжный слой: Supabase insert с ретраями/бэкоффом
  try {
    await withRetry(async () => {
      const db = getSupabase();
      const { error } = await db.from('agent4_handoff_queue').insert({
        telegram_id: telegramId,
        wizard_hash: hash,
        mode,
        attempt_count: 0,
        status: 'pending'
      });
      if (error) throw new Error(error.message);
    });
  } catch (err) {
    process.stderr.write(`[agent4Handoff] Supabase insert failed after retries: ${err.message}\n`);
  }

  // Быстрый слой: Redis pub/sub (best-effort, некритичная ошибка)
  try {
    await getRedis().publish(AGENT4_CHANNEL, JSON.stringify({
      event: 'wizard_ready',
      telegram_id: telegramId,
      wizard_hash: hash,
      mode,
      timestamp: new Date().toISOString()
    }));
  } catch (err) {
    process.stderr.write(`[agent4Handoff] Redis publish failed: ${err.message}\n`);
  }
}
