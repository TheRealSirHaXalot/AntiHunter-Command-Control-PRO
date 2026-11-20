import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DroneStatus } from '@prisma/client';
import { Subscription } from 'rxjs';

import { SerialService } from './serial.service';
import {
  SerialAlertEvent,
  SerialParseResult,
  SerialProbeHit,
  SerialTargetDetected,
} from './serial.types';
import { AlertRulesEngineService } from '../alert-rules/alert-rules-engine.service';
import { BaselineEventsService } from '../baseline-events/baseline-events.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CommandsService } from '../commands/commands.service';
import { DronesService } from '../drones/drones.service';
import { InventoryService } from '../inventory/inventory.service';
import { KnownRadiosService } from '../known-radios/known-radios.service';
import { NodesService } from '../nodes/nodes.service';
import { ProbeInventoryService } from '../probe-inventory/probe-inventory.service';
import { TakService } from '../tak/tak.service';
import { TargetsService } from '../targets/targets.service';
import { TargetTrackingService } from '../tracking/target-tracking.service';
import { TriangulationSessionService } from '../triangulation/triangulation-session.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { CommandCenterGateway } from '../ws/command-center.gateway';

const QUEUE_CLEARED_MESSAGE = 'Serial ingest queue cleared';

interface PendingTask<T = unknown> {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

class SerialIngestQueue {
  private readonly pending: PendingTask[] = [];

  private active = 0;

  constructor(private readonly concurrency: number) {}

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run: () => task(),
        resolve: resolve as PendingTask['resolve'],
        reject,
      });
      this.process();
    });
  }

  clear(): void {
    while (this.pending.length > 0) {
      const pending = this.pending.shift();
      pending?.reject(new Error(QUEUE_CLEARED_MESSAGE));
    }
  }

  get size(): number {
    return this.pending.length;
  }

  private process(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) {
        break;
      }
      this.active += 1;
      next
        .run()
        .then((result) => {
          next.resolve(result);
        })
        .catch((error) => {
          next.reject(error);
        })
        .finally(() => {
          this.active -= 1;
          this.process();
        });
    }
  }
}

@Injectable()
export class SerialIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SerialIngestService.name);
  private subscription?: Subscription;
  private static readonly DUPLICATE_WINDOW_MS = 500;
  private static readonly DUPLICATE_CACHE_MAX = 512;
  private readonly duplicateKeys = new Map<string, number>();
  private readonly ingestQueue: SerialIngestQueue;
  private readonly ingestHighWaterMark: number;
  private lastBacklogWarning = 0;
  private readonly recordDroneInventory: boolean;

  constructor(
    private readonly serialService: SerialService,
    private readonly nodesService: NodesService,
    private readonly inventoryService: InventoryService,
    private readonly commandsService: CommandsService,
    private readonly trackingService: TargetTrackingService,
    private readonly triangulationSessionService: TriangulationSessionService,
    private readonly gateway: CommandCenterGateway,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly takService: TakService,
    private readonly dronesService: DronesService,
    private readonly alertRulesEngine: AlertRulesEngineService,
    private readonly targetsService: TargetsService,
    private readonly probeInventoryService: ProbeInventoryService,
    private readonly campaignsService: CampaignsService,
    private readonly knownRadios: KnownRadiosService,
    private readonly baselineEvents: BaselineEventsService,
    configService: ConfigService,
  ) {
    const concurrency = Math.max(1, configService.get<number>('serial.ingestConcurrency', 1));
    this.ingestQueue = new SerialIngestQueue(concurrency);
    this.ingestHighWaterMark = Math.max(
      concurrency * 10,
      configService.get<number>('serial.ingestBuffer', 500),
    );
    this.recordDroneInventory = configService.get<boolean>('drones.recordInventory', false);
  }

  onModuleInit(): void {
    this.subscription = this.serialService.getParsedStream().subscribe((event) => {
      this.enqueueEvent(event);
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.ingestQueue.clear();
  }

  private enqueueEvent(event: SerialParseResult): void {
    const backlog = this.ingestQueue.size;
    if (backlog > this.ingestHighWaterMark) {
      const now = Date.now();
      if (now - this.lastBacklogWarning > 5000) {
        this.logger.warn(`Serial ingest backlog at ${backlog} events (processing queued)`);
        this.lastBacklogWarning = now;
      }
    }

    void this.ingestQueue
      .add(async () => {
        await this.handleEvent(event);
      })
      .catch((error) => {
        if (error instanceof Error && error.message === QUEUE_CLEARED_MESSAGE) {
          return;
        }
        this.logger.error(
          `Serial ingest failure: ${error instanceof Error ? error.message : error}`,
          error,
        );
      });
  }

  private async handleEvent(event: SerialParseResult): Promise<void> {
    const siteId = this.serialService.getSiteId();
    if (this.shouldFilterDuplicate(event, siteId)) {
      return;
    }

    switch (event.kind) {
      case 'node-telemetry':
        {
          const temperatureProvided =
            event.temperatureC !== undefined || event.temperatureF !== undefined;
          const temperatureUpdatedAt =
            event.temperatureUpdatedAt ??
            (temperatureProvided ? (event.timestamp ?? new Date()) : undefined);
          await this.nodesService.upsert({
            id: event.nodeId,
            name: event.nodeId,
            lat: event.lat ?? null,
            lon: event.lon ?? null,
            lastMessage: event.lastMessage,
            ts: event.timestamp ?? new Date(),
            lastSeen: event.timestamp ?? new Date(),
            siteId,
            temperatureC: event.temperatureC,
            temperatureF: event.temperatureF,
            temperatureUpdatedAt,
          });
          this.gateway.emitEvent({
            type: 'node.telemetry',
            nodeId: event.nodeId,
            lat: event.lat ?? null,
            lon: event.lon ?? null,
            raw: event.raw,
            siteId,
            temperatureC: event.temperatureC ?? null,
            temperatureF: event.temperatureF ?? null,
          });
          if (event.campaign !== undefined) {
            this.trackCampaign(event.nodeId, event.campaign, siteId);
          }
          void this.takService.streamNodeTelemetry({
            nodeId: event.nodeId,
            name: event.nodeId,
            lat: event.lat,
            lon: event.lon,
            message: event.lastMessage,
            siteId,
            timestamp: event.timestamp ?? new Date(),
          });
          void this.webhookDispatcher
            .dispatchNodeTelemetry(event, siteId)
            .catch((error) =>
              this.logger.warn(
                `Failed to dispatch node telemetry webhook: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
        }
        break;
      case 'target-detected':
        {
          const nodeSnapshot = event.nodeId
            ? this.nodesService.getSnapshotById(event.nodeId)
            : undefined;
          const detectionTime = new Date();
          const nodeLat = nodeSnapshot?.lat ?? undefined;
          const nodeLon = nodeSnapshot?.lon ?? undefined;
          const estimate = this.trackingService.ingestDetection({
            mac: event.mac,
            nodeId: event.nodeId,
            nodeLat,
            nodeLon,
            targetLat: event.lat,
            targetLon: event.lon,
            rssi: event.rssi,
            siteId,
            timestamp: detectionTime.getTime(),
            detectionTimestamp: event.detectionTimestamp,
          });

          const latForRecord = estimate?.lat ?? event.lat ?? nodeLat ?? undefined;
          const lonForRecord = estimate?.lon ?? event.lon ?? nodeLon ?? undefined;

          const detectionForPersistence: SerialTargetDetected = {
            ...event,
            lat: latForRecord,
            lon: lonForRecord,
            channel: event.channel,
          };

          await this.inventoryService.recordDetection(
            detectionForPersistence,
            siteId,
            nodeLat,
            nodeLon,
          );

          if (estimate?.shouldPersist) {
            await this.trackingService.persistEstimate(estimate.mac, estimate);
          }

          const trackingPayload = estimate
            ? {
                confidence: Number(estimate.confidence.toFixed(3)),
                spreadMeters: Number(estimate.spreadMeters.toFixed(2)),
                contributors: estimate.contributors.slice(0, 5),
                uniqueNodes: estimate.uniqueNodes,
                samples: estimate.samples,
              }
            : undefined;

          await this.alertRulesEngine.evaluateTargetDetection({
            event,
            siteId,
            nodeName: nodeSnapshot?.name ?? event.nodeId ?? undefined,
            nodeLat,
            nodeLon,
            lat: latForRecord ?? undefined,
            lon: lonForRecord ?? undefined,
            timestamp: detectionTime,
          });

          this.gateway.emitEvent({
            type: 'event.target',
            timestamp: detectionTime.toISOString(),
            nodeId: event.nodeId,
            mac: event.mac,
            rssi: event.rssi,
            deviceType: event.type,
            lat: latForRecord ?? nodeSnapshot?.lat ?? null,
            lon: lonForRecord ?? nodeSnapshot?.lon ?? null,
            channel: event.channel ?? null,
            confidence: trackingPayload?.confidence,
            tracking: trackingPayload,
            message: `Device ${event.mac} discovered (RSSI ${event.rssi ?? 'n/a'})`,
            raw: event.raw,
            siteId,
          });
          void this.takService.streamTargetDetection({
            mac: event.mac,
            nodeId: event.nodeId,
            lat: latForRecord ?? undefined,
            lon: lonForRecord ?? undefined,
            rssi: event.rssi,
            confidence: trackingPayload?.confidence,
            deviceType: event.type,
            message: `Device ${event.mac} discovered (RSSI ${event.rssi ?? 'n/a'})`,
            siteId,
          });
          void this.webhookDispatcher
            .dispatchTargetDetection(event, {
              siteId,
              timestamp: detectionTime,
              tracking: trackingPayload,
            })
            .catch((error) =>
              this.logger.warn(
                `Failed to dispatch target webhook: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
        }
        break;
      case 'device-seen':
        {
          const nodeSnapshot = event.nodeId
            ? this.nodesService.getSnapshotById(event.nodeId)
            : undefined;
          const asTarget: SerialTargetDetected = {
            kind: 'target-detected',
            nodeId: event.nodeId ?? 'unknown',
            mac: event.mac,
            rssi: event.rssi,
            type: event.type,
            name: event.name,
            channel: event.channel,
            raw: event.raw ?? '',
          };
          await this.inventoryService.recordDetection(
            asTarget,
            siteId,
            nodeSnapshot?.lat,
            nodeSnapshot?.lon,
          );
        }
        break;
      case 'alert':
        {
          if (this.knownRadios.observe(event)) {
            break;
          }
          const timestamp = new Date();
          const { lat, lon } = this.extractCoordinates(event);
          const { temperatureC, temperatureF } = this.extractAlertTemperatures(event);
          const temperatureProvided = temperatureC !== undefined || temperatureF !== undefined;
          const temperatureUpdatedAt = temperatureProvided ? timestamp : undefined;
          const sanitizedMessage = this.sanitizeMessage(event.message);
          const alertPayload = {
            type: 'event.alert' as const,
            timestamp: timestamp.toISOString(),
            level: event.level,
            category: event.category,
            nodeId: event.nodeId,
            message: sanitizedMessage,
            lat,
            lon,
            data: event.data,
            raw: event.raw,
            siteId,
          };
          this.gateway.emitEvent(alertPayload);
          void this.baselineEvents.record(alertPayload);
          const allowNodePositionUpdate = (() => {
            if (!event.category) return false;
            const normalized = event.category.toLowerCase();
            // Triangulation alerts contain target GPS, not node GPS. Avoid
            // overwriting the node snapshot with tracking estimates.
            return normalized === 'gps' || normalized === 'status';
          })();

          if (allowNodePositionUpdate && event.nodeId && lat != null && lon != null) {
            await this.nodesService.upsert({
              id: event.nodeId,
              name: event.nodeId,
              lat,
              lon,
              lastMessage: sanitizedMessage ?? event.message,
              ts: timestamp,
              lastSeen: timestamp,
              siteId,
              ...(temperatureProvided && {
                temperatureC,
                temperatureF,
                temperatureUpdatedAt,
              }),
            });
          }
          if (event.nodeId && !this.nodesService.getSnapshotById(event.nodeId)) {
            await this.nodesService.upsert({
              id: event.nodeId,
              name: event.nodeId,
              lastMessage: sanitizedMessage ?? event.message,
              ts: timestamp,
              lastSeen: timestamp,
              siteId,
            });
          }
          if (event.nodeId && (event.message || sanitizedMessage)) {
            await this.nodesService.updateLastMessage(
              event.nodeId,
              sanitizedMessage ?? event.message ?? '',
              timestamp,
              temperatureProvided
                ? {
                    temperatureC,
                    temperatureF,
                    temperatureUpdatedAt,
                  }
                : undefined,
            );
          }
          void this.takService.streamAlert({
            level: event.level,
            nodeId: event.nodeId,
            lat,
            lon,
            message: sanitizedMessage ?? event.message ?? '',
            category: event.category,
            siteId,
            timestamp,
          });
          void this.webhookDispatcher
            .dispatchNodeAlert(event, {
              siteId,
              lat,
              lon,
              message: sanitizedMessage ?? event.message ?? '',
            })
            .catch((error) =>
              this.logger.warn(
                `Failed to dispatch node alert webhook: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );

          if (event.category === 'campaign' && event.nodeId && event.data) {
            const campaign = event.data as { event?: string; name?: string | null };
            this.trackCampaign(
              event.nodeId,
              campaign.event === 'stop' ? null : (campaign.name ?? null),
              siteId,
            );
          }

          if (
            event.category?.toLowerCase() === 'triangulation' &&
            typeof event.data === 'object' &&
            event.data !== null
          ) {
            const triData = event.data as { stage?: string; mac?: string };
            if ((triData.stage === 'complete' || triData.stage === 'final') && triData.mac) {
              this.triangulationSessionService.stopSession(triData.mac, siteId);
            }
          }

          if (
            event.category?.toLowerCase() === 'triangulation' &&
            typeof event.data === 'object' &&
            event.data !== null &&
            'mac' in (event.data as Record<string, unknown>)
          ) {
            const triData = event.data as {
              mac?: unknown;
              lat?: unknown;
              lon?: unknown;
              rssi?: unknown;
              detectionTimestamp?: unknown;
              hdop?: unknown;
              stage?: unknown;
              type?: unknown;
            };

            const macFromData = triData.mac;
            const triLat = typeof triData.lat === 'number' ? triData.lat : undefined;
            const triLon = typeof triData.lon === 'number' ? triData.lon : undefined;
            const triRssi = typeof triData.rssi === 'number' ? triData.rssi : undefined;

            // Handle TARGET_DATA messages during triangulation
            const hasValidTriangulationPosition =
              triLat != null &&
              triLon != null &&
              Number.isFinite(triLat) &&
              Number.isFinite(triLon) &&
              !(triLat === 0 && triLon === 0);
            if (macFromData && hasValidTriangulationPosition && event.nodeId) {
              const macString = String(macFromData);
              const isTriangulationActive = this.triangulationSessionService.isActive(
                macString,
                siteId,
              );

              if (isTriangulationActive) {
                // During triangulation: T_D messages contain node GPS positions and timestamps.
                // T_F will provide final authoritative position with confidence/uncertainty
                try {
                  await this.targetsService.ensureTargetExists(macString, siteId);
                } catch (error) {
                  this.logger.warn(
                    `Failed to ensure target exists for ${macString}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }

                // Emit progress to WebSocket for UI display (detection event only, no position update)
                this.gateway.emitEvent({
                  type: 'triangulation.detection',
                  mac: macString,
                  nodeId: event.nodeId,
                  nodeLat: triLat,
                  nodeLon: triLon,
                  rssi: triRssi,
                  hits: typeof triData === 'object' && 'hits' in triData ? triData.hits : undefined,
                  siteId,
                  timestamp: timestamp.toISOString(),
                });

                this.logger.debug(
                  `Triangulation progress: ${macString} detected by ${event.nodeId} at ${triLat.toFixed(6)},${triLon.toFixed(6)} RSSI=${triRssi}`,
                );
              } else {
                // Auto-promote MAC to target if it doesn't exist and we see T_D from FW
                try {
                  await this.targetsService.ensureTargetExists(macString, siteId);
                } catch (error) {
                  this.logger.warn(
                    `Failed to ensure target exists for ${macString}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }

                // Update inventory without position calculation
                try {
                  await this.inventoryService.recordDetection(
                    {
                      kind: 'target-detected',
                      nodeId: event.nodeId,
                      mac: macString,
                      rssi: triRssi ?? 0,
                      type: triData.type ? String(triData.type) : undefined,
                      lat: triLat,
                      lon: triLon,
                      raw: event.raw,
                    },
                    siteId,
                    triLat,
                    triLon,
                  );
                } catch (error) {
                  this.logger.warn(
                    `Failed to update inventory for TARGET_DATA ${macString}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
              }
            }

            // Handle T_F (final) - PRIMARY source of triangulation results
            const isTriangulationFinal = triData.stage === 'final';
            if (isTriangulationFinal && macFromData) {
              const macString = String(macFromData);
              const finalLat = typeof triData.lat === 'number' ? triData.lat : undefined;
              const finalLon = typeof triData.lon === 'number' ? triData.lon : undefined;
              const confidence =
                typeof triData === 'object' &&
                'confidence' in triData &&
                typeof triData.confidence === 'number'
                  ? triData.confidence / 100.0
                  : undefined;
              const uncertainty =
                typeof triData === 'object' &&
                'uncertainty' in triData &&
                typeof triData.uncertainty === 'number'
                  ? triData.uncertainty
                  : undefined;

              if (finalLat != null && finalLon != null) {
                this.logger.log(
                  `Triangulation FINAL for ${macString}: ${finalLat.toFixed(6)},${finalLon.toFixed(6)} ` +
                    `confidence=${confidence?.toFixed(2)} uncertainty=${uncertainty?.toFixed(1)}m`,
                );

                await this.targetsService
                  .applyTrackingEstimate(
                    macString,
                    finalLat,
                    finalLon,
                    siteId,
                    confidence,
                    uncertainty,
                    'firmware-triangulation',
                  )
                  .catch((error) =>
                    this.logger.warn(
                      `Failed to apply T_F result for ${macString}: ${
                        error instanceof Error ? error.message : String(error)
                      }`,
                    ),
                  );

                // Notify clients
                this.gateway.emitEvent({
                  type: 'triangulation.complete',
                  mac: macString,
                  lat: finalLat,
                  lon: finalLon,
                  confidence,
                  uncertainty,
                  method: 'firmware',
                  siteId,
                });
              }
            }

            // Handle T_C (complete) - Fallback for older firmware or progress updates
            const isTriangulationComplete = triData.stage === 'complete';
            if (isTriangulationComplete && macFromData && lat != null && lon != null) {
              const macString = String(macFromData);
              this.logger.debug(
                `Triangulation COMPLETE (T_C) for ${macString}: ${lat.toFixed(6)},${lon.toFixed(6)}`,
              );
              // T_C is informational - T_F should be the primary update
              // Only apply if we haven't received T_F yet
              void this.targetsService
                .applyTrackingEstimate(macString, lat, lon, siteId)
                .catch((error) =>
                  this.logger.warn(
                    `Failed to apply T_C result for ${macString}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  ),
                );
            }
          }
        }
        break;
      case 'command-ack':
        await this.commandsService.handleAck(event);
        this.gateway.emitEvent({
          type: 'command.ack',
          nodeId: event.nodeId,
          ackType: event.ackType,
          status: event.status,
          raw: event.raw,
          siteId,
        });
        void this.takService.streamCommandAck({
          nodeId: event.nodeId,
          ackType: event.ackType,
          status: event.status,
          siteId,
          timestamp: new Date(),
        });
        void this.webhookDispatcher
          .dispatchCommandAck(event, siteId)
          .catch((error) =>
            this.logger.warn(
              `Failed to dispatch command ACK webhook: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        break;
      case 'command-result':
        await this.commandsService.handleResult(event);
        this.gateway.emitEvent({
          type: 'command.result',
          nodeId: event.nodeId,
          command: event.command,
          payload: event.payload,
          raw: event.raw,
          siteId,
        });
        void this.takService.streamCommandResult({
          nodeId: event.nodeId,
          command: event.command,
          siteId,
          result: event.payload,
          timestamp: new Date(),
        });
        void this.webhookDispatcher
          .dispatchCommandResult(event, siteId)
          .catch((error) =>
            this.logger.warn(
              `Failed to dispatch command result webhook: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        break;
      case 'drone-telemetry':
        {
          const timestamp = event.timestamp ?? new Date();
          const nodeSnapshot = event.nodeId
            ? this.nodesService.getSnapshotById(event.nodeId)
            : undefined;
          const resolvedSiteId = nodeSnapshot?.siteId ?? siteId;
          const reportingNodeId = nodeSnapshot?.id ?? null;
          const existingDrone = this.dronesService.getSnapshotById(event.droneId);
          const nextStatus = existingDrone?.status ?? DroneStatus.UNKNOWN;

          const droneSnapshot = await this.dronesService.upsert({
            id: event.droneId,
            droneId: event.droneId,
            mac: event.mac ?? null,
            nodeId: reportingNodeId,
            siteId: resolvedSiteId,
            originSiteId: resolvedSiteId ?? siteId ?? null,
            siteName: nodeSnapshot?.siteName ?? null,
            siteColor: nodeSnapshot?.siteColor ?? null,
            siteCountry: nodeSnapshot?.siteCountry ?? null,
            siteCity: nodeSnapshot?.siteCity ?? null,
            lat: event.lat,
            lon: event.lon,
            altitude: event.altitude ?? null,
            speed: event.speed ?? null,
            operatorLat: event.operatorLat ?? null,
            operatorLon: event.operatorLon ?? null,
            rssi: event.rssi ?? null,
            lastSeen: timestamp,
            ts: timestamp,
            status: nextStatus,
          });

          if (this.recordDroneInventory && event.mac && event.nodeId) {
            await this.inventoryService.recordDetection(
              {
                kind: 'target-detected',
                nodeId: event.nodeId,
                mac: event.mac,
                rssi: event.rssi,
                type: 'Drone',
                lat: event.lat,
                lon: event.lon,
                raw: event.raw,
              },
              resolvedSiteId,
              event.lat,
              event.lon,
            );
          }

          this.gateway.emitEvent({
            type: 'drone.telemetry',
            droneId: event.droneId,
            mac: event.mac ?? null,
            nodeId: reportingNodeId ?? event.nodeId ?? null,
            lat: event.lat,
            lon: event.lon,
            altitude: event.altitude ?? null,
            speed: event.speed ?? null,
            operatorLat: event.operatorLat ?? null,
            operatorLon: event.operatorLon ?? null,
            rssi: event.rssi ?? null,
            siteId: resolvedSiteId,
            siteName: nodeSnapshot?.siteName ?? null,
            siteColor: nodeSnapshot?.siteColor ?? null,
            siteCountry: nodeSnapshot?.siteCountry ?? null,
            siteCity: nodeSnapshot?.siteCity ?? null,
            originSiteId: droneSnapshot.originSiteId ?? resolvedSiteId ?? null,
            timestamp: timestamp.toISOString(),
            status: droneSnapshot.status,
            faa: droneSnapshot.faa ?? null,
          });
          void this.webhookDispatcher
            .dispatchDroneTelemetry(event, {
              siteId: resolvedSiteId,
              nodeId: reportingNodeId ?? event.nodeId ?? null,
              timestamp,
            })
            .catch((error) =>
              this.logger.warn(
                `Failed to dispatch drone telemetry webhook: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
        }
        break;
      case 'probe-hit': {
        const probeEvent = event as SerialProbeHit;
        const device = this.probeInventoryService.record(probeEvent, siteId);

        const asTarget: SerialTargetDetected = {
          kind: 'target-detected',
          nodeId: probeEvent.nodeId ?? 'unknown',
          mac: probeEvent.mac,
          rssi: probeEvent.rssi,
          type: 'WiFi',
          name: probeEvent.ssid,
          probe: true,
          channel: probeEvent.channel,
          lat: probeEvent.lat,
          lon: probeEvent.lon,
          raw: probeEvent.raw,
        };
        const nodeSnapshot = probeEvent.nodeId
          ? this.nodesService.getSnapshotById(probeEvent.nodeId)
          : undefined;
        await this.inventoryService.recordDetection(
          asTarget,
          siteId,
          nodeSnapshot?.lat,
          nodeSnapshot?.lon,
        );

        this.gateway.emitEvent({
          type: 'event.probe-hit',
          timestamp: new Date().toISOString(),
          nodeId: probeEvent.nodeId,
          mac: probeEvent.mac,
          vendor: probeEvent.vendor ?? null,
          isRandomized: probeEvent.isRandomized,
          rssi: probeEvent.rssi,
          channel: probeEvent.channel ?? null,
          ssid: probeEvent.ssid ?? null,
          isGhost: probeEvent.isGhost,
          isDst: probeEvent.isDst,
          hits: device.hits,
          siteId,
          raw: probeEvent.raw,
        });

        this.gateway.emitEvent({
          type: 'event.target',
          timestamp: new Date().toISOString(),
          nodeId: probeEvent.nodeId,
          mac: probeEvent.mac,
          rssi: probeEvent.rssi,
          deviceType: 'WiFi',
          lat: probeEvent.lat ?? nodeSnapshot?.lat ?? null,
          lon: probeEvent.lon ?? nodeSnapshot?.lon ?? null,
          channel: probeEvent.channel ?? null,
          message: `Probe ${probeEvent.mac} (RSSI ${probeEvent.rssi})`,
          raw: probeEvent.raw,
          siteId,
        });
        break;
      }
      case 'raw':
      default:
        this.gateway.emitEvent({ type: 'raw', raw: event.raw });
        void this.webhookDispatcher
          .dispatchRawFrame(event, siteId)
          .catch((error) =>
            this.logger.warn(
              `Failed to dispatch raw serial webhook: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        break;
    }
  }

  private trackCampaign(nodeId: string, name: string | null, siteId: string | null): void {
    void this.campaignsService
      .reconcile(nodeId, name, siteId)
      .catch((error) =>
        this.logger.warn(
          `Failed to record campaign state for ${nodeId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  }

  private shouldFilterDuplicate(event: SerialParseResult, siteId: string | null): boolean {
    if (event.kind === 'node-telemetry') {
      return false;
    }
    const key = this.buildDuplicateKey(event, siteId);
    if (!key) {
      return false;
    }
    const now = Date.now();
    const lastSeen = this.duplicateKeys.get(key);
    if (lastSeen && now - lastSeen < SerialIngestService.DUPLICATE_WINDOW_MS) {
      return true;
    }
    this.duplicateKeys.set(key, now);
    if (this.duplicateKeys.size > SerialIngestService.DUPLICATE_CACHE_MAX) {
      const cutoff = now - SerialIngestService.DUPLICATE_WINDOW_MS;
      for (const [candidate, ts] of this.duplicateKeys.entries()) {
        if (ts < cutoff || this.duplicateKeys.size > SerialIngestService.DUPLICATE_CACHE_MAX) {
          this.duplicateKeys.delete(candidate);
        }
        if (this.duplicateKeys.size <= SerialIngestService.DUPLICATE_CACHE_MAX) {
          break;
        }
      }
    }
    return false;
  }

  private parseNumeric(value: unknown): number | undefined {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private extractCoordinates(event: SerialAlertEvent): { lat?: number; lon?: number } {
    const latValue = typeof event.data?.lat === 'number' ? event.data.lat : undefined;
    const lonValue = typeof event.data?.lon === 'number' ? event.data.lon : undefined;
    if (latValue != null && lonValue != null) {
      return { lat: latValue, lon: lonValue };
    }
    const text = event.message ?? event.raw ?? '';
    const coordinateRegex =
      /GPS(?:[:=\s]+[A-Z]+[\s:]*)?(?:[A-Za-z0-9_-]+\s+)?(?<lat>-?\d+(?:\.\d+)?)(?:\s*(?:deg)?\s*(?<latDir>[NnSs]))?,\s*(?<lon>-?\d+(?:\.\d+)?)(?:\s*(?:deg)?\s*(?<lonDir>[EeWw]))?/;
    const match = coordinateRegex.exec(text);
    if (!match?.groups) {
      return {};
    }
    const latParsed = Number(match.groups.lat);
    const lonParsed = Number(match.groups.lon);
    if (!Number.isFinite(latParsed) || !Number.isFinite(lonParsed)) {
      return {};
    }
    const latDir = match.groups.latDir?.toUpperCase();
    const lonDir = match.groups.lonDir?.toUpperCase();
    const latFinal =
      latDir === 'S' ? -Math.abs(latParsed) : latDir === 'N' ? Math.abs(latParsed) : latParsed;
    const lonFinal =
      lonDir === 'W' ? -Math.abs(lonParsed) : lonDir === 'E' ? Math.abs(lonParsed) : lonParsed;
    return { lat: latFinal, lon: lonFinal };
  }

  private extractAlertTemperatures(event: SerialAlertEvent): {
    temperatureC?: number;
    temperatureF?: number;
  } {
    const temperatureC = this.parseNumeric(event.data?.tempC ?? event.data?.temperatureC);
    const temperatureF = this.parseNumeric(event.data?.tempF ?? event.data?.temperatureF);
    if (temperatureC !== undefined || temperatureF !== undefined) {
      return { temperatureC, temperatureF };
    }
    const text = event.message ?? event.raw ?? '';
    const tempRegex =
      /temp(?:erature)?[:=\s]*(?<c>-?\d+(?:\.\d+)?)\s*(?:°?\s*C)?(?:\s*\/\s*(?<f>-?\d+(?:\.\d+)?)\s*(?:°?\s*F)?)?/i;
    const match = tempRegex.exec(text);
    if (!match?.groups) {
      return {};
    }
    const parsedC = match.groups.c ? Number(match.groups.c) : undefined;
    const parsedF = match.groups.f ? Number(match.groups.f) : undefined;
    return {
      temperatureC: Number.isFinite(parsedC) ? parsedC : undefined,
      temperatureF: Number.isFinite(parsedF) ? parsedF : undefined,
    };
  }

  private buildDuplicateKey(event: SerialParseResult, siteId: string | null): string | null {
    switch (event.kind) {
      case 'alert': {
        const dataTime = this.extractAlertTimestamp(event.data);
        return [
          'alert',
          siteId ?? 'local',
          event.nodeId ?? 'unknown',
          event.category ?? 'generic',
          event.message ?? '',
          dataTime ?? '',
        ].join(':');
      }
      case 'target-detected':
        return [
          'target',
          siteId ?? 'local',
          event.nodeId ?? 'unknown',
          event.mac,
          event.channel ?? 'na',
          event.type ?? '',
        ].join(':');
      case 'device-seen':
        return ['device', siteId ?? 'local', event.nodeId ?? 'unknown', event.mac].join(':');
      case 'probe-hit':
        return [
          'probe',
          siteId ?? 'local',
          event.nodeId ?? 'unknown',
          event.mac,
          event.ssid ?? '',
        ].join(':');
      case 'command-ack':
        return ['ack', event.nodeId ?? 'unknown', event.ackType, event.status].join(':');
      case 'command-result':
        return ['result', event.nodeId ?? 'unknown', event.command, event.payload].join(':');
      case 'raw':
        return ['raw', event.raw].join(':');
      default:
        return null;
    }
  }

  private extractAlertTimestamp(data?: Record<string, unknown>): string | undefined {
    if (!data) {
      return undefined;
    }
    if (typeof data.time === 'string') {
      return data.time;
    }
    const withTs = data as { ts?: unknown };
    if (typeof withTs.ts === 'string') {
      return withTs.ts;
    }
    return undefined;
  }

  private sanitizeMessage(value?: string | null): string | undefined {
    if (!value) {
      return value ?? undefined;
    }
    return value.replace(/\/?undefinedf\b/gi, '').trim();
  }
}
