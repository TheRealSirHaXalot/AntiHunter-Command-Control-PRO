<p align="center">
  <img src="TopREADMElogo.png" alt="AntiHunter Command Center Logo" width="320" />
</p>

<h1 align="center">AntiHunter Command & Control Pro</h1>

AntiHunter Command & Control PRO is the companion operations platform for the AntiHunter SIGINT mesh network. Flash your AntiHunter detection nodes with the AntiHunter builds, then connect them here to orchestrate the entire perimeter defense mission. The Command Center ingests every heartbeat, target hit, triangulation update, and vibration alert from the mesh, renders nodes and geofences on a live map, automates scan/baseline/triangulation workflows, and drives alarm cues, exports, and audit trails.

> **Firmware note:** The companion firmware for mesh detection nodes lives in [lukeswitz/AntiHunter](https://github.com/lukeswitz/AntiHunter). Flash those builds to your field hardware before connecting them to this Command Center.

> **Early Release:** This is a beta build. Expect stability issues, breaking changes, and evolving features.

> **Security disclosure:** The platform has **not** undergone formal penetration testing or hardening for Internet-exposed deployments. Run it on trusted networks only, behind your own perimeter controls, until a full security review is complete.

---

## Table of Contents

1. [Overview](#overview)
2. [Core Features](#core-features)
   - [Key Highlights](#key-highlights)
   - [Digital Detection, Scanning & Triangulation](#digital-detection-scanning--triangulation)
   - [Drone Awareness & FAA Enhancements](#drone-awareness--faa-enhancements)
   - [UI Modules at a Glance](#ui-modules-at-a-glance)
3. [Architecture](#architecture)
4. [Security & Hardening](#security--hardening)
5. [Repository Layout](#repository-layout)
6. [Prerequisites](#prerequisites)
7. [Platform Setup](#platform-setup)
8. [Installation](#installation)
9. [Configuration](#configuration)
10. [Database & Migrations](#database--migrations)
11. [Running the Stack](#running-the-stack)
    - [Updating an Existing Deployment](#updating-an-existing-deployment)
12. [Running with Docker](#running-with-docker)
13. [Building for Production](#building-for-production)
14. [Production Deployment](#production-deployment)
15. [Serial Hardware & Meshtastic Sniffer](#serial-hardware--meshtastic-sniffer)
16. [Useful Scripts](#useful-scripts)
17. [Operations & Maintenance](#operations--maintenance)
18. [Troubleshooting](#troubleshooting)
19. [Legal Disclaimer](#legal-disclaimer)

---

## Overview

AntiHunter Command & Control PRO turns raw radio/mesh telemetry into actionable situational awareness. The application keeps track of nodes, devices, and geofences, allows operators to launch complex detection sequences, and streams alerts through a tone-aware alarm engine. Everything is multi-site aware and backed by Prisma/PostgreSQL for durability.

## Core Features

### Key Highlights

### Digital Detection, Scanning & Triangulation

- **Digital detections**: Meshtastic-like frames are parsed in real time and normalized into inventory entries with vendor/OUI resolution. The detector renders RSSI, timestamps, and raw payloads so analysts can confirm legitimacy.
- **Scanning workflows**: Command presets fire scan/baseline/deauth/randomization pipelines against nodes, with FOREVER protections and audit trails. Operators can schedule sweeps, chain commands, and monitor acknowledgements/results inside the console.
- **Tracking**: Every detection updates the live map with trails, heading vectors, RSSI pulses, and site-specific coloration. Inventory rows store the location history so you can pivot from console <-> map <-> export seamlessly.
- **Triangulation**: Multi-node detection events feed the triangulation engine, capturing angle-of-arrival data set by the nodes. Results surface in the Targets module with exports for external tooling (e.g., CSV/GeoJSON) and can be reviewed in the map view as overlays.
- **Exports & auditing**: Scan logs, triangulation snapshots, and detection histories are exportable from their respective modules, ensuring mission reporting and post-op analysis are one click away.

### Drone Awareness & FAA Enhancements

#### Drone Tracker & Inventory Drawer

- The live map now spawns a **Drone Tracker & Inventory** drawer whenever a telemetry frame arrives. The drawer lists every tracked drone/operator pair on a single line, shows the current heading (cardinal string), operator details, FAA metadata, and exposes map focus buttons for each entry.
- Clicking a drone or operator on the map re-opens the drawer if it was dismissed. Hostile rows pulse red, neutral/friendly rows pick up their site colors, and **Unknown** defaults to the new blue palette so status is immediately obvious.
- Status changes (Friendly / Neutral / Hostile) are committed through `PATCH /api/drones/:id/status` and reflected everywhere (map markers, drawer rows, Socket.IO events, MQTT federation). The UI guards against race conditions so you can keep toggling a status even while telemetry continues to stream.
- Set `DRONES_RECORD_INVENTORY=true` (see [Configuration](#configuration)) to automatically mirror every drone detection into the Inventory module; clearing inventory now flushes the drone cache and removes map markers until fresh telemetry arrives.

#### FAA Registry Integration

- The **Config -> FAA Registry** card can download and parse the public `ReleasableAircraft.zip` archive from the FAA (`https://registry.faa.gov/database/ReleasableAircraft.zip`). Uploading the ZIP (or just `MASTER.txt`) populates the local lookup cache.
- When the Command Center has internet access, it also performs on-demand lookups using the uasdoc API (`https://uasdoc.faa.gov/listDocs/{RID}`) through a throttled background queue. Results are cached for `FAA_ONLINE_CACHE_TTL_MINUTES` (default 60) and each RID/MAC lookup is rate-limited via `FAA_ONLINE_LOOKUP_COOLDOWN_MINUTES` (default 10).
- FAA matches update the drawer, map tooltips, and websocket/MQTT payloads automatically, so operators always see the craft and registrant names even after a restart.

#### Drone Geofence Breach Alarms

- Geofences now evaluate drone positions in addition to ground nodes. Tripping a perimeter raises a dedicated **Drone Geofence Breach** alarm level with its own sound slot on the **Config -> Alarms** page.
- While a breach is active the impacted geofence keeps its configured color but pulsates to draw attention, and the Drone Tracker drawer highlights the offending aircraft.

#### Flight Trails, Operators, and Persistence

- Each drone and operator pin now uses the same status-driven palette, includes heading vectors, and draws a historical trail so you can reconstruct the approach path.
- The backend keeps only one copy of each drone snapshot in memory and debounces writes to the database, preventing the persistence flood that previously occurred when running simulators or high-rate feeds.
- MQTT federation has been updated to publish only local drones and to retry failed subscriptions with exponential backoff, ensuring remote sites receive telemetry even across flaky links.

#### Simulator-Driven Testing

- `scripts/drone-simulator.cjs` posts fully formatted mesh lines to `/api/serial/simulate`, bootstraps a node, and streams drone telemetry (drone + operator positions) every 5 s. Supply an ADMIN JWT via `--token` to drive end-to-end tests without field hardware—see [Useful Scripts](#useful-scripts) for usage.
- The simulator supports real RID/MAC lists, adjustable speeds, and node/operator geometry. Because it mirrors the on-air payload format, every downstream parser (inventory, FAA lookup, alarms, MQTT) exercises the exact same code path you get from the live mesh.

### Mesh-Based Target Tracking

- **How operators start tracking:** promote a detection to a target, open the **Targets** page, and hit the `Track` button. You will be prompted for the tracking duration (10‑600 seconds). While a session is active the target row, map marker, and map overlay blink purple so the operator can see the estimation envelope in real time.
- **What happens on the mesh:** the command fan-outs to every node in the selected mesh/site. Each node reports periodic RSSI hits (and GPS lat/lon if available) for the MAC you selected. The backend’s `TargetTrackingService` ingests those detections inside a 45‑second sliding window, normalises each MAC, and weights the contribution from every node by RSSI strength. Direct GPS fixes from the triangulation nodes earn a higher weight, while simple RSSI-only hits are scaled by a BLE/WiFi path-loss model.
- **Estimation algorithm:** every batch of detections produces an intermediate centroid (great-circle average). We keep track of contributors, distance spread, total weight, and sample count so the operator sees where the “probable” device position sits. Successive estimates are smoothed to avoid jitter, and a persistence gate ensures we only write to the database every ~15 seconds or once the estimate moves ~8 metres. Confidence is clamped between 0–1 and reflects both RSSI strength and node diversity; single-node sightings never exceed the floor.
- **Why antenna consistency matters:** the algorithm assumes each node's antenna gain, orientation, and cable length are roughly the same. If one node has a wildly different antenna the RSSI weighting becomes biased and the centroid will drift toward that node. Always field the same antenna cut/length and mount height when you want high-confidence estimates.
- **Mesh density expectations:** tracking is most accurate inside the convex hull of the mesh. You can still “track” a MAC outside the mesh, but the estimate will hug the nearest node because it only has one line of bearing. The more evenly spaced your omni nodes are, the more believable the interpolation becomes. Think of it as RSSI-based trilateration rather than precise GNSS.
- **Spacing guidance:** plan for at least ~50 m spacing between nodes. Tighter spacing boosts confidence and reduces dilution of precision; wider spacing works, but the estimator has less overlap between coverage lobes and will “snap” toward the loudest node.
- **Limitations & reflections:** this is an estimation tool. It does not account for multipath reflections, terrain shielding, buildings, or antenna tilt. Treat the purple overlay as a probable region, not a guaranteed fix—obstacles and RF noise will widen the true uncertainty.

### Alert Automation & Integrations

- **Custom Alerts module**: build rules that match MACs, OUI prefixes, SSIDs, channels, RSSI windows, or inventory devices. Each rule controls its own alarm level, optional audible, and map styling (color, icon, blink, label). Promotions from Inventory drop straight into rule criteria so analysts can set up a watch list in seconds.
- **Alert Event Log**: the Alerts nav rail contains an Event Log page that mirrors Config’s layout—dark rail on the left, stacked cards on the right—so you can filter, search, and acknowledge past alert hits without leaving the module.
- **Webhook engine**: alert matches, inventory updates, node telemetry, and raw serial traffic can fan out to HTTPS endpoints with optional mutual TLS (CA bundle + client cert/key) and HMAC signatures. Hooks are configured under **Config → Webhooks** with inline testing, per-event subscription toggles, and automatic delivery logging.
- **Secure runtime**: webhook dispatchers let you disable TLS validation for lab setups or enforce full-chain verification in production. Client certificates and private keys are stored encrypted in the database, and Prisma migrations now cover inventory update events plus serial/raw tap targets.
- **Operator UX**: the Alerts, Config, and Addons pages now share the same shell (sidebar buttons outside the card, stacked sections within) so the experience is consistent no matter which subsystem you configure.

### UI Modules at a Glance

Each primary view ships with rich operator context.

#### Map

Tracks live nodes, renders trails and geofences, and highlights alerts in real time.

![Map view showing live nodes and radius overlays](images/Map.png)

#### Console

Launch commands, manage templates, and review command acknowledgements/audits.

![Console view with command orchestration](images/Console.png)

#### Inventory

Review discovered devices, signal strength history, vendor resolutions, and export datasets.

![Inventory view listing detected devices](images/InventoryFilled.png)

#### Targets

Promote detections to tracked targets, view triangulation results, and manage status notes.

![Targets view with active detections](images/TargetsFilled.png)

#### Geofence

Create and edit geofences, tune alarm behavior, and jump to polygons on the map.

![Geofence management interface](images/GeoFenceFilled.png)

#### Nodes

Audit node health, connectivity, and telemetry history with quick map focus actions.

![Nodes list with health indicators](images/NodesFilled.png)

#### Scheduler

Plan recurring scans, FOREVER tasks, and automated detection sequences.

![Scheduler automation dashboard](images/Scheduler.png)

#### Config

Adjust system defaults (alarms, detection presets, serial ports, site federation) from a single pane.

![Configuration panel with system defaults](images/Config.png)

#### Addons

Enable or disable optional modules (Scheduler, Alerts, Strategy Advisor, future analytics packs) to tailor the UI for your deployment. The updated capture shows the Addons catalog card, feature summaries, and the new badge callouts for beta-grade modules.

![Addons management](images/addons.png)

#### Exports

Generate CSV/GeoJSON bundles for inventory, targets, commands, and audit logs.

![Exports module with CSV and GeoJSON actions](images/Exports.png)

#### Account

Manage your profile, theme preferences, and admin-level user management tasks.

![Account preferences and admin tools](images/Account.png)

## Architecture

![AntiHunter multi-site architecture](images/architecture-overview.png)

### System Overview

| Layer          | Technology stack                                          | Role in the platform                                                                     |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Detection**  | AntiHunter mesh nodes (LoRa / Meshtastic payloads)        | Collects RF/BLE telemetry, vibration alerts, experimental RADAR/SIGINT streams           |
| **Edge C2**    | NestJS workers + Serial service + Gateway bridge          | Parses frames, normalises events, persists data, and originates outbound commands        |
| **Core C2**    | NestJS REST/WS API, Socket.IO, Prisma on PostgreSQL       | Surfaces APIs, websockets, scheduler, alarms, audit logging, command lifecycle tracking  |
| **Federation** | MQTT v3.1+ broker (QoS 1) & TAK/CoT bridge                | Shares node/device/command deltas across sites and publishes CoT feeds to TAK clients    |
| **Frontend**   | React (Vite), React Query, Zustand, Leaflet, Tailwind     | SPA with map, console, inventory, targets, configuration, scheduling, and admin consoles |
| **Tooling**    | pnpm workspaces, TypeScript strict mode, ESLint, Prettier | Developer experience, linting, formatting, and shared config across apps                 |

Each deployment runs its site-local C2 server and still functions if federation links are unavailable. The backend persists node, target, inventory, alarm, and audit records via Prisma/PostgreSQL. Socket.IO pushes live updates into Zustand stores so React screens stay real-time.

### Security & Protocols

| Surface             | Protocols & safeguards                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Device ingest**   | Serial (USB/UART) -> Meshtastic JSON/CBOR frames; optional signed frame validation; port selection locked behind RBAC.                     |
| **C2 API**          | HTTPS (configurable TLS certificates) + JWT auth; REST/WS share the same bearer token; role-aware guards on every controller.              |
| **Federation**      | MQTT (mqtt://... mqtts://, ws://... wss://) with per-site client IDs, QoS 1, optional mutual TLS (CA/cert/key). Topics namespaced `ahcc/`. |
| **Operator UI**     | HTTPS SPA; per-user preferences (theme, time format) stored server-side; alarm sounds served via signed URLs.                              |
| **TAK Integration** | Cursor-on-Target over TCP/UDP/HTTPS; selectable streams (nodes, alerts, targets, command ACKs); optional TLS and username/password.        |
| **Auditing**        | Every command, config change, and RBAC update persisted in the `AuditLog`; paired with per-command `CommandLog` lifecycle.                 |

Secrets such as MQTT credentials, TLS PEMs, TAK API keys, and SMTP passwords are encrypted at rest in the database. Environment variables (`SITE_ID`, `JWT_SECRET`, `HTTPS_CERT_PATH`, etc.) govern bootstrapping.

### Resilience & Fallback Paths

- **Local-first operation:** Each site keeps its own PostgreSQL instance and continues ingesting/commanding nodes if the broker or WAN link fails. Federation queues simply back off until the connection returns.
- **Command retry windows:** Serial sends use bounded retries with jittered backoff; failed ACKs surface as `ACK_TIMEOUT`/`RESULT_TIMEOUT` while the log entry persists for post-mortem review.
- **Alarm durability:** Alerts are recorded and replayed on reconnect, so socket re-subscriptions restitch event history.
- **Scheduler safeguard:** Work orders are stored in DB; missed executions (e.g., server restart) are re-evaluated on boot.
- **Data exports:** Inventory, targets, and command logs can be exported (CSV/JSON/GeoJSON) to seed a fresh node if a site must be rebuilt.

### MQTT Topic Topology

Multi-site deployments share state through a single broker. All topics live under the `ahcc/` namespace and are segmented per site (`<siteId>` defaults to `default`). The current tree looks like this:

| Topic                            | Direction           | Payload                                                                                                                                 |
| -------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ahcc/<siteId>/nodes/upsert`     | publish + subscribe | Node snapshots (id, coords, last message metadata) emitted on heartbeats.                                                               |
| `ahcc/<siteId>/inventory/upsert` | publish + subscribe | Inventory device upserts (MAC, vendor, RSSI stats, last position).                                                                      |
| `ahcc/<siteId>/targets/upsert`   | publish + subscribe | Target lifecycle payloads (status, notes, tags, location, device metadata).                                                             |
| `ahcc/<siteId>/targets/delete`   | publish + subscribe | `{ targetId }` payload notifying a target deletion.                                                                                     |
| `ahcc/<siteId>/commands/events`  | publish + subscribe | Command lifecycle messages (`command.event`) so consoles stay aligned.                                                                  |
| `ahcc/<siteId>/commands/request` | publish + subscribe | Remote command execution request for another site's serial worker.                                                                      |
| `ahcc/<siteId>/events/<type>`    | publish + subscribe | High-value broadcasts (`event.alert`, `event.target`, `command.ack`, `command.result`). `<type>` is sanitized (slashes/dots -> dashes). |

All topics use QoS 1 by default (configurable per site). Publishers short-circuit when the `originSiteId` matches their own so messages are not looped. If additional replication streams are added, follow the `ahcc/<site>/<resource>/<action>` convention.

#### MQTT Configuration Cheat Sheet

Configure federation per site in **Config -> MQTT** (or directly via the `MqttConfig` table). Key fields:

| Field                                      | Purpose                                                           | Notes                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `brokerUrl`                                | Broker endpoint (`mqtt://..., `mqtts://`, `ws://..., or `wss://`) | Example: `mqtt://...roker:1883`. WebSocket brokers often use `ws://...ost:port/mqtt`.                 |
| `clientId`                                 | Unique MQTT client identifier                                     | Defaults to `command-center-<siteId>`; must be unique on shared brokers.                              |
| `username` / `password`                    | Credentials for authenticated brokers                             | Leave blank for anonymous brokers. Combine with TLS settings when required.                           |
| `tlsEnabled`, `caPem`, `certPem`, `keyPem` | TLS configuration                                                 | Only needed for `mqtts://`/`wss://` brokers that require mutual TLS. PEM values are stored encrypted. |
| `qosEvents` / `qosCommands`                | Default QoS for publish/subscribe (`0`, `1`, or `2`)              | Defaults to `1`. Adjust when the broker or network profile demands otherwise.                         |
| `enabled`                                  | Toggle federation for the site                                    | Disable to keep a site local-only while preserving its saved connection details.                      |

**Environment defaults:**  
Set `SITE_ID` to the local site identifier (defaults to `default`). Each Command Center deployment **must use a unique `SITE_ID`** so MQTT replication distinguishes the origin site (e.g., `SITE_ID=alpha`, `SITE_ID=bravo`). Restart the backend after changing it. Optional flags like `MQTT_ENABLED`, `MQTT_COMMANDS_ENABLED`, and `MQTT_NAMESPACE` seed runtime config before any database records exist.

> **Tip:** Set `SITE_ID` (and optionally `SITE_NAME`) in the root `.env` **before** running `pnpm prisma db seed`. The seed script now creates the initial `Site`, `SerialConfig`, and `MqttConfig` rows with that identifier, so make sure it matches the value you expect the backend to advertise.

## Security & Hardening

AntiHunter ships with layered defenses: RBAC, MFA, rate limiting, and a programmable firewall. This section groups every capability and explains how to tune it.

### Authentication & Session Controls

- Roles (`ADMIN`, `OPERATOR`, `ANALYST`, `VIEWER`) gate every controller.
- JWT sessions expire quickly and inherit whatever you set for `JWT_EXPIRY`.
- Operators must accept the legal notice before accessing the console.
- TOTP-based 2FA plus invitation/password reset expirations protect account lifecycle flows.

| Setting / Env var             | Default                     | Purpose                                                             |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `JWT_SECRET`                  | _required_                  | Symmetric signing key for API + Socket.IO sessions. Rotate often.   |
| `JWT_EXPIRY`                  | `12h`                       | Lifetime of issued access tokens.                                   |
| `INVITE_EXPIRY_HOURS`         | `48`                        | TTL for admin-generated invitation links.                           |
| `PASSWORD_RESET_EXPIRY_HOURS` | `4`                         | TTL for password reset emails.                                      |
| `TWO_FACTOR_ISSUER`           | `AntiHunter Command Center` | Friendly label displayed inside authenticator apps.                 |
| `TWO_FACTOR_TOKEN_EXPIRY`     | `10m`                       | Window during which submitted 2FA codes remain valid.               |
| `TWO_FACTOR_WINDOW`           | `1`                         | Number of TOTP steps accepted on either side of the current window. |
| `TWO_FACTOR_SECRET_KEY`       | _(optional)_                | Seed used when bootstrapping TOTP secrets in offline environments.  |

### Abuse & Rate Limiting

- `RateLimitGuard` protects every auth endpoint with both burst and sustained windows.
- Login forms include a honeypot field plus a minimum submit timer (`AUTH_MIN_SUBMIT_MS`).
- When a limit trips, the firewall's auth-failure counter auto-bans the offending IP while returning a neutral message to the UI.

| Rule / Env var                                                | Default           | Notes                                                                                        |
| ------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_DEFAULT_LIMIT` / `RATE_LIMIT_DEFAULT_TTL`         | `300` req / `60s` | Fallback when a controller does not define its own rule.                                     |
| `RATE_LIMIT_LOGIN_BURST_LIMIT` / `RATE_LIMIT_LOGIN_BURST_TTL` | `10` / `10s`      | Short burst limiter on `/auth/login`.                                                        |
| `RATE_LIMIT_LOGIN_LIMIT` / `RATE_LIMIT_LOGIN_TTL`             | `30` / `60s`      | Sustained login limiter that feeds the firewall.                                             |
| `RATE_LIMIT_LEGAL_LIMIT` / `RATE_LIMIT_LEGAL_TTL`             | `20` / `300s`     | Protects the legal acceptance endpoint from script abuse.                                    |
| `RATE_LIMIT_2FA_LIMIT` / `RATE_LIMIT_2FA_TTL`                 | `10` / `300s`     | Caps TOTP verification attempts.                                                             |
| `AUTH_MIN_SUBMIT_MS`                                          | `600` ms          | Minimum time between rendering the login form and submission; pairs with the honeypot field. |

### Account Lockout & Login Alerts

- Password failures accrue per-user counters; once the threshold is crossed the account is locked and security contacts are alerted.
- Suspicious logins (new country/IP) raise security alerts, notify operators, and reset trusted device metadata.
- Admins can unlock accounts via `POST /users/:id/unlock`.

| Setting / Env var               | Default                                  | Notes                                                                                      |
| ------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `AUTH_LOCKOUT_ENABLED`          | `true`                                   | Disable only for lab environments.                                                         |
| `AUTH_LOCKOUT_THRESHOLD`        | `5` attempts                             | Number of consecutive password failures before locking the account.                        |
| `AUTH_LOCKOUT_DURATION_MINUTES` | `0`                                      | Minutes until automatic unlock. `0` = manual unlock required.                              |
| `AUTH_LOCKOUT_NOTIFY`           | _(inherits `SECURITY_ALERT_RECIPIENTS`)_ | Comma-separated list of emails that receive lockout notices.                               |
| `AUTH_ANOMALY_REQUIRE_2FA`      | `true`                                   | Forces a fresh MFA challenge for anomaly-detected logins (in addition to the normal flow). |
| `AUTH_ANOMALY_NOTIFY`           | _(inherits `SECURITY_ALERT_RECIPIENTS`)_ | Email recipients for anomaly login alerts.                                                 |
| `SECURITY_ALERT_RECIPIENTS`     | _(unset)_                                | Global fallback email list for any security notification.                                  |

### Firewall & Network Controls

The `/config/firewall` API (and Config UI) manages allow/deny policies, geo filtering, and auto-bans triggered by auth failures. Logs can be promoted directly into permanent rules.

| Config field                            | Default behavior                  | Where to set                                                                  |
| --------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `enabled`                               | `false` until an admin toggles it | `PUT /config/firewall`                                                        |
| `defaultPolicy`                         | `ALLOW`                           | Switch to `DENY` for zero-trust sites.                                        |
| `geoMode`                               | `DISABLED`                        | Choose `ALLOW_ONLY` or `BLOCK_LIST` to enforce ISO country allow/block lists. |
| `allowedCountries` / `blockedCountries` | `[]`                              | ISO 3166-1 alpha-2 codes applied based on `geoMode`.                          |
| `ipAllowList` / `ipBlockList`           | `[]`                              | CIDR strings or single IPs. Allow list takes precedence.                      |
| `failThreshold`                         | `5` (DB default)                  | Number of auth failures before issuing an automatic ban.                      |
| `failWindowSeconds`                     | `300`                             | Time window used when counting failures.                                      |
| `banDurationSeconds`                    | `3600`                            | Temporary ban length applied to abusive IPs.                                  |

**Before you enable the firewall:**  
- Seed trusted IPs first: add `127.0.0.1` and `::1` (and your office/VPN CIDRs) to `ipAllowList` so you cannot lock yourself out during testing.  
- Keep `defaultPolicy=ALLOW` until you have confirmed allow lists and geo rules are correct; then switch to `DENY` if needed.  
- If you use geo filtering, double-check ISO country codes and start in `BLOCK_LIST` mode with a small pilot blocklist.  
- Leave `failThreshold`/`banDurationSeconds` at defaults initially; tune only after you see real login volumes in the firewall logs.  
- Know the recovery path: you can always clear bans or re-open access by updating `FirewallConfig` and removing rows from `FirewallRule`/`FirewallLog` (see Troubleshooting).  
- Test from two networks (or one console + one private window) before turning this on in production to verify the allow list works as expected.  

### Transport & Secrets

Keep certificates, mail credentials, and site identifiers in environment variables—never in source control. When terminating TLS inside NestJS, provide PEM paths via the variables below.

| Setting                                                                        | Default   | Notes                                                                 |
| ------------------------------------------------------------------------------ | --------- | --------------------------------------------------------------------- |
| `HTTPS_ENABLED`                                                                | auto      | Forces the backend to expect TLS; otherwise inferred from cert paths. |
| `HTTPS_KEY_PATH` / `HTTPS_CERT_PATH` / `HTTPS_CA_PATH` / `HTTPS_PASSPHRASE`    | _(unset)_ | PEM bundle + optional passphrase for in-process TLS.                  |
| `HTTP_PREFIX`                                                                  | `api`     | Namespace for REST routes (useful when reverse proxying).             |
| `HTTP_REDIRECT_PORT`                                                           | _(unset)_ | Enables HTTP->HTTPS redirects when running dual listeners.            |
| `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM` | _(unset)_ | SMTP settings for invite/reset emails. Require STARTTLS/SMTPS.        |
| `SITE_ID`                                                                      | `default` | Tag firewall logs, MQTT topics, and exports per site for auditing.    |

- Helmet now enforces CSP, referrer policy, frameguard, cross-origin resource policy, and HSTS (when HTTPS is enabled) for every response.

### Command Audit & Attestation

- Every `CommandLog` row stores the originating IP, user-agent, and optional client fingerprint for "who sent this command?" investigations.
- REST and WebSocket command paths automatically pass metadata; remote MQTT fan-out preserves origin site IDs for cross-site attestations.
- Config updates (App + Firewall) are persisted in `AuditLog` with before/after snapshots to provide tamper-evident history.

### Hardening Checklist

- **Authentication throttling** — login, legal acceptance, and 2FA routes now run through a Redis-backed `RateLimitGuard` that enforces both burst and sustained limits, tripping firewall escalation for abusive clients.
- **Bot heuristics on login** — UI forms include a honeypot field plus a minimum submit time (600 ms) so scripted attacks are rejected server-side without inconveniencing operators.
- **Neutral firewall messaging** — when abuse is detected, the API surfaces neutral responses while logging detailed context internally, preventing the login page from advertising firewall decisions.
- Enforce HTTPS everywhere with modern TLS ciphers (consider terminating behind an ALB / nginx reverse proxy with OCSP stapling).
- Rotate JWT signing secrets and database credentials regularly; store them in a vault or managed secret store.
- Enable 2FA for all privileged users and keep recovery codes in offline storage.
- Apply database row-level backups and point-in-time recovery; schedule regular restore drills.
- Lock down the serial host: run the backend service under a dedicated system account with least privilege and disable unused TTY devices.
- Review firewall policies and geo/IP blocking rules, auto-expire temporary bans, and forward logs to a SOC/SIEM.
- Monitor MQTT broker access logs; require mutual TLS when traversing untrusted networks.
- Harden Docker hosts (if used): disable root SSH login, keep the kernel patched, and enable auditd or similar for command tracking.

### Port Exposure Reference

| Service / Flow               | Default Port  | Notes & Hardening Steps                                                                              |
| ---------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| HTTPS API + Socket.IO        | 443 (or 3000) | Reverse proxy with TLS termination; restrict to trusted operator ranges or VPN.                      |
| Serial worker (local device) | n/a (USB)     | Physical access only; ensure `/dev/tty*` or COM ports are root-owned and audit device plug events.   |
| PostgreSQL / Prisma          | 5432          | Bind to localhost/VPC only; require SCRAM auth and TLS; rotate credentials.                          |
| MQTT broker (federation)     | 1883 / 8883   | Prefer 8883 with mutual TLS; enforce client ID allowlists; rate-limit connection attempts.           |
| TAK/CoT bridge               | 8087 / 8089   | Use TLS profiles when possible; generate per-client API keys; segregate on dedicated security group. |
| Prometheus / Metrics scrape  | 9100+         | Keep behind VPN and IP allowlists; disable if metrics are collected by sidecars.                     |
| SMTP relay                   | 587 / 465     | Require STARTTLS/SMTPS with credential auth; scope accounts to command notifications only.           |

## Repository Layout

```
.
|- apps/
|  |- backend/           # NestJS app, Prisma schema, serial services
|  '- frontend/          # Vite SPA with React routes/stores
|- tools/
|  '- meshtastic-sniffer.ts  # standalone CLI to capture serial packets
|- pnpm-workspace.yaml
|- tsconfig.base.json
`- README.md
```

## Prerequisites

- **Node.js** 20 or newer (ships with Corepack for pnpm)

- **pnpm** 9 or newer (`corepack enable` sets it up automatically)

- **PostgreSQL** 14+ (local or managed)

- Build toolchain:
  - Linux: `build-essential`, `pkg-config`, `libssl-dev`

  - macOS: Xcode command-line tools

  - Windows: automatic install via Node.js (or Visual Studio Build Tools)

- Optional: Docker Desktop (for Postgres), Git, serial drivers (FTDI/CH340)

## Platform Setup

### Linux (Debian/Ubuntu)

```bash

sudo apt update

sudo apt install -y curl git build-essential pkg-config libssl-dev \

    python3 make gcc g++ postgresql-client

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

sudo apt install -y nodejs

sudo corepack enable

corepack prepare pnpm@latest --activate

sudo usermod -aG dialout "$USER"   # access to /dev/ttyUSB*

```

### macOS

```bash
xcode-select --install
brew install node@20 pnpm git postgresql
brew services start postgresql
```

<details>
<summary>macOS Command Center install checklist</summary>

1. **Clone & install dependencies**

   ```bash
   git clone https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO.git
   cd AntiHunter-Command-Control-PRO
   pnpm install
   ```

2. **Install the USB serial driver for your adapter**
   - Silicon Labs CP210x: `brew install --cask silicon-labs-vcp-driver`
   - Reboot so `/dev/tty.wchusbserial*` (or `/dev/tty.SLAB_USBtoUART*`) appears.

3. **Create `.env` with a unique `SITE_ID` before seeding**

   ```env
   SITE_ID=ahcc
   SITE_NAME=AHCC
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/command_center
   FPV_DECODER_ENABLED=true
   PORT=3000
   ```

4. **Seed the database**

   ```bash
   pnpm --filter @command-center/backend prisma db seed
   ```

5. **Start backend (and frontend if desired)**

   ```bash
   pnpm --filter @command-center/backend dev
   pnpm --filter @command-center/frontend dev
   ```

6. **Configure serial** – list ports, then set Config -> Serial

   ```bash
   pnpm --filter @command-center/backend exec node -e "const { SerialPortStream } = require('@serialport/stream'); SerialPortStream.list().then(list => console.log(list));"
   ```

7. **Enable MQTT federation** in Config -> MQTT (set broker URL/credentials and enable replication).

8. **Verify runtime site**
   ```bash
   curl http://localhost:3000/api/config/runtime
   ```
   Should return `"siteId":"ahcc"`.
   </details>

### Windows 10/11 (PowerShell)

```powershell

# Install Node.js 20+ from https://nodejs.org

corepack enable

corepack prepare pnpm@latest --activate

git clone https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO.git

# Optional: Docker Desktop for Postgres

# Serial ports appear under Device Manager -> Ports (COM & LPT)

```

> **WSL2**: Use the Linux instructions inside WSL. For USB passthrough, either run the backend on Windows or enable USBIP (`usbipd-win`).

## Installation

```bash

git clone https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO.git

cd AntiHunter-Command-Control-PRO

pnpm install

```

## Configuration

Create `apps/backend/.env`:

```
# Core backend wiring
DATABASE_URL="postgresql://command_center:command_center@localhost:5432/command_center"
PORT=3000
HTTP_PREFIX=api
LOG_LEVEL=info
SITE_ID=alpha
SITE_NAME="Alpha Site"

# HTTPS (leave disabled for local dev)
HTTPS_ENABLED=false
HTTPS_KEY_PATH=
HTTPS_CERT_PATH=

# Serial defaults (seed the single SerialConfig row)
SERIAL_DEVICE=/dev/ttyUSB0
SERIAL_BAUD=115200
SERIAL_DATA_BITS=8
SERIAL_PARITY=none
SERIAL_STOP_BITS=1
SERIAL_DELIMITER=\n
SERIAL_RECONNECT_BASE_MS=1000
SERIAL_RECONNECT_MAX_MS=15000
SERIAL_RECONNECT_JITTER=0.2
SERIAL_RECONNECT_MAX_ATTEMPTS=0
SERIAL_PROTOCOL=meshtastic-rewrite

# Command protections
ALLOW_FOREVER=true
ALLOW_ERASE_FORCE=false
```

Optional environment flags:

| Variable                             | Description                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                         | If auth is enabled later                                                                                                     |
| `SITE_ID`                            | Default site for ingest                                                                                                      |
| `WS_MAX_CLIENTS`                     | Socket.IO connection limit                                                                                                   |
| `SERIAL_PROTOCOL`                    | Parser profile (`meshtastic-rewrite`, `nmea-like`, etc.)                                                                     |
| `HTTPS_ENABLED`                      | `true` to serve the backend over HTTPS                                                                                       |
| `HTTPS_KEY_PATH`                     | PEM private key path when HTTPS is enabled                                                                                   |
| `HTTPS_CERT_PATH`                    | PEM certificate (or chain) path for HTTPS                                                                                    |
| `HTTPS_CA_PATH`                      | Optional comma separated CA bundle paths                                                                                     |
| `HTTPS_PASSPHRASE`                   | Passphrase if the private key is encrypted                                                                                   |
| `HTTP_REDIRECT_PORT`                 | Optional plain HTTP listener that 301-redirects to HTTPS                                                                     |
| `CLUSTER_WORKERS`                    | Number of backend workers for cluster mode (default 1 = single process; leader + replicas when >1)                           |
| `TAK_ENABLED`                        | `true` to boot the TAK bridge automatically                                                                                  |
| `TAK_PROTOCOL`                       | TAK transport (`UDP`, `TCP`, or `HTTPS`)                                                                                     |
| `TAK_HOST`                           | TAK core hostname or IP                                                                                                      |
| `TAK_PORT`                           | Port that matches the TAK protocol (e.g., 6969/8088/8443)                                                                    |
| `TAK_TLS`                            | `true` when TLS certificates are required                                                                                    |
| `TAK_USERNAME`                       | Optional basic-auth username for TAK gateways                                                                                |
| `TAK_PASSWORD`                       | Optional basic-auth password (otherwise set via UI)                                                                          |
| `TAK_API_KEY`                        | Optional API key for HTTPS-based TAK cores                                                                                   |
| `TWO_FACTOR_ISSUER`                  | Label shown in authenticator apps (default `AntiHunter Command Center`)                                                      |
| `TWO_FACTOR_TOKEN_EXPIRY`            | Lifetime of the temporary two-factor challenge token (default `10m`)                                                         |
| `TWO_FACTOR_WINDOW`                  | Allowed OTP drift window (number of 30s steps, default `1`)                                                                  |
| `TWO_FACTOR_SECRET_KEY`              | 32+ character passphrase used to encrypt stored authenticator secrets (AES-256-GCM). Leave unset only for local development. |
| `DRONES_RECORD_INVENTORY`            | `true` to auto-create/update inventory entries whenever a drone telemetry frame contains a MAC address + reporting node.     |
| `FAA_ONLINE_LOOKUP_ENABLED`          | Set to `false` to force offline-only FAA lookups (default `true`).                                                           |
| `FAA_ONLINE_CACHE_TTL_MINUTES`       | Minutes to cache positive FAA matches returned from the uasdoc API (default `60`).                                           |
| `FAA_ONLINE_LOOKUP_COOLDOWN_MINUTES` | Per-RID/MAC cooldown between online lookup attempts (default `10`).                                                          |

Frontend currently consumes backend settings via API, so no extra `.env` is needed.

### Drone & FAA configuration quick steps

1. **Mirror detections into inventory:** add `DRONES_RECORD_INVENTORY=true` to `apps/backend/.env` (or set it via your secrets manager) and restart the backend. Every drone telemetry event that includes a MAC + node id is now persisted in the Inventory module in addition to the live tracker.
2. **Seed FAA data offline:** download [ReleasableAircraft.zip](https://registry.faa.gov/database/ReleasableAircraft.zip) from the FAA, then open **Config -> FAA Registry** in the UI and click **Upload ZIP** (or upload `MASTER.txt`) to populate the local cache. The parser runs server-side and the FAA card shows ingest progress plus the number of cached aircraft.
3. **Enable/disable online lookups:** the same FAA card exposes a **Online Lookup** toggle backed by `FAA_ONLINE_LOOKUP_ENABLED`. Leave it on when the Command Center has outbound internet access; turn it off for fully air-gapped deployments. Online lookups hit `https://uasdoc.faa.gov/listDocs/{RID}` using the cooldown/TTL described by the env vars above.
4. **Customize drone geofence alarms:** browse to **Config -> Alarms**, scroll to the new **Drone Geofence Breach** slot, upload a custom tone if desired, and test it with the preview button. The alarm fires whenever a tracked drone crosses a geofence boundary.

### Environment file layout

The backend resolves `process.env` in this order:

1. **Repository root `.env`** – global defaults shared by the workspace (useful for local development).
2. **`apps/backend/.env`** – overrides that apply only to the NestJS service (preferred place for backend secrets when running `pnpm dev`).
3. **`apps/backend/prisma/.env`** – read exclusively by Prisma CLI utilities (migrations, `prisma studio`, seed scripts). This file normally only contains `DATABASE_URL` so migrations can run without loading the full backend environment.

The files are optional; supply whichever ones make sense for your deployment model (for Docker/Kubernetes you can mount an external env file instead). When values are duplicated, the later file in the list wins.

### Serial defaults & persistence

Each Command Center installation owns a single local LoRa gateway, so the serial stack now persists **one global configuration** (record id `serial`) regardless of how many sites you manage through federation.

- On first access (`GET /serial/config`), the backend seeds that global record with any `SERIAL_*` values present in the environment (e.g., `SERIAL_DEVICE`, `SERIAL_BAUD`, `SERIAL_DELIMITER`, `SERIAL_RECONNECT_BASE_MS`, etc.). The **Config -> Serial** card immediately reflects those defaults so operators can tweak them without touching `.env`.
- Subsequent edits through the UI/API write directly to the database and override the env defaults. Environment variables are only used as bootstrap values—they will not overwrite saved settings on restart.
- Changing the env defaults later? Use the UI/API (or delete the lone `SerialConfig` row) to reapply them. `SITE_ID` still labels events for federation, but it no longer influences serial persistence.
- The Serial card also shows a **Detected Ports** dropdown (populated from `GET /serial/ports`) and a **Reset to defaults** button (`POST /serial/config/reset`). Use them to quickly switch USB devices or re-seed from the current env without touching the database manually.

### Two-Factor Authentication (optional)

1. Choose a 32+ character secret used to encrypt TOTP seeds and add it to `apps/backend/.env`:
   ```env
   TWO_FACTOR_SECRET_KEY="change-this-to-a-long-random-passphrase"
   TWO_FACTOR_ISSUER="AntiHunter Command Center"
   ```
   Restart the backend after updating the file.
2. Users can now browse to **Account -> Two-Factor Authentication**, click **Enable Two-Factor**, scan the QR code with Google Authenticator (or any TOTP app), submit the current code, and download/store the generated recovery codes.
3. Administrators can regenerate recovery codes or disable 2FA from the same panel. Temporary login tokens for 2FA challenges expire after `TWO_FACTOR_TOKEN_EXPIRY` (default 10 minutes).

### Enabling HTTPS (optional)

1. Generate or obtain a PEM encoded private key and certificate chain (for local testing `mkcert` or OpenSSL works; in production prefer a CA-issued cert).
2. Place the files somewhere readable by the backend service account and update `apps/backend/.env`:
   - **Linux**:
     ```env
     HTTPS_ENABLED=true
     HTTPS_KEY_PATH=/etc/ahcc/tls/server.key
     HTTPS_CERT_PATH=/etc/ahcc/tls/server.crt
     HTTPS_CA_PATH=/etc/ahcc/tls/ca.pem    # optional bundle when using a private CA
     HTTP_REDIRECT_PORT=8080               # optional 301 redirect listener
     ```
     Ensure the backend user can read the files (`chmod 640` + `chgrp` as needed).
   - **macOS**:
     ```env
     HTTPS_ENABLED=true
     HTTPS_KEY_PATH=$HOME/certs/ahcc.key
     HTTPS_CERT_PATH=$HOME/certs/ahcc.crt
     HTTP_REDIRECT_PORT=8080
     ```
     When exporting from the Keychain, save the key/cert as PEM files the Node process can read.
   - **Windows**:
     ```env
     HTTPS_ENABLED=true
     HTTPS_KEY_PATH=C:/ahcc/certs/server.key
     HTTPS_CERT_PATH=C:/ahcc/certs/server.crt
     HTTP_REDIRECT_PORT=8080
     ```
     Forward slashes avoid escaping; if you prefer backslashes, double them (`C:\\ahcc\\certs\\server.key`).
3. Restart the backend (`pnpm --filter @command-center/backend dev` or your process manager). The server logs `"[https] HTTPS enabled using provided certificates."` when TLS is active.
4. Update `APP_URL` and any reverse proxies to reference the `https://` scheme.
5. When serving the frontend from a separate origin (e.g., static CDN or Vite dev server), set `VITE_BACKEND_URL=https://your-backend-host:port` before building so API calls and the Socket.IO client use HTTPS/WSS automatically.
6. Verify the WebSocket upgrade in browser devtools under **Network -> WS**; the scheme should be `wss://`.

### TAK / Cursor-on-Target Bridge

The backend ships with a TAK bridge that translates node/alert telemetry into Cursor-on-Target events for ATAK/WinTAK ecosystems.

1. Apply the latest Prisma migrations (`pnpm --filter @command-center/backend prisma migrate deploy`) so the `TakConfig` table exists.

2. Set baseline values through environment variables (see table above) **or** configure them from the **Config -> TAK Bridge** card in the UI.

3. Choose the transport (`UDP` or `TCP` today; HTTPS/TLS fields are stored now for the upcoming TLS connector), then supply the host/port and any credentials.

4. Use the **Streams** and **Alert severities** toggles to decide which telemetry (nodes, targets, command ack/results, per-level alerts) is mirrored into TAK.

5. Click **Restart Bridge** after changes to force the connector to reconnect with the new settings.

6. When enabled, node positions and alert severities are pushed to the TAK core in real time; triangulation results and command acks appear as CoT notes.

> Passwords and API keys are write-only in the UI - enter new values when rotating credentials or use the **Clear Password** action.

>

> HTTPS/TLS support is staged. The configuration is persisted, but the connector currently establishes UDP or TCP sockets while the TLS transport lands.

**Stream controls (defaults):**

| Toggle                   | Default | CoT payload     | Notes                                                                    |
| ------------------------ | ------- | --------------- | ------------------------------------------------------------------------ |
| Node telemetry           | Yes     | `AHCC-NODE-*`   | Emits live node markers with last message metadata.                      |
| Target detections        | Yes     | `AHCC-TARGET-*` | Sends MAC detections/triangulation estimates (includes RSSI/confidence). |
| Command acknowledgements | No      | `AHCC-CMDACK-*` | Forward only if your TAK users need live command audit.                  |
| Command results          | No      | `AHCC-CMDRES-*` | Large payloads trimmed to 240 characters in CoT detail.                  |
| Alert: Info              | No      | `AHCC-ALERT-*`  | Keep off unless you need every heartbeat-level notification.             |
| Alert: Notice            | Yes     |                 | Targets promoted, triangulation updates, baselines.                      |
| Alert: Alert             | Yes     |                 | Vibration, deauth, drone detections.                                     |
| Alert: Critical          | Yes     |                 | ERASE, tamper, high-priority events.                                     |

All events are tagged under `<detail><ahcc*>...` blocks so TAK filters/overlays can key off `site`, `node`, `mac`, `status`, and more. Partial failures (e.g., TAK server offline) are logged with `TAK_BRIDGE drop (...)` lines in the backend output. If you see persistent drops, restart the bridge from the Config page after verifying connectivity.

## Database & Migrations

All Prisma migrations and seed scripts live in `apps/backend/prisma`. Run once after configuring Postgres:

```bash

cd apps/backend

pnpm prisma:generate

pnpm prisma:migrate

pnpm prisma:seed

```

> **Managed Postgres note:** The `pnpm prisma:migrate` script runs `prisma migrate deploy`, so it works with database roles that cannot create new databases. When authoring new migrations locally, use `pnpm prisma:migrate:dev` against a development instance that grants `CREATE DATABASE`.

Seed inserts singleton config rows (AppConfig, AlarmConfig, VisualConfig, CoverageConfig) plus a default site and admin user stub.

### Database Update Helper

Upgrading older deployments that already contain manually created tables can generate Prisma errors (missing relations, duplicate tables, etc.). To simplify recovery, the repository ships with an interactive helper:

```bash
# from the repo root
pnpm update-db
```

The script provides options to:

1. Baseline (mark as applied) the initial migration `20251027205237_init` without changing data.
2. Baseline any other migration once you've confirmed the schema change already exists.
3. List all migrations in chronological order.
4. Run `prisma migrate deploy` against the configured database.
5. Run `prisma migrate reset --force --skip-seed` (drops the schema; only use when you intend to rebuild).
6. Drop and recreate the entire `public` schema (hard reset). Follow with option 4 to reapply migrations.

Each action logs the exact `pnpm prisma ...` command executed so you can reproduce it manually later. Use this helper any time a production upgrade leaves the `_prisma_migrations` table out of sync with the actual schema.

## Running the Stack

Open two terminals:

```bash

# Terminal 1 - backend API + WebSocket + serial worker

cd apps/backend

pnpm dev     # http://localhost:3000



# Terminal 2 - frontend SPA

cd apps/frontend

pnpm dev     # http://localhost:5173

```

Prefer a single command? From the repo root run `pnpm AHCC` to start both workspaces in parallel (single backend process).

Need multi-core / multi-worker? Use the cluster script and set worker count (leader + replicas):

```powershell
$env:CLUSTER_WORKERS=2; pnpm AHCC:cluster   # Windows PowerShell example
```

Or on POSIX shells:

```bash
CLUSTER_WORKERS=2 pnpm AHCC:cluster
```

The leader is the only process that opens serial hardware; replicas share the HTTP/WebSocket load.

The Vite dev server proxies `/api/*`, `/healthz`, `/readyz`, `/metrics`, `/socket.io` back to the NestJS service so CORS is not a concern in development.

For production after building, start the backend with clustering if you want multi-core:

```bash
CLUSTER_WORKERS=4 pnpm --filter @command-center/backend start:cluster
```

Set `CLUSTER_WORKERS=1` (or omit) to keep a single process.

### Updating an Existing Deployment

When you already have AntiHunter Command & Control PRO running in a live environment, follow this checklist after pulling new commits:

1. **Fetch latest code and dependencies**
   ```bash
   git pull origin main
   pnpm install
   ```
2. **Apply database migrations** (required whenever new migrations exist).

   ```bash
   pnpm --filter @command-center/backend exec prisma migrate deploy
   ```

   - In containerized or managed environments, execute the same command inside the deployment target prior to restarting services.
   - If the migration fails, resolve the database issue before proceeding; never run the backend against a partially migrated schema.
   - Prefer an automatic helper that inspects the current installation? Run `pnpm update-db` (alias of `node scripts/db-update-helper.mjs`) and it will detect pending migrations, baseline existing schemas, skip duplicate CREATE TABLE migrations, and apply updates. If drift is detected it prints the Prisma guidance you need to follow.

3. **Rebuild backend and frontend bundles**
   ```bash
   pnpm --filter @command-center/backend build
   pnpm --filter @command-center/frontend build
   ```
   Deploy the resulting artifacts (`apps/backend/dist`, `apps/frontend/dist`) or rebuild Docker images as needed.
4. **Restart services** so the updated code is loaded (systemd, PM2, Docker Compose, Kubernetes, etc.).
5. **Verify health**
   - Backend: check `/healthz` and review logs for the latest migration status.
   - Frontend: confirm the new build is served (version banner or build timestamp).
   - Optional: run `pnpm lint` or smoke tests relevant to your environment.
6. **Maintain rollback readiness**
   - Back up the database before upgrading.
   - If a release introduces issues you cannot fix quickly, restore the snapshot and redeploy the previous commit.

> **Tip:** For multi-site or federated deployments, run the migration step once (against the shared database) before restarting each site. Keeping every instance on the same schema prevents replication drift.

## Running with Docker

> Tested with Docker Engine 25+ and Compose V2. Make sure virtualization is enabled and (on Windows/macOS) that file sharing is configured for the repository folder.

### 1. Prerequisites

- Docker Desktop (Windows/macOS) **or** Docker Engine (Linux).

- Docker Compose V2 (bundled with recent Docker releases). Verify with:

  ```bash

  docker compose version

  docker info

  ```

### 2. Clone and prepare the repo

```bash

git clone https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO.git

cd AntiHunter-Command-Control-PRO

```

Optional: copy the sample Docker environment file and adjust credentials/secrets before the first run.

```bash

cp docker/.env.example docker/.env.local

# edit docker/.env.local with your DATABASE_URL, JWT secret, etc.

```

Compose auto-loads `.env` files adjacent to `docker-compose.yml`. To use the custom file above, launch with `docker compose --env-file docker/.env.local ...`. If you skip this step the defaults baked into `docker-compose.yml` are used (admin email `admin@example.com`, password `admin`).

### 3. Build the images

```bash

docker compose build

# or if you created docker/.env.local:

docker compose --env-file docker/.env.local build

```

This compiles the backend (NestJS) and frontend (Vite) and caches dependencies in intermediate layers.

### 4. Start the stack

```bash

docker compose up -d

# or with a custom env file

docker compose --env-file docker/.env.local up -d

```

- `cc_postgres` stores data in the `postgres-data` named volume.

- `cc_backend` runs Prisma migrations on boot (`RUN_MIGRATIONS=true` by default) and exposes HTTP/WebSocket on `http://localhost:3000`.

- `cc_frontend` serves the SPA on `http://localhost:8080` and proxies API calls to the backend.

On first boot the seed script provisions:

| Variable         | Default             | Override                              |
| ---------------- | ------------------- | ------------------------------------- |
| `ADMIN_EMAIL`    | `admin@example.com` | set `ADMIN_EMAIL` in your env file    |
| `ADMIN_PASSWORD` | `admin`             | set `ADMIN_PASSWORD` in your env file |

Log in at `http://localhost:8080` with those credentials and change the password immediately.

> **Upgrades / existing databases:** When pulling a new release against an existing Postgres volume, apply migrations before restarting services:
>
> ```bash
> docker compose run --rm --no-deps backend \
>   pnpm --filter @command-center/backend exec prisma migrate deploy
> ```
>
> If you ever hit a stuck migration (e.g., Prisma `P3009/P3018`), see the [Troubleshooting](#troubleshooting) section for recovery steps.

> **Seeding inside Docker:** The production image omits dev dependencies. If you need to re-run the seed (e.g., to recreate the default admin), first install the backend dev deps inside a temporary container:
>
> ```bash
> docker compose run --rm --no-deps backend sh -lc "
>   pnpm install --filter @command-center/backend --prod=false --ignore-scripts &&
>   pnpm --filter @command-center/backend prisma:seed
> "
> ```

### 5. Monitor logs

```bash

docker compose logs -f backend

docker compose logs -f frontend

docker compose logs -f postgres

```

When the backend finishes migrations you should see `Starting backend...` followed by NestJS bootstrap output.

### 6. Stop and clean up

```bash

docker compose down

```

Add `--volumes` if you also want to delete the Postgres data volume.

### Customizing the deployment

- **Environment overrides:** edit the `environment` block in `docker-compose.yml`, supply an override file (e.g. `docker-compose.override.yml`), or use `--env-file` as noted above. Common overrides include `LOG_LEVEL`, `SERIAL_DEVICE`, `ALLOW_FOREVER`, and mail server settings.

- **Serial passthrough (Linux):** add the following to the `backend` service and ensure the container user can access the device:

  ```yaml
  devices:
    - '/dev/ttyUSB0:/dev/ttyUSB0'

  group_add:
    - dialout
  ```

  On macOS/Windows Docker Desktop, direct serial passthrough is not supported; run the backend natively or via WSL if hardware access is required.

- **Skipping migrations:** set `RUN_MIGRATIONS=false` if you manage schema deploys externally or if your database role cannot create shadow databases (then run `pnpm prisma:migrate` from a privileged environment).

- **Live reload:** the Docker workflow runs compiled artefacts. For day-to-day development, prefer the pnpm workflow described earlier (`pnpm dev` + hot reload).

## Building for Production

```bash

# Build backend bundle (dist/)

cd apps/backend

pnpm build



# Build frontend assets (dist/)

cd ../frontend

pnpm build

```

Serve `apps/frontend/dist` with your preferred static host (Nginx, S3, etc.) and run `node dist/main.js` for the backend (or deploy via PM2/systemd).

## Production Deployment

1. **Provision infrastructure**
   - PostgreSQL 15+ (managed or self-hosted). Create the `command_center` database and record the connection string.
   - Hosts or containers for the NestJS backend (Node.js 20+) and the React/Vite frontend (served as static files via Nginx/CDN/etc.).
   - Optional reverse proxy, TLS certificates, logging/monitoring stack.

2. **Configure environment**
   - Backend `.env` (or service variables) must define at least:
     ```bash
     NODE_ENV=production
     PORT=3000
     DATABASE_URL=postgresql://command_center:command_center@postgres:5432/command_center
     JWT_SECRET=change_me_to_a_random_value
     ALLOW_FOREVER=false
     ALLOW_ERASE_FORCE=false
     ```
   - Add mail, MQTT, TAK, and serial settings as needed. The sample `.env.example` documents every flag.
   - Frontend builds read `VITE_BACKEND_URL` (defaults to `/api`). Adjust if you host the API under a different base path.

3. **Apply database migrations**

   ```bash
   pnpm --filter @command-center/backend exec prisma migrate deploy
   ```

   (In Docker use `docker compose run --rm --no-deps backend ...`.)

4. **Seed defaults (optional)**
   Run this once per environment to create the initial admin and config rows:

   ```bash
   pnpm --filter @command-center/backend prisma:seed
   ```

   Inside Docker, install backend dev dependencies first (see the note under [Useful Scripts](#useful-scripts)).

5. **Build backend and frontend artifacts**

   ```bash
   pnpm --filter @command-center/backend build
   pnpm --filter @command-center/frontend build
   ```

6. **Deploy**
   - Serve `apps/frontend/dist` with your preferred static host or CDN.
   - Run `node dist/main.js` (or a Docker/Kubernetes equivalent) for the backend under a supervisor (systemd, PM2, etc.) and expose port 3000 or proxy it behind TLS.

   <details>
   <summary><strong>Nginx reverse proxy (HTTPS) quick reference</strong></summary>

   ```nginx
   server {
       listen 443 ssl http2;
       server_name ahcc.example.com;

       ssl_certificate     /etc/letsencrypt/live/ahcc.example.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/ahcc.example.com/privkey.pem;
       include             /etc/letsencrypt/options-ssl-nginx.conf;
       ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

       root  /var/www/ahcc-frontend;
       index index.html;

       location /api/ {
           proxy_pass http://127.0.0.1:3000/;
           proxy_http_version 1.1;
           proxy_set_header Host              $host;
           proxy_set_header X-Real-IP         $remote_addr;
           proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header Upgrade           $http_upgrade;
           proxy_set_header Connection        "upgrade";
       }

       location /socket.io/ {
           proxy_pass http://127.0.0.1:3000/socket.io/;
           proxy_http_version 1.1;
           proxy_set_header Upgrade           $http_upgrade;
           proxy_set_header Connection        "upgrade";
           proxy_set_header Host              $host;
           proxy_set_header X-Real-IP         $remote_addr;
           proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_read_timeout 60s;
           proxy_buffering off;
       }

       location / {
           try_files $uri /index.html;
       }
   }

   server {
       listen 80;
       server_name ahcc.example.com;
       return 301 https://$host$request_uri;
   }
   ```

   **Helpful commands**
   - Tail Nginx logs: `tail -f /var/log/nginx/error.log /var/log/nginx/access.log`
   - Test upstream: `curl -Ivk https://ahcc.example.com/api/healthz`
   - Reload config: `nginx -t && systemctl reload nginx`

   </details>

7. **Harden and monitor**
   - Enforce HTTPS, rate limiting, firewall rules, and logging/metrics.
   - Configure the in-app Firewall module (default policy, geo blocking, brute-force thresholds) and enable 2FA for privileged accounts.

8. **Upgrade cycle**
   - `git pull`, `pnpm install`, `prisma migrate deploy`, rebuild bundles, restart services.
   - See [Updating an Existing Deployment](#updating-an-existing-deployment) and [Troubleshooting](#troubleshooting) for migration recovery steps (P1000/P3009/P3018).

### Automated Deployment Script (Debian/Ubuntu)

For a guided production rollout on Debian/Ubuntu servers we ship `scripts/deploy-production.sh`. It is interactive and will:

1. Validate prerequisites (non-root sudo user, supported distro).
2. Install Node.js LTS, pnpm, PostgreSQL, nginx, certbot, fail2ban, and UFW.
3. Clone/update this repository under `/opt/ahcc`, install dependencies, run Prisma migrations/seeds, and build backend/frontend artifacts.
4. Generate a backend `.env` from your answers (DB password, JWT secret, SITE_ID, serial defaults, etc.) and configure systemd + nginx (self-signed or LetsEncrypt TLS).
5. Optionally enable nightly backups and fail2ban rules.

> **Important:** Audit the script before running it. Run it as the dedicated service user (not root) with passwordless sudo:
>
> ```bash
> sudo adduser --system --group --home /opt/ahcc --shell /bin/bash ahcc
> sudo usermod -aG sudo,dialout ahcc
> sudo -iu ahcc
> chmod +x scripts/deploy-production.sh
> ./scripts/deploy-production.sh
> ```

The script prints a deployment summary (URLs, generated credentials). Store it securely and delete the file afterward.

## Serial Hardware & Meshtastic Sniffer

1. Connect the radio/mesh device via USB and note the port (`/dev/ttyUSB0`, `COM6`, etc.).

2. Update `SERIAL_DEVICE`/`SERIAL_BAUD` in the backend `.env`.

3. Start the backend; the serial worker auto-connects and begins ingest.

4. Use the built-in tool for raw capture:

```bash

pnpm tool:sniffer -- --port /dev/ttyUSB0 --baud 921600

# Additional flags: --output file.log --json --no-stdout --delimiter "\r\n"

```

The sniffer is a zero-dependency TypeScript script that mirrors frames to stdout and a log file for parser development.

## Useful Scripts

| Command                                                                | Description                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm AHCC`                                                            | Boots the backend + frontend dev servers in parallel (`pnpm -r --parallel dev`).                                                                        |
| `pnpm lint`                                                            | ESLint across backend + frontend                                                                                                                        |
| `pnpm format`                                                          | Prettier writes                                                                                                                                         |
| `pnpm --filter @command-center/backend prisma:studio`                  | Inspect DB via Prisma Studio                                                                                                                            |
| `pnpm --filter @command-center/backend prisma:seed`                    | Reseed config rows                                                                                                                                      |
| `pnpm seed`                                                            | Shortcut to seed default admin (requires pnpm on host)                                                                                                  |
| `pnpm update-db` (or `node scripts/db-update-helper.mjs`)              | Auto-detects DB state, baselines existing schemas, removes duplicate CREATE TABLE migrations, runs `prisma migrate deploy`, and surfaces drift guidance |
| `pnpm db:reset`                                                        | **WARNING: DELETES ALL DATA.** Nuclear option that drops database, recreates it from schema.prisma (bypasses migrations), and seeds. Use when migrations are broken beyond repair. |
| `pnpm --filter @command-center/frontend preview`                       | Preview SPA production build                                                                                                                            |
| `pnpm exec node scripts/drone-simulator.cjs --token "<JWT>" [options]` | Push simulated mesh lines (node bootstrap + drone telemetry) into `/api/serial/simulate` for end-to-end testing.                                        |

### Drone simulator usage

1. **Grab an ADMIN JWT** via `pnpm --filter @command-center/backend dev` – log in at `http://localhost:3000/api/auth/login` (or use the default seed credentials) and copy the `accessToken` from the response.
2. **Run the simulator** from the repo root:

   ```bash
   pnpm exec node scripts/drone-simulator.cjs \
     --token "$ADMIN_JWT" \
     --drone-id 1581F5FJD239C00DW22E \
     --mac 60:60:1F:30:2C:3D \
     --node AH99 \
     --node-lat 40.7138 \
     --node-lon -74.0050 \
     --iterations 60
   ```

   Defaults: 5 s message interval, 50-70 km/h approach speed, operator ~450 m from the node, drone spawning ~1.1 km out. Override geometry with `--start-distance`, `--operator-radius`, or provide comma-separated `--drone-ids/--macs` for quick swaps. Every run seeds node bootstrap lines, emits the drone/operator telemetry, and exercises the parser, FAA enrichment, alarms, and inventory ingestion without any hardware.

> **Docker note.** Production containers only install runtime dependencies, so the first time you seed from inside the backend container you must install the backend workspace dev deps and then run the seed:
>
> ```bash
> docker compose exec backend sh -lc "
>   cd /app &&
>   pnpm install --filter @command-center/backend --prod=false --ignore-scripts &&
>   pnpm --filter @command-center/backend prisma:seed
> "
> ```
>
> Subsequent reseeds can use the shorter command:
>
> ```bash
> docker compose exec backend sh -lc "cd /app && pnpm --filter @command-center/backend prisma:seed"
> ```

## Operations & Maintenance

- **Clearing nodes:** The UI invokes `DELETE /nodes`, which now removes rows from `Node`, `NodePosition`, `NodeCoverageOverride`, and `TriangulationResult` tables in addition to clearing the in-memory cache. This prevents stale nodes from reappearing when new telemetry arrives.

- **Geofence focus:** Clicking **Focus** zooms/frames the polygon and highlights it for 10 seconds. No stale highlights remain thanks to background pruning.

- **Alarm profiles:** Uploading a new tone immediately swaps the preview audio; re-running the preview reflects custom volume settings.

- **Configuration cards:** Each card has expanded width (min 360px) so action buttons remain inside the panel even in dark mode.

- **TAK bridge:** The Config -> TAK Bridge card surfaces enablement, per-stream toggles (nodes, targets, command ack/results, alert severities), credentials, and the **Restart Bridge** action. Watch backend logs for lines prefixed with `TAK_BRIDGE` to confirm successful subscriptions or authentication failures.
  | **Prisma P1000 (invalid DB credentials)** | The backend cannot authenticate to Postgres. Verify `DATABASE_URL` matches the actual user/password. With the default compose file use `postgresql://command_center:command_center@postgres:5432/command_center`. Restart the backend after correcting the credentials.|

## Troubleshooting

| Symptom                                             | Suggested Fix                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend shows a blank page or 404 after deploy** | Ensure the SPA is served from the `/` root and that your reverse proxy rewrites unknown routes to `index.html`. In Docker, the bundled Nginx config already handles this.                                                                                                                                                                      |
| **Cannot log in with default credentials**          | Confirm the seed ran: the backend container logs should show "Running database migrations...". If you customized `ADMIN_EMAIL`/`ADMIN_PASSWORD`, restart the backend with the new values or rerun `prisma:seed`.                                                                                                                               |
| **Backend returns `ECONNREFUSED` for Postgres**     | Check `docker compose logs postgres`; the DB must be healthy before the backend starts. If running locally, verify `DATABASE_URL` matches your Postgres host/port and that migrations were applied.                                                                                                                                            |
| **Serial device not detected**                      | On Windows note the `COM` port. On Linux grant access (`sudo usermod -aG dialout $USER` then re-login). Update Config -> Serial or `.env` `SERIAL_DEVICE` with the correct path and restart the backend.                                                                                                                                       |
| **No alerts despite telemetry**                     | Confirm devices flashed with the companion firmware send events, sockets are connected (check `/healthz`), and that the terminal/alert filters are not hiding the severity you expect.                                                                                                                                                         |
| **Custom alarm audio silent or too loud**           | After uploading a WAV file, adjust per-level volume sliders and click "Test". If volume does not change, refresh the page to reload cached audio. Supported format: 16-bit PCM WAV.                                                                                                                                                            |
| **Docker push fails due to upstream changes**       | Run `git pull --rebase origin main`, resolve conflicts, then `git push`. This keeps your fork in sync before you build and publish images.                                                                                                                                                                                                     |
| **Client notification: _Invalid Serial config?_**   | Meshtastic emits this when "Override console serial port" is enabled while running an interactive profile. Disable the override in firmware or switch the node to an output-only profile (NMEA/CalTopo) before reconnecting.                                                                                                                   |
| **MQTT connect timeout**                            | Ensure the backend is running (check `/healthz`) and that you are using a reachable endpoint. Some brokers require WebSockets (`ws://...`) instead of raw TCP (`mqtt://...`). Leave username/password blank for anonymous brokers and enable site replication before expecting events.                                                         |
| **HTTPS reverse proxy (502 / TLS errors)**          | Verify Nginx proxies `/api` and `/socket.io` to the backend on the correct host/port. Include websocket headers (`Upgrade`/`Connection`), tail `/var/log/nginx/error.log`, and test with `curl -Ivk https://your-domain/api/healthz`. See the [Nginx quick reference](#production-deployment) for a working example.                           |
| **Prisma P1000 (invalid DB credentials)**           | The backend cannot authenticate to Postgres. Verify `DATABASE_URL` matches the real database user/password. With the default compose file use `postgresql://command_center:command_center@postgres:5432/command_center`. After fixing it, restart the backend.                                                                                 |
| **Prisma P3009/P3018 (failed migration loop)**      | Inspect `_prisma_migrations` for rows with `finished_at` NULL. Mark them rolled back (`prisma migrate resolve --rolled-back <migration_name>`), recreate any missing objects (e.g., enums or tables), run `docker compose run --rm --no-deps backend pnpm --filter @command-center/backend exec prisma migrate deploy`, then restart services. |

---

## Legal Disclaimer

AntiHunter Command & Control PRO ("Software") is distributed for **lawful, authorized defensive use only**. You may operate this project solely on infrastructure, networks, devices, radio spectrum, and datasets that you own or for which you hold explicit, written permission to assess. By downloading, compiling, or executing the Software you agree to the following conditions:

- **Authorization & intent.** Use is limited to security research, blue-team training, regulatory-compliant monitoring, or other defensive activities. Offensive operations, targeted surveillance, harassment, or tracking of individuals without their informed consent are strictly prohibited.
- **Telecommunications compliance.** You are responsible for abiding by every jurisdictional regulation governing radio frequency use (e.g., FCC/CE/Ofcom rules, LoRa/ISM duty-cycle limits, licensing conditions) and any import/export controls that apply to cryptography, telemetry, or spectrum-monitoring tools.
- **Privacy & data protection.** Collect telemetry only with a lawful basis (GDPR, CCPA, ePrivacy, etc.). Obtain consent where required, minimize personal data, and apply retention/destruction schedules that match the applicable law. The maintainers do not process or host your data.
- **Computer misuse laws.** Scanning or accessing third-party networks without permission may violate the Computer Fraud and Abuse Act, UK Computer Misuse Act, or similar laws. Always obtain written authorization before interfacing with systems you do not control.
- **Export & sanctions.** You must ensure distribution and use complies with the U.S. EAR, EU dual-use regulations, local sanctions regimes, and any contractual restrictions. The maintainers do not grant export approvals.
- **Operational safeguards.** Run the Software on hardened, access-controlled infrastructure. You are responsible for segregation of duties, credential management, and preventing unauthorized access to intercepted telemetry or command functions.
- **Forks and modifications.** If you fork, redistribute, or modify the Software, you are solely responsible for supporting your derivative work. The original authors and contributors are not liable for defects or legal issues introduced by third-party changes, packaging, or integrations.

### No Warranty / Limitation of Liability

THE SOFTWARE IS PROVIDED AS IS AND AS AVAILABLE, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, OR ACCURACY. TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE AUTHORS, DEVELOPERS, MAINTAINERS, AND CONTRIBUTORS SHALL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL DAMAGES (INCLUDING, WITHOUT LIMITATION, LOSS OF DATA, PROFITS, GOODWILL, OR BUSINESS INTERRUPTION) ARISING FROM OR RELATED TO YOUR USE OF THE SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. WHERE LIABILITY CANNOT BE FULLY DISCLAIMED, THE TOTAL AGGREGATE LIABILITY SHALL NOT EXCEED THE GREATER OF (A) THE AMOUNT PAID, IF ANY, FOR THE COPY OF THE SOFTWARE THAT GAVE RISE TO THE CLAIM OR (B) USD $0.

### Responsibility for Compliance

You alone are responsible for ensuring your deployment complies with all applicable laws, regulations, licenses, permits, organizational policies, and third-party rights. No advice or information, whether oral or written, obtained from the project or through the Software, creates any warranty or obligation not expressly stated in this disclaimer. Continued use signifies your agreement to indemnify and hold harmless the authors, developers, maintainers, and contributors from claims arising out of or related to your activities with the Software.

If you do not agree to these terms, **do not build, deploy, or run** AntiHunter Command & Control PRO.
