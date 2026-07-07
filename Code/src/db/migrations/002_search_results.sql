-- Таблица структурированных результатов поиска (Агент 1 → Агент 3)
-- Агент 3 читает из этой таблицы напрямую через Supabase
-- Применять в проекте "Marketing agency" (id: wklecdbujgdwnbmfmggi)

CREATE TABLE IF NOT EXISTS intelligence_agent.search_results (
  id            BIGSERIAL PRIMARY KEY,
  job_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  telegram_id   BIGINT,
  task_type     TEXT NOT NULL DEFAULT 'report',  -- 'report' | 'trends' | 'search'
  query_topics  TEXT[],
  depth         TEXT NOT NULL DEFAULT 'standard',
  status        TEXT NOT NULL DEFAULT 'ok',       -- 'ok' | 'partial' | 'error'
  result        JSONB NOT NULL DEFAULT '{}',       -- { raw: { perplexity, youtube, firecrawl } }
  telegram_text TEXT,                              -- копия Telegram-отчёта (fallback для Агента 3)
  confidence    JSONB,                             -- { level: 'высокая|средняя|низкая', explanation }
  meta          JSONB,                             -- { tools_used, cost_usd, duration_sec, model_used }
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS search_results_telegram_id_idx  ON intelligence_agent.search_results(telegram_id);
CREATE INDEX IF NOT EXISTS search_results_created_at_idx   ON intelligence_agent.search_results(created_at DESC);
CREATE INDEX IF NOT EXISTS search_results_job_id_idx       ON intelligence_agent.search_results(job_id);
CREATE INDEX IF NOT EXISTS search_results_task_type_idx    ON intelligence_agent.search_results(task_type);

-- Права доступа
GRANT ALL ON intelligence_agent.search_results TO anon, authenticated, service_role;
GRANT USAGE ON SEQUENCE intelligence_agent.search_results_id_seq TO anon, authenticated, service_role;

ALTER TABLE intelligence_agent.search_results DISABLE ROW LEVEL SECURITY;
