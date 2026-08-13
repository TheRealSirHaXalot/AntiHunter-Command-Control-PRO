import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateBaselineConfigDto {
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(43_200)
  rollingWindowMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_440)
  gapThresholdMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100)
  frequentFlierVisits?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_080)
  visitorAbsenceMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  stationaryPresencePct?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_440)
  autoClassifyMinutes?: number;
}
