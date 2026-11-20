import { IsBoolean, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateWebhookDto {
  @IsString()
  @MaxLength(128)
  name!: string;

  @IsString()
  @MaxLength(2048)
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  secret?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  shareWithEveryone?: boolean;

  @IsOptional()
  @IsBoolean()
  verifyTls?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  clientCertificate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  clientKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  caBundle?: string;
}
