-- src/db/migrations/003_agent4_handoff.sql
-- Push-хендофф Агент 1 → Агент 4 (по прямому указанию пользователя 2026-07-10 —
-- основной путь пробуждения Агента 4 для конкретного wizard-запроса, не
-- постфактум-сопоставление через батч-прогоны Агента 3).
--
-- Быстрый слой: Redis pub/sub (notifications:agent4, тот же канал, что уже
-- слушает Агент 4 для уведомлений от Агента 3, разбор по полю "event") —
-- уведомляет Агента 4 немедленно, при недоступности Redis сообщение теряется
-- без последствий.
--
-- Надёжный слой (эта таблица): запись не теряется при перезапуске контейнера
-- или временной недоступности Агента 4. Агент 4 читает отсюда при старте или
-- по таймеру и забирает незамеченные wizard-запросы.
-- По образцу information_analysis_agent.agent4_handoff_queue (Агент 3,
-- migration 006_agent4_handoff.sql) — очередь живёт у отправителя.

CREATE TABLE IF NOT EXISTS intelligence_agent.agent4_handoff_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     BIGINT NOT NULL,
  wizard_hash     TEXT NOT NULL,   -- hash(network+content_type+format+style+description)
  mode            TEXT NOT NULL,   -- 'content' | 'publish'
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent4_handoff_queue_status_idx ON intelligence_agent.agent4_handoff_queue(status);

ALTER TABLE intelligence_agent.agent4_handoff_queue ENABLE ROW LEVEL SECURITY;

GRANT ALL ON intelligence_agent.agent4_handoff_queue TO anon, authenticated, service_role;
