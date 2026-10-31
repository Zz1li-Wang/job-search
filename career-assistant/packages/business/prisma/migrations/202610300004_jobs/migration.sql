-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "profiles" (
    "user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "eligibility_checks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "job_version_id" UUID NOT NULL,
    "profile_version" INTEGER NOT NULL,
    "review_version" INTEGER NOT NULL,
    "dependency_hash" CHAR(64) NOT NULL,
    "rules_version" VARCHAR(100) NOT NULL,
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL,
    "decision" JSONB NOT NULL,

    CONSTRAINT "eligibility_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eligibility_checks_user_id_id_idx" ON "eligibility_checks"("user_id", "id");

-- CreateIndex
CREATE INDEX "eligibility_checks_job_id_evaluated_at_idx" ON "eligibility_checks"("job_id", "evaluated_at");

-- CreateIndex
CREATE INDEX "jobs_recorded_at_id_idx" ON "jobs"("recorded_at", "id");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


UPDATE jobs j SET recorded_at=COALESCE((SELECT min(v.created_at) FROM source_versions v WHERE v.resource_id=j.resource_id),recorded_at);
ALTER TABLE profiles ADD CONSTRAINT profile_positive_version CHECK(version>0);
ALTER TABLE eligibility_checks ADD CONSTRAINT check_nonnegative_versions CHECK(profile_version>=0 AND review_version>=0);
