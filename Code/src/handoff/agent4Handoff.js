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

// Найдено живой проверкой 2026-07-10 (полная цепочка Агент1→2→3→4): эта
// функция и Content creation agent/Code/src/wizard/hash.js::computeWizardHash
// — независимые реализации одного и того же контракта, но с разным
// форматом (был `a|b|c`, там — `key=value\n...`) — то есть хеши НИКОГДА не
// совпадали, ни при одном реальном запросе, независимо от содержимого
// wizard'а. Не ломало функциональность (Агент 4 логирует "mismatch" и
// использует актуальные настройки — рабочий fallback), но делало саму
// сверку хешей бессмысленной и засоряло логи ложным предупреждением на
// каждый запрос. Теперь — точное зеркало формата Агента 4, включая новое
// поле use_trends (явный вопрос "на основе трендов", шаг 1 wizard'а).
//
// project + networks (2026-07-12, мультивыбор соцсетей + выбор PostMyPost-
// проекта) заменили одиночный network — networks это МАССИВ, порядок выбора
// пользователем (клики по кнопкам) не должен влиять на хеш, поэтому
// сериализуется через сортировку, а не через toString(). Обе стороны
// (здесь и Content creation agent/Code/src/wizard/hash.js::serializeField)
// обязаны сериализовать массивы одинаково — иначе повторится та же история,
// что и с прежним расхождением формата.
const WIZARD_HASH_FIELDS = ['project', 'networks', 'content_type', 'format', 'style', 'description', 'use_trends'];

function serializeField(value) {
  if (Array.isArray(value)) {
    return [...value].sort().join(',');
  }
  return value ?? '';
}

export function wizardHash(wizard) {
  const ordered = WIZARD_HASH_FIELDS.map((key) => `${key}=${serializeField(wizard[key])}`).join('\n');
  return createHash('sha256').update(ordered).digest('hex');
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
