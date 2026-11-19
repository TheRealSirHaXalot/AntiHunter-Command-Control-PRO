#!/usr/bin/env bash
set -euo pipefail

SERVICE_USER="ahcc-signal"
STATE_DIR="/var/lib/ahcc-signal"
CIPHER_DIR="$STATE_DIR/cipher"
DATA_DIR="$STATE_DIR/data"
OPT_DIR="/opt/ahcc-signal"
GATE="/usr/local/libexec/ahcc-signal-gate"
GATE_SCRIPT="/usr/local/libexec/ahcc-signal-gate.mjs"
CREDSTORE="/etc/credstore.encrypted"
CRED_NAME="ahcc-signal-fs"
UNIT="/etc/systemd/system/ahcc-signal.service"
FS_UNIT="/etc/systemd/system/ahcc-signal-fs.service"
SUDOERS="/etc/sudoers.d/ahcc-signal"
GATE_SOCKET="/run/ahcc-signal-gate.sock"
GATE_SOCKET_UNIT="/etc/systemd/system/ahcc-signal-gate.socket"
GATE_SERVICE_UNIT="/etc/systemd/system/ahcc-signal-gate@.service"

SIGNAL_VERSION="0.14.8"
NATIVE_URL="https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_VERSION}/signal-cli-${SIGNAL_VERSION}-Linux-native.tar.gz"
NATIVE_SHA256="36569af20c709e0c5e6e677b74f50f147b21f3740620b8a7affde70f6027f82a"
JVM_URL="https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_VERSION}/signal-cli-${SIGNAL_VERSION}.tar.gz"
JVM_SHA256="ccd408e831eff7e41ebaaf309704840bb00d78a7869f35ad700dbae5b5a5bb65"
JRE_URL="https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_aarch64_linux_hotspot_25.0.4.1_1.tar.gz"
JRE_SHA256="34828cbb93ed31c281c84ecb31ddab655d11a802f263c1fc019d42e9e0230fed"
LIBSIGNAL_URL="https://github.com/exquo/signal-libs-build/releases/download/libsignal_v0.102.1/libsignal_jni.so-v0.102.1-aarch64-unknown-linux-gnu.tar.gz"
LIBSIGNAL_SHA256="c45f2c54143292ef3941226f53419fd8884e88cba95e2a52a356a9321fc90e60"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_USER=""
SKIP_SYSTEMD=0

usage() {
  echo "usage: sudo $0 --backend-user USER [--no-systemd]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --backend-user) BACKEND_USER="${2:-}"; shift 2 ;;
    --no-systemd) SKIP_SYSTEMD=1; shift ;;
    *) usage ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -n "$BACKEND_USER" ] || usage
id "$BACKEND_USER" >/dev/null 2>&1 || { echo "backend user $BACKEND_USER does not exist" >&2; exit 1; }
[ "$BACKEND_USER" != "root" ] || { echo "backend user must not be root" >&2; exit 1; }

log() { echo "[ahcc-signal] $*"; }

install_packages() {
  local pkgs=(gocryptfs fuse3 curl ca-certificates)
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${pkgs[@]}" >/dev/null
  elif command -v dnf >/dev/null; then
    dnf install -y -q "${pkgs[@]}"
  elif command -v pacman >/dev/null; then
    pacman -S --noconfirm --needed "${pkgs[@]}"
  else
    echo "unsupported package manager; install: ${pkgs[*]}" >&2
    exit 1
  fi
}

fetch_verified() {
  local url="$1" sha="$2" out="$3"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$out" "$url"
  echo "$sha  $out" | sha256sum -c --quiet - || { rm -f "$out"; echo "checksum mismatch for $url" >&2; exit 1; }
}

install_signal_cli() {
  local arch tmp
  arch="$(uname -m)"
  tmp="$(mktemp -d)"
  install -d -o root -g root -m 0755 "$OPT_DIR"
  case "$arch" in
    x86_64)
      if [ ! -x "$OPT_DIR/signal-cli-$SIGNAL_VERSION/signal-cli" ]; then
        log "downloading signal-cli $SIGNAL_VERSION (native)"
        fetch_verified "$NATIVE_URL" "$NATIVE_SHA256" "$tmp/sc.tar.gz"
        install -d -o root -g root -m 0755 "$OPT_DIR/signal-cli-$SIGNAL_VERSION"
        tar -xzf "$tmp/sc.tar.gz" -C "$OPT_DIR/signal-cli-$SIGNAL_VERSION" --no-same-owner
      fi
      ln -sfn "$OPT_DIR/signal-cli-$SIGNAL_VERSION/signal-cli" "$OPT_DIR/signal-cli"
      ;;
    aarch64|arm64)
      if [ ! -x "$OPT_DIR/jre/bin/java" ]; then
        log "downloading Temurin JRE 25 (aarch64)"
        fetch_verified "$JRE_URL" "$JRE_SHA256" "$tmp/jre.tar.gz"
        install -d -o root -g root -m 0755 "$OPT_DIR/jre"
        tar -xzf "$tmp/jre.tar.gz" -C "$OPT_DIR/jre" --strip-components=1 --no-same-owner
      fi
      if [ ! -x "$OPT_DIR/signal-cli-$SIGNAL_VERSION/bin/signal-cli" ]; then
        log "downloading signal-cli $SIGNAL_VERSION (JVM)"
        fetch_verified "$JVM_URL" "$JVM_SHA256" "$tmp/sc.tar.gz"
        tar -xzf "$tmp/sc.tar.gz" -C "$OPT_DIR" --no-same-owner
      fi
      if [ ! -f "$OPT_DIR/lib/libsignal_jni.so" ]; then
        log "downloading libsignal_jni 0.102.1 (aarch64)"
        fetch_verified "$LIBSIGNAL_URL" "$LIBSIGNAL_SHA256" "$tmp/libsignal.tar.gz"
        install -d -o root -g root -m 0755 "$OPT_DIR/lib"
        tar -xzf "$tmp/libsignal.tar.gz" -C "$OPT_DIR/lib" --no-same-owner
      fi
      ln -sfn "$OPT_DIR/signal-cli-$SIGNAL_VERSION/bin/signal-cli" "$OPT_DIR/signal-cli"
      ;;
    *)
      echo "unsupported architecture $arch" >&2
      exit 1
      ;;
  esac
  chown -R root:root "$OPT_DIR"
  chmod -R go-w "$OPT_DIR"
  rm -rf "$tmp"
}

create_user() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$STATE_DIR" "$CIPHER_DIR" "$DATA_DIR"
}

seal_password() {
  install -d -o root -g root -m 0700 "$CREDSTORE"
  if [ -s "$CREDSTORE/$CRED_NAME" ]; then
    return
  fi
  local pass
  pass="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  if command -v systemd-creds >/dev/null && systemd-creds --help 2>/dev/null | grep -q -- '--with-key'; then
    printf '%s' "$pass" | systemd-creds encrypt --with-key=auto --name="$CRED_NAME" - "$CREDSTORE/$CRED_NAME"
    log "gocryptfs password sealed with systemd-creds ($(systemd-creds has-tpm2 >/dev/null 2>&1 && echo TPM2 || echo host key))"
    echo encrypted > "$CREDSTORE/$CRED_NAME.kind"
  else
    ( umask 077; printf '%s' "$pass" > "$CREDSTORE/$CRED_NAME" )
    echo plain > "$CREDSTORE/$CRED_NAME.kind"
    log "systemd-creds unavailable; password stored root-only (0600) without sealing"
  fi
  if [ ! -f "$CIPHER_DIR/gocryptfs.conf" ]; then
    local passfile
    passfile="$(mktemp /dev/shm/ahcc-signal.XXXXXX)"
    printf '%s' "$pass" > "$passfile"
    gocryptfs -init -q -passfile "$passfile" "$CIPHER_DIR"
    rm -f "$passfile"
    chown -R "$SERVICE_USER:$SERVICE_USER" "$CIPHER_DIR"
  fi
  unset pass
}

install_gate() {
  local node backend_group
  node="$(command -v node)" || { echo "node is required for the gate" >&2; exit 1; }
  backend_group="$(id -gn "$BACKEND_USER")"
  install -d -o root -g root -m 0755 /usr/local/libexec
  install -o root -g root -m 0644 "$SCRIPT_DIR/ahcc-signal-gate.mjs" "$GATE_SCRIPT"
  rm -f "$SUDOERS" "$GATE"
  cat > "$GATE_SOCKET_UNIT" <<EOF
[Unit]
Description=AHCC Signal gate socket (backend user only)

[Socket]
ListenStream=$GATE_SOCKET
SocketUser=$BACKEND_USER
SocketGroup=$backend_group
SocketMode=0600
Accept=yes
MaxConnections=16

[Install]
WantedBy=sockets.target
EOF
  cat > "$GATE_SERVICE_UNIT" <<EOF
[Unit]
Description=AHCC Signal gate request
Requires=ahcc-signal.service
After=ahcc-signal.service

CollectMode=inactive-or-failed

[Service]
User=$SERVICE_USER
Group=$SERVICE_USER
ExecStart=$node $GATE_SCRIPT
StandardInput=socket
StandardOutput=socket
StandardError=journal
RuntimeMaxSec=330
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateNetwork=yes
ReadWritePaths=/run/ahcc-signal
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=
SystemCallArchitectures=native
EOF
  chmod 0644 "$GATE_SOCKET_UNIT" "$GATE_SERVICE_UNIT"
}

install_unit() {
  local uid gid cred_line java_env=""
  uid="$(id -u "$SERVICE_USER")"
  gid="$(id -g "$SERVICE_USER")"
  if [ "$(cat "$CREDSTORE/$CRED_NAME.kind")" = encrypted ]; then
    cred_line="LoadCredentialEncrypted=$CRED_NAME:$CREDSTORE/$CRED_NAME"
  else
    cred_line="LoadCredential=$CRED_NAME:$CREDSTORE/$CRED_NAME"
  fi
  if [ -x "$OPT_DIR/jre/bin/java" ]; then
    java_env="Environment=JAVA_HOME=$OPT_DIR/jre \"JAVA_OPTS=-Djava.library.path=$OPT_DIR/lib\""
  fi
  cat > "$FS_UNIT" <<EOF
[Unit]
Description=AHCC Signal encrypted state (gocryptfs)
Before=ahcc-signal.service

[Service]
Type=simple
$cred_line
ExecStart=$(command -v gocryptfs) -fg -q -allow_other -force_owner $uid:$gid -passfile \${CREDENTIALS_DIRECTORY}/$CRED_NAME $CIPHER_DIR $DATA_DIR
ExecStartPost=/bin/sh -c 'i=0; while [ \$i -lt 100 ]; do mountpoint -q $DATA_DIR && exit 0; i=\$((i+1)); sleep 0.2; done; exit 1'
ExecStopPost=/bin/sh -c 'mountpoint -q $DATA_DIR && fusermount3 -u $DATA_DIR || true'
Restart=on-failure
RestartSec=10
EOF
  chmod 0644 "$FS_UNIT"
  cat > "$UNIT" <<EOF
[Unit]
Description=AHCC Signal connector (signal-cli daemon)
After=network-online.target ahcc-signal-fs.service
Wants=network-online.target
BindsTo=ahcc-signal-fs.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
$java_env
RuntimeDirectory=ahcc-signal
RuntimeDirectoryMode=0700
UMask=0077
ExecStart=$OPT_DIR/signal-cli --config $DATA_DIR daemon --socket /run/ahcc-signal/socket --receive-mode=on-start --ignore-attachments --ignore-stories
Restart=on-failure
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$STATE_DIR
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$UNIT"
  if [ "$SKIP_SYSTEMD" -eq 0 ]; then
    systemctl daemon-reload
    systemctl enable --now ahcc-signal-fs.service ahcc-signal.service ahcc-signal-gate.socket
  fi
}

install_packages
create_user
install_signal_cli
seal_password
install_gate
install_unit

log "installed. Add to the backend environment: AHCC_SIGNAL_GATE=$GATE_SOCKET"
