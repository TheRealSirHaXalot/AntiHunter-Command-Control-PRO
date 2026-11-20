import type { AlarmLevel, AlertRuleMatchMode, AlertRuleScope } from '@prisma/client';

export interface AlertRuleOwnerSummary {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface AlertRuleMapStyle {
  showOnMap?: boolean;
  color?: string | null;
  icon?: string | null;
  blink?: boolean;
  label?: string | null;
}

export interface AlertRuleDto {
  id: string;
  name: string;
  description?: string | null;
  scope: AlertRuleScope;
  severity: AlarmLevel;
  matchMode: AlertRuleMatchMode;
  isActive: boolean;
  ouiPrefixes: string[];
  ssids: string[];
  channels: number[];
  macAddresses: string[];
  inventoryMacs: string[];
  minRssi?: number | null;
  maxRssi?: number | null;
  notifyVisual: boolean;
  notifyAudible: boolean;
  notifyEmail: boolean;
  emailRecipients: string[];
  messageTemplate?: string | null;
  mapStyle?: AlertRuleMapStyle | null;
  createdAt: Date;
  updatedAt: Date;
  lastTriggeredAt?: Date | null;
  owner?: AlertRuleOwnerSummary | null;
}

export interface AlertRuleEventDto {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlarmLevel;
  message?: string | null;
  nodeId?: string | null;
  mac?: string | null;
  ssid?: string | null;
  channel?: number | null;
  rssi?: number | null;
  matchedCriteria?: string[];
  payload?: Record<string, unknown> | null;
  triggeredAt: Date;
}
