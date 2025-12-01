import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Map as LeafletMap, latLngBounds } from 'leaflet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MdCenterFocusStrong,
  MdTimeline,
  MdMyLocation,
  MdRadioButtonChecked,
  MdVisibility,
  MdCropFree,
  MdUndo,
  MdCancel,
  MdCheckCircle,
  MdBookmarkAdd,
  MdClose,
  MdRadar,
  MdSettingsInputAntenna,
} from 'react-icons/md';

import { getAcarsMessages } from '../api/acars';
import { getAdsbTracksViaProxy } from '../api/adsb';
import { apiClient } from '../api/client';
import type {
  AcarsMessage,
  AlarmLevel,
  AppSettings,
  AuthUser,
  Drone,
  DroneStatus,
  GeofenceVertex,
  MapStatePreference,
  MapViewSnapshotPreference,
  SavedMapViewPreference,
  SiteSummary,
  Target,
} from '../api/types';
import { DroneFloatingCard } from '../components/DroneFloatingCard';
import { CommandCenterMap, type IndicatorSeverity } from '../components/map/CommandCenterMap';
import { extractAlertColors, applyAlertOverrides } from '../constants/alert-colors';
import type { AlertColorConfig } from '../constants/alert-colors';
import { useAdsbStore } from '../stores/adsb-store';
import { useAlertStore } from '../stores/alert-store';
import { useAuthStore } from '../stores/auth-store';
import { useDroneStore } from '../stores/drone-store';
import { useGeofenceStore } from '../stores/geofence-store';
import { useMapCommandStore } from '../stores/map-command-store';
import { useMapPreferences } from '../stores/map-store';
import { type SavedMapView, useMapViewsStore } from '../stores/map-views-store';
import { canonicalNodeId, hasValidPosition, useNodeStore } from '../stores/node-store';
import { useTargetStore } from '../stores/target-store';
import type { TargetMarker } from '../stores/target-store';
import { useTrackingSessionStore } from '../stores/tracking-session-store';
import type { TrackingEstimate } from '../stores/tracking-session-store';
import { useTriangulationStore } from '../stores/triangulation-store';

const GEOFENCE_HIGHLIGHT_MS = 10_000;
const WORLD_VIEW_FALLBACK = { lat: 25, lon: 0, zoom: 3 };
const DRONE_STATUS_OPTIONS: { value: DroneStatus; label: string }[] = [
  { value: 'UNKNOWN', label: 'Unknown' },
  { value: 'FRIENDLY', label: 'Friendly' },
  { value: 'NEUTRAL', label: 'Neutral' },
  { value: 'HOSTILE', label: 'Hostile' },
];
const FRESH_DRONE_MAX_AGE_MS = 15 * 60 * 1000;

export function MapPage() {
  const queryClient = useQueryClient();
  const { nodes, order, histories } = useNodeStore((state) => ({
    nodes: state.nodes,
    order: state.order,
    histories: state.histories,
  }));

  const mapRef = useRef<LeafletMap | null>(null);
  const initialViewAppliedRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);

  const { commentMap, trackingMap } = useTargetStore((state) => ({
    commentMap: state.commentMap,
    trackingMap: state.trackingMap,
  }));
  const targetsQuery = useQuery({
    queryKey: ['targets'],
    queryFn: async () => apiClient.get<Target[]>('/targets'),
  });
  const alerts = useAlertStore((state) => state.alerts);
  const pendingTarget = useMapCommandStore((state) => state.target);
  const consumeTarget = useMapCommandStore((state) => state.consume);
  const goto = useMapCommandStore((state) => state.goto);

  const savedViews = useMapViewsStore((state) => state.views);
  const addView = useMapViewsStore((state) => state.addView);
  const removeView = useMapViewsStore((state) => state.removeView);
  const setViews = useMapViewsStore((state) => state.setViews);

  const [newViewName, setNewViewName] = useState('');
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');

  const authStatus = useAuthStore((state) => state.status);
  const currentUser = useAuthStore((state) => state.user);
  const setAuthUser = useAuthStore((state) => state.setUser);
  const isAuthenticated = authStatus === 'authenticated';
  const canManageDrones = currentUser?.role === 'ADMIN' || currentUser?.role === 'OPERATOR';

  useEffect(() => {
    if (!currentUser) {
      setViews([]);
      return;
    }
    const normalized = normalizeSavedViewsFromPreference(currentUser.preferences?.mapState ?? null);
    setViews(normalized);
  }, [currentUser, setViews]);

  const appSettingsQuery = useQuery({
    queryKey: ['appSettings'],
    queryFn: () => apiClient.get<AppSettings>('/config/app'),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });

  const drones = useDroneStore((state) => state.list);
  const droneTrails = useDroneStore((state) => state.trails);
  const upsertDroneStore = useDroneStore((state) => state.upsert);
  const setDroneStatusStore = useDroneStore((state) => state.setStatus);
  const setPendingDroneStatus = useDroneStore((state) => state.setPendingStatus);
  const clearPendingDroneStatus = useDroneStore((state) => state.clearPendingStatus);
  const adsbTrails = useAdsbStore((state) => state.trails);

  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: () => apiClient.get<SiteSummary[]>('/sites'),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });

  const geofences = useGeofenceStore((state) => state.geofences);
  const addGeofence = useGeofenceStore((state) => state.addGeofence);
  const loadGeofences = useGeofenceStore((state) => state.loadGeofences);
  const geofenceHighlights = useGeofenceStore((state) => state.highlighted);
  const pruneGeofenceHighlights = useGeofenceStore((state) => state.pruneHighlights);
  const setGeofenceHighlighted = useGeofenceStore((state) => state.setHighlighted);
  const trackingOverlays = useTrackingSessionStore((state) =>
    Object.values(state.sessions)
      .map((session) => session.estimate)
      .filter((estimate): estimate is TrackingEstimate => Boolean(estimate)),
  );
  const triangulationState = useTriangulationStore((state) => state);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    void loadGeofences();
  }, [isAuthenticated, loadGeofences]);

  const targetMarkers = useMemo<TargetMarker[]>(() => {
    if (!targetsQuery.data) {
      return [];
    }
    const withFix = targetsQuery.data.filter((target) =>
      hasValidPosition(target.lat ?? null, target.lon ?? null),
    );
    const triMac =
      triangulationState.status === 'success' &&
      triangulationState.link &&
      triangulationState.targetMac &&
      triangulationState.lastUpdated &&
      Date.now() - triangulationState.lastUpdated < 10_000
        ? triangulationState.targetMac.toUpperCase()
        : null;
    return withFix.map<TargetMarker>((target) => {
      const trackingEntry = trackingMap[target.id];
      const comment = commentMap[target.id];
      const lastSeen = target.updatedAt ?? target.createdAt;
      const targetMacUpper = target.mac ? target.mac.toUpperCase() : null;
      return {
        id: target.id,
        mac: target.mac ?? undefined,
        name: target.name ?? undefined,
        nodeId: target.firstNodeId ?? undefined,
        firstNodeId: target.firstNodeId ?? undefined,
        lat: target.lat,
        lon: target.lon,
        lastSeen,
        deviceType: target.deviceType ?? undefined,
        comment,
        tracking: trackingEntry?.active ?? false,
        trackingSince: trackingEntry?.since ?? null,
        trackingConfidence:
          typeof target.trackingConfidence === 'number' ? target.trackingConfidence : undefined,
        triangulatedRecent: triMac != null && targetMacUpper === triMac,
        history: [
          {
            lat: target.lat,
            lon: target.lon,
            ts: lastSeen,
          },
        ],
      };
    });
  }, [targetsQuery.data, commentMap, trackingMap, triangulationState]);

  const adsbAddonEnabled =
    useAuthStore((state) => state.user?.preferences?.notifications?.addons?.adsb ?? true) ?? true;
  const acarsAddonEnabled =
    useAuthStore((state) => state.user?.preferences?.notifications?.addons?.acars ?? true) ?? true;

  const {
    trailsEnabled,
    radiusEnabled,
    followEnabled,
    targetsEnabled,
    coverageEnabled,
    adsbEnabled,
    adsbGeofenceEnabled,
    acarsEnabled,
    mapStyle,
    toggleTrails,
    toggleRadius,
    toggleFollow,
    toggleTargets,
    toggleAdsb,
    toggleAdsbGeofence,
    toggleAcars,
  } = useMapPreferences();
  const fitEnabled = useMapPreferences((state) => state.fitEnabled);
  const setMapStyle = useMapPreferences((state) => state.setMapStyle);
  const setFitEnabled = useMapPreferences((state) => state.setFitEnabled);
  const adsbTracksQuery = useQuery({
    queryKey: ['adsb', 'tracks'],
    queryFn: getAdsbTracksViaProxy,
    enabled: isAuthenticated && adsbAddonEnabled && adsbEnabled,
    refetchInterval: 15_000,
  });

  const nodeList = useMemo(() => order.map((id) => nodes[id]).filter(Boolean), [nodes, order]);
  const nodeListWithFix = useMemo(
    () => nodeList.filter((node) => hasValidPosition(node.lat, node.lon)),
    [nodeList],
  );
  const adsbTracks = useMemo(
    () =>
      adsbAddonEnabled && adsbEnabled && adsbTracksQuery.data
        ? adsbTracksQuery.data.filter((track) => {
            const hasId =
              (track.callsign && track.callsign.trim()) || (track.reg && track.reg.trim());
            return hasId && hasValidPosition(track.lat, track.lon);
          })
        : [],
    [adsbAddonEnabled, adsbEnabled, adsbTracksQuery.data],
  );

  const acarsMessagesQuery = useQuery({
    queryKey: ['acars', 'messages'],
    queryFn: getAcarsMessages,
    enabled: isAuthenticated && acarsAddonEnabled && acarsEnabled,
    refetchInterval: 5_000,
  });

  const acarsMessages = useMemo(
    () =>
      acarsAddonEnabled && acarsEnabled && acarsMessagesQuery.data
        ? acarsMessagesQuery.data.filter((message) => {
            return message.tail && message.tail.trim();
          })
        : [],
    [acarsAddonEnabled, acarsEnabled, acarsMessagesQuery.data],
  );

  const acarsMessagesByIcao = useMemo(() => {
    const map = new Map<string, AcarsMessage[]>();
    acarsMessages.forEach((message) => {
      if (message.correlatedIcao) {
        const existing = map.get(message.correlatedIcao) ?? [];
        existing.push(message);
        map.set(message.correlatedIcao, existing);
      }
    });
    return map;
  }, [acarsMessages]);

  const uncorrelatedAcarsMessages = useMemo(
    () =>
      acarsMessages.filter(
        (message) =>
          !message.correlatedIcao && hasValidPosition(message.lat ?? null, message.lon ?? null),
      ),
    [acarsMessages],
  );

  useEffect(() => {
    const timer = window.setInterval(() => pruneGeofenceHighlights(), 1000);
    return () => window.clearInterval(timer);
  }, [geofenceHighlights, pruneGeofenceHighlights]);

  const onlineCount = useMemo(
    () => nodeList.filter((node) => Boolean(node?.lastSeen)).length,
    [nodeList],
  );

  const alertColors: AlertColorConfig = useMemo(
    () =>
      applyAlertOverrides(
        extractAlertColors(appSettingsQuery.data),
        currentUser?.preferences?.alertColors ?? null,
      ),
    [appSettingsQuery.data, currentUser?.preferences?.alertColors],
  );
  const mapDefaultRadius = appSettingsQuery.data?.defaultRadiusM ?? 50;

  const alertIndicatorMap = useMemo(() => {
    const severityRank: Record<IndicatorSeverity, number> = {
      idle: 0,
      info: 1,
      notice: 2,
      alert: 3,
      critical: 4,
    };
    const applyIndicator = (
      map: Map<string, IndicatorSeverity>,
      key: string,
      indicator: IndicatorSeverity,
    ) => {
      if (indicator === 'idle') {
        return;
      }
      const previous = map.get(key);
      const previousRank = previous ? severityRank[previous] : 0;
      if (severityRank[indicator] >= previousRank) {
        map.set(key, indicator);
      }
    };

    const map = new Map<string, IndicatorSeverity>();
    Object.values(alerts).forEach((alert) => {
      const level = (alert.level ?? 'INFO').toUpperCase();
      let indicator: IndicatorSeverity;
      switch (level) {
        case 'INFO':
          indicator = 'info';
          break;
        case 'NOTICE':
          indicator = 'notice';
          break;
        case 'ALERT':
          indicator = 'alert';
          break;
        case 'CRITICAL':
          indicator = 'critical';
          break;
        default:
          indicator = 'idle';
          break;
      }
      const scopedKey = composeNodeKey(alert.nodeId, alert.siteId);
      applyIndicator(map, scopedKey, indicator);
      // Record a site-agnostic fallback so alerts without a site still pulse nodes.
      const globalKey = composeNodeKey(alert.nodeId, undefined);
      applyIndicator(map, globalKey, indicator);
    });
    return map;
  }, [alerts]);

  const [drawingGeofence, setDrawingGeofence] = useState(false);
  const [draftVertices, setDraftVertices] = useState<GeofenceVertex[]>([]);
  const [hoverVertex, setHoverVertex] = useState<GeofenceVertex | null>(null);

  const performFit = useCallback(() => {
    if (!mapReady || !mapRef.current) {
      return false;
    }
    const positions = nodeListWithFix
      .map((node) =>
        typeof node.lat === 'number' && typeof node.lon === 'number'
          ? ([node.lat, node.lon] as [number, number])
          : null,
      )
      .filter((value): value is [number, number] => value !== null);
    if (positions.length === 0) {
      return false;
    }
    const bounds = latLngBounds(positions);
    mapRef.current.fitBounds(bounds.pad(0.25));
    return true;
  }, [mapReady, nodeListWithFix]);

  const handleFitClick = () => {
    if (fitEnabled) {
      setFitEnabled(false);
      return;
    }
    const fitted = performFit();
    if (fitted) {
      setFitEnabled(true);
    }
  };

  const persistMapState = useCallback(
    async ({
      views,
      lastView,
    }: {
      views?: SavedMapView[];
      lastView?: MapViewSnapshot | null;
    } = {}) => {
      if (!currentUser) {
        return;
      }
      const nextViews = views ?? useMapViewsStore.getState().views;
      const existingSnapshot = normalizeSnapshot(currentUser.preferences?.mapState?.lastView);
      let snapshotToStore: MapViewSnapshot | null;
      if (lastView === undefined) {
        snapshotToStore = existingSnapshot ?? null;
      } else {
        snapshotToStore = lastView;
      }
      const mapStatePayload: Record<string, unknown> = {
        views: nextViews.slice(0, 20).map(serializeViewForPreference),
      };
      if (snapshotToStore === null) {
        mapStatePayload.lastView = null;
      } else if (snapshotToStore) {
        mapStatePayload.lastView = snapshotToStore;
      }
      try {
        const response = await apiClient.put<AuthUser>('/users/me', {
          mapState: mapStatePayload,
        });
        setAuthUser(response);
      } catch (error) {
        console.error('Failed to persist map view', error);
        window.alert('Unable to save map view. Check your connection and try again.');
      }
    },
    [currentUser, setAuthUser],
  );

  const handleSaveView = () => {
    if (!mapReady || !mapRef.current) {
      return;
    }
    const center = mapRef.current.getCenter();
    const zoom = mapRef.current.getZoom();
    const trimmed = newViewName.trim();
    const createdView = addView({
      name: trimmed.length > 0 ? trimmed : undefined,
      lat: center.lat,
      lon: center.lng,
      zoom,
    });
    setNewViewName('');
    const snapshot = viewToSnapshot(createdView);
    const latestViews = useMapViewsStore.getState().views;
    void persistMapState({ views: latestViews, lastView: snapshot });
  };

  const handleApplyView = useCallback(
    (view: SavedMapView) => {
      if (!mapRef.current) {
        return;
      }
      mapRef.current.flyTo([view.lat, view.lon], view.zoom, { duration: 1.1 });
      void persistMapState({ lastView: viewToSnapshot(view) });
    },
    [persistMapState],
  );

  const handleRemoveView = useCallback(
    (view: SavedMapView) => {
      removeView(view.id);
      const updatedViews = useMapViewsStore.getState().views;
      const currentSnapshot = normalizeSnapshot(currentUser?.preferences?.mapState?.lastView);
      const nextLastView =
        currentSnapshot && currentSnapshot.id && currentSnapshot.id === view.id ? null : undefined;
      void persistMapState({ views: updatedViews, lastView: nextLastView });
    },
    [currentUser?.preferences?.mapState?.lastView, persistMapState, removeView],
  );

  useEffect(() => {
    if (!fitEnabled || !mapReady) {
      return;
    }
    performFit();
  }, [fitEnabled, performFit, nodeListWithFix.length, mapReady]);

  useEffect(() => {
    if (!pendingTarget || !mapReady || !mapRef.current) {
      return;
    }
    if (pendingTarget.bounds) {
      const bounds = latLngBounds([pendingTarget.bounds.southWest, pendingTarget.bounds.northEast]);
      mapRef.current.fitBounds(bounds.pad(0.2), { animate: true });
    } else {
      const zoom = pendingTarget.zoom ?? Math.max(mapRef.current.getZoom(), 15);
      mapRef.current.flyTo([pendingTarget.lat, pendingTarget.lon], zoom, {
        duration: 1.2,
      });
    }
    if (pendingTarget.geofenceId) {
      setGeofenceHighlighted(pendingTarget.geofenceId, GEOFENCE_HIGHLIGHT_MS);
    }
    consumeTarget();
  }, [pendingTarget, consumeTarget, setGeofenceHighlighted, mapReady]);

  useEffect(() => {
    initialViewAppliedRef.current = false;
  }, [currentUser?.id]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      return;
    }
    if (initialViewAppliedRef.current) {
      return;
    }
    const preferredView = normalizeSnapshot(currentUser?.preferences?.mapState?.lastView);
    if (preferredView) {
      mapRef.current.setView([preferredView.lat, preferredView.lon], preferredView.zoom);
    } else {
      mapRef.current.setView(
        [WORLD_VIEW_FALLBACK.lat, WORLD_VIEW_FALLBACK.lon],
        WORLD_VIEW_FALLBACK.zoom,
      );
    }
    initialViewAppliedRef.current = true;
  }, [mapReady, currentUser?.preferences?.mapState?.lastView]);

  const geofenceHighlightCount = useMemo(
    () => Object.keys(geofenceHighlights).length,
    [geofenceHighlights],
  );

  const freshDrones = useMemo(
    () =>
      drones.filter((drone) => {
        const ts = new Date(drone.lastSeen).getTime();
        if (Number.isNaN(ts)) return false;
        return Date.now() - ts <= FRESH_DRONE_MAX_AGE_MS;
      }),
    [drones],
  );

  const [activeDroneId, setActiveDroneId] = useState<string | null>(null);
  const [droneCardVisible, setDroneCardVisible] = useState(false);

  useEffect(() => {
    if (freshDrones.length === 0) {
      setActiveDroneId(null);
      setDroneCardVisible(false);
      return;
    }
    if (!activeDroneId || !freshDrones.some((drone) => drone.id === activeDroneId)) {
      setActiveDroneId(freshDrones[0].id);
      setDroneCardVisible(true);
    }
  }, [freshDrones, activeDroneId]);

  const droneStatusMutation = useMutation<
    Drone,
    Error,
    {
      id: string;
      status: DroneStatus;
    },
    { previousStatus?: DroneStatus; id: string }
  >({
    mutationFn: async ({ id, status }) => {
      const endpoint = `/drones/${encodeURIComponent(id)}/status`;
      return apiClient.patch<Drone>(endpoint, { status });
    },
    onMutate: async ({ id, status }) => {
      const current = useDroneStore.getState().map[id];
      const previousStatus = current?.status;
      setPendingDroneStatus(id, status);
      setDroneStatusStore(id, status, { clearPending: false });
      return { previousStatus, id };
    },
    onSuccess: (drone) => {
      clearPendingDroneStatus(drone.id);
      upsertDroneStore(drone);
      queryClient.setQueryData<Drone[]>(['drones'], (previous) => {
        if (!previous) {
          return previous;
        }
        const index = previous.findIndex((item) => item.id === drone.id);
        if (index === -1) {
          return previous;
        }
        const next = previous.slice();
        next[index] = drone;
        return next;
      });
    },
    onError: (error, _variables, context) => {
      if (context?.previousStatus !== undefined) {
        clearPendingDroneStatus(context.id);
        setDroneStatusStore(context.id, context.previousStatus);
      }
      const message =
        (error && typeof error.message === 'string' && error.message) || 'Unknown error';
      window.alert(`Failed to update drone status: ${message}`);
    },
  });

  const pendingDroneId = droneStatusMutation.variables?.id;
  const isUpdatingDrone = useCallback(
    (id: string) => Boolean(droneStatusMutation.isPending && pendingDroneId === id),
    [droneStatusMutation.isPending, pendingDroneId],
  );

  const handleDroneStatusChange = useCallback(
    (droneId: string, nextStatus: DroneStatus) => {
      if (!canManageDrones) {
        return;
      }
      const drone = drones.find((item) => item.id === droneId);
      if (!drone || drone.status === nextStatus) {
        return;
      }
      droneStatusMutation.mutate({ id: droneId, status: nextStatus });
    },
    [canManageDrones, drones, droneStatusMutation],
  );

  const handleDroneSelect = useCallback(
    (droneId: string, options?: { focus?: boolean }) => {
      setActiveDroneId(droneId);
      setDroneCardVisible(true);
      if (options?.focus && mapRef.current) {
        const drone = drones.find((item) => item.id === droneId);
        if (drone) {
          mapRef.current.flyTo([drone.lat, drone.lon], Math.max(mapRef.current.getZoom(), 15), {
            duration: 1,
          });
        }
      }
    },
    [drones],
  );

  const handleDroneCardClose = useCallback(() => setDroneCardVisible(false), []);

  useEffect(() => {
    if (geofenceHighlightCount === 0) {
      return;
    }
    const timer = window.setInterval(() => pruneGeofenceHighlights(), 1000);
    return () => window.clearInterval(timer);
  }, [geofenceHighlightCount, pruneGeofenceHighlights]);

  const startGeofenceDrawing = () => {
    setDrawingGeofence(true);
    setDraftVertices([]);
    setHoverVertex(null);
  };

  const cancelGeofenceDrawing = () => {
    setDrawingGeofence(false);
    setDraftVertices([]);
    setHoverVertex(null);
  };

  const undoGeofencePoint = () => {
    setDraftVertices((prev) => prev.slice(0, -1));
  };

  const handleMapPoint = (vertex: GeofenceVertex) => {
    if (!drawingGeofence) {
      return;
    }
    setDraftVertices((prev) => [...prev, vertex]);
  };

  const handleHover = (vertex: GeofenceVertex | null) => {
    if (!drawingGeofence) {
      return;
    }
    setHoverVertex(vertex);
  };

  const handleSaveGeofence = async () => {
    if (draftVertices.length < 3) {
      alert('Draw at least three points to create a geofence.');
      return;
    }
    const defaultName = `Geofence ${geofences.length + 1}`;
    const name = window.prompt('Geofence name', defaultName);
    if (!name) {
      return;
    }
    const message =
      window.prompt(
        'Custom alarm message (tokens: {entity}, {geofence}, {type}, {event})',
        '{entity} entered geofence {geofence}',
      ) ?? '{entity} entered geofence {geofence}';
    const alarmLevel = window.prompt('Alarm level (INFO, NOTICE, ALERT, CRITICAL)', 'ALERT');
    const level = normalizeAlarmLevel(alarmLevel);

    try {
      const geofence = await addGeofence({
        name,
        description: null,
        siteId: selectedSiteId || undefined,
        polygon: draftVertices,
        alarm: {
          enabled: true,
          level,
          message,
          triggerOnExit: false,
        },
      });

      const center = calculatePolygonCentroid(draftVertices);
      goto({
        lat: center.lat,
        lon: center.lon,
        zoom: Math.max(mapRef.current?.getZoom() ?? 13, 15),
      });

      cancelGeofenceDrawing();
      setGeofenceHighlighted(geofence.id, GEOFENCE_HIGHLIGHT_MS);

      window.setTimeout(() => {
        alert(`Geofence "${geofence.name}" created.`);
      }, 10);
    } catch (error) {
      console.error('Failed to create geofence', error);
      alert('Failed to create geofence. Please try again.');
    }
  };

  return (
    <>
      <section className="panel">
        <header className="panel__header">
          <div>
            <h1 className="panel__title">Operational Map</h1>
            <p className="panel__subtitle">
              {onlineCount} nodes online | {nodeList.length} total tracked
            </p>
          </div>
          <div className="controls-row map-controls-row">
            <button
              type="button"
              className={`control-chip ${fitEnabled ? 'is-active' : ''}`}
              onClick={handleFitClick}
            >
              <MdCenterFocusStrong /> Fit
            </button>
            <button
              type="button"
              className={`control-chip ${trailsEnabled ? 'is-active' : ''}`}
              onClick={toggleTrails}
            >
              <MdTimeline /> Trails
            </button>
            <button
              type="button"
              className={`control-chip ${followEnabled ? 'is-active' : ''}`}
              onClick={toggleFollow}
            >
              <MdMyLocation /> Follow
            </button>
            <button
              type="button"
              className={`control-chip ${radiusEnabled ? 'is-active' : ''}`}
              onClick={toggleRadius}
            >
              <MdRadioButtonChecked /> Radius
            </button>
            <button
              type="button"
              className={`control-chip ${targetsEnabled ? 'is-active' : ''}`}
              onClick={toggleTargets}
            >
              <MdVisibility /> Targets
            </button>
            {adsbAddonEnabled ? (
              <>
                <button
                  type="button"
                  className={`control-chip ${adsbEnabled ? 'is-active' : ''}`}
                  onClick={toggleAdsb}
                >
                  <MdRadar /> ADS-B
                </button>
                <button
                  type="button"
                  className={`control-chip ${adsbGeofenceEnabled ? 'is-active' : ''}`}
                  onClick={toggleAdsbGeofence}
                >
                  <MdRadar /> ADS-B Geofence
                </button>
              </>
            ) : null}
            {acarsAddonEnabled ? (
              <button
                type="button"
                className={`control-chip ${acarsEnabled ? 'is-active' : ''}`}
                onClick={toggleAcars}
              >
                <MdSettingsInputAntenna /> ACARS
              </button>
            ) : null}
          </div>
        </header>
        <div className="map-canvas">
          <CommandCenterMap
            nodes={nodeListWithFix}
            trails={histories}
            targets={targetMarkers}
            drones={drones}
            droneTrails={droneTrails}
            alertIndicators={alertIndicatorMap}
            alertColors={alertColors}
            defaultRadius={mapDefaultRadius}
            showRadius={radiusEnabled}
            showTrails={trailsEnabled}
            showTargets={targetsEnabled}
            adsbTracks={adsbAddonEnabled && adsbEnabled ? adsbTracks : []}
            adsbTrails={adsbTrails}
            acarsMessagesByIcao={
              acarsAddonEnabled && acarsEnabled ? acarsMessagesByIcao : new Map()
            }
            uncorrelatedAcarsMessages={
              acarsAddonEnabled && acarsEnabled ? uncorrelatedAcarsMessages : []
            }
            followEnabled={followEnabled}
            showCoverage={coverageEnabled}
            mapStyle={mapStyle}
            trackingOverlays={trackingOverlays}
            onMapStyleChange={setMapStyle}
            geofences={geofences}
            geofenceHighlights={geofenceHighlights}
            drawing={
              drawingGeofence
                ? {
                    enabled: true,
                    points: draftVertices,
                    hover: hoverVertex,
                    onPoint: handleMapPoint,
                    onHover: handleHover,
                  }
                : undefined
            }
            onReady={(map) => {
              mapRef.current = map;
              setMapReady(true);
            }}
            onDroneSelect={handleDroneSelect}
          />
        </div>
        <footer className="map-footer">
          <section className="map-footer__views">
            <div className="map-footer__views-controls">
              <input
                type="text"
                placeholder="View name"
                value={newViewName}
                className="control-input"
                onChange={(event) => setNewViewName(event.target.value)}
              />
              <button
                type="button"
                className="control-chip"
                onClick={handleSaveView}
                disabled={!mapReady || !mapRef.current}
              >
                <MdBookmarkAdd /> Save View
              </button>
            </div>
            {savedViews.length > 0 ? (
              <div className="map-footer__views-list">
                {savedViews.map((view) => (
                  <div key={view.id} className="map-footer__view-item">
                    <button
                      type="button"
                      className="control-chip"
                      onClick={() => handleApplyView(view)}
                    >
                      {view.name}
                    </button>
                    <button
                      type="button"
                      className="control-chip control-chip--danger"
                      onClick={() => handleRemoveView(view)}
                      aria-label={`Remove ${view.name}`}
                    >
                      <MdClose />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">Save map views for quick navigation.</p>
            )}
          </section>
          <div className="map-footer__actions">
            <label className="geofence-site-select">
              <span className="geofence-site-select__label">Site</span>
              <select
                className="control-input"
                value={selectedSiteId}
                onChange={(event) => setSelectedSiteId(event.target.value)}
                aria-label="Site"
              >
                <option value="">Local site</option>
                {sitesQuery.data?.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name ?? site.id}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="submit-button"
              onClick={startGeofenceDrawing}
              disabled={drawingGeofence}
            >
              <MdCropFree /> Create Geofence
            </button>
            {drawingGeofence ? (
              <div className="geofence-drawing-controls">
                <span>{draftVertices.length} point(s) selected. Click map to add more.</span>
                <div className="geofence-drawing-buttons">
                  <button
                    type="button"
                    onClick={undoGeofencePoint}
                    disabled={draftVertices.length === 0}
                  >
                    <MdUndo /> Undo
                  </button>
                  <button type="button" onClick={cancelGeofenceDrawing}>
                    <MdCancel /> Cancel
                  </button>
                  <button
                    type="button"
                    className="submit-button"
                    onClick={handleSaveGeofence}
                    disabled={draftVertices.length < 3}
                  >
                    <MdCheckCircle /> Save Geofence
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </footer>
      </section>
      <DroneFloatingCard
        drones={freshDrones}
        activeDroneId={activeDroneId}
        visible={droneCardVisible && freshDrones.length > 0}
        onClose={handleDroneCardClose}
        onSelect={handleDroneSelect}
        onStatusChange={canManageDrones ? handleDroneStatusChange : undefined}
        statusOptions={DRONE_STATUS_OPTIONS}
        isStatusUpdating={isUpdatingDrone}
        canManage={canManageDrones}
      />
    </>
  );
}

function composeNodeKey(nodeId: string, siteId?: string | null): string {
  return `${siteId ?? 'default'}::${canonicalNodeId(nodeId)}`;
}

function normalizeAlarmLevel(value: string | null): AlarmLevel {
  const normalized = (value ?? '').toUpperCase();
  if (
    normalized === 'CRITICAL' ||
    normalized === 'ALERT' ||
    normalized === 'NOTICE' ||
    normalized === 'INFO'
  ) {
    return normalized;
  }
  return 'ALERT';
}

function calculatePolygonCentroid(points: GeofenceVertex[]): GeofenceVertex {
  if (points.length === 0) {
    return { lat: 0, lon: 0 };
  }
  let sumLat = 0;
  let sumLon = 0;
  points.forEach((point) => {
    sumLat += point.lat;
    sumLon += point.lon;
  });
  return {
    lat: sumLat / points.length,
    lon: sumLon / points.length,
  };
}

type MapViewSnapshot = {
  id?: string;
  name?: string;
  lat: number;
  lon: number;
  zoom: number;
  updatedAt?: number;
};

function normalizeSavedViewsFromPreference(mapState: MapStatePreference | null): SavedMapView[] {
  if (!mapState?.views || !Array.isArray(mapState.views)) {
    return [];
  }
  return mapState.views
    .map((view, index) => {
      if (!view) {
        return null;
      }
      const lat = toFiniteNumber(view.lat);
      const lon = toFiniteNumber(view.lon);
      const zoom = toFiniteNumber(view.zoom);
      if (lat == null || lon == null || zoom == null) {
        return null;
      }
      const id =
        typeof view.id === 'string' && view.id.trim().length > 0
          ? view.id
          : `view_${index}_${Date.now()}`;
      const name =
        typeof view.name === 'string' && view.name.trim().length > 0
          ? view.name.trim()
          : `View ${index + 1}`;
      const createdAt =
        typeof view.createdAt === 'number' && Number.isFinite(view.createdAt)
          ? view.createdAt
          : Date.now();
      return { id, name, lat, lon, zoom, createdAt };
    })
    .filter((value): value is SavedMapView => value !== null);
}

function serializeViewForPreference(view: SavedMapView): SavedMapViewPreference {
  return {
    id: view.id,
    name: view.name,
    lat: Number(view.lat),
    lon: Number(view.lon),
    zoom: Number(view.zoom),
    createdAt: view.createdAt,
  };
}

function normalizeSnapshot(snapshot?: MapViewSnapshotPreference | null): MapViewSnapshot | null {
  if (!snapshot) {
    return null;
  }
  const lat = toFiniteNumber(snapshot.lat);
  const lon = toFiniteNumber(snapshot.lon);
  const zoom = toFiniteNumber(snapshot.zoom);
  if (lat == null || lon == null || zoom == null) {
    return null;
  }
  return {
    id: typeof snapshot.id === 'string' && snapshot.id.trim().length > 0 ? snapshot.id : undefined,
    name:
      typeof snapshot.name === 'string' && snapshot.name.trim().length > 0
        ? snapshot.name.trim()
        : undefined,
    lat,
    lon,
    zoom,
    updatedAt:
      typeof snapshot.updatedAt === 'number' && Number.isFinite(snapshot.updatedAt)
        ? snapshot.updatedAt
        : undefined,
  };
}

function viewToSnapshot(view: SavedMapView): MapViewSnapshot {
  return {
    id: view.id,
    name: view.name,
    lat: view.lat,
    lon: view.lon,
    zoom: view.zoom,
    updatedAt: Date.now(),
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}
