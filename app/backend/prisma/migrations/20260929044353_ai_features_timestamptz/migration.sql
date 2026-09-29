-- 時刻の列をタイムゾーン付きにそろえる（既存の値は UTC として解釈する）
-- AlterTable
ALTER TABLE "meal_suggestions" ADD COLUMN     "failed_at" TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "weekly_reports" ALTER COLUMN "notified_at" SET DATA TYPE TIMESTAMPTZ(3) USING "notified_at" AT TIME ZONE 'UTC',
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';

-- CreateIndex
CREATE INDEX "meal_suggestions_created_at_idx" ON "meal_suggestions"("created_at");
