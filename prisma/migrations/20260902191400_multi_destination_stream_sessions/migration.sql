-- CreateTable
CREATE TABLE "StreamSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "privacyStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreamSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreamSessionDestination" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,

    CONSTRAINT "StreamSessionDestination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StreamSessionDestination_sessionId_destinationId_key" ON "StreamSessionDestination"("sessionId", "destinationId");

-- AddForeignKey
ALTER TABLE "StreamSession" ADD CONSTRAINT "StreamSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamSession" ADD CONSTRAINT "StreamSession_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamSessionDestination" ADD CONSTRAINT "StreamSessionDestination_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StreamSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamSessionDestination" ADD CONSTRAINT "StreamSessionDestination_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "StreamDestination"("id") ON DELETE CASCADE ON UPDATE CASCADE;
