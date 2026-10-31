-- 放宽计数上限，保留已有运行及全部计数；旧应用仍可在更宽约束下运行。
BEGIN;
ALTER TABLE agent_runs DROP CONSTRAINT run_versions_positive;
ALTER TABLE agent_runs ADD CONSTRAINT run_versions_positive CHECK (
  attempt > 0 AND version > 0 AND last_sequence >= 0
  AND tool_calls >= 0 AND tool_calls <= 25
);
COMMIT;
