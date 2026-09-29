-- CreateEnum
CREATE TYPE "MealSlot" AS ENUM ('BREAKFAST', 'MORNING_SNACK', 'LUNCH', 'AFTERNOON_SNACK', 'DINNER');

-- AlterTable
ALTER TABLE "records" ADD COLUMN     "meal_slot" "MealSlot";

-- 既存の食事は、日本時間の時刻から区分を割り当てる
-- （〜10時 朝食 / 10〜11時 おやつ（午前） / 11〜14時 昼食 / 14〜17時 おやつ（午後） / 17時〜 夕食）
UPDATE "records"
   SET "meal_slot" = CASE
         WHEN extract(hour FROM "started_at" AT TIME ZONE 'Asia/Tokyo') < 10 THEN 'BREAKFAST'::"MealSlot"
         WHEN extract(hour FROM "started_at" AT TIME ZONE 'Asia/Tokyo') < 11 THEN 'MORNING_SNACK'::"MealSlot"
         WHEN extract(hour FROM "started_at" AT TIME ZONE 'Asia/Tokyo') < 14 THEN 'LUNCH'::"MealSlot"
         WHEN extract(hour FROM "started_at" AT TIME ZONE 'Asia/Tokyo') < 17 THEN 'AFTERNOON_SNACK'::"MealSlot"
         ELSE 'DINNER'::"MealSlot"
       END
 WHERE "type" = 'MEAL';

-- 区分は食事にだけあり、食事には必ずある
ALTER TABLE "records" ADD CONSTRAINT "records_meal_slot_check"
  CHECK (("type" = 'MEAL') = ("meal_slot" IS NOT NULL));
