-- Схема Intelligence Agent (Агент 1 — Разведчик)
-- Применять в Supabase проекте "Marketing agency" (id: wklecdbujgdwnbmfmggi)
-- Сначала создать схему вручную в Supabase Dashboard: SQL Editor

CREATE SCHEMA IF NOT EXISTS intelligence_agent;

-- Настройки пользователей
CREATE TABLE IF NOT EXISTS intelligence_agent.users (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT UNIQUE NOT NULL,
  settings     JSONB NOT NULL DEFAULT '{
    "topics":    ["маркетинг", "крипта", "партнёрки"],
    "platforms": ["youtube", "web"],
    "depth":     "standard"
  }'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- История отчётов (используется с v1.5)
CREATE TABLE IF NOT EXISTS intelligence_agent.reports (
  id          BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES intelligence_agent.users(telegram_id) ON DELETE CASCADE,
  task_type   TEXT NOT NULL,  -- 'report' | 'search' | 'trends' | 'osint'
  query       TEXT,
  content     TEXT NOT NULL,
  cost_usd    NUMERIC(10, 6) DEFAULT 0,
  tools_used  TEXT[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Метрики затрат API
CREATE TABLE IF NOT EXISTS intelligence_agent.api_costs (
  id          BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  task_type   TEXT NOT NULL,
  cost_usd    NUMERIC(10, 6) NOT NULL,
  tools_used  TEXT[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Обновлять updated_at автоматически
CREATE OR REPLACE FUNCTION intelligence_agent.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON intelligence_agent.users
  FOR EACH ROW EXECUTE FUNCTION intelligence_agent.set_updated_at();

-- Индексы
CREATE INDEX IF NOT EXISTS reports_telegram_id_idx ON intelligence_agent.reports(telegram_id);
CREATE INDEX IF NOT EXISTS api_costs_telegram_id_idx ON intelligence_agent.api_costs(telegram_id);
CREATE INDEX IF NOT EXISTS reports_created_at_idx ON intelligence_agent.reports(created_at DESC);
