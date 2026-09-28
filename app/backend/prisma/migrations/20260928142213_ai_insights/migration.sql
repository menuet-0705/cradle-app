-- CreateEnum
CREATE TYPE "MealAmount" AS ENUM ('ALL', 'HALF', 'LITTLE', 'NONE');

-- CreateEnum
CREATE TYPE "MealReaction" AS ENUM ('LIKED', 'NEUTRAL', 'DISLIKED');

-- CreateEnum
CREATE TYPE "MealSuggestionStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "WeeklyReportStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "children" ADD COLUMN     "avoid_foods" TEXT;

-- AlterTable
ALTER TABLE "families" ADD COLUMN     "ai_consent_at" TIMESTAMP(3),
ADD COLUMN     "ai_consent_by_id" UUID,
ADD COLUMN     "ai_consent_version" INTEGER;

-- AlterTable
ALTER TABLE "records" ADD COLUMN     "meal_amount" "MealAmount",
ADD COLUMN     "meal_reaction" "MealReaction";

-- CreateTable
CREATE TABLE "meal_suggestions" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "created_by_id" UUID,
    "status" "MealSuggestionStatus" NOT NULL DEFAULT 'PENDING',
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
    "status" "WeeklyReportStatus" NOT NULL DEFAULT 'PENDING',
    "content" JSONB,
    "model" TEXT NOT NULL,
    "batch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "weekly_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meal_suggestions_child_id_created_at_idx" ON "meal_suggestions"("child_id", "created_at");

-- CreateIndex
CREATE INDEX "meal_suggestions_created_by_id_created_at_idx" ON "meal_suggestions"("created_by_id", "created_at");

-- CreateIndex
CREATE INDEX "meal_suggestions_created_at_idx" ON "meal_suggestions"("created_at");

-- CreateIndex
CREATE INDEX "weekly_reports_status_batch_id_idx" ON "weekly_reports"("status", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_reports_child_id_period_end_key" ON "weekly_reports"("child_id", "period_end");

-- AddForeignKey
ALTER TABLE "meal_suggestions" ADD CONSTRAINT "meal_suggestions_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_suggestions" ADD CONSTRAINT "meal_suggestions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;
