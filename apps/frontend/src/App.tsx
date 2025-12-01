import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { apiClient } from './api/client';
import type { AppSettings, Drone } from './api/types';
import { AppHeader } from './components/app-header';
import { AuthOverlay } from './components/auth-overlay';
import { ChatPopupHub } from './components/chat-popup-hub';
import { SidebarNav } from './components/sidebar-nav';
import { SocketBridge } from './components/socket-bridge';
import { TerminalDrawer } from './components/terminal-drawer';
import {
  DEFAULT_ALERT_COLORS,
  extractAlertColors,
  applyAlertOverrides,
} from './constants/alert-colors';
import { resolveThemePalette, type ThemePalette, type ThemePresetId } from './constants/theme';
import { AcarsPage } from './pages/AcarsPage';
import { AddonPage } from './pages/AddonPage';
import { AdsbPage } from './pages/AdsbPage';
import { AlertsEventLogPage } from './pages/AlertsEventLogPage';
import { AlertsPage } from './pages/AlertsPage';
import { ChatPage } from './pages/ChatPage';
import { CommandConsolePage } from './pages/CommandConsolePage';
import { ConfigPage } from './pages/ConfigPage';
import { ExportsPage } from './pages/ExportsPage';
import { GeofencePage } from './pages/GeofencePage';
import { InventoryPage } from './pages/InventoryPage';
import { MapPage } from './pages/MapPage';
import { NodesPage } from './pages/NodesPage';
import { SchedulerPage } from './pages/SchedulerPage';
import { StrategyAdvisorPage } from './pages/StrategyAdvisorPage';
import { TargetsPage } from './pages/TargetsPage';
import { TerminalEventsPage } from './pages/TerminalEventsPage';
import { UserPage } from './pages/UserPage';
import { useTheme } from './providers/theme-provider';
import { useAuthStore } from './stores/auth-store';
import { useDroneStore } from './stores/drone-store';

const LAST_THEME_PRESET_STORAGE_KEY = 'ahcc:lastThemePreset';

export default function App() {
  const status = useAuthStore((state) => state.status);
  const isAuthenticated = status === 'authenticated';
  const user = useAuthStore((state) => state.user);
  const chatEnabled =
    useAuthStore((state) => state.user?.preferences?.notifications?.addons?.chat ?? false) ?? false;
  const { setTheme } = useTheme();
  const setDrones = useDroneStore((state) => state.setDrones);

  const appSettingsQuery = useQuery({
    queryKey: ['appSettings'],
    queryFn: () => apiClient.get<AppSettings>('/config/app'),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });

  const dronesQuery = useQuery({
    queryKey: ['drones'],
    queryFn: () => apiClient.get<Drone[]>('/drones'),
    enabled: isAuthenticated,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (dronesQuery.data) {
      setDrones(dronesQuery.data);
    }
  }, [dronesQuery.data, setDrones]);

  useEffect(() => {
    const preference = user?.preferences.theme;
    if (!preference) {
      return;
    }
    if (preference === 'dark' || preference === 'light') {
      setTheme(preference);
    } else if (typeof window !== 'undefined') {
      const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      setTheme(prefersDark ? 'dark' : 'light');
    }
  }, [user?.preferences.theme, setTheme]);

  useEffect(() => {
    if (!isAuthenticated) {
      applyAlertColors(DEFAULT_ALERT_COLORS);
      const storedPreset = getStoredThemePreset();
      const fallbackPreset: ThemePresetId = storedPreset ?? 'classic';
      if (typeof document !== 'undefined') {
        document.body.setAttribute('data-theme-preset', fallbackPreset);
      }
      const palette = resolveThemePalette(fallbackPreset);
      applyThemePalette(palette);
      return;
    }
    const baseAlertColors = appSettingsQuery.data
      ? extractAlertColors(appSettingsQuery.data)
      : { ...DEFAULT_ALERT_COLORS };
    const userAlertOverrides = user?.preferences?.alertColors ?? null;
    const presetId = user?.preferences?.themePreset ?? 'classic';
    if (typeof document !== 'undefined') {
      document.body.setAttribute('data-theme-preset', presetId);
    }
    applyAlertColors(applyAlertOverrides(baseAlertColors, userAlertOverrides));
    const resolvedPalette = resolveThemePalette(presetId, appSettingsQuery.data);
    applyThemePalette(resolvedPalette);
    saveThemePreset(presetId);
  }, [
    isAuthenticated,
    appSettingsQuery.data,
    user?.preferences?.alertColors,
    user?.preferences?.themePreset,
  ]);

  return (
    <BrowserRouter>
      <SocketBridge />
      <div className={`app-shell ${isAuthenticated ? '' : 'is-blurred'}`}>
        <AppHeader />
        <div className="app-content">
          <SidebarNav />
          <main className="app-main">
            <Routes>
              <Route path="/" element={<Navigate to="/map" replace />} />
              <Route path="/map" element={<MapPage />} />
              <Route path="/geofences" element={<GeofencePage />} />
              <Route path="/acars" element={<AcarsPage />} />
              <Route path="/adsb" element={<AdsbPage />} />
              <Route path="/nodes" element={<NodesPage />} />
              <Route path="/targets" element={<TargetsPage />} />
              <Route path="/strategy" element={<StrategyAdvisorPage />} />
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/alerts" element={<Navigate to="/alerts/custom" replace />} />
              <Route path="/alerts/custom" element={<AlertsPage />} />
              <Route path="/alerts/events" element={<AlertsEventLogPage />} />
              <Route path="/console" element={<CommandConsolePage />} />
              {chatEnabled ? <Route path="/chat" element={<ChatPage />} /> : null}
              <Route path="/terminal" element={<TerminalEventsPage />} />
              <Route path="/addon" element={<AddonPage />} />
              <Route path="/config" element={<ConfigPage />} />
              <Route path="/exports" element={<ExportsPage />} />
              <Route path="/scheduler" element={<SchedulerPage />} />
              <Route path="/account" element={<UserPage />} />
              <Route path="*" element={<Navigate to="/map" replace />} />
            </Routes>
          </main>
          <TerminalDrawer />
        </div>
      </div>
      <AuthOverlay />
      {chatEnabled ? <ChatPopupHub /> : null}
    </BrowserRouter>
  );
}

function applyAlertColors(config: typeof DEFAULT_ALERT_COLORS) {
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  root.style.setProperty('--alert-color-idle', config.idle);
  root.style.setProperty('--alert-color-info', config.info);
  root.style.setProperty('--alert-color-notice', config.notice);
  root.style.setProperty('--alert-color-alert', config.alert);
  root.style.setProperty('--alert-color-critical', config.critical);
}

function applyThemePalette(config: ThemePalette) {
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  const defaultAccentRgb = '37, 99, 235';
  const lightAccentRgb = hexToRgbString(config.accent.light.background) ?? defaultAccentRgb;
  const darkAccentRgb = hexToRgbString(config.accent.dark.background) ?? defaultAccentRgb;
  root.style.setProperty('--theme-light-bg', config.light.background);
  root.style.setProperty('--theme-light-surface', config.light.surface);
  root.style.setProperty('--theme-light-text', config.light.text);
  root.style.setProperty('--theme-dark-bg', config.dark.background);
  root.style.setProperty('--theme-dark-surface', config.dark.surface);
  root.style.setProperty('--theme-dark-text', config.dark.text);
  root.style.setProperty('--theme-light-accent', config.accent.light.background);
  root.style.setProperty('--theme-light-accent-text', config.accent.light.text);
  root.style.setProperty('--theme-dark-accent', config.accent.dark.background);
  root.style.setProperty('--theme-dark-accent-text', config.accent.dark.text);
  root.style.setProperty('--theme-light-accent-rgb', lightAccentRgb);
  root.style.setProperty('--theme-dark-accent-rgb', darkAccentRgb);
  root.style.setProperty('--theme-light-header-start', config.header.light.start);
  root.style.setProperty('--theme-light-header-end', config.header.light.end);
  root.style.setProperty('--theme-light-header-text', config.header.light.text);
  root.style.setProperty('--theme-dark-header-start', config.header.dark.start);
  root.style.setProperty('--theme-dark-header-end', config.header.dark.end);
  root.style.setProperty('--theme-dark-header-text', config.header.dark.text);
  root.style.setProperty('--theme-light-sidebar-bg', config.sidebar.light.background);
  root.style.setProperty('--theme-light-sidebar-border', config.sidebar.light.border);
  root.style.setProperty('--theme-light-sidebar-icon', config.sidebar.light.icon);
  root.style.setProperty('--theme-light-sidebar-icon-active', config.sidebar.light.iconActive);
  root.style.setProperty('--theme-dark-sidebar-bg', config.sidebar.dark.background);
  root.style.setProperty('--theme-dark-sidebar-border', config.sidebar.dark.border);
  root.style.setProperty('--theme-dark-sidebar-icon', config.sidebar.dark.icon);
  root.style.setProperty('--theme-dark-sidebar-icon-active', config.sidebar.dark.iconActive);
  root.style.setProperty('--theme-light-terminal-bg', config.terminal.light.background);
  root.style.setProperty('--theme-light-terminal-border', config.terminal.light.border);
  root.style.setProperty('--theme-dark-terminal-bg', config.terminal.dark.background);
  root.style.setProperty('--theme-dark-terminal-border', config.terminal.dark.border);
}

function getStoredThemePreset(): ThemePresetId | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const value = window.localStorage.getItem(LAST_THEME_PRESET_STORAGE_KEY);
  if (value === 'classic' || value === 'tactical_ops') {
    return value;
  }
  return null;
}

function saveThemePreset(preset: ThemePresetId) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(LAST_THEME_PRESET_STORAGE_KEY, preset);
}

function hexToRgbString(hex: string): string | null {
  const normalized = hex?.trim().replace(/^#/, '');
  if (!normalized || !/^[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(normalized)) {
    return null;
  }
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized;
  const value = Number.parseInt(expanded, 16);
  if (Number.isNaN(value)) {
    return null;
  }
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `${r}, ${g}, ${b}`;
}
