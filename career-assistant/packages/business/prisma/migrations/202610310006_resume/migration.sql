-- CreateTable
CREATE TABLE "resumes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "format" VARCHAR(10) NOT NULL,
    "file_key" VARCHAR(200),
    "content_hash" CHAR(64) NOT NULL,
    "version" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "active_run_id" UUID,
    "draft_id" UUID,
    "error_code" VARCHAR(100),
    "spans" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_drafts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "base_profile_version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "source_resume_id" UUID,
    "source_resume_version" INTEGER,
    "evidence" JSONB NOT NULL,
    "confirmed_profile_version" INTEGER,
    "confirmed_content" JSONB,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "profile_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resumes_user_id_created_at_id_idx" ON "resumes"("user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "resumes_status_idx" ON "resumes"("status");

-- CreateIndex
CREATE INDEX "profile_drafts_user_id_id_idx" ON "profile_drafts"("user_id", "id");

-- AddForeignKey
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_drafts" ADD CONSTRAINT "profile_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX resume_active_user_hash ON resumes(user_id,content_hash) WHERE deleted_at IS NULL;
ALTER TABLE resumes ADD CONSTRAINT resume_positive_version CHECK(version>0);
ALTER TABLE profile_drafts ADD CONSTRAINT draft_versions CHECK(version>0 AND base_profile_version>=0);
