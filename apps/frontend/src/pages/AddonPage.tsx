import { useEffect, useState } from 'react';
import {
  MdChat,
  MdEventNote,
  MdHub,
  MdNotificationsActive,
  MdRadar,
  MdSettingsInputAntenna,
} from 'react-icons/md';

import { apiClient } from '../api/client';
import type { AuthUser } from '../api/types';
import { useAuthStore } from '../stores/auth-store';

export function AddonPage() {
  const authUser = useAuthStore((state) => state.user);
  const setAuthUser = useAuthStore((state) => state.setUser);
  const addonPrefs = authUser?.preferences?.notifications?.addons ?? {};

  const [strategyEnabled, setStrategyEnabled] = useState<boolean>(addonPrefs.strategy ?? false);
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(addonPrefs.alerts ?? false);
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean>(addonPrefs.scheduler ?? false);
  const [chatEnabled, setChatEnabled] = useState<boolean>(addonPrefs.chat ?? false);
  const [adsbEnabled, setAdsbEnabled] = useState<boolean>(addonPrefs.adsb ?? true);
  const [acarsEnabled, setAcarsEnabled] = useState<boolean>(addonPrefs.acars ?? true);

  useEffect(() => {
    setStrategyEnabled(addonPrefs.strategy ?? false);
    setAlertsEnabled(addonPrefs.alerts ?? false);
    setSchedulerEnabled(addonPrefs.scheduler ?? false);
    setChatEnabled(addonPrefs.chat ?? false);
    setAdsbEnabled(addonPrefs.adsb ?? true);
    setAcarsEnabled(addonPrefs.acars ?? true);
  }, [
    addonPrefs.alerts,
    addonPrefs.chat,
    addonPrefs.scheduler,
    addonPrefs.strategy,
    addonPrefs.adsb,
    addonPrefs.acars,
  ]);

  const updateAddons = async (next: Partial<Record<string, boolean>>) => {
    const merged = { ...addonPrefs, ...next };
    try {
      const updated = await apiClient.put<AuthUser>('/users/me', { addons: merged });
      setAuthUser(updated);
      setStrategyEnabled(updated.preferences?.notifications?.addons?.strategy ?? false);
      setAlertsEnabled(updated.preferences?.notifications?.addons?.alerts ?? false);
      setSchedulerEnabled(updated.preferences?.notifications?.addons?.scheduler ?? false);
      setChatEnabled(updated.preferences?.notifications?.addons?.chat ?? false);
      setAdsbEnabled(updated.preferences?.notifications?.addons?.adsb ?? true);
      setAcarsEnabled(updated.preferences?.notifications?.addons?.acars ?? true);
    } catch (error) {
      console.error('Failed to update add-ons', error);
    }
  };

  const handleStrategyToggle = () => updateAddons({ strategy: !strategyEnabled });
  const handleAlertsToggle = () => updateAddons({ alerts: !alertsEnabled });
  const handleSchedulerToggle = () => updateAddons({ scheduler: !schedulerEnabled });
  const handleChatToggle = () => updateAddons({ chat: !chatEnabled });
  const handleAdsbToggle = () => updateAddons({ adsb: !adsbEnabled });
  const handleAcarsToggle = () => updateAddons({ acars: !acarsEnabled });

  return (
    <div className="page addon-page">
      <header className="page-header">
        <h1>Add-ons</h1>
        <p className="form-hint">Extend Command Center with experimental capabilities.</p>
      </header>
      <div className="addon-grid">
        <article className="config-card addon-card">
          <div className="addon-card__logo">
            <MdHub size={42} />
          </div>
          <h2>Strategy Advisor</h2>
          <div className="addon-card__body">
            <p>
              Generate high-level coverage plans and mission overlays using current target data.
            </p>
            <div className="addon-card__notice">This addon is under development.</div>
            <p className="form-hint">
              Provides planning and overlay tools for commanders; visible in the main navigation
              when enabled.
            </p>
          </div>
          <div className="addon-card__actions">
            <button type="button" className="control-chip" onClick={handleStrategyToggle}>
              {strategyEnabled ? 'Deactivate add-on' : 'Activate add-on'}
            </button>
          </div>
        </article>

        <article className="config-card addon-card">
          <div className="addon-card__logo addon-card__logo--alerts">
            <MdNotificationsActive size={42} />
          </div>
          <h2>Alerts</h2>
          <div className="addon-card__body">
            <p>Manage alert rules, routing, and webhook notifications for target detections.</p>
            <div className="addon-card__notice">This addon is under development.</div>
            <p className="form-hint">
              Configure alert rules, destinations, and webhooks for detections across sites.
            </p>
          </div>
          <div className="addon-card__actions">
            <button type="button" className="control-chip" onClick={handleAlertsToggle}>
              {alertsEnabled ? 'Deactivate add-on' : 'Activate add-on'}
            </button>
          </div>
        </article>

        <article className="config-card addon-card">
          <div className="addon-card__logo addon-card__logo--scheduler">
            <MdEventNote size={42} />
          </div>
          <h2>Scheduler</h2>
          <div className="addon-card__body">
            <p>Plan commands days in advance and automatically dispatch sequences based on time.</p>
            <div className="addon-card__notice">This addon is under development.</div>
            <p className="form-hint">
              Use for timed or recurring command sequences; keep it off when operating purely
              manually.
            </p>
          </div>
          <div className="addon-card__actions">
            <button type="button" className="control-chip" onClick={handleSchedulerToggle}>
              {schedulerEnabled ? 'Deactivate add-on' : 'Activate add-on'}
            </button>
          </div>
        </article>

        <article className="config-card addon-card">
          <div className="addon-card__logo">
            <MdChat size={42} />
          </div>
          <h2>Operator Chat</h2>
          <div className="addon-card__body">
            <p>Secure, encrypted operator chat over MQTT between sites.</p>
            <div className="addon-card__notice">This addon is under development.</div>
            <p className="form-hint">
              Encrypted operator chat; keys are managed in Config &rarr; Chat and messages broadcast
              to all sites.
            </p>
          </div>
          <div className="addon-card__actions">
            <button type="button" className="control-chip" onClick={handleChatToggle}>
              {chatEnabled ? 'Deactivate add-on' : 'Activate add-on'}
            </button>
          </div>
        </article>

        <article className="config-card addon-card">
          <div className="addon-card__logo">
            <MdRadar size={42} />
          </div>
          <h2>ADS-B Ingest</h2>
          <div className="addon-card__body">
            <p>
              Pull live sky traffic from dump1090/readsb and overlay it on the map with geofence
              triggers.
            </p>
            <div className="addon-card__notice">This addon is under development.</div>
            <p className="form-hint">
              Shows ADS-B overlays on the map and triggers geofences when enabled. Configure feed
              and database under ADS-B.
            </p>
          </div>
          <div className="addon-card__actions">
            <button type="button" className="control-chip" onClick={handleAdsbToggle}>
              {adsbEnabled ? 'Deactivate add-on' : 'Activate add-on'}
            </button>
          </div>
        </article>

        <article className="config-card addon-card">
          <div className="addon-card__logo">
            <MdSettingsInputAntenna size={42} />
          </div>
          <h2>ACARS Decoder</h2>
          <div className="addon-card__body">
            <p>
              Decode VDL2 and legacy ACARS messages from aircraft via RTL-SDR and acarsdec/dumpvdl2.
            </p>
            <div className="addon-card__notice">This addon is under development.</div>
            <p className="form-hint">
              Receives aircraft datalink messages over UDP. Configure feed settings under ACARS.
            </p>
          </div>
          <div className="addon-card__actions">
            <button type="button" className="control-chip" onClick={handleAcarsToggle}>
              {acarsEnabled ? 'Deactivate add-on' : 'Activate add-on'}
            </button>
          </div>
        </article>
      </div>
    </div>
  );
}
