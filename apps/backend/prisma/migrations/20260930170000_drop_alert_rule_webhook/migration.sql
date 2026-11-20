-- DropForeignKey
ALTER TABLE "AlertRuleWebhook" DROP CONSTRAINT "AlertRuleWebhook_ruleId_fkey";

-- DropForeignKey
ALTER TABLE "AlertRuleWebhook" DROP CONSTRAINT "AlertRuleWebhook_webhookId_fkey";

-- DropTable
DROP TABLE "AlertRuleWebhook";
