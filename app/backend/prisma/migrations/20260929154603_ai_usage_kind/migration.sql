-- CreateEnum
CREATE TYPE "AiUsageKind" AS ENUM ('MEAL_SUGGESTION', 'CHART_COMMENT');

-- DropIndex
DROP INDEX "ai_usages_created_at_idx";

-- DropIndex
DROP INDEX "ai_usages_user_id_created_at_idx";

-- AlterTable
ALTER TABLE "ai_usages" ADD COLUMN     "kind" "AiUsageKind" NOT NULL DEFAULT 'MEAL_SUGGESTION';

-- CreateIndex
CREATE INDEX "ai_usages_kind_user_id_created_at_idx" ON "ai_usages"("kind", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usages_kind_created_at_idx" ON "ai_usages"("kind", "created_at");
