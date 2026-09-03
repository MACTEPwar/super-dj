-- AlterTable
ALTER TABLE "StreamSession" ADD COLUMN     "templateId" TEXT;

-- AddForeignKey
ALTER TABLE "StreamSession" ADD CONSTRAINT "StreamSession_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "StreamTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
