-- AlterTable
ALTER TABLE "task_outbox" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "attempt_limit" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "claimed_refresh_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dedupe_key" VARCHAR(200),
ADD COLUMN     "error_code" VARCHAR(100),
ADD COLUMN     "fencing_token" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lease_until" TIMESTAMPTZ(3),
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "refresh_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "source_key" VARCHAR(100),
ADD COLUMN     "status" VARCHAR(32) NOT NULL DEFAULT 'queued',
ADD COLUMN     "successor_task_id" UUID,
ADD COLUMN     "target" JSONB,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "source_streams" (
    "id" VARCHAR(200) NOT NULL,
    "stream_key" VARCHAR(32) NOT NULL,
    "generation" INTEGER NOT NULL,
    "checkpoint" INTEGER NOT NULL,
    "checkpoint_version" INTEGER NOT NULL,
    "next_discovery_at" TIMESTAMPTZ(3) NOT NULL,
    "pause_reason" VARCHAR(100),
    "state_version" INTEGER NOT NULL,

    CONSTRAINT "source_streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_resources" (
    "id" UUID NOT NULL,
    "source_key" VARCHAR(100) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "source_id" VARCHAR(200) NOT NULL,
    "canonical_url" VARCHAR(4000) NOT NULL,
    "current_version_id" UUID,
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_fetched_at" TIMESTAMPTZ(3),
    "next_refresh_at" TIMESTAMPTZ(3) NOT NULL,
    "review_version" INTEGER NOT NULL DEFAULT 0,
    "current_review_id" UUID,
    "state_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "source_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_snapshots" (
    "id" UUID NOT NULL,
    "sanitized_digest" CHAR(64) NOT NULL,
    "byte_length" INTEGER NOT NULL,
    "format" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "source_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_versions" (
    "id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "material_hash" CHAR(64) NOT NULL,
    "body" JSONB NOT NULL,
    "parser_version" VARCHAR(100) NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "source_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fetch_observations" (
    "id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "http_status" INTEGER NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "raw_digest" CHAR(64) NOT NULL,
    "parser_version" VARCHAR(100) NOT NULL,

    CONSTRAINT "fetch_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_evidence_links" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "resource_id" UUID,
    "url" VARCHAR(4000) NOT NULL,
    "relation_kind" VARCHAR(32) NOT NULL,
    "association_version" UUID NOT NULL,
    "association_status" VARCHAR(32) NOT NULL,

    CONSTRAINT "job_evidence_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_drafts" (
    "id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "job_version_id" UUID NOT NULL,
    "fields" JSONB NOT NULL,
    "parser_version" VARCHAR(100) NOT NULL,

    CONSTRAINT "requirement_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_reviews" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "job_version_id" UUID NOT NULL,
    "review_version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "review_digest" CHAR(64) NOT NULL,
    "is_complete" BOOLEAN NOT NULL,
    "verified_at" TIMESTAMPTZ(3),
    "reviewed_at" TIMESTAMPTZ(3) NOT NULL,
    "actor_reference" VARCHAR(200) NOT NULL,

    CONSTRAINT "requirement_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_attempts" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "token" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "result_code" VARCHAR(100),
    "next_retry_at" TIMESTAMPTZ(3),

    CONSTRAINT "task_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_requesters" (
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,

    CONSTRAINT "task_requesters_pkey" PRIMARY KEY ("user_id","task_id")
);

-- CreateTable
CREATE TABLE "source_request_budgets" (
    "id" VARCHAR(200) NOT NULL,
    "limit" INTEGER NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "source_request_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_permits" (
    "id" VARCHAR(200) NOT NULL,
    "next_start_at" TIMESTAMPTZ(3) NOT NULL,
    "lease_until" TIMESTAMPTZ(3),
    "owner" UUID,
    "state" JSONB,

    CONSTRAINT "domain_permits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_runs" (
    "id" UUID NOT NULL,
    "operation_key" UUID NOT NULL,
    "snapshot_at" TIMESTAMPTZ(3) NOT NULL,
    "cutoff_sequence" BIGINT NOT NULL,
    "scope_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "manifest_digest" CHAR(64),
    "entries" JSONB NOT NULL,
    "record_count" INTEGER NOT NULL,

    CONSTRAINT "export_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_resources_next_refresh_at_idx" ON "source_resources"("next_refresh_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_resources_source_key_kind_source_id_key" ON "source_resources"("source_key", "kind", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_resource_id_key" ON "jobs"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_versions_resource_id_material_hash_key" ON "source_versions"("resource_id", "material_hash");

-- CreateIndex
CREATE UNIQUE INDEX "fetch_observations_attempt_id_key" ON "fetch_observations"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_evidence_links_job_id_url_association_version_key" ON "job_evidence_links"("job_id", "url", "association_version");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_drafts_job_version_id_key" ON "requirement_drafts"("job_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_reviews_job_id_review_version_key" ON "requirement_reviews"("job_id", "review_version");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_reviews_job_id_review_digest_key" ON "requirement_reviews"("job_id", "review_digest");

-- CreateIndex
CREATE UNIQUE INDEX "task_attempts_task_id_attempt_key" ON "task_attempts"("task_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "export_runs_operation_key_key" ON "export_runs"("operation_key");

-- CreateIndex
CREATE INDEX "task_outbox_status_available_at_priority_idx" ON "task_outbox"("status", "available_at", "priority");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "source_resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "source_resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "source_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fetch_observations" ADD CONSTRAINT "fetch_observations_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "source_resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fetch_observations" ADD CONSTRAINT "fetch_observations_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "source_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_evidence_links" ADD CONSTRAINT "job_evidence_links_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_drafts" ADD CONSTRAINT "requirement_drafts_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "source_resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_reviews" ADD CONSTRAINT "requirement_reviews_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_requesters" ADD CONSTRAINT "task_requesters_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_requesters" ADD CONSTRAINT "task_requesters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 历史已完成任务保持成功；新执行器只领取明确带来源的任务。
UPDATE task_outbox SET status='succeeded' WHERE completed_at IS NOT NULL;
CREATE UNIQUE INDEX task_outbox_active_dedupe ON task_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running','retry_wait','paused');
ALTER TABLE task_outbox ADD CONSTRAINT task_execution_nonnegative CHECK(attempt>=0 AND attempt_limit>0 AND fencing_token>=0 AND refresh_generation>=0 AND claimed_refresh_generation>=0);
ALTER TABLE source_streams ADD CONSTRAINT source_stream_versions CHECK(generation>=0 AND checkpoint>0 AND checkpoint_version>=0 AND state_version>=0);
ALTER TABLE source_resources ADD CONSTRAINT source_resource_versions CHECK(review_version>=0 AND state_version>=0);
ALTER TABLE source_request_budgets ADD CONSTRAINT source_budget_bounds CHECK(used>=0 AND "limit">=0 AND used<="limit");
ALTER TABLE source_snapshots ADD CONSTRAINT snapshot_size CHECK(byte_length>=0);
ALTER TABLE task_attempts ADD CONSTRAINT attempt_positive CHECK(attempt>0 AND token>0);
