-- src/db/migrations/004_agent4_consent.sql
-- Канал согласия пользователя (пункт G, «Доработки для Агентов 1 и 3»).
-- Таблица живёт в схеме Агента 1 (отправитель решения) — паттерн "очередь у
-- отправителя", одинаковый для всех хендоффов в проекте. Агент 4 читает её
-- через .schema('intelligence_agent') (кросс-схема), точно так же, как Агент 1
-- читает content_creation_agent.agent1_delivery_queue.
--
-- Быстрый слой: Redis pub/sub notifications:agent4_from_agent1 (best-effort).
-- Надёжный слой (эта таблица): catch-up при перезапуске контейнера Агента 4.
-- Агент 4 поллит её каждые 30 сек (consent/poller.js) и уже подписан на канал
-- (consent/subscribe.js) — отправляющую сторону (Агент 1) это касается только
-- через строгий формат JSON для Redis и обязательные поля таблицы ниже.

CREATE TABLE IF NOT EXISTS intelligence_agent.agent4_consent_queue (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id           BIGINT NOT NULL,
  generated_content_id  UUID NOT NULL,
  decision_type         TEXT NOT NULL,
  decision              TEXT NOT NULL,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  last_attempt_at       TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'pending',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent4_consent_queue_status_idx
  ON intelligence_agent.agent4_consent_queue(status);

ALTER TABLE intelligence_agent.agent4_consent_queue ENABLE ROW LEVEL SECURITY;

GRANT ALL ON intelligence_agent.agent4_consent_queue TO anon, authenticated, service_role;
