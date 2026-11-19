-- CreateTable
CREATE TABLE "BaselineEvent" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "siteId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BaselineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BaselineEvent_kind_createdAt_idx" ON "BaselineEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "BaselineEvent_nodeId_kind_idx" ON "BaselineEvent"("nodeId", "kind");
