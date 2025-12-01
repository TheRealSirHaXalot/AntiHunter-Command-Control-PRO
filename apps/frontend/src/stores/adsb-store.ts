import { create } from 'zustand';

export interface AdsbTrailPoint {
  lat: number;
  lon: number;
  ts: string;
}

interface AdsbStoreState {
  trails: Record<string, AdsbTrailPoint[]>;
  appendTrailPoint: (id: string, point: AdsbTrailPoint) => void;
  clearTrails: () => void;
  pruneInactiveTracks: (activeIds: Set<string>) => void;
}

const MAX_TRAIL_POINTS = 50;

export const useAdsbStore = create<AdsbStoreState>()((set) => ({
  trails: {},
  appendTrailPoint: (id, point) =>
    set((state) => ({
      trails: appendToTrails(state.trails, id, point.lat, point.lon, point.ts),
    })),
  clearTrails: () => set({ trails: {} }),
  pruneInactiveTracks: (activeIds) =>
    set((state) => {
      const nextTrails: Record<string, AdsbTrailPoint[]> = {};
      Object.keys(state.trails).forEach((id) => {
        if (activeIds.has(id)) {
          nextTrails[id] = state.trails[id];
        }
      });
      return { trails: nextTrails };
    }),
}));

function appendToTrails(
  trails: Record<string, AdsbTrailPoint[]>,
  id: string,
  lat: number,
  lon: number,
  ts: string,
): Record<string, AdsbTrailPoint[]> {
  const next = { ...trails };
  const entry = next[id] ? [...next[id]] : [];

  // Skip if position hasn't changed significantly
  const last = entry[entry.length - 1];
  if (last && Math.abs(last.lat - lat) < 0.0001 && Math.abs(last.lon - lon) < 0.0001) {
    return trails;
  }

  entry.push({ lat, lon, ts });
  while (entry.length > MAX_TRAIL_POINTS) {
    entry.shift();
  }
  next[id] = entry;
  return next;
}
