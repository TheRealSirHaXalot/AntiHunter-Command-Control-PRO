#!/usr/bin/env bash
set -euo pipefail

#############################################################################
# AntiHunter Command & Control Pro - Production Deployment Script
# BE SURE TO FOLLOW README.md AND AUDIT THIS SCRIPT BEFORE BLINDLY EXECUTING
# Target: Debian/Ubuntu with native PostgreSQL
#############################################################################

VERSION="1.0.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Color codes
if [[ -t 1 ]] && [[ "$(tput colors 2>/dev/null)" -ge 8 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m' 
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    MAGENTA='\033[0;35m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    CYAN=''
    MAGENTA=''
    NC=''
fi

# Ensure system paths are available
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# Logging functions
log() { echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*"; }
info() { echo -e "${CYAN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
error_exit() { error "$*"; exit 1; }
success() { echo -e "${GREEN}✓${NC} $*"; }
step() { echo -e "${MAGENTA}[STEP]${NC} $*"; }

# Configuration defaults
INSTALL_USER="ahcc"
INSTALL_DIR="/opt/ahcc"
REPO_URL="https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO.git"
REPO_DIR="$INSTALL_DIR/AntiHunter-Command-Control-PRO"
BACKEND_DIR="$REPO_DIR/apps/backend"
FRONTEND_DIR="$REPO_DIR/apps/frontend"
NGINX_ROOT="/var/www/ahcc-frontend"
SCRIPTS_DIR="$INSTALL_DIR/scripts"
BACKUP_DIR="$INSTALL_DIR/backups"
LOG_DIR="$INSTALL_DIR/logs"

# Database defaults
DB_NAME="command_center"
DB_USER="command_center"
DB_HOST="localhost"
DB_PORT="5432"

# Service defaults
BACKEND_PORT="3000"
BACKEND_SERVICE="ahcc-backend"
NODE_ENV="production"
HTTP_PREFIX="api"
LOG_LEVEL="info"

# SSL defaults
SSL_CERT_DIR="/etc/ssl/certs"
SSL_KEY_DIR="/etc/ssl/private"
SSL_CERT_FILE="ahcc-selfsigned.crt"
SSL_KEY_FILE="ahcc-selfsigned.key"

# User input variables (populated interactively)
DOMAIN=""
SSL_METHOD=""
DB_PASSWORD=""
JWT_SECRET=""
TWO_FACTOR_SECRET_KEY=""
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
SITE_ID=""
SITE_NAME=""
SERIAL_DEVICE=""
SERIAL_BAUD="115200"
ENABLE_FAIL2BAN="yes"
ENABLE_BACKUPS="yes"
BACKUP_RETENTION_DAYS="7"
LE_EMAIL=""

#############################################################################
# Pre-flight Checks
#############################################################################

check_root() {
    # Debug info
    info "Current user: $(whoami), EUID: $EUID, UID: $UID"
    
    if [[ $EUID -eq 0 ]] || [[ "$(whoami)" == "root" ]]; then
        echo ""
        echo "ERROR: This script must NOT be run as root."
        echo ""
        echo "Please create a dedicated system user with sudo privileges:"
        echo ""
        echo "    sudo adduser --system --group --home $INSTALL_DIR --shell /bin/bash $INSTALL_USER"
        echo "    sudo usermod -aG sudo $INSTALL_USER"  
        echo "    sudo usermod -aG dialout $INSTALL_USER"
        echo ""
        echo "Then switch to that user and re-run this script:"
        echo ""
        echo "    sudo -u $INSTALL_USER -i"
        echo "    bash $(basename "$0")"
        echo ""
        exit 1
    fi
}

check_sudo() {
    if ! sudo -n true 2>/dev/null; then
        error_exit "This script requires sudo privileges. Configure passwordless sudo or run:
    ${CYAN}sudo -v${NC}
Then re-run this script."
    fi
}

check_os() {
    if [[ ! -f /etc/os-release ]]; then
        error_exit "Cannot detect OS. This script requires Debian or Ubuntu."
    fi
    
    source /etc/os-release
    
    if [[ "$ID" != "debian" && "$ID" != "ubuntu" ]]; then
        error_exit "Unsupported OS: $ID. This script requires Debian or Ubuntu."
    fi
    
    info "Detected: $PRETTY_NAME"
}

check_disk_space() {
    local available_gb
    available_gb=$(df -BG / | awk 'NR==2 {print $4}' | sed 's/G//')
    
    if [[ $available_gb -lt 5 ]]; then
        warn "Low disk space: ${available_gb}GB available. 5GB+ recommended."
        read -p "Continue anyway? (yes/no): " -r
        [[ "$REPLY" =~ ^[Yy][Ee][Ss]$ ]] || exit 1
    fi
}

check_port_available() {
    local port=$1
    local service=$2
    if sudo lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        warn "Port $port ($service) is already in use."
        read -p "Attempt to continue? (yes/no): " -r
        [[ "$REPLY" =~ ^[Yy][Ee][Ss]$ ]] || exit 1
    fi
}

preflight_checks() {
    log "Running pre-flight checks..."
    info "Current user: $(whoami), UID: $UID, EUID: $EUID"
    info "Running from: $(pwd)"
    check_root
    check_sudo
    check_os
    check_disk_space
    check_port_available 80 "HTTP"
    check_port_available 443 "HTTPS"
    check_port_available "$BACKEND_PORT" "Backend API"
    success "Pre-flight checks passed"
}

#############################################################################
# Interactive Configuration
#############################################################################

prompt_configuration() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  AntiHunter Command & Control Pro - Deployment Configuration${NC}"
    echo -e "${BLUE}  Version: $VERSION${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    
    # SSL Method first
    echo ""
    info "SSL Certificate Method:"
    echo "  1) Self-signed (immediate, no DNS required)"
    echo "  2) Let's Encrypt (requires valid DNS pointing to this server)"
    read -p "Choose (1 or 2) [1]: " ssl_choice
    ssl_choice=${ssl_choice:-1}
    
    case $ssl_choice in
        1) SSL_METHOD="selfsigned" ;;
        2) SSL_METHOD="letsencrypt" ;;
        *) warn "Invalid choice, defaulting to self-signed"; SSL_METHOD="selfsigned" ;;
    esac
    
    # Domain - handle differently based on SSL method
    echo ""
    if [[ "$SSL_METHOD" == "selfsigned" ]]; then
        info "Self-signed certificate selected."
        echo "Choose domain for local access:"
        echo "  1) localhost (recommended - works immediately)"
        echo "  2) Custom local domain (e.g., ahcc.local)"
        read -p "Choose (1 or 2) [1]: " domain_choice
        domain_choice=${domain_choice:-1}
        
        case $domain_choice in
            1) 
                DOMAIN="localhost"
            ;;
            2)
                read -p "Custom local domain: " DOMAIN
                while [[ -z "$DOMAIN" ]]; do
                    warn "Domain cannot be empty"
                    read -p "Custom local domain: " DOMAIN
                done
            ;;
            *)
                DOMAIN="localhost"
            ;;
        esac
    else
        read -p "Domain name (must point to this server): " DOMAIN
        while [[ -z "$DOMAIN" ]]; do
            warn "Domain cannot be empty for Let's Encrypt"
            read -p "Domain name: " DOMAIN
        done
        
        read -p "Email for Let's Encrypt notifications: " LE_EMAIL
        while [[ -z "$LE_EMAIL" ]]; do
            warn "Email cannot be empty for Let's Encrypt"
            read -p "Email: " LE_EMAIL
        done
    fi

    # Site ID and Name
    echo ""
    read -p "Site ID [default]: " SITE_ID
    SITE_ID=${SITE_ID:-default}
    
    read -p "Site Name [$SITE_ID]: " SITE_NAME
    if [[ -z "$SITE_NAME" ]]; then
        if [[ "$SITE_ID" == "default" ]]; then
            SITE_NAME="Default Site"
        else
            SITE_NAME="$SITE_ID"
        fi
    fi
    
    # Database password
    echo ""
    DB_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
    info "Generated database password: $DB_PASSWORD"
    read -p "Press Enter to accept or type custom password: " custom_db_pass
    [[ -n "$custom_db_pass" ]] && DB_PASSWORD="$custom_db_pass"
    
    # JWT Secret
    JWT_SECRET=$(openssl rand -base64 64 | tr -d "=+/" | cut -c1-64)
    info "Generated JWT secret (64 characters)"
    
    # Two-Factor Secret Key
    TWO_FACTOR_SECRET_KEY=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
    info "Generated Two-Factor secret key (32 characters)"
    
    # Admin credentials
    echo ""
    read -p "Admin email [admin@example.com]: " ADMIN_EMAIL
    ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}
    
    ADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d "=+/" | cut -c1-16)
    info "Generated admin password: $ADMIN_PASSWORD"
    read -p "Press Enter to accept or type custom password: " custom_admin_pass
    [[ -n "$custom_admin_pass" ]] && ADMIN_PASSWORD="$custom_admin_pass"
    
    # Serial device
    echo ""
    info "Serial device configuration (for mesh hardware)"
    read -p "Serial device path [/dev/ttyUSB0] (or 'skip' for UI-only): " SERIAL_DEVICE
    SERIAL_DEVICE=${SERIAL_DEVICE:-/dev/ttyUSB0}
    
    if [[ "$SERIAL_DEVICE" != "skip" ]]; then
        read -p "Serial baud rate [115200]: " SERIAL_BAUD
        SERIAL_BAUD=${SERIAL_BAUD:-115200}
    fi
    
    # fail2ban
    echo ""
    read -p "Enable fail2ban for brute-force protection? [yes]: " fail2ban_choice
    ENABLE_FAIL2BAN=${fail2ban_choice:-yes}
    
    # Backups
    echo ""
    read -p "Enable daily database backups? [yes]: " backup_choice
    ENABLE_BACKUPS=${backup_choice:-yes}
    
    if [[ "$ENABLE_BACKUPS" =~ ^[Yy][Ee][Ss]$ ]]; then
        read -p "Backup retention days [7]: " retention
        BACKUP_RETENTION_DAYS=${retention:-7}
    fi
    
    # Summary
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}Configuration Summary:${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo "Domain:              $DOMAIN"
    echo "SSL Method:          $SSL_METHOD"
    if [[ "$SSL_METHOD" == "selfsigned" && "$DOMAIN" != "localhost" ]]; then
        echo "                     (will be added to /etc/hosts)"
    fi
    echo "Site ID:             $SITE_ID"
    echo "Site Name:           $SITE_NAME"
    echo "Database:            $DB_NAME (PostgreSQL)"
    echo "DB User:             $DB_USER"
    echo "DB Password:         ${DB_PASSWORD:0:8}..."
    echo "JWT Secret:          <generated 64 chars>"
    echo "2FA Secret:          <generated 32 chars>"
    echo "Admin Email:         $ADMIN_EMAIL"
    echo "Admin Password:      ${ADMIN_PASSWORD}"
    echo "Backend Port:        $BACKEND_PORT"
    if [[ "$SERIAL_DEVICE" == "skip" ]]; then
        echo "Serial Device:       <disabled>"
    else
        echo "Serial Device:       $SERIAL_DEVICE @ ${SERIAL_BAUD} baud"
    fi
    echo "fail2ban:            $ENABLE_FAIL2BAN"
    echo "Backups:             $ENABLE_BACKUPS"
    [[ "$ENABLE_BACKUPS" =~ ^[Yy][Ee][Ss]$ ]] && echo "Retention:           $BACKUP_RETENTION_DAYS days"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    
    read -p "Proceed with deployment? (yes/no): " -r
    [[ "$REPLY" =~ ^[Yy][Ee][Ss]$ ]] || error_exit "Deployment cancelled by user"
}
#############################################################################
# System User & Directory Setup
#############################################################################

setup_system_user() {
    step "Setting up system user and directories..."
    
    if ! id "$INSTALL_USER" >/dev/null 2>&1; then
        info "Creating system user: $INSTALL_USER"
        sudo useradd --system --create-home --home-dir "$INSTALL_DIR" --shell /bin/bash "$INSTALL_USER" || \
            error_exit "Failed to create user $INSTALL_USER"
    else
        info "User $INSTALL_USER already exists"
    fi
    
    sudo usermod -aG dialout "$INSTALL_USER" 2>/dev/null || warn "Could not add user to dialout group (may already be member)"
    
    sudo mkdir -p "$INSTALL_DIR" "$SCRIPTS_DIR" "$BACKUP_DIR" "$LOG_DIR" "$NGINX_ROOT"
    sudo chown -R "$INSTALL_USER":"$INSTALL_USER" "$INSTALL_DIR"
    
    success "System user and directories configured"
}

#############################################################################
# Package Installation
#############################################################################

update_system() {
    step "Updating system package lists..."
    sudo apt-get update -qq || error_exit "Failed to update package lists"
    success "Package lists updated"
}

install_base_packages() {
    step "Installing base packages..."
    
    local packages=(
        curl
        git
        build-essential
        pkg-config
        libssl-dev
        ca-certificates
        gnupg
        lsb-release
        rsync
        wget
        openssl
    )
    
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${packages[@]}" || \
        error_exit "Failed to install base packages"
    
    success "Base packages installed"
}

install_nodejs() {
    step "Installing Node.js 20.x..."
    
    if command -v node >/dev/null 2>&1; then
        local node_version
        node_version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ $node_version -ge 20 ]]; then
            info "Node.js $(node --version) already installed"
            return
        else
            warn "Found Node.js $node_version, upgrading to 20.x..."
        fi
    fi
    
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - || \
        error_exit "Failed to add NodeSource repository"
    
    sudo apt-get install -y nodejs || error_exit "Failed to install Node.js"
    
    node --version || error_exit "Node.js installation verification failed"
    success "Node.js installed: $(node --version)"
}

install_pnpm() {
    step "Installing pnpm package manager..."
    
    if command -v pnpm >/dev/null 2>&1; then
        info "pnpm already installed: $(pnpm --version)"
        return
    fi
    
    if ! command -v corepack >/dev/null 2>&1; then
        error_exit "Corepack not found. Please ensure Node.js 20+ is installed."
    fi
    
    sudo corepack enable || error_exit "Failed to enable corepack"
    sudo corepack prepare pnpm@9.9.0 --activate || error_exit "Failed to activate pnpm"
    
    pnpm --version || error_exit "pnpm installation verification failed"
    success "pnpm installed: $(pnpm --version)"
}

install_postgresql() {
    step "Installing PostgreSQL..."
    
    if command -v psql >/dev/null 2>&1; then
        info "PostgreSQL already installed: $(psql --version)"
    else
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib postgresql-client || \
            error_exit "Failed to install PostgreSQL"
    fi
    
    sudo systemctl start postgresql || error_exit "Failed to start PostgreSQL"
    sudo systemctl enable postgresql || warn "Failed to enable PostgreSQL (may already be enabled)"
    
    sleep 2
    
    if ! sudo systemctl is-active --quiet postgresql; then
        error_exit "PostgreSQL service is not running"
    fi
    
    success "PostgreSQL installed and running"
}

install_nginx() {
    step "Installing Nginx..."
    
    if command -v nginx >/dev/null 2>&1; then
        info "Nginx already installed: $(nginx -v 2>&1 | cut -d'/' -f2)"
    else
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nginx || \
            error_exit "Failed to install Nginx"
    fi
    
    sudo systemctl stop nginx 2>/dev/null || true
    
    success "Nginx installed"
}

install_ufw() {
    step "Installing UFW firewall..."
    
    if command -v ufw >/dev/null 2>&1; then
        info "UFW already installed: $(ufw --version 2>/dev/null | head -n1 || echo 'version unknown')"
        return
    fi
    
    info "Installing UFW package..."
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ufw || \
    error_exit "Failed to install UFW package"
    
    # Verify installation
    sleep 1
    if ! command -v ufw >/dev/null 2>&1; then
        # Try to source profile/reload PATH
        export PATH="/usr/sbin:/sbin:$PATH"
        hash -r
        
        if ! command -v ufw >/dev/null 2>&1; then
            error_exit "UFW package installed but command not found in PATH. UFW may be at /usr/sbin/ufw"
        fi
    fi
    
    # Test UFW can run
    if ! sudo ufw --version >/dev/null 2>&1; then
        error_exit "UFW installed but cannot execute properly"
    fi
    
    success "UFW installed and verified: $(sudo ufw --version | head -n1)"
}

install_fail2ban() {
    if [[ ! "$ENABLE_FAIL2BAN" =~ ^[Yy][Ee][Ss]$ ]]; then
        info "Skipping fail2ban installation (user choice)"
        return
    fi
    
    step "Installing fail2ban..."
    
    if command -v fail2ban-client >/dev/null 2>&1; then
        info "fail2ban already installed"
    else
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban || \
            error_exit "Failed to install fail2ban"
    fi
    
    sudo systemctl enable fail2ban || warn "Failed to enable fail2ban"
    
    success "fail2ban installed"
}

install_certbot() {
    if [[ "$SSL_METHOD" != "letsencrypt" ]]; then
        return
    fi
    
    step "Installing certbot for Let's Encrypt..."
    
    if command -v certbot >/dev/null 2>&1; then
        info "certbot already installed"
    else
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-nginx || \
            error_exit "Failed to install certbot"
    fi
    
    success "certbot installed"
}

#############################################################################
# PostgreSQL Configuration
#############################################################################

configure_postgresql() {
    step "Configuring PostgreSQL database..."
    
    # Check if database exists
    if sudo -u postgres psql -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
        info "Database $DB_NAME already exists"
    else
        info "Creating database: $DB_NAME"
        sudo -u postgres createdb "$DB_NAME" || error_exit "Failed to create database"
    fi
    
    # Check if user exists
    if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
        info "User $DB_USER already exists, updating password"
        sudo -u postgres psql -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASSWORD';" || \
            error_exit "Failed to update user password"
    else
        info "Creating database user: $DB_USER"
        sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';" || \
            error_exit "Failed to create database user"
    fi
    
    # Grant privileges
    sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" || \
        error_exit "Failed to grant database privileges"
    
    sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO $DB_USER;" || \
        warn "Failed to grant schema privileges (may not be critical)"
    
    # Configure pg_hba.conf for localhost-only access
    local pg_hba_conf
    pg_hba_conf=$(sudo -u postgres psql -t -P format=unaligned -c 'SHOW hba_file')
    
    if ! sudo grep -q "^host.*$DB_NAME.*$DB_USER.*127.0.0.1" "$pg_hba_conf"; then
        info "Adding localhost entry to pg_hba.conf"
        echo "host    $DB_NAME    $DB_USER    127.0.0.1/32    scram-sha-256" | \
            sudo tee -a "$pg_hba_conf" > /dev/null
        sudo systemctl reload postgresql || error_exit "Failed to reload PostgreSQL"
    fi
    
    # Configure postgresql.conf to listen only on localhost
    local pg_conf
    pg_conf=$(sudo -u postgres psql -t -P format=unaligned -c 'SHOW config_file')
    
    if sudo grep -q "^listen_addresses" "$pg_conf"; then
        sudo sed -i "s/^listen_addresses.*/listen_addresses = 'localhost'/" "$pg_conf"
    else
        echo "listen_addresses = 'localhost'" | sudo tee -a "$pg_conf" > /dev/null
    fi
    
    sudo systemctl restart postgresql || error_exit "Failed to restart PostgreSQL"
    
    # Wait for PostgreSQL to be ready
    sleep 5
    
    # Verify connectivity with retry
    local db_attempts=10
    local db_attempt=0
    while (( db_attempt < db_attempts )); do
        if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" > /dev/null 2>&1; then
            break
        fi
        db_attempt=$((db_attempt + 1))
        sleep 2
    done
    
    if ! PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" > /dev/null 2>&1; then
        error_exit "Failed to connect to database after retries. Check credentials and pg_hba.conf"
    fi
    
    success "PostgreSQL configured successfully"
}

#############################################################################
# Repository & Application Setup
#############################################################################

clone_repository() {
    step "Cloning AntiHunter Command Center repository..."
    
    if [[ -d "$REPO_DIR/.git" ]]; then
        info "Repository already exists, pulling latest changes..."
        cd "$REPO_DIR"
        sudo -u "$INSTALL_USER" git pull origin main || warn "Failed to pull latest changes"
    else
        info "Cloning repository from $REPO_URL"
        sudo -u "$INSTALL_USER" git clone "$REPO_URL" "$REPO_DIR" || \
            error_exit "Failed to clone repository"
    fi
    
    success "Repository ready at $REPO_DIR"
}

install_workspace_dependencies() {
    step "Installing workspace dependencies (this may take several minutes)..."
    
    cd "$REPO_DIR"
    
    sudo -u "$INSTALL_USER" pnpm install || \
        error_exit "Failed to install workspace dependencies"
    
    success "Workspace dependencies installed"
}

create_backend_env() {
    step "Creating backend environment configuration..."
    
    local env_file="$BACKEND_DIR/.env"
    local database_url="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
    
    sudo -u "$INSTALL_USER" tee "$env_file" > /dev/null <<EOF
# AntiHunter Command Center - Backend Configuration
# Generated by deployment script on $(date)

NODE_ENV=$NODE_ENV
PORT=$BACKEND_PORT
DATABASE_URL=$database_url

# Security
JWT_SECRET=$JWT_SECRET
TWO_FACTOR_SECRET_KEY=$TWO_FACTOR_SECRET_KEY
TWO_FACTOR_ISSUER=AntiHunter Command Center

# Site Configuration
SITE_ID=$SITE_ID
SITE_NAME=$SITE_NAME

# API Configuration
HTTP_PREFIX=$HTTP_PREFIX
LOG_LEVEL=$LOG_LEVEL

# Serial Configuration
EOF
    
    if [[ "$SERIAL_DEVICE" != "skip" ]]; then
        sudo -u "$INSTALL_USER" tee -a "$env_file" > /dev/null <<EOF
SERIAL_DEVICE=$SERIAL_DEVICE
SERIAL_BAUD=$SERIAL_BAUD
EOF
    fi
    
    sudo -u "$INSTALL_USER" tee -a "$env_file" > /dev/null <<EOF

# Safety Protections
ALLOW_FOREVER=false
ALLOW_ERASE_FORCE=false

# HTTPS Configuration (optional - configure after deployment if needed)
HTTPS_ENABLED=false
# HTTPS_KEY_PATH=/etc/ssl/private/ahcc-selfsigned.key
# HTTPS_CERT_PATH=/etc/ssl/certs/ahcc-selfsigned.crt

# Mail Configuration (optional - configure in UI)
MAIL_ENABLED=false

# MQTT Configuration (optional - configure in UI)
MQTT_ENABLED=false

# TAK Bridge (optional - configure in UI)
TAK_ENABLED=false
EOF
    
    chmod 640 "$env_file"
    
    success "Backend environment configured at $env_file"
}

get_server_ip() {
    local server_ip=""
    
    # Try multiple methods to get the server's IP
    if command -v hostname >/dev/null 2>&1; then
        server_ip=$(hostname -I 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
    fi
    
    if [[ -z "$server_ip" ]] && command -v ip >/dev/null 2>&1; then
        server_ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
    fi
    
    if [[ -z "$server_ip" ]]; then
        server_ip=$(ip addr show | grep -E 'inet [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | grep -v '127.0.0.1' | head -n1 | awk '{print $2}' | cut -d'/' -f1)
    fi
    
    if [[ -z "$server_ip" ]]; then
        server_ip="localhost"
    fi
    
    echo "$server_ip"
}

generate_prisma_client() {
    step "Generating Prisma client..."
    
    cd "$BACKEND_DIR"
    
    sudo -u "$INSTALL_USER" pnpm prisma:generate || \
        error_exit "Failed to generate Prisma client"
    
    success "Prisma client generated"
}

run_database_migrations() {
    step "Running database migrations..."
    
    cd "$BACKEND_DIR"
    
    sudo -u "$INSTALL_USER" pnpm prisma migrate deploy || \
        error_exit "Database migrations failed. Check DATABASE_URL and PostgreSQL logs."
    
    success "Database migrations completed"
}

seed_database() {
    step "Seeding database with initial data..."
    
    cd "$BACKEND_DIR"
    
    # Temporarily disable ALL firewall rules to prevent seeding issues
    info "Temporarily disabling all firewall rules for seeding..."
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" << 'EOF' || warn "Could not disable firewall rules (table may not exist yet)"
DELETE FROM "FirewallRule" WHERE 1=1;
EOF
    
    # Clean up existing admin user completely
    info "Cleaning up existing admin user for fresh seed..."
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" << EOF || warn "Could not clean existing data (tables may not exist yet)"
-- Delete in correct order to avoid foreign key constraints
DELETE FROM "UserPreference" WHERE "userId" IN (SELECT id FROM "User" WHERE email = '$ADMIN_EMAIL');
DELETE FROM "UserPermission" WHERE "userId" IN (SELECT id FROM "User" WHERE email = '$ADMIN_EMAIL');
DELETE FROM "UserSiteAccess" WHERE "userId" IN (SELECT id FROM "User" WHERE email = '$ADMIN_EMAIL');
DELETE FROM "PasswordResetToken" WHERE "userId" IN (SELECT id FROM "User" WHERE email = '$ADMIN_EMAIL');
DELETE FROM "AuditLog" WHERE "userId" IN (SELECT id FROM "User" WHERE email = '$ADMIN_EMAIL');
DELETE FROM "CommandLog" WHERE "userId" IN (SELECT id FROM "User" WHERE email = '$ADMIN_EMAIL');
DELETE FROM "User" WHERE email = '$ADMIN_EMAIL';
EOF
    
    # Export environment variables for seed script
    export ADMIN_EMAIL="$ADMIN_EMAIL"
    export ADMIN_PASSWORD="$ADMIN_PASSWORD"
    export SITE_ID="$SITE_ID"
    export SITE_NAME="$SITE_NAME"
    
    # Run the seed script with better error handling
    if ! sudo -u "$INSTALL_USER" -E pnpm prisma db seed; then
        error "Database seeding failed. Attempting to diagnose..."
        
        # Check if user was created
        local user_exists
        user_exists=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM \"User\" WHERE email = '$ADMIN_EMAIL';" 2>/dev/null || echo "0")
        
        if [[ "$user_exists" -eq 0 ]]; then
            error_exit "Seeding failed and no admin user was created"
        else
            warn "Seeding reported failure but admin user exists, continuing..."
        fi
    fi
    
    # Verify the admin user was created properly
    local user_count
    user_count=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM \"User\" WHERE email = '$ADMIN_EMAIL' AND \"passwordHash\" IS NOT NULL;" 2>/dev/null || echo "0")
    
    if [[ "$user_count" -eq 1 ]]; then
        success "Database seeded with admin user: $ADMIN_EMAIL"
    else
        # Try to get more info about what went wrong
        local user_info
        user_info=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT id, email, \"passwordHash\" IS NOT NULL as has_password FROM \"User\" WHERE email = '$ADMIN_EMAIL';" 2>/dev/null || echo "No user found")
        error "Admin user verification failed. User info: $user_info"
        error_exit "Database seeding verification failed"
    fi
    
    # Set up minimal firewall rules (but keep them permissive for initial setup)
    info "Setting up minimal firewall rules..."
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" << 'EOF' || warn "Could not set up initial firewall rules"
-- Only block clearly malicious IPs, keep everything else open for initial setup
INSERT INTO "FirewallRule" (id, ip, type, reason, "createdBy", "createdAt", "updatedAt") VALUES
    (gen_random_uuid(), '0.0.0.0/0', 'ALLOW', 'Initial setup - allow all', 'system', NOW(), NOW())
ON CONFLICT DO NOTHING;
EOF
}

build_backend() {
    step "Building backend application..."
    
    cd "$BACKEND_DIR"
    
    sudo -u "$INSTALL_USER" pnpm build || \
        error_exit "Backend build failed"
    
    if [[ ! -f "$BACKEND_DIR/dist/main.js" ]]; then
        error_exit "Backend build artifact missing: $BACKEND_DIR/dist/main.js"
    fi
    
    success "Backend built successfully"
}

ensure_frontend_dependencies() {
    step "Ensuring frontend dependencies are installed..."
    
    cd "$FRONTEND_DIR"
    
    # Check if node_modules exists and has content
    if [[ ! -d "node_modules" ]] || [[ -z "$(ls -A node_modules 2>/dev/null)" ]]; then
        info "Installing frontend dependencies..."
        sudo -u "$INSTALL_USER" pnpm install || \
        error_exit "Failed to install frontend dependencies"
    fi
    
    success "Frontend dependencies ready"
}

build_frontend() {
    step "Building frontend application..."
    
    cd "$FRONTEND_DIR"
    
    # Ensure dependencies are installed
    ensure_frontend_dependencies
    
    # Clean any previous builds
    sudo -u "$INSTALL_USER" rm -rf dist/ 2>/dev/null || true
    
    # Build with explicit environment
    sudo -u "$INSTALL_USER" NODE_ENV=production pnpm build || \
    error_exit "Frontend build failed"
    
    # Verify build output
    if [[ ! -d "$FRONTEND_DIR/dist" ]]; then
        error_exit "Frontend build directory missing: $FRONTEND_DIR/dist"
    fi
    
    # Check for essential files
    if [[ ! -f "$FRONTEND_DIR/dist/index.html" ]]; then
        error_exit "Frontend build incomplete: missing index.html"
    fi
    
    step "Deploying frontend to Nginx root..."
    
    # Ensure nginx root exists
    sudo mkdir -p "$NGINX_ROOT"
    
    # Copy with verification
    sudo rsync -av --delete "$FRONTEND_DIR/dist/" "$NGINX_ROOT/" || \
    error_exit "Failed to deploy frontend files"
    
    # Set proper permissions
    sudo chown -R www-data:www-data "$NGINX_ROOT"
    sudo chmod -R 755 "$NGINX_ROOT"
    
    # Verify deployment
    if [[ ! -f "$NGINX_ROOT/index.html" ]]; then
        error_exit "Frontend deployment verification failed: missing index.html in nginx root"
    fi
    
    success "Frontend built and deployed to $NGINX_ROOT"
}

#############################################################################
# SSL Certificate Generation
#############################################################################

generate_selfsigned_certificate() {
    if [[ "$SSL_METHOD" != "selfsigned" ]]; then
        return
    fi
    
    step "Generating self-signed SSL certificate..."
    
    local cert_path="$SSL_CERT_DIR/$SSL_CERT_FILE"
    local key_path="$SSL_KEY_DIR/$SSL_KEY_FILE"
    
    if sudo test -f "$cert_path" && sudo test -f "$key_path"; then
        info "SSL certificate already exists at $cert_path"
        if sudo test -r "$cert_path" && sudo test -r "$key_path"; then
            return
        else
            warn "Existing SSL files have permission issues, regenerating..."
        fi
    fi
    
    # Ensure directories exist
    sudo mkdir -p "$SSL_CERT_DIR" "$SSL_KEY_DIR"
    
    # Ensure ssl-cert group exists first
    if ! getent group ssl-cert >/dev/null 2>&1; then
        sudo groupadd ssl-cert
    fi
    
    # Add www-data to ssl-cert group so nginx can read the key
    sudo usermod -a -G ssl-cert www-data
    
    # Generate certificate with explicit error checking
    if ! sudo openssl req -x509 -nodes -days 365 -newkey rsa:4096 \
        -keyout "$key_path" \
        -out "$cert_path" \
        -subj "/C=US/ST=State/L=City/O=AntiHunter/CN=$DOMAIN" \
        -addext "subjectAltName=DNS:$DOMAIN,DNS:www.$DOMAIN,IP:127.0.0.1" 2>/dev/null; then
            error_exit "Failed to generate self-signed certificate"
        fi
    
    # Set proper permissions
    sudo chmod 644 "$cert_path"
    sudo chmod 640 "$key_path"
    sudo chown root:ssl-cert "$key_path"
    sudo chown root:root "$cert_path"
    
    # Verify files exist and are readable by the system (using sudo for checks)
    if ! sudo test -f "$cert_path" || ! sudo test -f "$key_path"; then
        error "Checking what files were created:"
        sudo ls -la "$SSL_CERT_DIR/"ahcc* 2>/dev/null || echo "No cert files found"
        sudo ls -la "$SSL_KEY_DIR/"ahcc* 2>/dev/null || echo "No key files found"
        error_exit "SSL certificate files were not created properly"
    fi
    
    # Test readability with sudo (how nginx will access them)
    if ! sudo test -r "$cert_path"; then
        error_exit "SSL certificate is not readable: $cert_path"
    fi
    
    if ! sudo test -r "$key_path"; then
        error_exit "SSL private key is not readable: $key_path"
    fi
    
    success "Self-signed SSL certificate generated and verified"
    warn "Self-signed certificate is NOT trusted by browsers. For production, use Let's Encrypt."
}

obtain_letsencrypt_certificate() {
    if [[ "$SSL_METHOD" != "letsencrypt" ]]; then
        return
    fi
    
    step "Obtaining Let's Encrypt certificate..."
    
    # Temporarily start nginx with basic config for certbot webroot verification
    sudo systemctl start nginx || warn "Nginx already running"
    
    sudo certbot certonly --nginx \
    --non-interactive \
    --agree-tos \
    --email "$LE_EMAIL" \
    -d "$DOMAIN" || \
    error_exit "Failed to obtain Let's Encrypt certificate. Verify DNS points to this server."
    
    # Update paths to use Let's Encrypt certificates
    SSL_CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
    SSL_CERT_FILE="fullchain.pem"
    SSL_KEY_FILE="privkey.pem"
    
    success "Let's Encrypt certificate obtained"
}

setup_local_domain() {
    if [[ "$SSL_METHOD" != "selfsigned" ]] || [[ "$DOMAIN" == "localhost" ]]; then
        return
    fi
    
    step "Setting up local domain resolution..."
    
    # Check if domain already exists in /etc/hosts
    if ! grep -q "127.0.0.1.*$DOMAIN" /etc/hosts; then
        info "Adding $DOMAIN to /etc/hosts for local resolution"
        echo "127.0.0.1 $DOMAIN" | sudo tee -a /etc/hosts
    else
        info "$DOMAIN already configured in /etc/hosts"
    fi
    
    success "Domain $DOMAIN configured for local access"
}

#############################################################################
# SystemD Service Configuration
#############################################################################

create_systemd_service() {
    step "Creating systemd service for backend..."
    
    local service_file="/etc/systemd/system/${BACKEND_SERVICE}.service"
    local node_path
    node_path="$(command -v node)" || error_exit "Node executable not found"
    
    # Verify node can execute
    if ! "$node_path" --version >/dev/null 2>&1; then
        error_exit "Node executable found but cannot run: $node_path"
    fi
    
    # Ensure the service user can access node
    if ! sudo -u "$INSTALL_USER" "$node_path" --version >/dev/null 2>&1; then
        error_exit "Service user $INSTALL_USER cannot execute node at $node_path"
    fi
    
    sudo tee "$service_file" > /dev/null <<EOF
[Unit]
Description=AntiHunter Command Center Backend
Documentation=https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=$INSTALL_USER
Group=$INSTALL_USER
WorkingDirectory=$BACKEND_DIR
EnvironmentFile=$BACKEND_DIR/.env
ExecStart=$node_path dist/main.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$BACKEND_DIR $LOG_DIR $BACKUP_DIR
MemoryMax=2G
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
    
    sudo systemctl daemon-reload || error_exit "Failed to reload systemd"
    sudo systemctl enable "$BACKEND_SERVICE" || error_exit "Failed to enable service"
    
    success "Systemd service created: $BACKEND_SERVICE"
}

start_backend_service() {
    step "Starting backend service..."
    
    # Stop any existing service
    sudo systemctl stop "$BACKEND_SERVICE" 2>/dev/null || true
    sleep 3
    
    # Verify database is accessible before starting
    info "Verifying database connectivity..."
    local db_test_attempts=5
    local db_test_attempt=0
    while (( db_test_attempt < db_test_attempts )); do
        if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
            break
        fi
        db_test_attempt=$((db_test_attempt + 1))
        sleep 2
    done
    
    if ! PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
        error_exit "Cannot connect to database before starting backend service"
    fi
    
    # Start the service
    sudo systemctl start "$BACKEND_SERVICE" || {
        error "Failed to start backend service. Recent logs:"
        sudo journalctl -u "$BACKEND_SERVICE" -n 20 --no-pager
        error_exit "Backend service failed to start"
    }
    
    # Wait for service to be active with better error handling
    local service_attempts=20
    local service_attempt=0
    while (( service_attempt < service_attempts )); do
        if sudo systemctl is-active --quiet "$BACKEND_SERVICE"; then
            break
        fi
        service_attempt=$((service_attempt + 1))
        if (( service_attempt % 5 == 0 )); then
            info "Still waiting for service to start... (attempt $service_attempt/$service_attempts)"
        fi
        sleep 2
    done
    
    if ! sudo systemctl is-active --quiet "$BACKEND_SERVICE"; then
        error "Backend service failed to start within timeout. Recent logs:"
        sudo journalctl -u "$BACKEND_SERVICE" -n 30 --no-pager
        error_exit "Backend service is not running"
    fi
    
    # Verify health endpoint with better timeout
    info "Waiting for backend to be ready..."
    local max_attempts=30
    local attempt=0
    while (( attempt < max_attempts )); do
        if curl -sf --connect-timeout 5 --max-time 10 "http://localhost:$BACKEND_PORT/healthz" >/dev/null 2>&1; then
            success "Backend service started and health check passed"
            return
        fi
        attempt=$((attempt + 1))
        if (( attempt % 5 == 0 )); then
            info "Still waiting for health check... (attempt $attempt/$max_attempts)"
        fi
        sleep 3
    done
    
    warn "Backend started but health check failed after $max_attempts attempts."
    warn "This may be normal if the backend is still initializing. Check logs:"
    sudo journalctl -u "$BACKEND_SERVICE" -n 20 --no-pager
}

#############################################################################
# Nginx Configuration
#############################################################################

configure_nginx() {
    step "Configuring Nginx reverse proxy..."
    
    local nginx_site="/etc/nginx/sites-available/ahcc"
    local nginx_enabled="/etc/nginx/sites-enabled/ahcc"
    local cert_path="$SSL_CERT_DIR/$SSL_CERT_FILE"
    local key_path="$SSL_KEY_DIR/$SSL_KEY_FILE"
    
    # Verify SSL certificates exist
    if ! sudo test -f "$cert_path"; then
        error_exit "SSL certificate not found at: $cert_path"
    fi
    
    if ! sudo test -f "$key_path"; then
        error_exit "SSL private key not found at: $key_path"
    fi
    
    # Verify frontend files are deployed
    if [[ ! -f "$NGINX_ROOT/index.html" ]]; then
        error_exit "Frontend files not found in nginx root: $NGINX_ROOT"
    fi
    
    # Verify backend is responding
    if ! curl -sf --connect-timeout 5 --max-time 10 "http://localhost:$BACKEND_PORT/healthz" >/dev/null 2>&1; then
        warn "Backend not responding on localhost:$BACKEND_PORT - nginx may show 502 errors"
    fi
    
    # Create nginx configuration
    sudo tee "$nginx_site" > /dev/null <<EOF
# Rate limiting zones
limit_req_zone \$binary_remote_addr zone=api_limit:10m rate=10r/s;
limit_req_zone \$binary_remote_addr zone=general_limit:10m rate=30r/s;
limit_conn_zone \$binary_remote_addr zone=conn_limit:10m;

# Upload size limit
client_max_body_size 50M;

# HTTPS Server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    # SSL Configuration
    ssl_certificate     $cert_path;
    ssl_certificate_key $key_path;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_session_tickets off;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Logging
    access_log /var/log/nginx/ahcc_access.log;
    error_log  /var/log/nginx/ahcc_error.log warn;

    # Connection limits
    limit_conn conn_limit 10;

    # Frontend static files
    root  $NGINX_ROOT;
    index index.html;

    # API proxy with rate limiting
    location /api/ {
        limit_req zone=api_limit burst=20 nodelay;
        
        proxy_pass http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # Buffer settings
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;
        proxy_busy_buffers_size 8k;
    }

    # WebSocket proxy for Socket.IO
    location /socket.io/ {
        limit_req zone=general_limit burst=50 nodelay;

        proxy_pass http://127.0.0.1:$BACKEND_PORT/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }

    # WebSocket proxy for /ws namespace
    location /ws {
        limit_req zone=general_limit burst=50 nodelay;

        proxy_pass http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }

    # Health check endpoints
    location ~ ^/(healthz|readyz|metrics) {
        proxy_pass http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        access_log off;
    }

    # Media files
    location /media/ {
        proxy_pass http://127.0.0.1:$BACKEND_PORT/media/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
    }

    # Frontend SPA fallback
    location / {
        limit_req zone=general_limit burst=100 nodelay;
        try_files \$uri \$uri/ /index.html;
    }

    # Security: Block access to hidden files
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }
}

# HTTP to HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    
    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF
    
    # Remove default site
    sudo rm -f /etc/nginx/sites-enabled/default
    
    # Enable AHCC site
    sudo ln -sf "$nginx_site" "$nginx_enabled"
    
    # Test configuration
    if ! sudo nginx -t; then
        error "Nginx configuration test failed"
        error_exit "Fix nginx configuration errors"
    fi
    
    # Stop nginx, then start it fresh
    sudo systemctl stop nginx 2>/dev/null || true
    sleep 2
    
    if ! sudo systemctl start nginx; then
        error "Failed to start nginx. Checking logs:"
        sudo journalctl -u nginx -n 20 --no-pager
        error_exit "Nginx failed to start"
    fi
    
    # Wait for nginx to be ready
    sleep 3
    if ! sudo systemctl is-active --quiet nginx; then
        error_exit "Nginx is not running after start"
    fi
    
    success "Nginx configured and running"
}

#############################################################################
# Firewall Configuration
#############################################################################

configure_firewall() {
    step "Configuring UFW firewall..."
    
    # Ensure UFW is available
    if ! command -v ufw >/dev/null 2>&1; then
        export PATH="/usr/sbin:/sbin:$PATH"
        hash -r
        if ! command -v ufw >/dev/null 2>&1; then
            error_exit "UFW command not found. Installation may have failed."
        fi
    fi
    
    # Disable UFW first to prevent lockout
    sudo ufw --force disable
    
    # Set default policies
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    
    # Allow SSH (preserve current connection)
    sudo ufw allow 22/tcp comment 'SSH'
    
    # Allow HTTP and HTTPS
    sudo ufw allow 80/tcp comment 'HTTP'
    sudo ufw allow 443/tcp comment 'HTTPS'
    
    # Enable UFW
    echo "y" | sudo ufw enable
    
    # Block PostgreSQL from external access using UFW instead of raw iptables
    info "Blocking PostgreSQL port from external access..."
    sudo ufw deny 5432/tcp comment 'Block PostgreSQL external access'
    
    success "Firewall configured"
    sudo ufw status
}
#############################################################################
# fail2ban Configuration
#############################################################################

configure_fail2ban() {
    if [[ ! "$ENABLE_FAIL2BAN" =~ ^[Yy][Ee][Ss]$ ]]; then
        return
    fi
    
    step "Configuring fail2ban..."
    
    # Create filter
    sudo tee /etc/fail2ban/filter.d/ahcc-auth.conf > /dev/null <<'EOF'
[Definition]
failregex = ^.*"message":"Authentication failed.*"ip":"<HOST>".*$
            ^.*"message":"Invalid credentials.*"ip":"<HOST>".*$
            ^.*Unauthorized.*from <HOST>.*$
            ^<HOST>.*"POST /api/auth/login HTTP.*" 401
ignoreregex =
EOF
    
    # Create jail with higher retry limit for initial setup
    sudo tee /etc/fail2ban/jail.d/ahcc.conf > /dev/null <<EOF
[ahcc-auth]
enabled = true
port = http,https
filter = ahcc-auth
logpath = /var/log/nginx/ahcc_access.log
maxretry = 10
findtime = 600
bantime = 3600
action = iptables-multiport[name=ahcc, port="http,https", protocol=tcp]
EOF
    
    sudo systemctl restart fail2ban || error_exit "Failed to restart fail2ban"
    sleep 2
    
    # Unban localhost just in case
    sudo fail2ban-client set ahcc-auth unbanip 127.0.0.1 2>/dev/null || true
    
    if sudo systemctl is-active --quiet fail2ban; then
        success "fail2ban configured and running"
    else
        warn "fail2ban may not be running properly"
    fi
}
#############################################################################
# Backup Script Configuration
#############################################################################

create_backup_script() {
    if [[ ! "$ENABLE_BACKUPS" =~ ^[Yy][Ee][Ss]$ ]]; then
        return
    fi
    
    step "Creating database backup script..."
    
    local backup_script="$SCRIPTS_DIR/backup-db.sh"
    
    sudo -u "$INSTALL_USER" tee "$backup_script" > /dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="$BACKUP_DIR"
RETENTION_DAYS="$BACKUP_RETENTION_DAYS"
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
LOG_PREFIX="[backup \$TIMESTAMP]"

# Ensure backup directory exists
mkdir -p "\$BACKUP_DIR"

echo "\$LOG_PREFIX Starting database backup"

# Test database connectivity first
if ! pg_dump --version >/dev/null 2>&1; then
    echo "\$LOG_PREFIX ERROR: pg_dump not found in PATH"
    exit 1
fi

# Create backup with error handling
if pg_dump "\$DATABASE_URL" 2>/dev/null | gzip > "\$BACKUP_DIR/ahcc_\$TIMESTAMP.sql.gz"; then
    if [[ -f "\$BACKUP_DIR/ahcc_\$TIMESTAMP.sql.gz" ]] && [[ -s "\$BACKUP_DIR/ahcc_\$TIMESTAMP.sql.gz" ]]; then
        echo "\$LOG_PREFIX Backup created: ahcc_\$TIMESTAMP.sql.gz"
    else
        echo "\$LOG_PREFIX ERROR: Backup file is empty or missing!"
        rm -f "\$BACKUP_DIR/ahcc_\$TIMESTAMP.sql.gz"
        exit 1
    fi
else
    echo "\$LOG_PREFIX ERROR: pg_dump failed!"
    rm -f "\$BACKUP_DIR/ahcc_\$TIMESTAMP.sql.gz"
    exit 1
fi

# Cleanup old backups
echo "\$LOG_PREFIX Cleaning up backups older than \$RETENTION_DAYS days"
find "\$BACKUP_DIR" -name "ahcc_*.sql.gz" -mtime +\$RETENTION_DAYS -delete 2>/dev/null || true

echo "\$LOG_PREFIX Backup complete"
EOF
    
    sudo chmod +x "$backup_script"
    sudo chown "$INSTALL_USER":"$INSTALL_USER" "$backup_script"
    
    # Add cron job - handle case where no crontab exists
    local cron_entry="0 2 * * * $backup_script >> $LOG_DIR/backup.log 2>&1"
    
    info "Adding cron job for daily backups..."
    # Get existing crontab or create empty one if none exists
    if sudo -u "$INSTALL_USER" crontab -l >/dev/null 2>&1; then
        # Crontab exists, add our entry
        (sudo -u "$INSTALL_USER" crontab -l 2>/dev/null | grep -v "$backup_script" || true; echo "$cron_entry") | sudo -u "$INSTALL_USER" crontab -
    else
        # No crontab exists, create new one
        echo "$cron_entry" | sudo -u "$INSTALL_USER" crontab -
    fi
    
    success "Backup script created and scheduled (daily at 2:00 AM)"
}

#############################################################################
# Post-Deployment Verification
#############################################################################

verify_deployment() {
    step "Verifying deployment..."
    
    local all_passed=true
    
    # Check backend service
    if sudo systemctl is-active --quiet "$BACKEND_SERVICE"; then
        success "Backend service is running"
    else
        error "Backend service is NOT running"
        all_passed=false
    fi
    
    # Check nginx
    if sudo systemctl is-active --quiet nginx; then
        success "Nginx is running"
    else
        error "Nginx is NOT running"
        all_passed=false
    fi
    
    # Check PostgreSQL
    if sudo systemctl is-active --quiet postgresql; then
        success "PostgreSQL is running"
    else
        error "PostgreSQL is NOT running"
        all_passed=false
    fi
    
    # Check health endpoint
    if curl -sf "http://localhost:$BACKEND_PORT/healthz" >/dev/null 2>&1; then
        success "Backend health check passed"
    else
        warn "Backend health check failed (may still be starting)"
    fi
    
    info "Continuing with authentication test..."
    
    # Test authentication (with firewall temporarily disabled)
    info "Temporarily disabling firewall rules for auth test..."
    if ! timeout 10 bash -c "PGPASSWORD=\"$DB_PASSWORD\" psql -h \"$DB_HOST\" -p \"$DB_PORT\" -U \"$DB_USER\" -d \"$DB_NAME\" -c \"UPDATE \\\"FirewallRule\\\" SET enabled = false;\" >/dev/null 2>&1"; then
        warn "Could not disable firewall rules for auth test"
    fi
    
    info "Testing authentication..."
    local auth_response
    auth_response=$(timeout 15 curl -sf --connect-timeout 5 --max-time 10 "http://localhost:$BACKEND_PORT/api/auth/login" \
-X POST -H "Content-Type: application/json" \
-d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null || echo "AUTH_FAILED")
    
    if [[ "$auth_response" == "AUTH_FAILED" ]]; then
        warn "Authentication test failed (connection issue)"
    elif [[ "$auth_response" == *'"token"'* ]]; then
        success "Authentication test passed"
        # Re-enable reasonable firewall rules
        info "Re-enabling firewall rules..."
        if ! timeout 10 bash -c "PGPASSWORD=\"$DB_PASSWORD\" psql -h \"$DB_HOST\" -p \"$DB_PORT\" -U \"$DB_USER\" -d \"$DB_NAME\" -c \"UPDATE \\\"FirewallRule\\\" SET enabled = true WHERE action != 'BLOCK' OR (action = 'BLOCK' AND name NOT LIKE '%admin%');\" >/dev/null 2>&1"; then
            warn "Could not re-enable firewall rules"
        fi
    elif [[ -n "$auth_response" ]]; then
        # For debugging - let's see why it's not matching
        if echo "$auth_response" | grep -q '"token"'; then
            success "Authentication test passed (fallback check)"
        else
            warn "Authentication response received but no token found"
            warn "First 200 chars: ${auth_response:0:200}..."
        fi
    else
        warn "Authentication test failed: empty response"
    fi
    
    # Check HTTPS
    info "Testing HTTPS endpoint..."
    if timeout 10 curl -sfk --connect-timeout 5 --max-time 8 "https://localhost/" >/dev/null 2>&1; then
        success "HTTPS endpoint responding"
    else
        warn "HTTPS endpoint not responding (may need DNS/certificate adjustment)"
    fi
    
    # Check fail2ban
    if [[ "$ENABLE_FAIL2BAN" =~ ^[Yy][Ee][Ss]$ ]]; then
        if sudo systemctl is-active --quiet fail2ban; then
            success "fail2ban is running"
        else
            warn "fail2ban is NOT running"
        fi
    fi
    
    # Check UFW
    local ufw_path=""
    if command -v ufw >/dev/null 2>&1; then
        ufw_path="ufw"
    elif [[ -x /usr/sbin/ufw ]]; then
        ufw_path="/usr/sbin/ufw"
    fi
    
    if [[ -n "$ufw_path" ]] && sudo "$ufw_path" status | grep -q "Status: active"; then
        success "UFW firewall is active"
    else
        warn "UFW firewall is NOT active"
    fi
    
    if [[ "$all_passed" == true ]]; then
        success "All critical checks passed!"
    else
        warn "Some checks failed. Review errors above."
    fi
}

#############################################################################
# Deployment Summary
#############################################################################

print_deployment_summary() {
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Deployment Complete!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    local display_url="https://$DOMAIN"
    if [[ "$DOMAIN" == "localhost" ]]; then
        local server_ip
        server_ip=$(get_server_ip)
        if [[ "$server_ip" != "localhost" ]]; then
            display_url="https://$server_ip"
            echo -e "${CYAN}Access Information:${NC}"
            echo "  URL:              $display_url"
            echo "  Local URL:        https://localhost"
        else
            echo -e "${CYAN}Access Information:${NC}"
            echo "  URL:              $display_url"
        fi
    else
        echo -e "${CYAN}Access Information:${NC}"
        echo "  URL:              $display_url"
    fi
    echo "  Admin Email:      $ADMIN_EMAIL"
    echo "  Admin Password:   $ADMIN_PASSWORD"
    echo ""
    echo -e "${CYAN}Service Status:${NC}"
    echo "  Backend:          sudo systemctl status $BACKEND_SERVICE"
    echo "  Nginx:            sudo systemctl status nginx"
    echo "  PostgreSQL:       sudo systemctl status postgresql"
    [[ "$ENABLE_FAIL2BAN" =~ ^[Yy][Ee][Ss]$ ]] && echo "  fail2ban:         sudo systemctl status fail2ban"
    echo ""
    echo -e "${CYAN}Logs:${NC}"
    echo "  Backend:          sudo journalctl -u $BACKEND_SERVICE -f"
    echo "  Nginx Access:     sudo tail -f /var/log/nginx/ahcc_access.log"
    echo "  Nginx Error:      sudo tail -f /var/log/nginx/ahcc_error.log"
    [[ "$ENABLE_BACKUPS" =~ ^[Yy][Ee][Ss]$ ]] && echo "  Backup:           tail -f $LOG_DIR/backup.log"
    echo ""
    echo -e "${CYAN}Common Commands:${NC}"
    echo "  Restart backend:  sudo systemctl restart $BACKEND_SERVICE"
    echo "  Reload Nginx:     sudo systemctl reload nginx"
    echo "  View firewall:    sudo ufw status verbose"
    [[ "$ENABLE_BACKUPS" =~ ^[Yy][Ee][Ss]$ ]] && echo "  Manual backup:    sudo -u $INSTALL_USER $SCRIPTS_DIR/backup-db.sh"
    echo ""
    echo -e "${CYAN}Security Notes:${NC}"
    if [[ "$SSL_METHOD" == "selfsigned" ]]; then
        echo "  ⚠ Self-signed certificate in use (browsers will show warnings)"
        echo "    For production, obtain a Let's Encrypt certificate:"
        echo "    sudo certbot --nginx -d $DOMAIN"
    fi
    echo "  ✓ Change admin password immediately after first login"
    echo "  ✓ Review Config -> Firewall settings in the UI"
    echo "  ✓ Configure 2FA for admin account (Account -> Two-Factor Auth)"
    if [[ "$SERIAL_DEVICE" == "skip" ]]; then
        echo "  ⚠ Serial device not configured (UI-only mode)"
        echo "    Configure in: Config -> Serial"
    fi
    echo ""
    echo -e "${CYAN}Database:${NC}"
    echo "  Name:             $DB_NAME"
    echo "  User:             $DB_USER"
    echo "  Connection:       localhost:$DB_PORT"
    [[ "$ENABLE_BACKUPS" =~ ^[Yy][Ee][Ss]$ ]] && echo "  Backups:          $BACKUP_DIR (${BACKUP_RETENTION_DAYS}d retention)"
    echo ""
    echo -e "${CYAN}Next Steps:${NC}"
    if [[ "$DOMAIN" == "localhost" ]]; then
        local server_ip
        server_ip=$(get_server_ip)
        if [[ "$server_ip" != "localhost" ]]; then
            echo "  1. Visit https://$server_ip (or https://localhost) and log in"
        else
            echo "  1. Visit https://localhost and log in"
        fi
    else
        echo "  1. Visit https://$DOMAIN and log in"
    fi
    echo "  2. Change admin password in Account settings"
    echo "  3. Enable 2FA for admin account"
    echo "  4. Configure Serial device (Config -> Serial) if using hardware"
    echo "  5. Review and configure MQTT federation if multi-site"
    echo "  6. Configure TAK bridge if integrating with ATAK/WinTAK"
    echo "  7. Review Firewall settings (Config -> Firewall)"
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    
    # Save credentials to file
    local creds_file="$INSTALL_DIR/deployment-credentials.txt"
    sudo -u "$INSTALL_USER" tee "$creds_file" > /dev/null <<EOF
AntiHunter Command Center - Deployment Credentials
Generated: $(date)

$(if [[ "$DOMAIN" == "localhost" ]]; then
    local server_ip
    server_ip=$(get_server_ip)
    if [[ "$server_ip" != "localhost" ]]; then
        echo "URL: https://$server_ip"
        echo "Local URL: https://localhost"
    else
        echo "URL: https://localhost"
    fi
else
    echo "URL: https://$DOMAIN"
fi)
Admin Email: $ADMIN_EMAIL
Admin Password: $ADMIN_PASSWORD

Database: $DB_NAME
DB User: $DB_USER
DB Password: $DB_PASSWORD

Site ID: $SITE_ID
Site Name: $SITE_NAME

IMPORTANT: Delete this file after saving credentials securely!
EOF
    
    sudo chmod 600 "$creds_file"
    warn "Credentials saved to: $creds_file (delete after reading!)"
}

#############################################################################
# Main Execution
#############################################################################

main() {
    echo -e "${BLUE}"
    cat <<'EOF'
    ___          __  _ __  __            __           
   /   |  ____  / /_(_) / / /_  ______  / /____  _____
  / /| | / __ \/ __/ / /_/ / / / / __ \/ __/ _ \/ ___/
 / ___ |/ / / / /_/ / __  / /_/ / / / / /_/  __/ /    
/_/  |_/_/ /_/\__/_/_/ /_/\__,_/_/ /_/\__/\___/_/     
                                                        
        Command & Control Pro - Deployment Script
EOF
    echo -e "${NC}"
    
    preflight_checks
    prompt_configuration
    
    echo ""
    log "Starting deployment..."
    echo ""
    
    # System setup
    setup_system_user
    update_system
    
    # Install packages
    install_base_packages
    install_nodejs
    install_pnpm
    install_postgresql
    install_nginx
    install_ufw
    install_fail2ban
    install_certbot
    
    # Configure database
    configure_postgresql
    
    # Clone and build application
    clone_repository
    install_workspace_dependencies
    create_backend_env
    generate_prisma_client
    run_database_migrations
    seed_database
    build_backend
    ensure_frontend_dependencies
    build_frontend
    
    # SSL certificates
    generate_selfsigned_certificate
    setup_local_domain
    obtain_letsencrypt_certificate
    
    # Configure services
    create_systemd_service
    start_backend_service
    configure_nginx
    
    # Security
    configure_firewall
    configure_fail2ban
    
    # Backups
    create_backup_script
    
    # Verify and summarize
    verify_deployment
    print_deployment_summary
}

# Run main function
main "$@"