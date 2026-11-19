-- Add built-in Tailscale (tsnet) fields to RemoteAlertConfig
ALTER TABLE "RemoteAlertConfig" ADD COLUMN "tailscaleEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RemoteAlertConfig" ADD COLUMN "tsAuthKey" TEXT;
ALTER TABLE "RemoteAlertConfig" ADD COLUMN "tsHostname" TEXT;
