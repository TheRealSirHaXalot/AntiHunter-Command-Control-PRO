export interface WebhookOwnerDto {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface WebhookDeliveryDto {
  id: string;
  statusCode?: number | null;
  success: boolean;
  errorMessage?: string | null;
  triggeredAt: Date;
  completedAt?: Date | null;
}

export interface WebhookDto {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  verifyTls: boolean;
  shared: boolean;
  clientCertificate?: string | null;
  clientKey?: string | null;
  caBundle?: string | null;
  lastSuccessAt?: Date | null;
  lastFailureAt?: Date | null;
  owner?: WebhookOwnerDto | null;
  recentDeliveries: WebhookDeliveryDto[];
}
