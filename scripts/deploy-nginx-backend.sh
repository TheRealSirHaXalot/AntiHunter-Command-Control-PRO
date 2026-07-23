#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# Configuration (edit me)
# -----------------------------
REPO_DIR="/var/www/AntiHunter-Command-Control-PRO"
FRONTEND_BUILD_DIR="$REPO_DIR/apps/frontend/dist"
NGINX_ROOT="/var/www/ahcc-frontend"
NGINX_SITE="/etc/nginx/sites-available/ahcc"
NGINX_SITE_LINK="/etc/nginx/sites-enabled/ahcc"
DOMAIN="ahcc.example.com"
LE_CERT_PATH="/etc/letsencrypt/live/${DOMAIN}"

BACKEND_SERVICE="ahcc-backend.service"
BACKEND_ENV_FILE="$REPO_DIR/apps/backend/.env.production"

DB_USER="command_center"
DB_PASSWORD="command_center"
DB_NAME="command_center"
DB_HOST_LOCAL="${DB_HOST_LOCAL:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST_LOCAL}:${DB_PORT}/${DB_NAME}"
NODE_ENV="production"
PORT="3000"
JWT_SECRET="${JWT_SECRET:-changeme_super_secret}"

COMPOSE_BIN="${COMPOSE_BIN:-docker compose}"
COMPOSE_POSTGRES_SERVICE="${COMPOSE_POSTGRES_SERVICE:-postgres}"

# -----------------------------
# Helper functions
# -----------------------------
log() { echo -e "\033[1;32m[$(date '+%Y-%m-%d %H:%M:%S')] $*\033[0m"; }
error_exit() { echo -e "\033[1;31mERROR: $*\033[0m" >&2; exit 1; }

ensure_apt_packages() {
  local packages=(curl git nginx rsync ca-certificates lsb-release postgresql-client)
  local missing=()
  for pkg in "${packages[@]}"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if (( ${#missing[@]} > 0 )); then
    log "Installing system packages: ${missing[*]}..."
    apt-get update
    apt-get install -y "${missing[@]}"
  fi
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    return
  fi
  log "Installing Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi
  if command -v corepack >/dev/null 2>&1; then
    log "Activating pnpm via corepack..."
    corepack enable
    corepack prepare pnpm@9.9.0 --activate
  else
    log "Installing pnpm globally via npm..."
    npm install -g pnpm@9.9.0
  fi
}

bootstrap_dependencies() {
  ensure_apt_packages
  ensure_node
  ensure_pnpm
}

wait_for_postgres() {
  local retries=30
  while (( retries > 0 )); do
    if PGPASSWORD="$DB_PASSWORD" pg_isready -h "$DB_HOST_LOCAL" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      log "PostgreSQL is reachable at ${DB_HOST_LOCAL}:${DB_PORT}"
      return 0
    fi
    sleep 2
    retries=$((retries - 1))
  done
  return 1
}

ensure_postgres() {
  if wait_for_postgres; then
    return
  fi

  if command -v docker >/dev/null 2>&1; then
    log "Attempting to start Postgres via docker compose..."
    (cd "$REPO_DIR" && ${COMPOSE_BIN} up -d "$COMPOSE_POSTGRES_SERVICE") || error_exit "Failed to start Postgres service with docker compose."
    if wait_for_postgres; then
      return
    fi
  fi

  error_exit "Postgres is not reachable at ${DB_HOST_LOCAL}:${DB_PORT}. Start the database service and rerun."
}

check_prereqs() {
  command -v git >/dev/null       || error_exit "git not found"
  command -v pnpm >/dev/null      || error_exit "pnpm not found"
  command -v node >/dev/null      || error_exit "node not found"
  command -v nginx >/dev/null     || error_exit "nginx not found"
  command -v rsync >/dev/null     || error_exit "rsync not found"
  command -v systemctl >/dev/null || error_exit "systemctl not found"
  [[ -d "$LE_CERT_PATH" ]]        || error_exit "Let's Encrypt cert path $LE_CERT_PATH missing"
}

update_repo() {
  log "Updating repository..."
  cd "$REPO_DIR"
  git fetch --all --tags
  git pull
}

install_deps() {
  log "Installing workspace dependencies..."
  pnpm install
}

generate_prisma_client() {
  log "Running database migrations..."
  DATABASE_URL="$DATABASE_URL" pnpm --filter @command-center/backend prisma:migrate
  log "Generating Prisma client..."
  DATABASE_URL="$DATABASE_URL" pnpm --filter @command-center/backend prisma:generate
}

build_backend() {
  log "Building backend..."
  pnpm --filter @command-center/backend build
}

build_frontend() {
  log "Building frontend..."
  pnpm --filter @command-center/frontend build
  log "Syncing frontend build to $NGINX_ROOT..."
  mkdir -p "$NGINX_ROOT"
  rsync -a --delete "$FRONTEND_BUILD_DIR/" "$NGINX_ROOT/"
}

write_backend_env() {
  log "Writing backend .env.production..."
  cat > "$BACKEND_ENV_FILE" <<EOF
NODE_ENV=$NODE_ENV
PORT=$PORT
DATABASE_URL=$DATABASE_URL
JWT_SECRET=$JWT_SECRET
ALLOW_FOREVER=false
ALLOW_ERASE_FORCE=false
EOF
}

deploy_backend_service() {
  local unit_file="/etc/systemd/system/$BACKEND_SERVICE"
  if [[ ! -f "$unit_file" ]]; then
    log "Creating systemd unit $BACKEND_SERVICE..."
    cat > "$unit_file" <<EOF
[Unit]
Description=AntiHunter Command Center Backend
After=network.target

[Service]
WorkingDirectory=$REPO_DIR/apps/backend
EnvironmentFile=$BACKEND_ENV_FILE
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
  fi

  log "Restarting backend service..."
  systemctl enable "$BACKEND_SERVICE"
  systemctl restart "$BACKEND_SERVICE"
  systemctl status "$BACKEND_SERVICE" --no-pager
}

install_nginx_site() {
  log "Writing Nginx site configuration..."
  cat > "$NGINX_SITE" <<EOF
server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     $LE_CERT_PATH/fullchain.pem;
    ssl_certificate_key $LE_CERT_PATH/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    access_log /var/log/nginx/ahcc_access.log;
    error_log  /var/log/nginx/ahcc_error.log warn;

    root  $NGINX_ROOT;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:$PORT/;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:$PORT/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
        proxy_buffering off;
    }

    location / {
        try_files \$uri /index.html;
    }
}

server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
EOF

  ln -sf "$NGINX_SITE" "$NGINX_SITE_LINK"

  log "Testing Nginx configuration..."
  nginx -t

  log "Reloading Nginx..."
  systemctl reload nginx
}

print_post_deploy_checks() {
  cat <<EOF

Deployment complete!

Suggested verification:
  - Backend: curl -sSf http://127.0.0.1:$PORT/healthz
  - Frontend: curl -I https://$DOMAIN
  - Socket:   curl -Ivk https://$DOMAIN/socket.io/?EIO=4&transport=websocket

Logs:
  - systemctl status $BACKEND_SERVICE
  - journalctl -u $BACKEND_SERVICE -f
  - tail -f /var/log/nginx/ahcc_error.log
  - tail -f /var/log/nginx/ahcc_access.log

EOF
}

# -----------------------------
# Main
# -----------------------------
bootstrap_dependencies
check_prereqs
update_repo
install_deps
ensure_postgres
generate_prisma_client
build_backend
write_backend_env
deploy_backend_service
build_frontend
install_nginx_site
print_post_deploy_checks

