import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpdateRemoteAlertConfigDto {
  @IsOptional()
  @IsBoolean()
  tailscaleEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tsAuthKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  tsHostname?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  tsAllowedLogins?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(320)
  vapidSubject?: string;

  @IsOptional()
  @IsBoolean()
  ntfyEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  ntfyUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  ntfyToken?: string;

  @IsOptional()
  @IsBoolean()
  signalEnabled?: boolean;

  // clients cannot redirect Signal: number, apiUrl and recipients are set server-side only

  @IsOptional()
  @IsBoolean()
  matrixEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  matrixHomeserverUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  matrixAccessToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  matrixRoomId?: string;

  @IsOptional()
  @IsBoolean()
  matterEnabled?: boolean;

  @IsOptional()
  @IsIn(['bridge', 'flat'])
  matterLayout?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_.:-]*$/)
  matterInterface?: string;

  @IsOptional()
  @IsObject()
  alertTiers?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  coordsUnencrypted?: boolean;
}
