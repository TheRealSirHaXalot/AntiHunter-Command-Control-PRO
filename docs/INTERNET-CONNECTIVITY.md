# AHCC Remote Connections

Reach AHCC from a phone or another site without opening a port on your router. Every step below ends with a **Check**. If the check fails, stop and fix that step before moving on.

## Contents

0. [First: passwords and 2FA](#prep)
1. [Tailscale: open AHCC from your phone (recommended)](#tailscale)
2. [Cloudflare Tunnel: open AHCC with an email login](#cloudflare)
3. [Alerts to your phone: push, Signal, ntfy, Matrix, Discord, IFTTT, Home Assistant](#alerts)
3a. [Apple Home and Google Home (Matter)](#matter)
4. [TAK bridge](#tak)
5. [MQTTS broker and site federation](#mqtts)
6. [Email alerts](#email)
7. [Webhooks (reference)](#webhooks)
8. [Meshtastic + TAK](#meshtastic)
9. [RBAC (accounts and roles)](#rbac)
10. [Bonus: Canarytokens tripwires](#canary)
11. [Quick reference](#quickref)

| I want to...                                      | Do this                          |
| ------------------------------------------------- | -------------------------------- |
| Use the full AHCC map and console from my phone   | [Tailscale](#tailscale)          |
| Let people in without installing an app           | [Cloudflare Tunnel](#cloudflare) |
| Get a message when something is detected          | [Alerts](#alerts)                |
| See alerts as sensors in Apple Home / Google Home | [Matter](#matter)                |
| See nodes and targets in iTAK/ATAK/WinTAK         | [TAK bridge](#tak)               |
| Feed raw JSON to scripts or Node-RED              | [MQTTS broker](#mqtts)           |
| Link two AHCC sites                               | [MQTTS federation](#mqtts)       |

Never forward ports 3000, 5173, 8080 or 5432 on your router, and never run `tailscale funnel` or a Cloudflare quick tunnel (`trycloudflare.com`). All of these put the AHCC login page on the public internet.

--------------------------------------------------------------------------------
<a id="prep"></a>
0. First: passwords and 2FA
--------------------------------------------------------------------------------

Your first admin password was printed once at install by the setup script. For Docker, read it with `docker compose exec backend cat apps/backend/.secrets/initial-admin-password`.

Only the web UI needs a VPN. Use WireGuard or Netbird. Don't open ports 3000 or 5173 to the internet. The backend listens on all interfaces on port 3000, so block it with the host firewall.

1. Sign in, open **Account** in the sidebar → **User Management** → **Manage** on your admin row → type a long password you will remember in **Set New Password** → **Save Changes**.
2. Open **Account** → **Security** → **Enable Two-Factor**. Scan the QR code with Google Authenticator, 1Password, Authy or any TOTP app, then enter the 6-digit code and click **Confirm Setup**. Save the recovery codes.

   ![Two-factor panel](images/remote/account-2fa.png)

3. Give every person their own account: **Account** → **User Management** → **Create User**. Pick the lowest **Role** that works (VIEWER only looks, OPERATOR runs commands). See [RBAC](#rbac).

   ![Create user](images/remote/users-create.png)

**Check:** sign out, sign back in. You are asked for a 6-digit code.

4. Turn on the firewall: **Config** → **Firewall**.

   | Setting | Set to |
   | ------- | ------ |
   | Status | Enabled |
   | Default policy | Allow (the IP allow list does the restricting; Deny with an empty list locks everyone out) |
   | Geo policy | Allow list |
   | Allowed countries | your country code, e.g. `US` (local and tailnet addresses have no country and pass) |
   | Blocked countries | empty |
   | IP allow list | `127.0.0.1` and `::1`, then every IP you see for your own sign-ins (below) |
   | IP block list | empty; add attackers from the log |
   | Failed attempts (count) | `5` |
   | Failure window (seconds) | `900` |
   | Ban duration (seconds) | `900` |

   Sign in from each device you use (the AHCC computer, the phone over Tailscale, a Cloudflare login). Open **Recent firewall activity** at the bottom of the card, find each `AUTH SUCCESS` entry, and add its IP to **IP allow list**. Docker and proxied logins can show a proxy address (a Docker bridge like `172.17.0.1`, or your reverse proxy) instead of your device, because AHCC trusts a forwarded client IP only from a loopback proxy by default. Either add the address the log shows, or set `TRUST_PROXY` (to the number of proxy hops, or the proxy's address/CIDR) so the log records the real client IP. Save, then sign in again from each device.

**Check:** every device still reaches the login page. A browser on an address not in the list gets `Access denied by firewall (allow list)`.

--------------------------------------------------------------------------------
<a id="tailscale"></a>
1. Tailscale: open AHCC from your phone (recommended)
--------------------------------------------------------------------------------

Tailscale is a private network between your own devices. Only devices signed in to your Tailscale account can open AHCC. AHCC gets an HTTPS address like `https://ahcc-box.tail1234.ts.net` with a valid certificate. The free Personal plan covers 6 users.

### Docker: built-in Tailscale container

Docker installs can skip steps 2-5 below: `docker-compose.yml` has a `tailscale` service under the `remote` profile. It runs Tailscale in its own container, serves AHCC over HTTPS on your tailnet, and never turns on Funnel. Requests go through a separate nginx entrance that checks each person's Tailscale login against an allowlist before AHCC's own login. The entrance listens on port 8081 at 127.0.0.1 inside the frontend container. The Tailscale container shares that container's network, so nothing else can reach the entrance.

1. Do step 1 and step 3 below (account, MagicDNS + HTTPS Certificates), and paste the access-control policy from step 8 so `tag:ahcc` exists.
2. In the Tailscale admin console: **Settings** → **Keys** → **Generate auth key**. Tick **Tags** and pick `tag:ahcc`. Leave **Reusable** off. Copy the key.
3. In `.env` next to `docker-compose.yml`:

       TS_AUTHKEY=tskey-auth-...
       TS_HOSTNAME=ahcc

4. `docker compose --profile remote up -d`. Once the machine shows up in the Tailscale admin console, delete the `TS_AUTHKEY` line from `.env`. The container keeps its login in the `tailscale-state` volume.
5. In AHCC: **Config** → **Remote Access** → **Remote access (Tailscale)**. Tick **Enable remote access**, enter the Tailscale login (email) of each person allowed in under **Allowed Tailscale logins**, one per line, and click **Save**. An empty list lets nobody in.

**Check:** on the phone with Tailscale on and Wi-Fi off, `https://ahcc.<your-tailnet>.ts.net` shows the AHCC login page. Remove your login from the list and reload: you get **403 Forbidden**.

Tagged devices (servers you tagged in Tailscale) carry no user login, so the entrance refuses them. Phones and laptops signed in as a person work.

**Step 1. Make an account.** Go to https://tailscale.com and sign in with Google, Microsoft, GitHub or Apple. Use the same login on every device below.

**Step 2. Install Tailscale on the AHCC computer.**

- Linux: `curl -fsSL https://tailscale.com/install.sh | sh` then `sudo tailscale up`, and open the link it prints to sign in.
- macOS / Windows: install the app from https://tailscale.com/download and sign in. On the macOS App Store version the command is `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (use it wherever this guide says `tailscale`).

**Check:** `tailscale status` lists this computer, and `tailscale version` shows 1.104.2 or newer. Leave Tailscale SSH off on this computer: `tailscale set --ssh=false`.

**Step 3. Turn on HTTPS certificates.** Open https://console.tailscale.com/admin/dns. Turn on **MagicDNS**, then turn on **HTTPS Certificates** on the same page.

**Step 4. Publish AHCC on your tailnet.** On the AHCC computer, run the line that matches how you installed AHCC (add `sudo` on Linux):

| Installed with            | Command                                   |
| ------------------------- | ----------------------------------------- |
| Docker (`docker compose`) | `tailscale serve --bg localhost:8080`     |
| `pnpm dev` / setup script | `tailscale serve --bg localhost:5173`     |

Then run `tailscale serve status`. It shows your address, e.g. `https://ahcc-box.tail1234.ts.net`. `--bg` keeps it running after reboots.

**Step 5 (pnpm installs only). Allow that address.** The pnpm web server rejects addresses it does not know. Create `apps/frontend/.env` with your address, no `https://`, no trailing slash:

    AHCC_ALLOWED_HOSTS=ahcc-box.tail1234.ts.net

Restart AHCC (`Ctrl+C`, then `pnpm dev`). Docker installs skip this step.

**Check:** on the AHCC computer, open the `https://...ts.net` address. You see the AHCC login page with a padlock. If you see `Blocked request. This host (...) is not allowed`, step 5 is missing or has a typo.

**Step 6. Set the app URL.** **Config** → **Security Defaults** → **Application URL**: set it to your `https://...ts.net` address so links in emails point to it.

![Security defaults](images/remote/security-defaults.png)

**Step 7. Phone.** Install Tailscale from the App Store / Play Store, sign in with the same account, turn it on, and open the `https://...ts.net` address in the browser. Add it to your home screen.

**Check:** the AHCC login page loads on the phone over mobile data (Wi-Fi off).

**Step 8. Lock the tailnet to AHCC's HTTPS port.** AHCC's own ports (3000 and 5173, plus 8080 and 5432 on Docker) only listen on the computer itself. Tailscale still lets every device on your tailnet reach every other port on the AHCC computer (SSH, file sharing). Restrict them to 443:

1. Open the **Access controls** tab in the Tailscale admin console. Replace the policy with the block below and save. If you use this tailnet for other things, keep your other rules and delete only the allow-all rule (`"src": ["*"], "dst": ["*"], "ip": ["*"]`).

       {
         "tagOwners": {
           "tag:ahcc": ["autogroup:admin"]
         },
         "grants": [
           {
             "src": ["autogroup:member"],
             "dst": ["tag:ahcc"],
             "ip": ["tcp:443"]
           }
         ]
       }

2. Open https://console.tailscale.com/admin/machines, click **...** on the AHCC computer's row → **Edit tags** → add `tag:ahcc`. Tagging makes the machine belong to the tailnet instead of your user and turns off key expiry.

**Check:** on the phone, `https://...ts.net` still loads. The AHCC computer's row on the Machines page shows `tag:ahcc`.

**Firewall:** add `100.64.0.0/10` and `fd7a:115c:a1e0::/48` (Tailscale's address ranges) to **IP allow list** — this covers every device on your tailnet. To allow one device instead of the whole range, find its `100.x` address in the Tailscale admin console (**Machines**) or in **Recent firewall activity**. Keep the rest as in [step 0](#prep).

**Turn it off:** `tailscale serve reset`.

Security: no port is open to the internet. Tailscale encrypts traffic between your devices, and only devices signed in to your tailnet can connect. AHCC's login and 2FA still apply.

If the AHCC computer is lost or compromised, delete it on the **Machines** page of the Tailscale admin console. Reinstalling it does not revoke its key.

--------------------------------------------------------------------------------
<a id="cloudflare"></a>
2. Cloudflare Tunnel: open AHCC with an email login
--------------------------------------------------------------------------------

Use this when viewers cannot install Tailscale. Cloudflare puts a login page (a one-time code sent to an approved email) in front of AHCC. You need a free Cloudflare account and a domain whose DNS is on Cloudflare.

Do the steps in this order. If you add the tunnel route before the Access app, AHCC is public until the Access app exists.

**Step 1. Create the Access app.** In the Cloudflare dashboard: **Zero Trust** → **Access controls** → **Applications** → **Create new application** → **Self-hosted and private** → **Add public hostname**. Enter `ahcc` and pick your domain. Under **Access policies**, create a policy that allows only the email addresses of the people who need AHCC, and use One-time PIN as the login method. Click **Create**.

**Step 2. Create the tunnel.** **Networking** → **Tunnels** → **Create a tunnel** → name it `ahcc` → **Create Tunnel**. Pick the AHCC computer's operating system and run the install command it shows on that computer. Click **Continue** once it shows connected.

**Step 3. Route the hostname to AHCC.** Open the tunnel → **Routes** tab → **Add route** → **Published application**. Subdomain `ahcc`, your **Domain**, **Service URL**:

- Docker: `http://localhost:8080`
- pnpm: `http://localhost:5173`, and add `AHCC_ALLOWED_HOSTS=ahcc.yourdomain.com` to `apps/frontend/.env`, then restart AHCC (see [Tailscale step 5](#tailscale)).

Click **Add route**.

**Check:** open `https://ahcc.yourdomain.com` in a private browser window. You see Cloudflare's email-code page first, not AHCC. An email that is not on the list never gets a code.

**Firewall:** Cloudflare users' home and mobile IPs change, so an IP allow list will lock them out. Either add each user's IP from **Recent firewall activity** after they sign in, or empty **IP allow list** and rely on **Geo policy** (your country) plus the lockout values from [step 0](#prep).

Security: the tunnel dials out from the AHCC computer, so no port opens on your router. Cloudflare checks the email code before any traffic reaches AHCC. Cloudflare decrypts the traffic at its edge; use Tailscale if you do not want a third party to see it.

--------------------------------------------------------------------------------
<a id="alerts"></a>
3. Alerts to your phone: push, Signal, ntfy, Matrix, Discord, IFTTT, Home Assistant
--------------------------------------------------------------------------------

No remote access needed. AHCC dials out to the service when an alert rule fires, when an alert arrives over MQTT, and when a node reports an ALERT-level event (attack, tamper, erase, ALERT-level vibration). Node heartbeats and other INFO/NOTICE messages are not sent. Each message carries the rule and severity, the alert text, and the device MAC, SSID, RSSI, channel, node, location and time when the alert has them.

Everything in this section is on **Alerts** → **Remote alerts**: phone push, Signal, ntfy, Matrix, webhooks, Matter and **Alert sources**. Only admins see the settings cards, and only admins with two-factor authentication turned on can change them or send tests ([step 0](#prep)).

**Alert sources** decides what is sent. Each row (an alert rule, a node event type, linked MQTT sites, data streams) has a **Notify** and a **Critical** tick; untick both to send nothing for that source. Click **Save levels**. The same choice applies to every channel, webhooks included. Data streams (inventory, telemetry, command results, raw serial lines) start unticked.

GPS coordinates go only to end-to-end encrypted channels (phone push, Signal). ntfy, Matrix and webhooks get the alert without coordinates unless **Include GPS coordinates in ntfy, Matrix and webhooks (not encrypted)** is ticked under **Alert sources** and saved with **Save levels**.

Tokens and the push signing key are encrypted in the database (AES-256-GCM). The key is `REMOTE_ALERTS_SECRET_KEY` when set; otherwise a random key stored at rest per OS: the macOS Keychain, Windows DPAPI (bound to the account AHCC runs as), or, for the `deploy-production.sh` service on Linux, a `systemd-creds` credential (sealed to the TPM when present). Without those it falls back to `apps/backend/.secrets/remote-alerts.key` (Docker: the `remote-secrets` volume). A database dump alone does not reveal the tokens. Back up the key with the database; without it, re-enter the tokens and press **Reset keys** on the **Phone push** card. Discord, Slack, IFTTT and Home Assistant are webhooks, in the **Webhooks** card on the same page.

| Channel | Who can read the alert text | Setup |
| ------- | --------------------------- | ----- |
| Phone push | only your phone (end-to-end encrypted) | one tap per phone |
| Signal | only the recipients (end-to-end encrypted) | link a device once |
| Matter (Apple/Google Home) | no text is sent, only sensor on/off | scan a code, needs a home hub |
| Matrix | your homeserver | bot account |
| ntfy | the ntfy server | topic URL + token |
| Discord, Slack, IFTTT | the provider | paste a URL |

### Phone push (end-to-end encrypted)

The alert is encrypted on the AHCC computer for your phone's key; Apple, Google or Mozilla relay it but cannot read it.

AHCC creates the push keys the first time they are needed.

1. Open AHCC over HTTPS on the phone (the Tailscale address). On iPhone/iPad (iOS 16.4 or newer): **Share** → **Add to Home Screen**, then open AHCC from the Home Screen icon. Android: Chrome works directly.
2. **Alerts** → **Remote alerts** → **Alerts on this device** → **Enable on this device** → allow notifications.
3. **Send test**.

**Check:** a notification arrives; tapping it opens **Alerts** → **Event log**. The device appears in the table on the admin **Phone push** card, where **Remove** deletes it. **Send test to all devices** tests every phone.

**Reset keys** signs out every subscribed device; each one presses **Enable on this device** again.

### Signal (end-to-end encrypted)

AHCC links a Signal device (like Signal Desktop) and posts to a private **AntiHunter Alerts** group it creates. A linked device can otherwise act as the whole account, so AHCC boxes it in — how depends on where the connector runs:

- **Docker, macOS, Windows:** the connector (`signal-api`) sits on an internal-only network with no published port. The backend reaches it only through `signal-proxy`, which allows nothing but reading the account, linking, creating the group, and sending to that group — it cannot send to a phone number, read messages, or list your contacts.
- **Linux isolated host mode:** signal-cli runs as a separate `ahcc-signal` user with its account data in an encrypted (gocryptfs) store. The backend never touches those files or the daemon; it reaches them only through a local gate socket that exposes the same four actions.
- Either way, AHCC's own code only ever sends to its own group, and the config API refuses to change the number, connector URL, or recipients.

**The installers and the in-app Signal card do most of this for you.** Your steps:

1. **Use a dedicated Signal number**, not your personal one. A linked device is account-wide; keep it on a number that does nothing else.
2. Set up the connector for your system — find yours:

   | System | What to do | What the app does |
   |---|---|---|
   | **Linux (recommended)** | Answer **yes** to "Install Signal alerts" in `setup-local.sh` / `deploy-production.sh`. | Installs signal-cli as the locked-down `ahcc-signal` service with encrypted state and a gate socket; sets `AHCC_SIGNAL_GATE`. Nothing to start. |
   | **Linux (didn't run the installer, x86_64)** | Nothing. | The first time you link, AHCC downloads signal-cli (pinned checksum), stores it at `AHCC_SIGNAL_HOME` (default `<backend cwd>/.signal-cli`, files `0700`), and runs it itself. |
   | **Docker** | `docker compose --profile signal up -d` | Runs the connector and proxy, neither published. |
   | **macOS / arm Linux** | Open **Alerts → Remote alerts → Signal**, click **Copy start** and run the copied command on the AHCC computer. | The card detects Docker/Colima, lists setup steps with a Docker install link, and has **Copy start** / **Copy stop** / **Copy restart** buttons (connector on loopback `127.0.0.1:8079`). AHCC then finds the connector automatically. |
   | **Windows** | Install Docker Desktop (`winget install -e --id Docker.DockerDesktop` — the card links it) and turn on virtualization (WSL2 or Hyper-V), then run the card's command. | Same Docker connector on `127.0.0.1:8079`. **A Windows VM on an Apple Silicon Mac can't run Docker** (no nested virtualization) — run the connector on a physical PC or another host and set `SIGNAL_API_URL` to it over a trusted link. |

3. **Alerts → Remote alerts → Signal** → tick **Send alerts to Signal** → **Save** → **Link Signal**. On the phone: Signal → **Settings** → **Linked devices** → **+** → scan the QR. Then **Send test**.
4. Add other people by opening the **AntiHunter Alerts** group in Signal and inviting them. The group is created admin-only (no member can add others, post, or share an invite link), so alerts stay one-way.

**Check:** the **AntiHunter Alerts** group gets `AntiHunter test`.

The **remote-alerts key** that encrypts your tokens is sealed to the machine, not left in a file: macOS Keychain, Windows DPAPI, or a `systemd-creds` credential for the Linux service (TPM-sealed when present). **Check for updates** on the Signal card compares the installed signal-cli against the latest release.

For the full hardening, what was tested, and the residual attacks to weigh against your threat appetite, see [Signal & remote-alerts security](SIGNAL-SECURITY.md).

### ntfy

The ntfy server can read every alert. Run your own ntfy server, require login, and give AHCC an access token with write access to one topic.

**Alerts** → **Remote alerts** → **ntfy**: tick **Send alerts to ntfy**, **Topic URL** (`https://ntfy.example.com/ahcc-alerts`), **Access token (optional)** (`tk_...`), **Save**, **Send test**. Critical alerts use priority 5.

### Matrix

Messages are not end-to-end encrypted; the homeserver can read them. Use your own homeserver, a bot account, and a private room. **Alerts** → **Remote alerts** → **Matrix**: tick **Send alerts to Matrix**, **Homeserver URL**, **Room ID** (`!abc:example.com`), **Bot access token**, **Save**, **Send test**.

URLs for ntfy, Signal and Matrix must be `https://`, or `http://` to `localhost` or `signal-api`, with no username or password in the URL. Tokens are never shown again after saving; leave the field blank to keep the saved one, or click **Remove token**.

Treat every webhook URL below as a password: anyone who has it can post to your channel. Don't paste it in chats or screenshots.

Alert text from nodes can contain names chosen by whoever owns the detected device (Wi-Fi SSIDs, BLE names). AHCC escapes it for Discord and Slack and turns off Discord mentions, so a device named `@everyone [click](https://...)` shows as plain text.

### Discord

1. In Discord: hover the channel → gear (**Edit Channel**) → **Integrations** → **Webhooks** → **New Webhook** → **Copy Webhook URL**.
2. In AHCC: **Alerts** → **Remote alerts** → **Webhooks** → **Create webhook**. **Name** `Discord alerts`, paste the URL into **Destination URL**, leave **Enabled** and **Verify server certificates** ticked, click **Create**.

   ![Discord webhook](images/remote/webhook-discord.png)

3. In **Registered webhooks**, click **Test** on the new row, then **Edit** to see **Recent deliveries**.

   ![Registered webhooks](images/remote/webhook-list.png)

   **Check:** the Discord channel shows `[INFO] Test payload from Command Center ...` and Recent deliveries says **Success**.

Every enabled webhook receives every source ticked in **Alert sources** (top of this section). There is no per-webhook event list.

### IFTTT (SMS, phone notification, smart lights)

1. At https://ifttt.com create an applet. **If This** → **Webhooks** → **Receive a web request with a JSON payload** → event name `ahcc_alert`. **Then That**: any action (notification, SMS, lights). Use the `{{JsonPayload}}` ingredient for the text.
2. Get your key: https://ifttt.com/maker_webhooks → **Documentation**.
3. In AHCC, create a webhook with **Destination URL** `https://maker.ifttt.com/trigger/ahcc_alert/json/with/key/<your key>`. Click **Test**.

**Check:** the IFTTT action fires.

### Home Assistant

1. In Home Assistant: **Settings** → **Automations** → **Create automation** → trigger **Webhook**. Copy the webhook ID. Keep **Only accessible from the local network** on if AHCC is on the same network.
2. In AHCC, create a webhook with **Preset** `Home Assistant / Apple Home`, **Destination URL** `https://<home-assistant-host>/api/webhook/<webhook_id>`. **Test**.
3. In the automation, use `{{ trigger.json.summary }}` for the text, `{{ trigger.json.rule.severity }}` for the level and `{{ trigger.json.data.mac }}` for the device.

**Check:** the automation's trace shows the test run.

--------------------------------------------------------------------------------
<a id="matter"></a>
3a. Apple Home and Google Home (Matter)
--------------------------------------------------------------------------------

AHCC can run a Matter device that Apple Home and Google Home add like any smart-home sensor. It shows two occupancy sensors:

| Sensor | Turns on for |
| ------ | ------------ |
| **AntiHunter Alert** | every source set to Alert or Critical |
| **AntiHunter Critical** | only the sources you set to Critical |

Each turns on when an alert fires and turns off after 60 seconds. Home then sends its own notifications and can run automations (turn on lights, sound a HomePod). No alert text is sent, only on/off.

You pick the level per source in **Alerts** → **Remote alerts** → **Alert sources**: each alert rule by name, each node event type and linked MQTT sites. Tick **Notify** for the Alert sensor, **Critical** for both; untick both to send nothing. Click **Save levels**. Alert rules, Wi-Fi attacks, deauth/disassoc, tamper, vibration, erase, mesh guard and linked MQTT sites start at Notify; everything else starts unticked; nothing is Critical until you choose it. The same levels apply to phone push, Signal, ntfy, Matrix and webhooks: Critical messages start with `CRITICAL:` and use ntfy priority 5. Email is unchanged.

Node heartbeats, GPS fixes, startup, baseline and new-device notices (INFO and NOTICE) never reach these channels; they stay in the AHCC console. To alert on a specific device, create an alert rule for it and set its level here.

Needs a home hub: HomePod, HomePod mini, Apple TV or iPad for Apple Home; a Nest speaker/display, Google TV Streamer or Nest Wifi Pro for Google Home. The phone and the AHCC computer must be on the same network while pairing.

**macOS: build the signed app first.** The Matter device accepts connections from your hub, so macOS's firewall must let it in. Allow only a dedicated, signed program, never `node`:

    cd apps/backend
    CODESIGN_IDENTITY="Developer ID Application: <you> (<TEAMID>)" NOTARY_PROFILE=<notarytool profile> tools/matter/build.sh

This builds `apps/backend/bin/matter/ahcc-matter` with Bun, signs it with your Developer ID and hardened runtime, and notarizes it. Set `AHCC_MATTER_BIN` to that path in `apps/backend/.env` and restart AHCC. When macOS asks whether **ahcc-matter** may accept incoming connections, click **Allow**. The backend talks to it over a pipe, and it only gets its own settings, not the database password or API keys. Linux and Docker skip this step.

**Google Home only: register the device once.** AHCC uses Matter's test vendor ID, and Google Home only pairs test devices listed in a Google Home Developer Console project that your Google account belongs to. The project is free.

1. Open https://console.home.google.com, create a project, and add a **Matter** integration.
2. Enter Vendor ID `0xFFF1` and Product ID `0x8000`.
3. Pair with the same Google account that owns the project (or add other people as project members).

**Pair it.**

1. **Alerts** → **Remote alerts** → **Apple Home / Google Home** → tick **On**, leave **Network** at **Automatic** (or pick your home network interface), **Save**. State changes to `waiting to pair`. Click **Show pairing code** for the QR code, **Setup code** and **Passcode**.
2. Apple Home: **+** → **Add Accessory** → point the camera at the QR code on screen. Accept the uncertified-accessory warning. Google Home: **Devices** → **Add** → **Matter-enabled device** → scan the QR code. If the camera won't read it, choose **More options** and type the setup code.
3. **Test**. It sends a Critical alert, which turns on both sensors.

**Check:** both sensors show occupancy detected in Home, and the card shows `paired`.

**Reset pairing** asks to confirm, removes AntiHunter from every home it was added to, and shows a new code. **Restart** restarts the Matter device without unpairing.

The device is a bridge with the two named sensors. `AHCC_MATTER_LAYOUT=flat` in `apps/backend/.env` instead exposes two unnamed sensors; after changing it, remove AntiHunter from Home and pair again. To tell flat sensors apart, fire a Notify-level alert (only **AntiHunter Alert** turns on) and rename them in Home.

Docker: Matter pairing uses local-network discovery (mDNS), which Docker's default network does not pass. Run the backend outside Docker, or with host networking, to pair.

Lock it down

- Set `AHCC_MATTER_INTERFACE` (e.g. `en0`, `eth0`) to listen and announce only on your home network interface, not on VPN or Docker interfaces.
- Pairing state, including the device's private keys, is stored in `AHCC_MATTER_STORAGE` (default `apps/backend/.matter`) with permissions `0700`/`0600`. Keep it out of backups you share.
- The setup code is printed in the backend log until the device is paired. Pair it right away.
- Google Home may show one bridged sensor as "Matter device" instead of its name (open Matter SDK bug, no fix yet). Rename it in Google Home.

--------------------------------------------------------------------------------
<a id="tak"></a>
4. TAK bridge -> TAK server -> iTAK/ATAK/WinTAK
--------------------------------------------------------------------------------

AHCC turns its events into CoT and sends them to a single TAK server. It can send over UDP, plain TCP, or TLS. Plain TCP and UDP are unencrypted, so keep those on localhost or Tailscale. Turn on TLS (set TAK_TLS=true and the cert fields) and AHCC verifies the server's certificate, so that hop is safe to cross the internet.

iTAK can't connect to AHCC directly, so the TAK server sits in the middle. AHCC feeds it locally, and iTAK connects to the server over TLS. That server-to-iTAK hop is the encrypted one that crosses the internet.

Free servers: OpenTAKServer (easiest), FreeTAKServer, TAK Server. The plaintext CoT port is around 8087 or 8088. The TLS streaming port is 8089. Check your server's docs.

1. Install OpenTAKServer on the AHCC host, or on a VPN-only machine.
2. Migrate if you haven't: `pnpm --filter @command-center/backend prisma:migrate`
3. Set the bridge in apps/backend/.env:

       TAK_ENABLED=true
       TAK_PROTOCOL=TCP
       TAK_HOST=127.0.0.1
       TAK_PORT=8088
       TAK_TLS=false   # set true for TLS; add cafile/certfile/keyfile (PEM text or file path)

   Or use Config -> TAK Bridge in the UI. The UI wins after you save. Restart the bridge.
4. Turn on the streams you want (Config -> TAK Bridge -> Streams).
5. Make an enrol QR or data package on the server for the phone.
6. Add the server in iTAK over the VPN. Use the TLS streaming port.
7. Promote a detection in AHCC. Check that an AHCC-TARGET-* marker shows up.

By default AHCC streams node telemetry, target detections, and the Notice, Alert, and Critical alert levels; Info alerts and command results stay off. It also reads CoT coming back and saves those positions as nodes, but it never accepts commands, so you can't control your nodes from iTAK.

Lock it down

- Only the TLS port (8089) faces the internet. Block the plaintext CoT port.
- Require client certs on the server. Revoke lost devices. Use TLS 1.2 or newer and your own certificate, not the installer's sample.
- With TLS on, AHCC verifies the server's certificate. `cafile` pins a private CA; `certfile` and `keyfile` add a client cert for mutual TLS. `TAK_TLS_INSECURE=true` turns the check off; don't use it.
- Only connect AHCC to a TAK server you control. It trusts positions it receives.

--------------------------------------------------------------------------------
<a id="mqtts"></a>
5. MQTTS broker and site federation
--------------------------------------------------------------------------------

Every site connects to one shared broker and publishes its data under `ahcc/<siteId>/`, where siteId is the site's SITE_ID from .env (unique per site). Because each site also subscribes, two sites on the same broker see each other's topics and stay in sync on their own. Messages use QoS 1 by default; **QoS (events)** and **QoS (commands)** change it per site. To read everything from every site at once, subscribe to `ahcc/#`.

| Topic                        | Payload                                    |
| ---------------------------- | ------------------------------------------ |
| `ahcc/<siteId>/nodes/upsert`      | Node snapshot per heartbeat                |
| `ahcc/<siteId>/inventory/upsert`  | Device: MAC, vendor, RSSI, position        |
| `ahcc/<siteId>/targets/upsert`    | Target lifecycle                           |
| `ahcc/<siteId>/targets/delete`    | `{ targetId }`                             |
| `ahcc/<siteId>/geofences/upsert`  | Geofence upsert                            |
| `ahcc/<siteId>/geofences/delete`  | Geofence removal                           |
| `ahcc/<siteId>/geofences/snapshot`| Full geofence set                          |
| `ahcc/<siteId>/drones/upsert`     | Drone telemetry                            |
| `ahcc/<siteId>/commands/events`   | Command lifecycle                          |
| `ahcc/<siteId>/commands/request`  | Remote command request                     |
| `ahcc/<siteId>/events/<type>`     | Alerts and events. `<type>` is the event name with dots and slashes turned into dashes, e.g. `event-alert` |

Mosquitto is the default: tiny, free, and configured through plain passwd and acl files. EMQX Open Source is heavier but adds a web dashboard for managing users. Neither needs clustering.

1. Install Mosquitto on a VPS or the AHCC host. Get a cert with certbot.
2. Set up a listener in /etc/mosquitto/conf.d/ahcc.conf:

       listener 8883
       certfile /etc/mosquitto/certs/fullchain.pem
       keyfile  /etc/mosquitto/certs/privkey.pem
       allow_anonymous false
       password_file /etc/mosquitto/passwd
       acl_file /etc/mosquitto/acl

3. Add one readwrite user per site and a read-only viewer:

       mosquitto_passwd -c /etc/mosquitto/passwd ahcc-alpha
       mosquitto_passwd    /etc/mosquitto/passwd viewer

   In the acl: `ahcc-alpha` gets `readwrite ahcc/#`, `viewer` gets `read ahcc/#`.
4. Open 8883, not 1883. Restart Mosquitto.
5. Point AHCC at it: **Config** → **MQTT Federation**. Set **Broker URL** to `mqtts://host:8883`, a unique **Client ID**, **Username** and **Password**, and tick **TLS enabled**. Leave **CA PEM** empty for a public cert.

Read the feed with MQTTX or any client:

    mqttx sub -h mqtt.example.com -p 8883 -u viewer -P 'password' -t 'ahcc/#'

To add a second site, give it its own SITE_ID, clientId, and readwrite user. Both sites then share nodes, inventory, targets, geofences, drones, and chat. Each can command the other's serial workers.

Lock it down

- AHCC verifies the broker's cert by default. For a private cert, paste its CA into caPem. MQTT_TLS_INSECURE=true turns the check off. Don't use it.
- Set allow_anonymous false. One account per site. Give viewers read-only.
- Use TLS 1.2 or newer. Only AHCC should publish to commands/request. That topic runs commands on your nodes.
- The broker password and certs sit in AHCC's database as plain text. Protect it.

--------------------------------------------------------------------------------
<a id="email"></a>
6. Email alerts
--------------------------------------------------------------------------------

The simplest route: no VPN, broker, or TAK server. AHCC emails you whenever an alert rule matches.

1. Set the SMTP values in apps/backend/.env, then restart:

       MAIL_ENABLED=true
       MAIL_HOST=smtp.example.com
       MAIL_PORT=587
       MAIL_SECURE=false
       MAIL_USER=alerts@example.com
       MAIL_PASS=app-password
       MAIL_FROM="AHCC <alerts@example.com>"

2. In each alert rule, turn on Email and add recipients.
3. Test with MAIL_PREVIEW=true. It logs instead of sending. Or trigger an event.

Port 587 is STARTTLS. Port 465 needs MAIL_SECURE=true. Never use 25. MAIL_PASS is stored in plain text.

Lock it down

- Use a dedicated sending account with an app password. Not your mailbox password.
- Set up SPF and DKIM on the sending domain. That stops spoofing and spam filtering.
- The emails carry MACs and locations. Keep the recipient list short.

--------------------------------------------------------------------------------
<a id="webhooks"></a>
7. Webhooks (reference)
--------------------------------------------------------------------------------

AHCC POSTs events to an HTTPS endpoint. It only dials out. Step-by-step setups for Discord and IFTTT are in [Alerts](#alerts).

Body fields: `summary` (one-line plain text), `content` + `embeds` + `allowed_mentions` (Discord, escaped), `text` (Slack, escaped), `event`, `eventType`, `rule`, `data` (message, MAC, node, SSID, channel, RSSI, lat/lon, siteId, timestamp), `payload` (event-specific).

1. Open **Alerts** → **Remote alerts** → **Webhooks** → **Create webhook**. Enter the https URL of your receiver in **Destination URL**.
2. Set **Secret (optional)**. AHCC signs each POST body with HMAC-SHA256 using it (hex, `x-webhook-signature` header). Your receiver checks the signature.
3. For mutual TLS, fill in **Client certificate (PEM)**, **Client private key (PEM)** and **Custom CA bundle (optional)**.
4. Choose what is sent in **Alert sources**; every enabled webhook gets every ticked source.
5. Click **Test** on the webhook row, then **Edit** → **Recent deliveries**.

Lock it down

- Use https only. AHCC verifies the endpoint's cert by default.
- Check the signature on your receiver. Reject old timestamps to block replays.
- AHCC doesn't check where the URL points. It can hit your LAN or a cloud metadata address. Keep webhooks admin-only.

--------------------------------------------------------------------------------
<a id="meshtastic"></a>
8. Meshtastic + TAK (LoRa, not internet)
--------------------------------------------------------------------------------

The Meshtastic app's TAK feature carries Meshtastic's own CoT between nodes (positions, chat, markers), not AntiHunter detections, which are plain text frames rather than CoT. It also runs over LoRa, not the internet. To get detections into TAK, use the [TAK bridge](#tak).

AHCC itself reaches the mesh through one Meshtastic radio on USB with Send Mode `protobuf`. See [Serial Hardware](../README.md#serial-hardware--meshtastic-sniffer) in the README.

--------------------------------------------------------------------------------
<a id="rbac"></a>
9. RBAC (accounts and roles)
--------------------------------------------------------------------------------

Each account gets one role.

| Role     | Can                                            |
| -------- | ---------------------------------------------- |
| ADMIN    | Everything: users, config, firewall            |
| OPERATOR | Run commands, manage targets and geofences     |
| ANALYST  | Review data, inventory, exports                |
| VIEWER   | Read-only map and console                      |

Roles are checked on every API call. Changes go to the AuditLog. RBAC covers AHCC accounts only. TAK and broker users have their own logins.

Lock it down

- One account per person. Give the lowest role that fits.
- Require 2FA on ADMIN and on any remote login.
- Keep ADMINs few. Disable accounts instead of sharing them.

--------------------------------------------------------------------------------
<a id="canary"></a>
10. Bonus: Canarytokens tripwires
--------------------------------------------------------------------------------

A canarytoken is a fake file, link or credential that emails you the moment someone opens or uses it. Free at https://canarytokens.org, no account.

1. Open https://canarytokens.org and pick a token type.
2. Enter the email that gets the alert, and a memo that tells you where you planted it (e.g. `USB stick in node case 3`).
3. Click create, then download or copy what it gives you.

Where to plant them near an AHCC deployment:

| Token             | Plant it                                                                | Fires when                           |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| WireGuard config  | Save as `ahcc-remote.conf` on the AHCC computer's desktop or a USB stick | someone tries to connect with it     |
| QR code           | Sticker on a node enclosure or the AHCC box                              | someone scans it                     |
| AWS API keys      | `~/.aws/credentials` on the AHCC computer                                | someone tries the keys               |
| Word / PDF        | `AHCC-admin-passwords.docx` in the AHCC folder                           | someone opens it                     |
| Web bug (URL)     | A bookmark or note named "AHCC admin"                                    | someone opens the link               |

The alert includes the IP address, time and browser of whoever tripped it. Never put a real credential next to a token.

--------------------------------------------------------------------------------
<a id="quickref"></a>
11. Quick reference
--------------------------------------------------------------------------------

| Hop                         | Encrypted by                   | Crosses internet?     |
| --------------------------- | ------------------------------ | --------------------- |
| Phone -> AHCC (Tailscale)   | Tailscale (WireGuard) + ts.net HTTPS | yes, tailnet only |
| Browser -> AHCC (Cloudflare)| Cloudflare HTTPS + Access login | yes, approved emails only |
| Browser -> AHCC UI (LAN)    | yes if HTTPS_* set, else none  | no                    |
| AHCC -> TAK server          | TLS if enabled, else none      | yes with TLS          |
| TAK server -> iTAK          | server's TLS (8089)            | yes                   |
| AHCC -> MQTT broker         | yes (caPem for private CA)     | yes                   |
| AHCC -> webhook             | yes (HMAC, mTLS)               | yes                   |
| AHCC -> phone push          | end-to-end (RFC 8291) via Apple/Google/Mozilla relay | yes          |
| AHCC -> Signal              | end-to-end (Signal protocol)   | yes                   |
| AHCC -> ntfy / Matrix       | TLS to your server; server reads it | yes              |
| Hub/phone -> Matter device  | Matter (CASE/PASE sessions)    | no, LAN only          |
| AHCC -> SMTP server         | STARTTLS/TLS                   | yes                   |
