-- AlterTable
ALTER TABLE "users" ADD COLUMN     "weekly_report_email" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "meal_suggestions" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "created_by_id" UUID,
    "content" JSONB,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meal_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_reports" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "summary" JSONB NOT NULL,
    "content" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meal_suggestions_child_id_created_at_idx" ON "meal_suggestions"("child_id", "created_at");

-- CreateIndex
CREATE INDEX "weekly_reports_period_end_notified_at_idx" ON "weekly_reports"("period_end", "notified_at");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_reports_child_id_period_end_key" ON "weekly_reports"("child_id", "period_end");

-- AddForeignKey
ALTER TABLE "meal_suggestions" ADD CONSTRAINT "meal_suggestions_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_suggestions" ADD CONSTRAINT "meal_suggestions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;
