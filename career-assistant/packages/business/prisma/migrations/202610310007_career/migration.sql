-- CreateTable
CREATE TABLE "favorites" (
    "user_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("user_id","job_id")
);

-- CreateTable
CREATE TABLE "job_applications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "action_date" VARCHAR(10),
    "note" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_history" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "action_date" VARCHAR(10),
    "note" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "application_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_applications_user_id_job_id_key" ON "job_applications"("user_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_history_application_id_version_key" ON "application_history"("application_id", "version");

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_history" ADD CONSTRAINT "application_history_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "job_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE job_applications ADD CONSTRAINT application_version_positive CHECK(version>0);
