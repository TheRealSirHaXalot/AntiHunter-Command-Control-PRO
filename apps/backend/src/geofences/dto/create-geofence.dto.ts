import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsHexColor,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { GeofenceAlarmConfigDto } from './alarm-config.dto';
import { GeofenceVertexDto } from './geofence-vertex.dto';

export class CreateGeofenceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  siteId?: string | null;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GeofenceVertexDto)
  @ArrayMinSize(3)
  polygon!: GeofenceVertexDto[];

  @IsDefined()
  @ValidateNested()
  @Type(() => GeofenceAlarmConfigDto)
  alarm!: GeofenceAlarmConfigDto;

  @IsOptional()
  @IsBoolean()
  appliesToAdsb?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesToDrones?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesToTargets?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesToDevices?: boolean;
}
