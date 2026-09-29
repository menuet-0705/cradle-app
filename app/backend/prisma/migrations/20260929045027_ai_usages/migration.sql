-- DropIndex
DROP INDEX "meal_suggestions_created_at_idx";

-- CreateTable
CREATE TABLE "ai_usages" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usages_user_id_created_at_idx" ON "ai_usages"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usages_created_at_idx" ON "ai_usages"("created_at");

-- AddForeignKey
ALTER TABLE "ai_usages" ADD CONSTRAINT "ai_usages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
