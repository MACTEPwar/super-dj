-- CreateTable
CREATE TABLE "InteractionRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "minAmount" INTEGER NOT NULL,
    "commandKeyword" TEXT NOT NULL DEFAULT 'song',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InteractionRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InteractionRule_userId_idx" ON "InteractionRule"("userId");

-- AddForeignKey
ALTER TABLE "InteractionRule" ADD CONSTRAINT "InteractionRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
