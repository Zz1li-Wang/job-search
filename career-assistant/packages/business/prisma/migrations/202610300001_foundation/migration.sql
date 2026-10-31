CREATE TABLE "idempotency_records" (
  "scope" VARCHAR(100) NOT NULL,
  "key" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "response_reference" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("scope", "key")
);
CREATE TABLE "task_outbox" (
  "id" UUID PRIMARY KEY,
  "event_key" VARCHAR(200) NOT NULL UNIQUE,
  "kind" VARCHAR(100) NOT NULL,
  "resource_reference" VARCHAR(200) NOT NULL,
  "available_at" TIMESTAMPTZ(3) NOT NULL,
  "completed_at" TIMESTAMPTZ(3)
);
CREATE INDEX "task_outbox_available_at_idx" ON "task_outbox"("available_at");
CREATE TABLE "audit_events" (
  "id" UUID PRIMARY KEY,
  "actor_reference" VARCHAR(200) NOT NULL,
  "action" VARCHAR(100) NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL
);
