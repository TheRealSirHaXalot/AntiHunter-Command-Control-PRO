-- CreateTable
CREATE TABLE "DeviceBaselineConfig" (
    "id" TEXT NOT NULL,
    "baselineStart" TIMESTAMP(3),
    "rollingWindowMinutes" INTEGER NOT NULL DEFAULT 1440,
    "gapThresholdMinutes" INTEGER NOT NULL DEFAULT 30,
    "frequentFlierVisits" INTEGER NOT NULL DEFAULT 3,
    "visitorAbsenceMinutes" INTEGER NOT NULL DEFAULT 120,
    "stationaryPresencePct" INTEGER NOT NULL DEFAULT 70,
    "autoClassifyMinutes" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceBaselineConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevicePresence" (
    "mac" TEXT NOT NULL,
    "siteId" TEXT,
    "vendor" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "minRssi" INTEGER,
    "maxRssi" INTEGER,
    "nodeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currentVisitId" TEXT,
    "category" TEXT,
    "smartName" TEXT,
    "classifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevicePresence_pkey" PRIMARY KEY ("mac")
);

-- CreateTable
CREATE TABLE "DeviceVisit" (
    "id" TEXT NOT NULL,
    "mac" TEXT NOT NULL,
    "siteId" TEXT,
    "start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "end" TIMESTAMP(3) NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "nodeId" TEXT,

    CONSTRAINT "DeviceVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DevicePresence_siteId_idx" ON "DevicePresence"("siteId");

-- CreateIndex
CREATE INDEX "DevicePresence_category_idx" ON "DevicePresence"("category");

-- CreateIndex
CREATE INDEX "DevicePresence_lastSeen_idx" ON "DevicePresence"("lastSeen");

-- CreateIndex
CREATE INDEX "DeviceVisit_mac_idx" ON "DeviceVisit"("mac");

-- CreateIndex
CREATE INDEX "DeviceVisit_start_idx" ON "DeviceVisit"("start");

-- CreateIndex
CREATE INDEX "DeviceVisit_mac_start_idx" ON "DeviceVisit"("mac", "start");

