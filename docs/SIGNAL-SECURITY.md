# Signal & remote-alerts security

What AHCC hardens, what was tested, and what's left for you to weigh against your own threat appetite. Scope: the Signal connector, the remote-alerts key, and the alert/auth surface around them.

## Threat model

The control protects the **Signal account** and the **alert tokens** against a **compromised AHCC backend** (a bug in AHCC, a bad dependency, or code-exec as the backend user). It does **not** protect against an attacker who already has **root/administrator on the running host** — that person can read decrypted secrets from memory regardless. Isolation raises the bar from "any backend flaw = account takeover" to "you need host root."

## Hardening

**Connector boundary (Docker / macOS / Windows)** — signal-cli runs behind `signal-proxy`; the backend can only reach four actions.

- Proxy rebuilds every request from validated fields; the only send allowed is to one `group.` recipient.
- Blocked: sending to a phone number, `/v1/send`, listing groups, creating a group with foreign members, path traversal, extra or case-duplicated JSON keys, bodies over the size cap (→ 413), messages over the length cap (truncated).
- Optional bearer token (`SIGNAL_PROXY_TOKEN`, constant-time compare) and a per-minute send-rate limit.
- `signal-api` sits on an internal network with no published port; the host connector command publishes only the proxy, on loopback, with the token.

**Isolated host mode (Linux)** — signal-cli runs as its own user, state encrypted, reached only through a gate.

- Separate `ahcc-signal` system user, no login shell. Binaries are root-owned and pinned by SHA-256 (x86_64 native; aarch64 JVM + Temurin JRE + libsignal).
- Account data in a gocryptfs store; the passphrase is sealed with `systemd-creds` (to the TPM when present, otherwise a root-only host key).
- The backend never touches those files or the daemon. It connects to a socket-activated **gate** (mode 0600, openable only by the backend user) exposing exactly: status, link, create-group, send. No sudo.
- The gate service is sandboxed: `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateNetwork`, empty capability set. It rejects unknown ops, extra fields, bad group ids, and non-JSON.

**Key at rest** — the remote-alerts key (which encrypts every token in the DB) is sealed to the machine, never a plain file by default: macOS Keychain, Windows DPAPI (bound to the account AHCC runs as), or a `systemd-creds` credential for the Linux service.

**Alert & auth surface (all platforms)**

- A role change takes effect on the next request (role read from the DB, not the token). An admin-set password ends that user's existing sessions.
- Matter pairing codes are shown only to admins with 2FA.
- The public web entrance returns 404 for the Tailscale-login check endpoint, so it can't be used as a login-guessing oracle.
- A failed Signal/ntfy/Matrix delivery, or a failed receive, raises a push notification. Incoming messages are fetched on a schedule so the linked device doesn't idle-unlink; attachments and stories are ignored.

## Tested

- **Docker/REST path, end to end:** 32/32 against the real pinned image with the backend built — link QR, group creation, full detection→alert→send, delivery-failure push, nginx entrances, Matter redaction, auth.
- **What the proxy will and won't do (measured).** The proxy sits in front of the connector and lets AHCC do exactly one thing: send an alert to its own group. We tried the reads an attacker would want and each was refused:

  | Attempt through the proxy | Result |
  |---|---|
  | Read your incoming messages (direct and group) | refused — `blocked by AntiHunter signal-proxy` |
  | List your groups and their members | refused |
  | List your contacts | refused |
  | Download an attachment sent to you | refused |
  | Send with no token / a wrong token | refused — `token required` |
  | Send to a phone number, or add a second recipient | dropped — the body is rebuilt from checked fields |
  | Send one message to the AHCC group | allowed |

  Reaching the connector *directly* (bypassing the proxy) does read everything — which is why, as deployed, the connector has **no published port** and is unreachable from the host (`connection refused`). On Linux the gate goes further: it has no read operation at all.
- **Isolated host mode:** on a real Kali arm64 box and a Debian VM — gate ops correct; every break-out attempt denied (socket `EACCES` for other users; the backend user cannot sudo, read the state dir, read the sealed credential, read plaintext through the mount, or modify the binaries/gate); a canary written through the mount is absent from the cipher directory; stopping the service unmounts and empties the data dir; restart restores it; survives reboot. Full `deploy-production.sh` run with Signal + sealed key.
- **Windows DPAPI:** the compiled key module on Windows 11 — 7/7: seal/open round-trip, legacy plaintext key migrated and deleted, no plaintext key left on disk, a second process decrypts the first's blob.

## Not tested (settle before relying on it)

- **TPM sealing** — validated only on hosts without a TPM (fell back to the host key). Confirm on a TPM host with `systemd-creds has-tpm2`.
- **Windows Docker connector** — Docker can't run in a Windows VM on Apple Silicon (no nested virtualization). Needs a physical/Intel Windows host.

## Residual risks — decide by your threat appetite

| Attack | How it works | What you can do |
|---|---|---|
| **Host root/admin, live** | Reads the decrypted key from AHCC's memory, or unlocks the store as the service does. | Limit who has root; this is out of scope for the isolation, which only contains a compromised *backend*. |
| **Stolen disk, no TPM (Linux)** | The gocryptfs passphrase is sealed to a root-only file on the same disk; with the powered-off disk, an attacker reads that file and decrypts the state. | Use a TPM host (then the disk alone is useless), or full-disk encryption (LUKS). |
| **Windows account takeover** | DPAPI is bound to the AHCC account; anyone who runs code as that account decrypts the key. | Run AHCC as a dedicated least-privilege account; don't share it or its login. |
| **Docker/host admin (Docker/mac/win)** | signal-cli state lives in a Docker volume with no separate-user isolation; a Docker-admin `exec`s into the container. | FileVault/BitLocker; treat Docker-admin as equivalent to the account. |
| **Unauthenticated proxy** | With `SIGNAL_PROXY_TOKEN` blank, any process that can reach the proxy port drives it (still only send-to-group). Safe only because the port isn't published. | Set the token if you ever expose the port. |
| **Linked-device inheritance** | Linking grants an account-wide device; a stolen connector reads everything sent to you and sends as you. Signal shows no safety-number change on link. | Dedicated number; watch **Linked devices**; on suspicion **re-register**, not just unlink — unlink doesn't revoke a copied identity key. Keep the state volume/`.signal-cli` out of backups. |
| **Version deprecation** | Signal's servers reject old signal-cli; alerts stop. | Update the pinned version/image; the Signal card flags an update. |
| **Idle unlink** | ~25–30 days of inactivity unlinks the device. The 6-hourly receive keeps it awake; whether send alone counts is unconfirmed. | Keep the backend running; check **Linked devices** after a quiet stretch. |
| **Alert-text injection** | Device-chosen names (Wi-Fi SSID, BLE name) flow into alert text. Escaped for Discord/Slack with mentions off; Signal/ntfy/Matrix receive it as plain text. | Aware-only; treat alert text as untrusted. |
