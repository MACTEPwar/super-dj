-- AlterTable
ALTER TABLE "StreamDestination" ADD COLUMN     "youtubeLiveStreamId" TEXT;

-- AlterTable
ALTER TABLE "StreamSession" ADD COLUMN     "latencyPreference" TEXT,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT 'Untitled preset';
