import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateSerialConfigDto {
  @IsOptional()
  @IsString()
  devicePath?: string | null;

  @IsOptional()
  @IsInt()
  @Min(300)
  @Max(921600)
  baud?: number | null;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(9)
  dataBits?: number | null;

  @IsOptional()
  @IsString()
  parity?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2)
  stopBits?: number | null;

  @IsOptional()
  @IsString()
  delimiter?: string | null;

  @IsOptional()
  @IsIn(['meshtastic-rewrite', 'raw-lines', 'nmea-like'])
  protocol?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  reconnectBaseMs?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  reconnectMaxMs?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  reconnectJitter?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  reconnectMaxAttempts?: number | null;

  @IsOptional()
  @IsIn(['plain', 'protobuf', 'meshcore'])
  sendMode?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(7)
  hopLimit?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(7)
  sendChannel?: number | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
