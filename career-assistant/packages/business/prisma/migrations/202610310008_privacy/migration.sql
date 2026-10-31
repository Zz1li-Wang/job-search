-- CreateTable
CREATE TABLE "deletion_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scope" VARCHAR(20) NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deletion_requests_user_id_id_idx" ON "deletion_requests"("user_id", "id");
