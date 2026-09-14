
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "alert" (
    "id" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "targetRate" DECIMAL NOT NULL,
    "direction" TEXT NOT NULL,
    "triggeredAt" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "refreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_userId_idx_a489d58a" ON "alert"("userId");

-- CreateIndex
CREATE INDEX "alert_pair_active_331cc7d1" ON "alert"("baseCurrency", "quoteCurrency") WHERE ("isActive" = true);

-- CreateIndex
CREATE UNIQUE INDEX "alert_user_alert_active_5b2336d6" ON "alert"("userId", "baseCurrency", "quoteCurrency", "direction", "targetRate") WHERE ("isActive" = true);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refreshToken_tokenHash_key" ON "refreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "refreshToken_userId_idx_a489d58a" ON "refreshToken"("userId");

-- CreateIndex
CREATE INDEX "refreshToken_expiresAt_idx_6b6b8c10" ON "refreshToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refreshToken" ADD CONSTRAINT "refreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddCheckConstraint
-- Not expressible in Prisma 7's PSL (`@@check` does not exist), so these are
-- written by hand. `migrate diff` leaves check constraints it cannot express
-- alone, which is the only reason they survive; a `migrate reset` would rebuild
-- the database without them if they were not here.
ALTER TABLE "alert" ADD CONSTRAINT "alert_rate_positive_71f5f09d"
  CHECK ("targetRate" > 0);

ALTER TABLE "alert" ADD CONSTRAINT "alert_pair_distinct_e7f2bcc4"
  CHECK ("baseCurrency" <> "quoteCurrency");

ALTER TABLE "alert" ADD CONSTRAINT "alert_direction_check_134ec2b3"
  CHECK ("direction" = ANY (ARRAY['ABOVE'::text, 'BELOW'::text]));
