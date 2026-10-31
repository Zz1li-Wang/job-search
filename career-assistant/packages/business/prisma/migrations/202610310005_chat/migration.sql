-- AlterTable
ALTER TABLE "users" ADD COLUMN     "personal_data_epoch" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "active_run_id" UUID,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "client_message_id" UUID,
    "request_hash" CHAR(64),
    "role" VARCHAR(20) NOT NULL,
    "text" TEXT NOT NULL,
    "run_id" UUID,
    "status" VARCHAR(32) NOT NULL,
    "citations" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "conversation_id" UUID,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'chat',
    "resource_id" UUID,
    "status" VARCHAR(32) NOT NULL,
    "attempt" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "last_sequence" INTEGER NOT NULL,
    "error_code" VARCHAR(100),
    "auth_epoch" INTEGER NOT NULL,
    "personal_data_epoch" INTEGER NOT NULL,
    "tool_calls" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "lease_until" TIMESTAMPTZ(3),
    "parent_run_id" UUID,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_events" (
    "run_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("run_id","sequence")
);

-- CreateIndex
CREATE INDEX "conversations_user_id_created_at_id_idx" ON "conversations"("user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_id_idx" ON "messages"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_client_message_id_key" ON "messages"("conversation_id", "client_message_id");

-- CreateIndex
CREATE INDEX "agent_runs_status_created_at_idx" ON "agent_runs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE UNIQUE INDEX agent_runs_one_active_conversation ON agent_runs(conversation_id) WHERE conversation_id IS NOT NULL AND status IN ('queued','running');
ALTER TABLE users ADD CONSTRAINT personal_epoch_nonnegative CHECK(personal_data_epoch>=0);
ALTER TABLE agent_runs ADD CONSTRAINT run_versions_positive CHECK(attempt>0 AND version>0 AND last_sequence>=0 AND tool_calls>=0 AND tool_calls<=8);
