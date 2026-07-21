import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type {
  AlarmLevel,
  Drone,
  DroneStatus,
  FaaAircraftSummary,
  Geofence,
  ChatMessage,
  Target,
  ChatClearEvent,
  AdsbTrack,
  AcarsMessage,
} from '../api/types';
import { sentinelDetectionLabel } from '../data/sentinel';
import { useAlarm } from '../providers/alarm-provider';
import { useSocket } from '../providers/socket-provider';
import { useAdsbStore } from '../stores/adsb-store';
import { useAlertStore } from '../stores/alert-store';
import { useAuthStore } from '../stores/auth-store';
import { useChatKeyStore } from '../stores/chat-key-store';
import { useChatStore } from '../stores/chat-store';
import { useDroneStore } from '../stores/drone-store';
import { useGeofenceStore } from '../stores/geofence-store';
import type { GeofenceEvent } from '../stores/geofence-store';
import { useMapPreferences } from '../stores/map-store';
import { canonicalNodeId, NodeDiffPayload, NodeSummary, useNodeStore } from '../stores/node-store';
import { useProbeStore } from '../stores/probe-store';
import { useSentinelStore } from '../stores/sentinel-store';
import { TerminalEntry, TerminalLevel, useTerminalStore } from '../stores/terminal-store';
import { useTrackingBannerStore } from '../stores/tracking-banner-store';
import { useTrackingSessionStore } from '../stores/tracking-session-store';
import { useTriangulationStore } from '../stores/triangulation-store';
import { decryptText } from '../utils/chat-crypto';

const NOTIFICATION_CATEGORIES = new Set(['gps', 'status', 'console']);
const DEVICE_LINE_REGEX =
  /^(?:[A-Za-z0-9_-]+):?\s*DEVICE:(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}(?:\s+[A-Za-z0-9]+)?\s+-?\d+/i;
const DEVICE_FALLBACK_REGEX = /^[A-Za-z0-9_-]+\s+DEVICE:?$/i;
const HTTP_LINK_REGEX = /^https?:\/\//i;

type TerminalEntryInput = Omit<TerminalEntry, 'id' | 'timestamp'> & { timestamp?: string };

export function SocketBridge() {
  const socket = useSocket();
  const queryClient = useQueryClient();
  const { play, playDroneGeofence, playDroneTelemetry } = useAlarm();
  const setInitialNodes = useNodeStore((state) => state.setInitialNodes);
  const applyDiff = useNodeStore((state) => state.applyDiff);
  const addEntry = useTerminalStore((state) => state.addEntry);
  const triggerAlert = useAlertStore((state) => state.triggerAlert);
  const setDrones = useDroneStore((state) => state.setDrones);
  const upsertDrone = useDroneStore((state) => state.upsert);
  const appendDroneTrail = useDroneStore((state) => state.appendTrailPoint);
  const removeDrone = useDroneStore((state) => state.remove);
  const setDroneStatus = useDroneStore((state) => state.setStatus);
  const addChatIncoming = useChatStore((state) => state.addIncoming);
  const appendAdsbTrail = useAdsbStore((state) => state.appendTrailPoint);
  const pruneAdsbTrails = useAdsbStore((state) => state.pruneInactiveTracks);
  const addProbeHit = useProbeStore((state) => state.addHit);

  useEffect(() => {
    if (!socket) {
      return;
    }

    const currentUser = useAuthStore.getState().user;

    const handleInit = (payload: unknown) => {
      if (isInitPayload(payload)) {
        setInitialNodes(payload.nodes);
        if (Array.isArray(payload.geofences)) {
          useGeofenceStore.getState().setGeofences(payload.geofences);
        }
        if (Array.isArray(payload.drones)) {
          setDrones(payload.drones);
        }
      }
    };

    const emitGeofenceEvents = (events: GeofenceEvent[], siteId?: string | null) => {
      events.forEach((event) => {
        const entry: TerminalEntryInput = {
          message: `Geofence ${event.geofenceName} (${event.transition.toUpperCase()}): ${event.message}`,
          level: alarmLevelToTerminal(event.level),
          source: 'geofence',
        };
        addEntry(entry);
        triggerAlert({
          nodeId: event.entityId,
          siteId: siteId ?? undefined,
          category: 'geofence',
          level: event.level,
          message: event.message,
          lat: event.lat,
          lon: event.lon,
          timestamp: new Date().toISOString(),
        });
        if (event.entityType === 'drone') {
          playDroneGeofence();
        } else {
          play(event.level);
        }
      });
    };

    const handleNodeDiff = (payload: unknown) => {
      if (isNodeDiffPayload(payload)) {
        applyDiff(payload);

        if (payload.type === 'upsert') {
          const state = useNodeStore.getState();
          const node = state.nodes[canonicalNodeId(payload.node.id)];
          if (node) {
            const geofenceEvents = useGeofenceStore.getState().processNodePosition(node);
            emitGeofenceEvents(geofenceEvents, node.siteId ?? undefined);
          }
        }
      }
    };

    const handleChatEvent = async (payload: unknown) => {
      if (!isChatMessage(payload)) {
        return;
      }
      const isFromSelf =
        (currentUser?.id && payload.fromUserId === currentUser.id) ||
        (currentUser?.email && payload.fromEmail === currentUser.email);
      if (isFromSelf) {
        return;
      }
      const siteKey =
        payload.siteId && typeof payload.siteId === 'string'
          ? useChatKeyStore.getState().getKey()
          : undefined;
      let text = payload.text ?? '';
      let decryptError = false;
      if (payload.encrypted) {
        if (payload.cipherText && siteKey) {
          try {
            text = await decryptText(siteKey, payload.cipherText);
          } catch {
            decryptError = true;
            text = payload.text ?? '[Encrypted]';
          }
        } else {
          decryptError = true;
          text = payload.text ?? '[Encrypted]';
        }
      }
      const ts = Date.parse(payload.ts);
      addChatIncoming({
        id: payload.id,
        text,
        from: payload.fromDisplayName ?? payload.fromEmail ?? 'Operator',
        role: payload.fromRole,
        siteId: payload.siteId,
        ts: Number.isFinite(ts) ? ts : Date.now(),
        encrypted: payload.encrypted,
        cipherText: payload.cipherText,
        decryptError,
      });
    };

    const handleEvent = (payload: unknown) => {
      // Handle real-time tracking updates from TDOA/RSSI triangulation
      if (isTrackingUpdateEvent(payload)) {
        const normalizedMac = normalizeMacKey(payload.mac);

        let changed = false;
        // Update target position in query cache
        queryClient.setQueryData(['targets'], (previous: Target[] | undefined) => {
          if (!previous) {
            return previous;
          }
          const next = previous.map((target) => {
            if (!target.mac) {
              return target;
            }
            const macKey = normalizeMacKey(target.mac);
            if (macKey !== normalizedMac) {
              return target;
            }
            const confidence = payload.confidence ?? target.trackingConfidence ?? null;
            if (
              Math.abs(target.lat - payload.lat) > 1e-6 ||
              Math.abs(target.lon - payload.lon) > 1e-6 ||
              (confidence ?? null) !== (target.trackingConfidence ?? null)
            ) {
              changed = true;
              return {
                ...target,
                lat: payload.lat,
                lon: payload.lon,
                trackingConfidence: confidence,
                updatedAt: new Date().toISOString(),
              };
            }
            return target;
          });
          return changed ? next : previous;
        });

        if (changed) {
          void queryClient.invalidateQueries({ queryKey: ['targets'] });
        }

        // Update triangulation store with method and confidence
        useTriangulationStore.getState().complete({
          mac: payload.mac,
          lat: payload.lat,
          lon: payload.lon,
          confidence: payload.confidence,
          contributors: payload.contributors,
        });

        return;
      }

      // Handle live triangulation detections for Hollywood-style animations
      if (isTriangulationDetectionEvent(payload)) {
        useTriangulationStore.getState().addDetection({
          nodeId: payload.nodeId,
          nodeLat: payload.nodeLat,
          nodeLon: payload.nodeLon,
          rssi: payload.rssi,
          hits: payload.hits,
          timestamp: Date.now(),
          lat: payload.lat,
          lon: payload.lon,
        });
        return;
      }

      // Handle triangulation complete (T_F final result)
      if (isTriangulationCompleteEvent(payload)) {
        const normalizedMac = normalizeMacKey(payload.mac);

        // Update target with final position and stats
        queryClient.setQueryData(['targets'], (previous: Target[] | undefined) => {
          if (!previous) {
            return previous;
          }
          const next = previous.map((target) => {
            if (!target.mac) {
              return target;
            }
            const macKey = normalizeMacKey(target.mac);
            if (macKey !== normalizedMac) {
              return target;
            }
            return {
              ...target,
              lat: payload.lat,
              lon: payload.lon,
              trackingConfidence: payload.confidence ?? null,
              trackingUncertainty: payload.uncertainty ?? null,
              triangulationMethod: payload.method ?? null,
              updatedAt: new Date().toISOString(),
            };
          });
          return next;
        });

        void queryClient.invalidateQueries({ queryKey: ['targets'] });

        // Update triangulation store with final result
        useTriangulationStore.getState().complete({
          mac: payload.mac,
          lat: payload.lat,
          lon: payload.lon,
          confidence: payload.confidence,
        });

        return;
      }

      if (isAdsbTracksEvent(payload)) {
        // Check if ADS-B addon is enabled for this user
        const adsbAddonEnabled = currentUser?.preferences?.notifications?.addons?.adsb ?? false;
        if (!adsbAddonEnabled) {
          return; // Skip processing if addon is disabled
        }

        // Keep only tracks that can be plotted (valid position and id); do NOT drop
        // tracks just because callsign/registration is missing.
        const filteredTracks = payload.tracks.filter(
          (track) =>
            typeof track.id === 'string' &&
            Number.isFinite(track.lat) &&
            Number.isFinite(track.lon),
        );

        // Update ADSB trails
        const activeIds = new Set<string>();
        filteredTracks.forEach((track) => {
          activeIds.add(track.id);
          appendAdsbTrail(track.id, {
            lat: track.lat,
            lon: track.lon,
            ts: track.lastSeen,
          });
        });
        pruneAdsbTrails(activeIds);

        const adsbMuted = useMapPreferences.getState().adsbMuted;
        if (!adsbMuted) {
          addEntry({
            message: `ADS-B tracks updated: ${filteredTracks.length} aircraft`,
            level: 'info',
            source: 'adsb',
            timestamp: new Date().toISOString(),
          });
        }
        queryClient.setQueryData(['adsb', 'tracks'], filteredTracks);
        return;
      }
      if (isAcarsMessagesEvent(payload)) {
        // Check if ACARS addon is enabled for this user
        const acarsAddonEnabled = currentUser?.preferences?.notifications?.addons?.acars ?? false;
        if (!acarsAddonEnabled) {
          return; // Skip processing if addon is disabled
        }

        const acarsMuted = useMapPreferences.getState().acarsMuted;
        if (!acarsMuted && payload.messages.length > 0) {
          payload.messages.forEach((msg) => {
            const label = msg.flight || msg.tail;
            const textPreview = msg.text
              ? msg.text.length > 50
                ? `${msg.text.substring(0, 47)}...`
                : msg.text
              : '';
            const labelInfo = msg.label ? ` [${msg.label}]` : '';
            const freqInfo = msg.frequency ? ` ${msg.frequency.toFixed(3)}MHz` : '';
            const signalInfo = msg.signalLevel ? ` ${msg.signalLevel.toFixed(1)}dB` : '';

            addEntry({
              message: `ACARS ${label}${labelInfo}${freqInfo}${signalInfo}${textPreview ? `: ${textPreview}` : ''}`,
              level: 'info',
              source: 'acars',
              timestamp: msg.timestamp,
            });
          });
        }
        queryClient.setQueryData(['acars', 'messages'], payload.messages);
        return;
      }
      if (isGeofenceAlertEvent(payload)) {
        const data = (payload as { data?: { geofenceId?: string } }).data;
        const geofenceId = (payload as { geofenceId?: string }).geofenceId ?? data?.geofenceId;
        if (geofenceId) {
          useGeofenceStore.getState().setHighlighted(geofenceId, 5000);
        }
      }
      if (isChatClearEvent(payload)) {
        useChatStore.getState().clearAllRemote();
        return;
      }
      if (isChatMessage(payload)) {
        void handleChatEvent(payload);
        return;
      }
      if (isDroneTelemetryEvent(payload)) {
        const timestamp = payload.timestamp ?? new Date().toISOString();
        upsertDrone({
          id: payload.droneId,
          droneId: payload.droneId,
          mac: payload.mac ?? null,
          nodeId: payload.nodeId ?? null,
          siteId: payload.siteId ?? null,
          originSiteId: payload.originSiteId ?? payload.siteId ?? null,
          siteName: payload.siteName ?? null,
          siteColor: payload.siteColor ?? null,
          siteCountry: payload.siteCountry ?? null,
          siteCity: payload.siteCity ?? null,
          lat: payload.lat,
          lon: payload.lon,
          altitude: payload.altitude ?? null,
          speed: payload.speed ?? null,
          operatorLat: payload.operatorLat ?? null,
          operatorLon: payload.operatorLon ?? null,
          rssi: payload.rssi ?? null,
          status: normalizeDroneStatus(payload.status),
          faa: payload.faa ?? null,
          lastSeen: timestamp,
        });

        const geofenceEvents = useGeofenceStore.getState().processCoordinateEvent({
          entityId: payload.droneId,
          entityLabel: payload.droneId,
          entityType: 'drone',
          lat: payload.lat,
          lon: payload.lon,
        });
        emitGeofenceEvents(geofenceEvents, payload.siteId ?? undefined);

        appendDroneTrail(payload.droneId, {
          lat: payload.lat,
          lon: payload.lon,
          ts: timestamp,
        });

        const macSegment = payload.mac ? ` MAC:${payload.mac}` : '';
        const rssiSegment = payload.rssi != null ? ` RSSI:${payload.rssi}dBm` : '';
        const altitudeSegment = payload.altitude != null ? ` ALT:${payload.altitude}m` : '';
        const speedSegment = payload.speed != null ? ` SPD:${payload.speed}m/s` : '';
        const operatorSegment =
          payload.operatorLat != null && payload.operatorLon != null
            ? ` OP:${payload.operatorLat.toFixed(6)},${payload.operatorLon.toFixed(6)}`
            : '';
        const viaSegment = payload.nodeId ? ` via ${payload.nodeId}` : '';
        const message = `Drone ${payload.droneId}${viaSegment} GPS:${payload.lat.toFixed(6)},${payload.lon.toFixed(
          6,
        )}${altitudeSegment}${speedSegment}${rssiSegment}${operatorSegment}${macSegment}`;

        addEntry({
          message,
          level: 'alert',
          source: 'drone',
          timestamp,
          siteId: payload.siteId ?? undefined,
        });

        triggerAlert({
          nodeId: payload.nodeId ?? payload.droneId,
          siteId: payload.siteId ?? undefined,
          category: 'drone',
          level: 'ALERT',
          message,
          lat: payload.lat,
          lon: payload.lon,
          timestamp,
        });

        playDroneTelemetry();
        return;
      }

      if (isDroneStatusEvent(payload)) {
        setDroneStatus(payload.droneId, payload.status);
        const state = useDroneStore.getState();
        const existing = state.map[payload.droneId] ?? null;
        if (payload.faa || existing) {
          upsertDrone({
            id: payload.id ?? payload.droneId,
            droneId: payload.droneId,
            lat: payload.lat ?? existing?.lat ?? 0,
            lon: payload.lon ?? existing?.lon ?? 0,
            lastSeen: payload.timestamp ?? existing?.lastSeen ?? new Date().toISOString(),
            status: payload.status,
            faa: payload.faa ?? existing?.faa ?? null,
            mac: existing?.mac ?? null,
            nodeId: existing?.nodeId ?? null,
            siteId: payload.siteId ?? existing?.siteId ?? null,
            originSiteId: payload.originSiteId ?? existing?.originSiteId ?? null,
            siteName: existing?.siteName ?? null,
            siteColor: existing?.siteColor ?? null,
            siteCountry: existing?.siteCountry ?? null,
            siteCity: existing?.siteCity ?? null,
            altitude: existing?.altitude ?? null,
            speed: existing?.speed ?? null,
            operatorLat: existing?.operatorLat ?? null,
            operatorLon: existing?.operatorLon ?? null,
            rssi: existing?.rssi ?? null,
          });
        }
        return;
      }

      if (isDroneRemovalEvent(payload)) {
        removeDrone(payload.droneId);
        return;
      }

      if (isProbeHitEvent(payload)) {
        addProbeHit({
          mac: payload.mac,
          vendor: payload.vendor,
          isRandomized: payload.isRandomized,
          rssi: payload.rssi,
          channel: payload.channel,
          ssid: payload.ssid,
          isGhost: payload.isGhost,
          isDst: payload.isDst,
          hits: payload.hits,
          nodeId: payload.nodeId ?? undefined,
          siteId: payload.siteId,
          timestamp: payload.timestamp ?? new Date().toISOString(),
        });
        const label = payload.vendor ?? (payload.isRandomized ? 'Randomized' : payload.mac);
        addEntry({
          message: `Probe: ${payload.mac} [${label}] RSSI:${payload.rssi}${payload.ssid ? ` SSID:${payload.ssid}` : ''}${payload.isGhost ? ' GHOST' : ''}`,
          level: 'info',
          source: 'inventory',
          timestamp: payload.timestamp,
          siteId: payload.siteId ?? undefined,
        });
        return;
      }

      const entry = parseEventPayload(payload, {
        onTriangulationComplete: () => {
          void queryClient.invalidateQueries({ queryKey: ['targets'] });
        },
      });
      if (entry) {
        addEntry(entry);
      }
      const alarmLevel = extractAlarmLevel(payload);
      if (alarmLevel) {
        const playbackLevel: AlarmLevel = alarmLevel === 'CRITICAL' ? 'ALERT' : alarmLevel;
        play(playbackLevel);
      }

      const targetDetails = extractTargetDetails(payload);
      if (targetDetails) {
        let targetChanged = false;
        if (
          targetDetails.mac &&
          typeof targetDetails.lat === 'number' &&
          typeof targetDetails.lon === 'number' &&
          Number.isFinite(targetDetails.lat) &&
          Number.isFinite(targetDetails.lon)
        ) {
          const normalizedMac = normalizeMacKey(targetDetails.mac);
          queryClient.setQueryData(['targets'], (previous: Target[] | undefined) => {
            if (!previous) {
              return previous;
            }
            let changed = false;
            const next = previous.map((target) => {
              if (!target.mac) {
                return target;
              }
              const macKey = normalizeMacKey(target.mac);
              if (macKey !== normalizedMac) {
                return target;
              }
              const lat = targetDetails.lat ?? target.lat;
              const lon = targetDetails.lon ?? target.lon;
              const confidence =
                typeof targetDetails.confidence === 'number'
                  ? targetDetails.confidence
                  : (target.trackingConfidence ?? null);
              const updatedAt = targetDetails.detectedAt ?? target.updatedAt;
              if (
                Math.abs(target.lat - lat) > 1e-6 ||
                Math.abs(target.lon - lon) > 1e-6 ||
                (confidence ?? null) !== (target.trackingConfidence ?? null) ||
                updatedAt !== target.updatedAt
              ) {
                changed = true;
                targetChanged = true;
                return {
                  ...target,
                  lat,
                  lon,
                  updatedAt,
                  trackingConfidence: confidence,
                };
              }
              return target;
            });
            return changed ? next : previous;
          });
        }

        if (
          targetDetails.mac &&
          typeof targetDetails.lat === 'number' &&
          typeof targetDetails.lon === 'number' &&
          Number.isFinite(targetDetails.lat) &&
          Number.isFinite(targetDetails.lon)
        ) {
          useTriangulationStore.getState().complete({
            mac: targetDetails.mac,
            lat: targetDetails.lat,
            lon: targetDetails.lon,
            link: undefined,
          });
          if (targetChanged) {
            void queryClient.invalidateQueries({ queryKey: ['targets'] });
          }
        }

        const nodeState = useNodeStore.getState();
        const node = targetDetails.nodeId
          ? nodeState.nodes[canonicalNodeId(targetDetails.nodeId)]
          : undefined;
        const lat = targetDetails.lat ?? node?.lat;
        const lon = targetDetails.lon ?? node?.lon;
        if (
          typeof lat === 'number' &&
          Number.isFinite(lat) &&
          typeof lon === 'number' &&
          Number.isFinite(lon)
        ) {
          const entityId =
            targetDetails.mac ??
            targetDetails.nodeId ??
            `target-${targetDetails.detectedAt ?? Date.now()}`;
          const entityType = targetDetails.deviceType ?? 'target';
          const entityLabel =
            [targetDetails.deviceType, targetDetails.mac ?? targetDetails.nodeId]
              .filter(Boolean)
              .join(' ')
              .trim() || entityId;
          const geofenceEvents = useGeofenceStore.getState().processCoordinateEvent({
            entityId,
            entityLabel,
            entityType,
            lat,
            lon,
          });
          emitGeofenceEvents(geofenceEvents, node?.siteId ?? undefined);
        }
      }

      const alertDetails = extractAlertDetails(payload);
      const trackingSample = extractTrackingSample(payload);
      if (trackingSample) {
        useTrackingSessionStore.getState().recordSample(trackingSample);
      }
      const serverEstimate = extractServerTrackingEstimate(payload);
      if (serverEstimate) {
        useTrackingSessionStore.getState().applyServerEstimate(serverEstimate);
      }
      if (alertDetails && alertDetails.nodeId) {
        const level = (alertDetails.level ?? 'NOTICE').toUpperCase() as AlarmLevel;
        triggerAlert({
          nodeId: alertDetails.nodeId,
          siteId: alertDetails.siteId,
          category: alertDetails.category ?? 'status',
          level,
          message: alertDetails.message ?? 'Alert triggered',
          lat: alertDetails.lat,
          lon: alertDetails.lon,
          timestamp: alertDetails.timestamp,
        });
      }

      const sentinelEvent = extractSentinelEvent(payload);
      if (sentinelEvent) {
        if (sentinelEvent.kind === 'status') {
          useSentinelStore.getState().setStatus(sentinelEvent.status);
        } else {
          useSentinelStore.getState().addDetection(sentinelEvent.detection);
        }
      }
    };

    const handleCommandUpdate = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const command = payload as { id?: string; name?: string; status?: string };
      const status = String(command.status ?? 'UNKNOWN').toUpperCase();
      const level: TerminalLevel =
        status === 'ERROR' ? 'critical' : status === 'OK' ? 'notice' : 'info';
      const name = command.name ?? command.id ?? 'command';

      const entry: TerminalEntryInput = {
        message: `Command ${name} -> ${status}`,
        level,
        source: 'command',
      };

      addEntry(entry);
      if (status === 'ERROR') {
        play('ALERT');
      }

      // Start tracking banner countdown only after SCAN_START is acknowledged
      const normalizedName = (name ?? '').toString().toUpperCase();
      if (normalizedName === 'SCAN_START') {
        if (status === 'SENT' || status === 'OK') {
          const store = useTrackingBannerStore.getState();
          if (store.pendingMac && typeof store.pendingDuration === 'number') {
            store.setCountdown(store.pendingMac, store.pendingDuration);
          }
        } else if (status === 'ERROR') {
          useTrackingBannerStore.getState().fail();
        }
      }
    };

    const handleGeofenceUpsert = (payload: unknown) => {
      if (payload && typeof payload === 'object' && 'id' in payload) {
        useGeofenceStore.getState().upsertGeofence(payload as Geofence);
      }
    };

    const handleGeofenceDelete = (payload: unknown) => {
      if (payload && typeof payload === 'object' && 'id' in payload) {
        const geofence = payload as { id?: string };
        if (typeof geofence.id === 'string') {
          const store = useGeofenceStore.getState();
          store.removeGeofence(geofence.id);
          store.resetStates(geofence.id);
        }
      }
    };

    socket.on('init', handleInit);
    socket.on('nodes', handleNodeDiff);
    socket.on('event', handleEvent);
    socket.on('command.update', handleCommandUpdate);
    socket.on('geofences.upsert', handleGeofenceUpsert);
    socket.on('geofences.delete', handleGeofenceDelete);

    return () => {
      socket.off('init', handleInit);
      socket.off('nodes', handleNodeDiff);
      socket.off('event', handleEvent);
      socket.off('command.update', handleCommandUpdate);
      socket.off('geofences.upsert', handleGeofenceUpsert);
      socket.off('geofences.delete', handleGeofenceDelete);
    };
  }, [
    socket,
    setInitialNodes,
    applyDiff,
    addEntry,
    addChatIncoming,
    play,
    playDroneGeofence,
    playDroneTelemetry,
    triggerAlert,
    queryClient,
    setDrones,
    upsertDrone,
    appendDroneTrail,
    removeDrone,
    setDroneStatus,
    appendAdsbTrail,
    pruneAdsbTrails,
    addProbeHit,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const timer = window.setInterval(() => {
      useAlertStore.getState().purgeExpired();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return null;
}

interface InitPayload {
  nodes: NodeSummary[];
  geofences?: Geofence[];
  drones?: Drone[];
}

function isInitPayload(payload: unknown): payload is InitPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'nodes' in payload &&
    Array.isArray((payload as { nodes: unknown[] }).nodes)
  );
}

function isNodeDiffPayload(payload: unknown): payload is NodeDiffPayload {
  return typeof payload === 'object' && payload !== null && 'type' in payload && 'node' in payload;
}

type DroneTelemetryEventPayload = {
  type: 'drone.telemetry';
  droneId: string;
  mac?: string | null;
  nodeId?: string | null;
  siteId?: string | null;
  originSiteId?: string | null;
  siteName?: string | null;
  siteColor?: string | null;
  siteCountry?: string | null;
  siteCity?: string | null;
  lat: number;
  lon: number;
  altitude?: number | null;
  speed?: number | null;
  operatorLat?: number | null;
  operatorLon?: number | null;
  rssi?: number | null;
  timestamp?: string;
  status?: DroneStatus;
  faa?: FaaAircraftSummary | null;
};

type DroneRemoveEventPayload = {
  type: 'drone.remove';
  droneId: string;
};

type DroneStatusEventPayload = {
  type: 'drone.status';
  id?: string;
  droneId: string;
  status: DroneStatus;
  lat?: number;
  lon?: number;
  timestamp?: string;
  siteId?: string | null;
  originSiteId?: string | null;
  faa?: FaaAircraftSummary | null;
};

function isDroneTelemetryEvent(payload: unknown): payload is DroneTelemetryEventPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Partial<DroneTelemetryEventPayload>;
  return (
    candidate.type === 'drone.telemetry' &&
    typeof candidate.droneId === 'string' &&
    typeof candidate.lat === 'number' &&
    typeof candidate.lon === 'number'
  );
}

function isDroneRemovalEvent(payload: unknown): payload is DroneRemoveEventPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Partial<DroneRemoveEventPayload>;
  return candidate.type === 'drone.remove' && typeof candidate.droneId === 'string';
}

function isDroneStatusEvent(payload: unknown): payload is DroneStatusEventPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Partial<DroneStatusEventPayload>;
  return (
    candidate.type === 'drone.status' &&
    typeof candidate.droneId === 'string' &&
    isDroneStatus(candidate.status)
  );
}

function isDroneStatus(value: unknown): value is DroneStatus {
  return value === 'UNKNOWN' || value === 'FRIENDLY' || value === 'NEUTRAL' || value === 'HOSTILE';
}

function normalizeDroneStatus(value: unknown): DroneStatus {
  return isDroneStatus(value) ? value : 'UNKNOWN';
}

function parseEventPayload(
  payload: unknown,
  options?: { onTriangulationComplete?: () => void },
): TerminalEntryInput | null {
  if (typeof payload === 'string') {
    return { message: payload, level: 'info', source: 'ws' };
  }

  if (payload && typeof payload === 'object') {
    const base = payload as {
      type?: string;
      message?: string;
      line?: string;
      level?: string;
      raw?: string;
      nodeId?: string;
      timestamp?: string;
      siteId?: string;
      category?: string;
      data?: unknown;
    };

    if (base.type === 'event.alert') {
      const levelRaw = typeof base.level === 'string' ? base.level.toUpperCase() : undefined;
      const category = typeof base.category === 'string' ? base.category.toLowerCase() : undefined;

      if (category === 'mesh-coordination') {
        return null;
      }

      const baseMessage = base.message ?? `Alert from ${base.nodeId ?? 'unknown node'}`;
      const messageUpper = baseMessage.toUpperCase();

      let terminalLevel = alarmLevelToTerminal(levelRaw as AlarmLevel | undefined);
      let isNotification =
        !levelRaw ||
        levelRaw === 'INFO' ||
        levelRaw === 'NOTICE' ||
        (category ? NOTIFICATION_CATEGORIES.has(category) : false);

      const isVibrationStatus =
        category === 'vibration' && messageUpper.includes('VIBRATION_STATUS');
      if (isVibrationStatus) {
        terminalLevel = 'notice';
        isNotification = true;
      } else if (isNotification && terminalLevel === 'info') {
        terminalLevel = 'notice';
      }

      const deviceTextCandidate =
        (typeof base.raw === 'string' && base.raw) ||
        (typeof base.line === 'string' && base.line) ||
        baseMessage;
      const looksLikeDeviceNotification =
        isNotification &&
        deviceTextCandidate &&
        (DEVICE_LINE_REGEX.test(deviceTextCandidate) ||
          DEVICE_FALLBACK_REGEX.test(deviceTextCandidate)) &&
        (!category || category === 'status' || category === 'console');
      if (looksLikeDeviceNotification) {
        return {
          message: baseMessage ?? deviceTextCandidate ?? 'Device event',
          level: 'info',
          source: 'raw',
          timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
          siteId: base.siteId,
        };
      }

      const source = isNotification ? 'notification' : 'alert';
      const dataRecord =
        base.data && typeof base.data === 'object' ? (base.data as Record<string, unknown>) : null;
      const linkCandidate =
        dataRecord && typeof dataRecord.link === 'string' ? dataRecord.link.trim() : undefined;
      const link = linkCandidate && HTTP_LINK_REGEX.test(linkCandidate) ? linkCandidate : undefined;
      const message = link && !baseMessage.includes(link) ? `${baseMessage}\n${link}` : baseMessage;

      if (category === 'triangulation' && dataRecord) {
        const mac = typeof dataRecord.mac === 'string' ? dataRecord.mac.toUpperCase() : undefined;
        const lat = typeof dataRecord.lat === 'number' ? dataRecord.lat : undefined;
        const lon = typeof dataRecord.lon === 'number' ? dataRecord.lon : undefined;
        useTriangulationStore.getState().complete({ mac, lat, lon, link });
        // Ensure map/targets refresh after a triangulation completes so the position and styling update.
        options?.onTriangulationComplete?.();
      }
      return {
        message,
        level: terminalLevel,
        source,
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
        link,
      };
    }

    if (base.type === 'raw') {
      const rawValue = (base as { raw?: unknown }).raw;
      const message =
        typeof rawValue === 'string'
          ? rawValue
          : rawValue != null
            ? JSON.stringify(rawValue)
            : JSON.stringify(payload);
      return {
        message,
        level: 'info',
        source: 'raw',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if (base.type === 'event.target') {
      return {
        message: base.message ?? `Device discovered by ${base.nodeId ?? 'unknown node'}`,
        level: 'notice',
        source: 'inventory',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if (base.type === 'command.ack') {
      return {
        message: base.message ?? `Command acknowledgement from ${base.nodeId ?? 'node'}`,
        level: 'info',
        source: 'command',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if (base.type === 'command.result') {
      return {
        message: base.message ?? `Command result from ${base.nodeId ?? 'node'}`,
        level: 'notice',
        source: 'command',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if (base.type === 'alert.rule') {
      const severity =
        typeof base.level === 'string'
          ? base.level.toUpperCase()
          : typeof (base as { severity?: string }).severity === 'string'
            ? ((base as { severity?: string }).severity as string).toUpperCase()
            : 'ALERT';
      const ruleName = (base as { ruleName?: string }).ruleName;
      const ruleId = (base as { ruleId?: string }).ruleId;
      const message =
        base.message ??
        `Alert rule ${typeof ruleName === 'string' ? ruleName : typeof ruleId === 'string' ? ruleId : 'event'} triggered`;
      return {
        message,
        level: alarmLevelToTerminal(severity as AlarmLevel),
        source: 'alert',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if (base.type === 'node.telemetry') {
      const telemetry = payload as {
        nodeId?: string;
        lat?: number | string;
        lon?: number | string;
        lastMessage?: string | null;
        raw?: string;
        timestamp?: string;
        siteId?: string;
      };
      const lat = toNumber(telemetry.lat);
      const lon = toNumber(telemetry.lon);
      const parts: string[] = [`Node ${telemetry.nodeId ?? 'unknown'} telemetry update`];
      if (typeof lat === 'number' && typeof lon === 'number') {
        parts.push(`(${lat.toFixed(5)}, ${lon.toFixed(5)})`);
      }
      const summary = summarizeTelemetryMessage(
        typeof telemetry.lastMessage === 'string' ? telemetry.lastMessage : undefined,
        typeof telemetry.raw === 'string' ? telemetry.raw : undefined,
      );
      if (summary) {
        parts.push(summary);
      }
      return {
        message: parts.join(' '),
        level: 'info',
        source: 'raw',
        timestamp: typeof telemetry.timestamp === 'string' ? telemetry.timestamp : undefined,
        siteId: telemetry.siteId ?? base.siteId,
      };
    }

    if (base.type === 'node.upsert') {
      const upsert = payload as {
        originSiteId?: string;
        payload?: {
          id?: string;
          name?: string | null;
          siteId?: string | null;
          siteName?: string | null;
          lat?: number | string;
          lon?: number | string;
        };
        siteId?: string;
      };
      const nodeId = upsert.payload?.id ?? base.nodeId ?? 'unknown node';
      const siteLabel =
        upsert.payload?.siteName ??
        upsert.payload?.siteId ??
        upsert.originSiteId ??
        base.siteId ??
        'remote site';
      const lat = toNumber(upsert.payload?.lat);
      const lon = toNumber(upsert.payload?.lon);
      const parts = [`Remote node ${nodeId} update from ${siteLabel}`];
      if (typeof lat === 'number' && typeof lon === 'number') {
        parts.push(`(${lat.toFixed(5)}, ${lon.toFixed(5)})`);
      }
      return {
        message: parts.join(' '),
        level: 'info',
        source: 'raw',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: upsert.payload?.siteId ?? upsert.originSiteId ?? base.siteId,
      };
    }

    if (base.type && (base.type.startsWith('node.') || base.type === 'nodes.diff')) {
      return {
        message: JSON.stringify(payload),
        level: 'info',
        source: 'raw',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if ('line' in base) {
      const { line, type } = base as { line: string; type?: string };
      const level: TerminalLevel =
        type === 'critical' ? 'critical' : type === 'alert' ? 'alert' : 'info';
      return { message: line, level, source: type ?? 'raw' };
    }

    return {
      message: JSON.stringify(payload),
      level: 'info',
      source: 'ws',
    };
  }

  return {
    message: String(payload),
    level: 'info',
    source: 'ws',
  };
}

function extractAlarmLevel(payload: unknown): AlarmLevel | null {
  if (payload && typeof payload === 'object' && 'type' in payload) {
    const base = payload as { type?: string; level?: string; severity?: string };
    if (base.type === 'event.alert' && base.level) {
      return base.level.toUpperCase() as AlarmLevel;
    }
    if (base.type === 'event.target') {
      return 'NOTICE';
    }
    if (base.type === 'alert.rule') {
      const level = base.level ?? base.severity;
      if (level) {
        return level.toUpperCase() as AlarmLevel;
      }
      return 'ALERT';
    }
  }
  return null;
}

function summarizeTelemetryMessage(message?: string, raw?: string): string | undefined {
  const candidate = (message ?? raw ?? '').trim();
  if (!candidate) {
    return undefined;
  }
  const bracket = candidate.match(/\[[^\]]+\]/);
  if (bracket?.[0]) {
    return bracket[0];
  }
  const beforeColon = candidate.split(':', 1)[0];
  if (beforeColon && beforeColon.length > 0 && beforeColon.length <= 40) {
    return beforeColon;
  }
  return candidate.length > 40 ? `${candidate.slice(0, 37)}…` : candidate;
}

interface TargetEventDetails {
  mac?: string;
  nodeId?: string;
  rssi?: number;
  deviceType?: string;
  channel?: number;
  lat?: number;
  lon?: number;
  detectedAt?: string;
  confidence?: number;
}

interface TrackingEstimatePayload {
  mac: string;
  lat: number;
  lon: number;
  confidence?: number;
  contributors?: Array<{ nodeId?: string; lat: number; lon: number; weight?: number }>;
}

function extractTargetDetails(payload: unknown): TargetEventDetails | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const base = payload as {
    type?: string;
    mac?: string;
    nodeId?: string;
    rssi?: number | string;
    deviceType?: string;
    lat?: number | string;
    lon?: number | string;
    timestamp?: string;
    ts?: string;
    confidence?: number;
    tracking?: { confidence?: number };
    channel?: number | string | null;
  };

  if (base.type !== 'event.target') {
    return null;
  }

  const trackingConfidence =
    typeof base.confidence === 'number'
      ? base.confidence
      : typeof base.tracking?.confidence === 'number'
        ? base.tracking.confidence
        : undefined;

  return {
    mac: base.mac,
    nodeId: base.nodeId,
    rssi: toNumber(base.rssi),
    deviceType: base.deviceType,
    channel: toNumber(base.channel),
    lat: toNumber(base.lat),
    lon: toNumber(base.lon),
    detectedAt:
      typeof base.timestamp === 'string'
        ? base.timestamp
        : typeof base.ts === 'string'
          ? base.ts
          : undefined,
    confidence: typeof trackingConfidence === 'number' ? trackingConfidence : undefined,
  };
}

function extractServerTrackingEstimate(payload: unknown): TrackingEstimatePayload | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const base = payload as {
    type?: string;
    mac?: string;
    lat?: number | string;
    lon?: number | string;
    tracking?: {
      confidence?: number;
      contributors?: Array<{
        nodeId?: string;
        lat?: number;
        lon?: number;
        weight?: number;
      }>;
    };
  };
  if (base.type !== 'event.target' || typeof base.mac !== 'string') {
    return null;
  }
  const lat = toNumber(base.lat);
  const lon = toNumber(base.lon);
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return null;
  }
  const contributors = Array.isArray(base.tracking?.contributors)
    ? base
        .tracking!.contributors.map((entry) => {
          const cLat = toNumber(entry?.lat);
          const cLon = toNumber(entry?.lon);
          if (typeof cLat !== 'number' || typeof cLon !== 'number') {
            return null;
          }
          return {
            nodeId: typeof entry?.nodeId === 'string' ? entry?.nodeId : undefined,
            lat: cLat,
            lon: cLon,
            weight: toNumber(entry?.weight),
          } as { nodeId?: string; lat: number; lon: number; weight?: number };
        })
        .filter((entry): entry is { nodeId?: string; lat: number; lon: number; weight?: number } =>
          Boolean(entry),
        )
    : [];
  return {
    mac: base.mac,
    lat,
    lon,
    confidence:
      typeof base.tracking?.confidence === 'number' ? base.tracking.confidence : undefined,
    contributors,
  };
}

interface AlertDetails {
  nodeId?: string;
  siteId?: string;
  category?: string;
  level?: AlarmLevel;
  message?: string;
  lat?: number;
  lon?: number;
  timestamp?: string;
}

function extractAlertDetails(payload: unknown): AlertDetails | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const base = payload as {
    type?: string;
    category?: string;
    nodeId?: string;
    level?: string;
    message?: string;
    lat?: number | string;
    lon?: number | string;
    timestamp?: string;
    data?: Record<string, unknown>;
    siteId?: string;
  };

  if (base.type !== 'event.alert' && base.type !== 'alert.rule') {
    return null;
  }

  const data = base.data ?? {};
  const severityValue = base.level ?? (base as { severity?: string }).severity;

  return {
    nodeId: base.nodeId,
    siteId: base.siteId,
    category: base.type === 'alert.rule' ? 'alert-rule' : base.category,
    level: severityValue ? (severityValue.toUpperCase() as AlarmLevel) : undefined,
    message: base.message,
    lat: toNumber(base.lat ?? (data as Record<string, unknown>).lat),
    lon: toNumber(base.lon ?? (data as Record<string, unknown>).lon),
    timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
  };
}

type SentinelEventResult =
  | {
      kind: 'detection';
      detection: {
        id: string;
        nodeId: string;
        siteId?: string;
        category: string;
        level: string;
        detectionType: string;
        label: string;
        mac?: string;
        rssi?: number;
        message: string;
        data: Record<string, unknown>;
        timestamp: string;
      };
    }
  | {
      kind: 'status';
      status: {
        nodeId: string;
        siteId?: string;
        enabled?: boolean;
        running?: boolean;
        timestamp: string;
      };
    };

function extractSentinelEvent(payload: unknown): SentinelEventResult | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const base = payload as {
    type?: string;
    category?: string;
    nodeId?: string;
    siteId?: string;
    level?: string;
    message?: string;
    timestamp?: string;
    data?: Record<string, unknown>;
  };
  if (base.type !== 'event.alert' || !base.nodeId) {
    return null;
  }
  const category = typeof base.category === 'string' ? base.category.toLowerCase() : '';
  if (category !== 'sentinel' && category !== 'mesh-guard') {
    return null;
  }
  const data = base.data ?? {};
  const timestamp = typeof base.timestamp === 'string' ? base.timestamp : new Date().toISOString();
  const message = typeof base.message === 'string' ? base.message : '';

  if (
    category === 'sentinel' &&
    typeof data.detectionType === 'undefined' &&
    ('enabled' in data || 'running' in data || 'state' in data)
  ) {
    const enabled =
      typeof data.enabled === 'boolean'
        ? data.enabled
        : typeof data.state === 'string'
          ? data.state.toLowerCase() === 'on'
          : undefined;
    return {
      kind: 'status',
      status: {
        nodeId: base.nodeId,
        siteId: base.siteId,
        enabled,
        running: typeof data.running === 'boolean' ? data.running : undefined,
        timestamp,
      },
    };
  }

  const detectionType =
    category === 'mesh-guard'
      ? typeof data.intrusionType === 'string'
        ? data.intrusionType
        : 'MESH_GUARD'
      : typeof data.detectionType === 'string'
        ? data.detectionType
        : 'SENTINEL';
  const mac = [data.mac, data.bssid, data.src].find((value) => typeof value === 'string') as
    | string
    | undefined;
  const id =
    typeof window !== 'undefined' && window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${base.nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    kind: 'detection',
    detection: {
      id,
      nodeId: base.nodeId,
      siteId: base.siteId,
      category,
      level: base.level ?? 'ALERT',
      detectionType,
      label: sentinelDetectionLabel(detectionType),
      mac,
      rssi: typeof data.rssi === 'number' ? data.rssi : undefined,
      message,
      data,
      timestamp,
    },
  };
}

function isChatMessage(payload: unknown): payload is ChatMessage {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const base = payload as Partial<ChatMessage>;
  return base.type === 'chat.message' && typeof base.id === 'string';
}

function isChatClearEvent(payload: unknown): payload is ChatClearEvent {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const base = payload as Partial<ChatClearEvent>;
  return base.type === 'chat.clear';
}

function isAdsbTracksEvent(
  payload: unknown,
): payload is { type: 'adsb.tracks'; tracks: AdsbTrack[] } {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const base = payload as { type?: string; tracks?: unknown };
  return base.type === 'adsb.tracks' && Array.isArray(base.tracks);
}

function isAcarsMessagesEvent(
  payload: unknown,
): payload is { type: 'acars.messages'; messages: AcarsMessage[] } {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const base = payload as { type?: string; messages?: unknown };
  return base.type === 'acars.messages' && Array.isArray(base.messages);
}

function isGeofenceAlertEvent(payload: unknown): payload is {
  type: string;
  category?: string;
  geofenceId?: string;
  data?: { geofenceId?: string };
} {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const base = payload as { type?: string; category?: string };
  if (base.type !== 'event.alert') {
    return false;
  }
  const category = typeof base.category === 'string' ? base.category.toLowerCase() : '';
  return category === 'geofence';
}

function isTrackingUpdateEvent(payload: unknown): payload is {
  type: 'tracking.update';
  mac: string;
  lat: number;
  lon: number;
  confidence?: number;
  method?: string;
  contributors?: Array<{
    nodeId?: string;
    weight: number;
    maxRssi?: number;
    lat?: number;
    lon?: number;
  }>;
  siteId?: string | null;
} {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const base = payload as {
    type?: string;
    mac?: string;
    lat?: number;
    lon?: number;
  };
  return (
    base.type === 'tracking.update' &&
    typeof base.mac === 'string' &&
    typeof base.lat === 'number' &&
    typeof base.lon === 'number' &&
    Number.isFinite(base.lat) &&
    Number.isFinite(base.lon)
  );
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeMacKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function alarmLevelToTerminal(level: AlarmLevel | undefined): TerminalLevel {
  switch (level) {
    case 'CRITICAL':
      return 'critical';
    case 'ALERT':
      return 'alert';
    case 'NOTICE':
      return 'notice';
    case 'INFO':
    default:
      return 'info';
  }
}

function extractTrackingSample(payload: unknown): {
  mac: string;
  nodeId: string;
  rssi: number;
  band?: string;
  timestamp: number;
} | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const base = payload as {
    type?: string;
    category?: string;
    nodeId?: string;
    data?: Record<string, unknown>;
    timestamp?: string;
  };
  if (base.type !== 'event.alert') {
    return null;
  }
  const category = typeof base.category === 'string' ? base.category.toLowerCase() : '';
  if (category !== 'triangulation') {
    return null;
  }
  if (typeof base.nodeId !== 'string') {
    return null;
  }
  const data = base.data ?? {};
  const macValue = (data as Record<string, unknown>).mac;
  const rssiValue = (data as Record<string, unknown>).rssi;
  if (typeof macValue !== 'string') {
    return null;
  }
  const rssi =
    typeof rssiValue === 'number'
      ? rssiValue
      : typeof rssiValue === 'string'
        ? Number(rssiValue)
        : NaN;
  if (!Number.isFinite(rssi)) {
    return null;
  }
  const timestamp = typeof base.timestamp === 'string' ? Date.parse(base.timestamp) : Date.now();
  const band =
    typeof (data as Record<string, unknown>).type === 'string'
      ? ((data as Record<string, unknown>).type as string)
      : undefined;
  return {
    mac: macValue,
    nodeId: base.nodeId,
    rssi,
    band,
    timestamp,
  };
}

function isTriangulationDetectionEvent(payload: unknown): payload is {
  type: 'triangulation.detection';
  mac: string;
  nodeId: string;
  nodeLat: number;
  nodeLon: number;
  rssi?: number;
  hits?: number;
  lat?: number;
  lon?: number;
  timestamp?: string;
  siteId?: string | null;
} {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const base = payload as {
    type?: string;
    mac?: string;
    nodeId?: string;
    nodeLat?: number;
    nodeLon?: number;
  };
  return (
    base.type === 'triangulation.detection' &&
    typeof base.mac === 'string' &&
    typeof base.nodeId === 'string' &&
    typeof base.nodeLat === 'number' &&
    typeof base.nodeLon === 'number' &&
    Number.isFinite(base.nodeLat) &&
    Number.isFinite(base.nodeLon)
  );
}

function isProbeHitEvent(payload: unknown): payload is {
  type: 'event.probe-hit';
  mac: string;
  vendor?: string | null;
  isRandomized: boolean;
  rssi: number;
  channel?: number | null;
  ssid?: string | null;
  isGhost: boolean;
  isDst: boolean;
  hits: number;
  nodeId?: string | null;
  siteId?: string | null;
  timestamp?: string;
} {
  if (!payload || typeof payload !== 'object') return false;
  const base = payload as { type?: string; mac?: string };
  return base.type === 'event.probe-hit' && typeof base.mac === 'string';
}

function isTriangulationCompleteEvent(payload: unknown): payload is {
  type: 'triangulation.complete';
  mac: string;
  lat: number;
  lon: number;
  confidence?: number;
  uncertainty?: number;
  method?: string;
  siteId?: string | null;
} {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const base = payload as {
    type?: string;
    mac?: string;
    lat?: number;
    lon?: number;
  };
  return (
    base.type === 'triangulation.complete' &&
    typeof base.mac === 'string' &&
    typeof base.lat === 'number' &&
    typeof base.lon === 'number' &&
    Number.isFinite(base.lat) &&
    Number.isFinite(base.lon)
  );
}
