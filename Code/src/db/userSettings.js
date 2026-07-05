import { getSupabase } from './supabase.js';

const DEFAULT_SETTINGS = {
  topics:    ['маркетинг', 'крипта', 'партнёрки'],
  platforms: ['youtube', 'web'],
  depth:     'standard',
};

// In-memory кэш — fallback при недоступности Supabase
const cache = new Map();

export async function getSettings(telegramId) {
  if (cache.has(telegramId)) return cache.get(telegramId);

  try {
    const db = getSupabase();
    const { data, error } = await db
      .from('users')
      .select('settings')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (error) throw error;
    if (data?.settings) {
      const settings = { ...DEFAULT_SETTINGS, ...data.settings };
      cache.set(telegramId, settings);
      return settings;
    }
  } catch (err) {
    process.stderr.write(`[Settings] Supabase read failed, using defaults: ${err.message}\n`);
  }

  const settings = { ...DEFAULT_SETTINGS };
  cache.set(telegramId, settings);
  return settings;
}

export async function saveSettings(telegramId, settings) {
  cache.set(telegramId, settings);

  try {
    const db = getSupabase();
    await db
      .from('users')
      .upsert({ telegram_id: telegramId, settings }, { onConflict: 'telegram_id' });
  } catch (err) {
    process.stderr.write(`[Settings] Supabase write failed (cached locally): ${err.message}\n`);
  }
}

export async function updateSetting(telegramId, key, value) {
  const current = await getSettings(telegramId);
  const updated = { ...current, [key]: value };
  await saveSettings(telegramId, updated);
  return updated;
}
