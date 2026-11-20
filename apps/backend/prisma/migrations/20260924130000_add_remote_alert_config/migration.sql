-- CreateTable
CREATE TABLE "RemoteAlertConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tsAllowedLogins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "vapidPublicKey" TEXT,
    "vapidPrivateKey" TEXT,
    "vapidSubject" TEXT,
    "ntfyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ntfyUrl" TEXT,
    "ntfyToken" TEXT,
    "signalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "signalApiUrl" TEXT,
    "signalNumber" TEXT,
    "signalRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matrixEnabled" BOOLEAN NOT NULL DEFAULT false,
    "matrixHomeserverUrl" TEXT,
    "matrixAccessToken" TEXT,
    "matrixRoomId" TEXT,
    "matterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "matterLayout" TEXT NOT NULL DEFAULT 'bridge',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteAlertConfig_pkey" PRIMARY KEY ("id")
);
