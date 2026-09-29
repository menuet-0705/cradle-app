-- CreateEnum
CREATE TYPE "ChartKind" AS ENUM ('WEIGHT', 'MILK');

-- CreateTable
CREATE TABLE "chart_comments" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "chart" "ChartKind" NOT NULL,
    "input_hash" TEXT NOT NULL,
    "content" JSONB,
    "model" TEXT NOT NULL,
    "failed_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chart_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chart_comments_child_id_chart_created_at_idx" ON "chart_comments"("child_id", "chart", "created_at");

-- AddForeignKey
ALTER TABLE "chart_comments" ADD CONSTRAINT "chart_comments_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_comments" ADD CONSTRAINT "chart_comments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
