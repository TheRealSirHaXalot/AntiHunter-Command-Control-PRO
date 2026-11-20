import { AlarmLevel, AlertRuleMatchMode, AlertRuleScope } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class AlertRuleMapStyleDto {
  @IsOptional()
  @IsBoolean()
  showOnMap?: boolean;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsBoolean()
  blink?: boolean;

  @IsOptional()
  @IsString()
  label?: string;
}

export class CreateAlertRuleDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @IsOptional()
  @IsEnum(AlertRuleScope)
  scope?: AlertRuleScope;

  @IsOptional()
  @IsEnum(AlarmLevel)
  severity?: AlarmLevel;

  @IsOptional()
  @IsEnum(AlertRuleMatchMode)
  matchMode?: AlertRuleMatchMode;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ouiPrefixes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ssids?: string[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  channels?: number[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  macAddresses?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  inventoryMacs?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-150)
  minRssi?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-150)
  maxRssi?: number | null;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  notifyVisual?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  notifyAudible?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  notifyEmail?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  emailRecipients?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  messageTemplate?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => AlertRuleMapStyleDto)
  mapStyle?: AlertRuleMapStyleDto | null;
}
