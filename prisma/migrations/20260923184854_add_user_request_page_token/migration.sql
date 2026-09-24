-- AlterTable
ALTER TABLE "User" ADD COLUMN     "requestPageToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_requestPageToken_key" ON "User"("requestPageToken");

