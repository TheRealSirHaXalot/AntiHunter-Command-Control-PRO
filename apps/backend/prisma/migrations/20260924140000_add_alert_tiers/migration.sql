-- AlterTable
ALTER TABLE "RemoteAlertConfig" ADD COLUMN     "alertTiers" JSONB NOT NULL DEFAULT '{}';
