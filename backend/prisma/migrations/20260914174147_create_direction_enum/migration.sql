/*
  Warnings:

  - Changed the type of `direction` on the `alert` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('ABOVE', 'BELLOW');

-- AlterTable
ALTER TABLE "alert" DROP COLUMN "direction",
ADD COLUMN     "direction" "Direction" NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "alert_user_alert_active_5b2336d6" ON "alert"("userId", "baseCurrency", "quoteCurrency", "direction", "targetRate") WHERE ("isActive" = true);
