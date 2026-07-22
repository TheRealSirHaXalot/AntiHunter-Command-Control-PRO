#!/usr/bin/env bash
set -euo pipefail

#############################################################################
# AntiHunter Command & Control Pro - Local Setup Script
# For development/local installations (macOS, Linux, Windows/WSL)
# No hardening, firewall, or reverse proxy - just gets the app running
#############################################################################

if [[ "$EUID" -eq 0 ]]; then
    echo -e "\033[0;31m[ERROR]\033[0m This script should NOT be run with sudo or as root"
    echo ""
    echo "Correct usage:"
    echo "  ./setup-local.sh        (as regular user)"
    echo ""
    echo "The script will prompt for sudo where needed for:"
    echo "  - Installing system packages (Node.js, PostgreSQL, build tools)"
    echo "  - Setting up PostgreSQL database"
    echo "  - Fixing file permissions"
    echo ""
    exit 1
fi

VERSION="1.0.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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

if [[ -z "$CYAN" ]]; then
    if [[ -z "${NO_COLOR:-}" ]]; then
        RED='\033[0;31m'
        GREEN='\033[0;32m'
        YELLOW='\033[1;33m'
        BLUE='\033[0;34m'
        CYAN='\033[0;36m'
        MAGENTA='\033[0;35m'
        NC='\033[0m'
    fi
fi

log() { echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*"; }
info() { echo -e "${CYAN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
success() { echo -e "${GREEN}✓${NC} $*"; }
step() { echo -e "${MAGENTA}[STEP]${NC} $*"; }

fix_repository_permissions() {
    if [[ -d "$REPO_DIR" ]]; then
        info "Fixing repository permissions..."
        local current_user
        local current_group

        if [[ "$OS" == "macos" ]] || [[ "$OS" == "linux" ]]; then
            current_user=$(whoami)

            if [[ "$OS" == "macos" ]]; then
                current_group=$(id -gn "$current_user")
            else
                current_group=$(id -gn)
            fi

            info "Setting ownership to $current_user:$current_group"
            if [[ -w "$REPO_DIR" ]]; then
                chown -R "$current_user:$current_group" "$REPO_DIR" 2>/dev/null || \
                sudo chown -R "$current_user:$current_group" "$REPO_DIR"
            else
                sudo chown -R "$current_user:$current_group" "$REPO_DIR"
            fi

            chmod -R u+rwX "$REPO_DIR"

            find "$REPO_DIR" -name "*.timestamp-*" -delete 2>/dev/null || true
            if [[ -d "$REPO_DIR/node_modules/.cache" ]]; then
                find "$REPO_DIR/node_modules/.cache" -type d -exec rm -rf {} + 2>/dev/null || true
            fi

            success "Repository permissions fixed for user: $current_user"
        elif [[ "$OS" == "windows" ]]; then
            warn "Windows detected - skipping ownership changes"
        fi
    fi
}

install_dependencies() {
    step "Installing application dependencies..."

    if ! command -v pnpm >/dev/null 2>&1; then
        warn "pnpm not available, skipping dependency installation"
        return 0
    fi

    if [[ ! -f "$REPO_DIR/package.json" ]]; then
        error "package.json not found at $REPO_DIR"
        if prompt_yes_no "Continue anyway?"; then
            warn "Skipping dependency installation"
            return 0
        fi
        return 1
    fi

    cd "$REPO_DIR" || {
        error "Cannot change to repository directory: $REPO_DIR"
        if prompt_yes_no "Continue anyway?"; then
            return 0
        fi
        return 1
    }

    info "Running pnpm install in $REPO_DIR..."
    info "This may take several minutes, especially for native module compilation..."

    if [[ "$ARCH_TYPE" == "armv6" ]] || [[ "$ARCH_TYPE" == "armv7" ]] || [[ "$ARCH_TYPE" == "arm64" ]]; then
        info "ARM architecture detected - native module compilation may take extra time"
        
        if [[ "$DISTRO" == "raspbian" ]] || [[ -f /etc/rpi-issue ]]; then
            warn "Raspbian/Raspberry Pi OS detected"
            warn "Native modules (argon2, serialport) may take 5-15 minutes to compile"
        fi
    fi

    if pnpm install; then
        success "Dependencies installed successfully"
        fix_repository_permissions
        return 0
    fi

    {
        error "Failed to install dependencies"
        error "Current directory: $(pwd)"
        error "Package.json exists: $(test -f package.json && echo 'yes' || echo 'no')"
        echo ""
        error "Common causes and solutions:"
        echo ""

        if ! command -v gcc >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
            error "  Missing build tools (gcc, python3)"
            echo "  Solution: Re-run this script and accept build tools installation"
            echo "  Or manually install: sudo apt-get install -y build-essential python3 python3-dev"
        fi

        if [[ "$ARCH_TYPE" == "armv6" ]] || [[ "$ARCH_TYPE" == "armv7" ]] || [[ "$ARCH_TYPE" == "arm64" ]]; then
            error "  ARM architecture detected - native modules may need additional dependencies"
            echo "  Solution: Install ARM build dependencies:"
            echo "  sudo apt-get install -y python3-dev libnode-dev libudev-dev libatomic1"
            
            if [[ "$DISTRO" == "raspbian" ]] || [[ -f /etc/rpi-issue ]]; then
                echo "  Raspbian-specific: Ensure you have at least 1GB free RAM"
                echo "  Consider enabling swap if compilation fails: sudo dphys-swapfile swapon"
            fi
        fi

        if [[ ! -w "$REPO_DIR" ]]; then
            error "  Repository directory is not writable"
            echo "  Solution: Fix permissions with:"
            echo "  sudo chown -R $(whoami):$(whoami) $REPO_DIR"
        fi

        if command -v node >/dev/null 2>&1; then
            local node_version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
            if [[ $node_version -lt 20 ]]; then
                error "  Node.js version is too old: v$node_version (need v20+)"
                echo "  Solution: Install Node.js 20 or later"
            fi
        fi

        echo ""
        error "To see full error details, scroll up or check the output above"
        echo ""

        if prompt_yes_no "Try installing dependencies with verbose logging?"; then
            info "Running pnpm install with verbose output..."
            pnpm install --reporter=verbose || {
                error "Installation failed again"
            }
        fi

        echo ""
        if prompt_yes_no "Continue anyway?"; then
            warn "Continuing without dependencies installed"
            warn "You'll need to manually run: cd $REPO_DIR && pnpm install"
            return 0
        fi
        return 1
    }
}

detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
        PKG_MANAGER="brew"
        DISTRO="macos"
        DISTRO_NAME="macOS"
    elif [[ "$OSTYPE" == "linux-gnu"* ]] || [[ "$OSTYPE" == "linux" ]]; then
        OS="linux"

        if [[ -f /etc/os-release ]]; then
            . /etc/os-release
            DISTRO="${ID:-unknown}"
            DISTRO_VERSION="${VERSION_ID:-unknown}"
            DISTRO_NAME="${NAME:-Linux}"
            
            if [[ -f /etc/rpi-issue ]] || [[ "$DISTRO" == "raspbian" ]]; then
                DISTRO="raspbian"
                DISTRO_NAME="Raspbian (Raspberry Pi OS)"
                info "Raspberry Pi detected via /etc/rpi-issue or ID"
            fi
        elif [[ -f /etc/debian_version ]]; then
            DISTRO="debian"
            DISTRO_NAME="Debian"
            
            if [[ -f /etc/rpi-issue ]]; then
                DISTRO="raspbian"
                DISTRO_NAME="Raspbian (Raspberry Pi OS)"
            fi
        else
            DISTRO="unknown"
            DISTRO_NAME="Linux"
        fi

        if command -v apt-get >/dev/null 2>&1; then
            PKG_MANAGER="apt"
        elif command -v yum >/dev/null 2>&1; then
            PKG_MANAGER="yum"
        elif command -v dnf >/dev/null 2>&1; then
            PKG_MANAGER="dnf"
        elif command -v pacman >/dev/null 2>&1; then
            PKG_MANAGER="pacman"
        else
            PKG_MANAGER="unknown"
        fi
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
        OS="windows"
        PKG_MANAGER="none"
        DISTRO="windows"
        DISTRO_NAME="Windows"
    else
        OS="unknown"
        PKG_MANAGER="unknown"
        DISTRO="unknown"
        DISTRO_NAME="Unknown"
    fi

    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64|amd64)
            ARCH_TYPE="x64"
            ;;
        aarch64|arm64)
            ARCH_TYPE="arm64"
            ;;
        armv7l|armv7)
            ARCH_TYPE="armv7"
            ;;
        armv6l)
            ARCH_TYPE="armv6"
            ;;
        i686|i386)
            ARCH_TYPE="x86"
            ;;
        *)
            ARCH_TYPE="$ARCH"
            ;;
    esac

    info "Detected OS: $OS ($DISTRO_NAME ${DISTRO_VERSION:-})"
    info "Architecture: $ARCH_TYPE ($ARCH)"
    info "Package Manager: $PKG_MANAGER"
    
    if [[ "$DISTRO" == "raspbian" ]]; then
        warn "Raspbian detected - setup optimized for Raspberry Pi hardware"
    fi
}

DB_NAME="command_center"
DB_USER="command_center"
DB_HOST="localhost"
DB_PORT="5432"
BACKEND_PORT="3000"
FRONTEND_PORT="5173"

DB_PASSWORD=""
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
SITE_ID=""
SITE_NAME=""
SERIAL_DEVICE=""
SERIAL_BAUD="115200"
REPO_URL=""
CLONE_DIR=""

prompt_yes_no() {
    local prompt="$1"
    local response

    if [[ ! -t 0 ]] || [[ -n "${CI:-}" ]] || [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        warn "Non-interactive environment detected - defaulting to 'no' for: $prompt"
        return 1
    fi

    while true; do
        read -p "$prompt (y/n): " -r response
        response=$(printf '%s' "$response" | tr '[:upper:]' '[:lower:]')
        case "$response" in
            y|yes) return 0 ;;
            n|no) return 1 ;;
            *) warn "Please enter 'y' or 'n'" ;;
        esac
    done
}

check_git() {
    step "Checking Git installation..."
    
    if command -v git >/dev/null 2>&1; then
        success "Git $(git --version) found"
        return 0
    fi
    
    error "Git not found"
    if prompt_yes_no "Install Git automatically?"; then
        case "$PKG_MANAGER" in
            apt)
                sudo apt-get update && sudo apt-get install -y git
                ;;
            yum|dnf)
                sudo $PKG_MANAGER install -y git
                ;;
            pacman)
                sudo pacman -S --noconfirm git
                ;;
            brew)
                brew install git
                ;;
            *)
                error "Cannot auto-install Git for your system"
                echo "Please install Git from: https://git-scm.com/"
                return 1
                ;;
        esac
        
        hash -r
        if command -v git >/dev/null 2>&1; then
            success "Git installed successfully"
            return 0
        fi
    fi
    
    echo "Please install Git and re-run this script"
    exit 1
}

clone_repository() {
    step "Repository Setup"
    echo ""
    
    if [[ -f "package.json" ]] && [[ -d "apps" ]]; then
        info "Repository structure detected in current directory: $(pwd)"
        if prompt_yes_no "Use current directory as repository?"; then
            REPO_DIR="$(pwd)"
            success "Using current directory: $REPO_DIR"
            return 0
        fi
    fi
    
    if [[ -f "$REPO_DIR/package.json" ]] && [[ -d "$REPO_DIR/apps" ]]; then
        info "Repository structure detected at: $REPO_DIR"
        if prompt_yes_no "Use existing repository at this location?"; then
            success "Using existing repository"
            return 0
        fi
    fi
    
    echo ""
    REPO_URL="https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO.git"
    info "Repository: $REPO_URL"
    echo ""

    read -p "What to name the cloned folder: " CLONE_DIR
    CLONE_DIR=${CLONE_DIR:-repository}
    
    CLONE_DIR=$(cd "$(dirname "$CLONE_DIR")" 2>/dev/null && pwd)/$(basename "$CLONE_DIR") || echo "$CLONE_DIR"
    
    if [[ -d "$CLONE_DIR" ]]; then
        if [[ -f "$CLONE_DIR/package.json" ]] && [[ -d "$CLONE_DIR/apps" ]]; then
            info "Valid repository found at: $CLONE_DIR"
            if prompt_yes_no "Use this existing repository?"; then
                REPO_DIR="$CLONE_DIR"
                success "Using existing repository at: $REPO_DIR"
                return 0
            fi
        fi
        
        error "Directory already exists: $CLONE_DIR"
        if ! prompt_yes_no "Remove existing directory and clone fresh?"; then
            warn "Cancelled by user"
            exit 1
        fi
        rm -rf "$CLONE_DIR"
    fi
    
    info "Cloning repository..."
    if git clone "$REPO_URL" "$CLONE_DIR"; then
        REPO_DIR="$CLONE_DIR"
        
        local current_user=$(whoami)
        chown -R "$current_user:$current_user" "$REPO_DIR" 2>/dev/null || true
        
        success "Repository cloned to: $REPO_DIR"
        return 0
    else
        error "Failed to clone repository"
        exit 1
    fi
}

prompt_configuration() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}  AntiHunter Command & Control Pro - Local Setup${NC}"
    echo -e "${BLUE}  Version: $VERSION${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    while [[ -z "$SITE_ID" ]]; do
        read -p "Site ID [default]: " SITE_ID
        SITE_ID=${SITE_ID:-default}
    done

    read -p "Site Name [$SITE_ID]: " SITE_NAME
    if [[ -z "$SITE_NAME" ]]; then
        if [[ "$SITE_ID" == "default" ]]; then
            SITE_NAME="Default Site"
        else
            SITE_NAME="$SITE_ID"
        fi
    fi

    echo ""
    DB_PASSWORD=$(openssl rand -base64 32 2>/dev/null | tr -d "=+/" | cut -c1-32 || echo "changeme$(date +%s)")
    info "Generated database password: $DB_PASSWORD"
    read -p "Press Enter to accept or type custom password: " custom_db_pass
    [[ -n "$custom_db_pass" ]] && DB_PASSWORD="$custom_db_pass"

    echo ""
    while [[ -z "$ADMIN_EMAIL" ]]; do
        read -p "Admin email [admin@example.com]: " ADMIN_EMAIL
        ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}
        if [[ ! "$ADMIN_EMAIL" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
            warn "Invalid email format, please try again"
            ADMIN_EMAIL=""
        fi
    done

    ADMIN_PASSWORD=$(openssl rand -base64 16 2>/dev/null | tr -d "=+/" | cut -c1-16 || echo "admin$(date +%s)")
    info "Generated admin password: $ADMIN_PASSWORD"
    read -p "Press Enter to accept or type custom password: " custom_admin_pass
    [[ -n "$custom_admin_pass" ]] && ADMIN_PASSWORD="$custom_admin_pass"

    echo ""
    info "Serial device configuration (for mesh hardware)"
    echo "Common paths:"
    echo "  Linux:   /dev/ttyUSB0 or /dev/ttyACM0"
    echo "  macOS:   /dev/cu.usbserial-* or /dev/cu.usbmodem*"
    echo "  Windows: COM3, COM4, etc."
    read -p "Serial device path (or 'skip' to configure later): " SERIAL_DEVICE
    SERIAL_DEVICE=${SERIAL_DEVICE:-skip}

    if [[ "$SERIAL_DEVICE" != "skip" ]]; then
        read -p "Serial baud rate [115200]: " SERIAL_BAUD
        SERIAL_BAUD=${SERIAL_BAUD:-115200}
    fi

    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}Configuration Summary:${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo "Repository:          $REPO_DIR"
    echo "Site ID:             $SITE_ID"
    echo "Site Name:           $SITE_NAME"
    echo "Database:            $DB_NAME"
    echo "DB User:             $DB_USER"
    echo "DB Password:         ${DB_PASSWORD:0:8}..."
    echo "Admin Email:         $ADMIN_EMAIL"
    echo "Admin Password:      ${ADMIN_PASSWORD}"
    echo "Backend Port:        $BACKEND_PORT"
    echo "Frontend Port:       $FRONTEND_PORT"
    if [[ "$SERIAL_DEVICE" == "skip" ]]; then
        echo "Serial Device:       <configure later>"
    else
        echo "Serial Device:       $SERIAL_DEVICE @ ${SERIAL_BAUD} baud"
    fi
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    if ! prompt_yes_no "Proceed with setup?"; then
        warn "Setup cancelled by user"
        if prompt_yes_no "Do you want to reconfigure?"; then
            SITE_ID=""
            ADMIN_EMAIL=""
            prompt_configuration
        else
            exit 0
        fi
    fi
}

install_homebrew() {
    if command -v brew >/dev/null 2>&1; then
        success "Homebrew already installed"
        return 0
    fi

    info "Homebrew not found"
    if prompt_yes_no "Install Homebrew?"; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        if [[ $? -eq 0 ]]; then
            success "Homebrew installed"
            if [[ -f /opt/homebrew/bin/brew ]]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [[ -f /usr/local/bin/brew ]]; then
                eval "$(/usr/local/bin/brew shellenv)"
            fi
            return 0
        else
            error "Homebrew installation failed"
            return 1
        fi
    fi
    return 1
}

install_node() {
    case "$PKG_MANAGER" in
        brew)
            if ! command -v brew >/dev/null 2>&1; then
                install_homebrew || return 1
            fi
            info "Installing Node.js via Homebrew..."
            brew install node@20 && brew link node@20 --force --overwrite
            ;;
        apt)
            info "Installing Node.js via apt..."
            info "Distribution: $DISTRO, Architecture: $ARCH_TYPE"

            if [[ "$ARCH_TYPE" == "armv6" ]] || [[ "$ARCH_TYPE" == "armv7" ]] || [[ "$ARCH_TYPE" == "arm64" ]]; then
                info "ARM architecture detected - using NodeSource repository"

                if ! command -v curl >/dev/null 2>&1; then
                    info "Installing curl first..."
                    sudo apt-get update && sudo apt-get install -y curl
                fi

                if [[ "$DISTRO" == "raspbian" ]]; then
                    warn "Raspbian detected - Node.js installation may require additional steps"
                    
                    if [[ "$ARCH_TYPE" == "armv6" ]]; then
                        warn "ARMv6 architecture - NodeSource may not support this"
                        warn "Attempting unofficial builds as fallback..."
                        
                        if curl -fsSL https://unofficial-builds.nodejs.org/download/release/v20.11.0/node-v20.11.0-linux-armv6l.tar.xz -o /tmp/node.tar.xz; then
                            sudo mkdir -p /usr/local/lib/nodejs
                            sudo tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
                            sudo ln -sf /usr/local/lib/nodejs/node-v20.11.0-linux-armv6l/bin/node /usr/local/bin/node
                            sudo ln -sf /usr/local/lib/nodejs/node-v20.11.0-linux-armv6l/bin/npm /usr/local/bin/npm
                            sudo ln -sf /usr/local/lib/nodejs/node-v20.11.0-linux-armv6l/bin/npx /usr/local/bin/npx
                            rm /tmp/node.tar.xz
                            hash -r
                            if command -v node >/dev/null 2>&1; then
                                success "Node.js installed from unofficial builds"
                                return 0
                            fi
                        fi
                    fi
                fi

                if curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -; then
                    sudo apt-get install -y nodejs
                else
                    error "NodeSource setup failed"
                    warn "Trying alternative method with distribution repository..."
                    sudo apt-get update
                    sudo apt-get install -y nodejs npm || {
                        error "Failed to install Node.js from distribution repository"
                        
                        if [[ "$DISTRO" == "raspbian" ]]; then
                            warn "For Raspberry Pi, you may need to manually install Node.js"
                            warn "See: https://github.com/nodejs/unofficial-builds"
                        fi
                        return 1
                    }
                fi
            else
                if curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -; then
                    sudo apt-get install -y nodejs
                else
                    error "NodeSource setup failed"
                    return 1
                fi
            fi
            ;;
        yum|dnf)
            info "Installing Node.js via $PKG_MANAGER..."
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
            sudo $PKG_MANAGER install -y nodejs
            ;;
        pacman)
            info "Installing Node.js via pacman..."
            sudo pacman -S --noconfirm nodejs npm
            ;;
        *)
            error "Cannot auto-install Node.js for your system"
            echo ""
            echo "Please install Node.js 20+ manually:"
            echo "  Website: https://nodejs.org/"
            echo ""
            if [[ "$ARCH_TYPE" == "armv6" ]] || [[ "$ARCH_TYPE" == "armv7" ]] || [[ "$ARCH_TYPE" == "arm64" ]]; then
                echo "For ARM systems (Raspberry Pi):"
                echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
                echo "  sudo apt-get install -y nodejs"
                echo ""
                if [[ "$ARCH_TYPE" == "armv6" ]]; then
                    echo "For ARMv6 (Pi Zero, Pi 1):"
                    echo "  https://github.com/nodejs/unofficial-builds"
                fi
            fi
            return 1
            ;;
    esac
}

check_node() {
    step "Checking Node.js installation..."

    if command -v node >/dev/null 2>&1; then
        local node_version
        node_version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ $node_version -ge 20 ]]; then
            success "Node.js $(node --version) found"
            return 0
        else
            warn "Found Node.js $node_version, but 20+ is required"
        fi
    fi

    error "Node.js 20+ not found"
    if prompt_yes_no "Install Node.js 20 automatically?"; then
        if install_node; then
            hash -r
            if command -v node >/dev/null 2>&1; then
                success "Node.js installed successfully: $(node --version)"
                return 0
            else
                error "Node.js installation completed but node command not found"
                info "You may need to restart your shell or add Node.js to PATH"
            fi
        else
            error "Failed to install Node.js"
        fi
        
        if prompt_yes_no "Continue setup anyway?"; then
            warn "Continuing without Node.js - you'll need to install it manually"
            return 0
        fi
        return 1
    else
        echo ""
        echo "Please install Node.js 20 LTS from: https://nodejs.org/"
        if prompt_yes_no "Continue setup anyway?"; then
            warn "Continuing without Node.js - you'll need to install it manually"
            return 0
        fi
        return 1
    fi
}

check_node_gyp() {
    step "Checking node-gyp (required for native modules like argon2)..."

    if command -v node-gyp >/dev/null 2>&1; then
        success "node-gyp $(node-gyp --version) found"
        return 0
    fi

    if command -v npm >/dev/null 2>&1; then
        if npm list -g node-gyp >/dev/null 2>&1; then
            success "node-gyp found (npm global)"
            return 0
        fi
    fi

    warn "node-gyp not found - required for native modules (argon2, serialport)"
    info "Installing node-gyp globally..."

    if command -v npm >/dev/null 2>&1; then
        if npm install -g node-gyp; then
            hash -r
            if command -v node-gyp >/dev/null 2>&1; then
                success "node-gyp installed: $(node-gyp --version)"
                return 0
            fi
        fi
    fi

    warn "Could not install node-gyp globally"
    info "This may cause native module compilation failures"
    return 0
}

check_pnpm() {
    step "Checking pnpm installation..."
    
    if command -v pnpm >/dev/null 2>&1; then
        success "pnpm $(pnpm --version) found"
        return 0
    fi
    
    info "pnpm not found"
    
    if ! command -v node >/dev/null 2>&1; then
        warn "Node.js not found - cannot install pnpm"
        if prompt_yes_no "Continue without pnpm?"; then
            warn "You'll need to install Node.js 20+ and pnpm manually later"
            return 0
        fi
        return 1
    fi
    
    local node_version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [[ $node_version -lt 20 ]]; then
        warn "Node.js $node_version is too old for pnpm (need 20+)"
        warn "Please install Node.js 20+ first, then run this script again"
        if prompt_yes_no "Continue without pnpm?"; then
            warn "You'll need to upgrade Node.js to 20+ and install pnpm manually"
            return 0
        fi
        return 1
    fi
    
    if prompt_yes_no "Install pnpm?"; then
        if command -v corepack >/dev/null 2>&1; then
            info "Installing pnpm via corepack (requires sudo)..."
            if sudo corepack enable && sudo corepack prepare pnpm@9.9.0 --activate; then
                hash -r
                if command -v pnpm >/dev/null 2>&1; then
                    success "pnpm installed: $(pnpm --version)"
                    return 0
                fi
            else
                warn "corepack installation failed, trying npm method..."
            fi
        fi
        
        if command -v npm >/dev/null 2>&1; then
            info "Installing pnpm via npm (requires sudo)..."
            if sudo npm install -g pnpm; then
                hash -r
                if command -v pnpm >/dev/null 2>&1; then
                    success "pnpm installed: $(pnpm --version)"
                    return 0
                fi
            fi
        fi
        
        error "Failed to install pnpm"
        if prompt_yes_no "Continue anyway?"; then
            warn "Continuing without pnpm - you'll need to install it manually"
            return 0
        fi
        return 1
    fi
    
    if prompt_yes_no "Continue without pnpm?"; then
        warn "Continuing without pnpm - you'll need to install it manually"
        return 0
    fi
    return 1
}

install_postgresql() {
    case "$PKG_MANAGER" in
        brew)
            if ! command -v brew >/dev/null 2>&1; then
                install_homebrew || return 1
            fi
            info "Installing PostgreSQL via Homebrew..."
            brew install postgresql@15
            brew services start postgresql@15
            sleep 3
        ;;
        apt)
            info "Installing PostgreSQL via apt..."
            
            if [[ "$DISTRO" == "raspbian" ]]; then
                warn "Raspbian detected - PostgreSQL installation optimized for Raspberry Pi"
                
                local total_mem=$(grep MemTotal /proc/meminfo | awk '{print $2}')
                local mem_mb=$((total_mem / 1024))
                
                if [[ $mem_mb -lt 1024 ]]; then
                    warn "Low memory detected: ${mem_mb}MB"
                    warn "PostgreSQL may require configuration tuning"
                fi
                
                if ! swapon --show | grep -q .; then
                    warn "No swap detected - consider enabling swap for compilation"
                    if prompt_yes_no "Enable swap now? (Recommended for <2GB RAM)"; then
                        if [[ -f /etc/dphys-swapfile ]]; then
                            sudo dphys-swapfile setup
                            sudo dphys-swapfile swapon
                            success "Swap enabled"
                        else
                            warn "dphys-swapfile not found - skipping swap setup"
                        fi
                    fi
                fi
            fi
            
            sudo apt-get update
            sudo apt-get install -y postgresql postgresql-contrib
            
            if [[ "$DISTRO" == "raspbian" ]]; then
                info "Configuring PostgreSQL for Raspberry Pi..."
                local pg_version=$(psql --version 2>/dev/null | grep -oP '\d+' | head -1)
                if [[ -n "$pg_version" ]]; then
                    local pg_conf="/etc/postgresql/$pg_version/main/postgresql.conf"
                    if [[ -f "$pg_conf" ]]; then
                        info "Optimizing PostgreSQL settings for limited resources..."
                        sudo cp "$pg_conf" "$pg_conf.backup"
                        
                        sudo sed -i "s/^#*shared_buffers = .*/shared_buffers = 128MB/" "$pg_conf"
                        sudo sed -i "s/^#*effective_cache_size = .*/effective_cache_size = 256MB/" "$pg_conf"
                        sudo sed -i "s/^#*maintenance_work_mem = .*/maintenance_work_mem = 64MB/" "$pg_conf"
                        sudo sed -i "s/^#*work_mem = .*/work_mem = 4MB/" "$pg_conf"
                        
                        info "PostgreSQL configuration tuned for Raspberry Pi"
                    fi
                fi
            fi
            
            sudo systemctl start postgresql
            sudo systemctl enable postgresql
            sleep 3
        ;;
        yum|dnf)
            info "Installing PostgreSQL via $PKG_MANAGER..."
            sudo $PKG_MANAGER install -y postgresql-server postgresql-contrib
            sudo postgresql-setup --initdb
            sudo systemctl start postgresql
            sudo systemctl enable postgresql
            sleep 3
        ;;
        pacman)
            info "Installing PostgreSQL via pacman..."
            sudo pacman -S --noconfirm postgresql
            sudo -u postgres initdb -D /var/lib/postgres/data
            sudo systemctl start postgresql
            sudo systemctl enable postgresql
            sleep 3
        ;;
        *)
            error "Cannot auto-install PostgreSQL for your system"
            return 1
        ;;
    esac
}

check_postgresql() {
    step "Checking PostgreSQL installation..."
    
    if command -v psql >/dev/null 2>&1; then
        success "PostgreSQL found: $(psql --version)"
        return 0
    fi
    
    error "PostgreSQL not found"
    if prompt_yes_no "Install PostgreSQL automatically?"; then
        if install_postgresql; then
            hash -r
            if command -v psql >/dev/null 2>&1; then
                success "PostgreSQL installed successfully"
                return 0
            else
                error "PostgreSQL installation completed but psql command not found"
                info "You may need to restart your shell or add PostgreSQL to PATH"
            fi
        else
            error "Failed to install PostgreSQL"
        fi
        
        echo ""
        echo "Manual installation instructions:"
        if [[ "$OS" == "macos" ]]; then
            echo "  brew install postgresql@15"
            echo "  brew services start postgresql@15"
        elif [[ "$OS" == "linux" ]]; then
            echo "  sudo apt-get install postgresql postgresql-contrib"
            if [[ "$DISTRO" == "raspbian" ]]; then
                echo ""
                echo "  Raspbian-specific: After installation, optimize settings:"
                echo "  sudo nano /etc/postgresql/*/main/postgresql.conf"
                echo "  Set: shared_buffers = 128MB, effective_cache_size = 256MB"
            fi
        fi
        
        if prompt_yes_no "Continue anyway?"; then
            warn "Continuing without PostgreSQL - you'll need to install it manually"
            return 0
        fi
        return 1
    else
        if prompt_yes_no "Continue without PostgreSQL?"; then
            warn "Continuing without PostgreSQL - you'll need to install it manually"
            return 0
        fi
        return 1
    fi
}

setup_postgresql() {
    step "Setting up PostgreSQL database..."
    
    if ! command -v psql >/dev/null 2>&1; then
        warn "PostgreSQL not available, skipping database setup"
        return 0
    fi
    
    info "Checking if PostgreSQL is running..."
    local pg_running=false
    
    if [[ "$OS" == "linux" ]]; then
        if systemctl is-active --quiet postgresql 2>/dev/null || systemctl is-active --quiet postgresql@*.service 2>/dev/null; then
            pg_running=true
        elif systemctl status postgresql 2>/dev/null | grep -q "active (exited)"; then
            info "PostgreSQL service shows 'active (exited)' - attempting restart..."
            if sudo systemctl restart postgresql 2>/dev/null; then
                sleep 3
                if systemctl is-active --quiet postgresql 2>/dev/null; then
                    pg_running=true
                fi
            fi
        fi
    elif [[ "$OS" == "macos" ]]; then
        if brew services list 2>/dev/null | grep -q "postgresql.*started"; then
            pg_running=true
        elif pgrep -x postgres >/dev/null 2>&1; then
            pg_running=true
        fi
    fi
    
    if [[ "$pg_running" == "false" ]]; then
        warn "PostgreSQL is installed but not running"
        if prompt_yes_no "Start PostgreSQL service?"; then
            if [[ "$OS" == "linux" ]]; then
                info "Starting PostgreSQL service..."
                sudo systemctl start postgresql || {
                    error "Failed to start PostgreSQL"
                    
                    if [[ "$DISTRO" == "raspbian" ]]; then
                        warn "Raspbian detected - checking for common issues..."
                        
                        local pg_version=$(psql --version 2>/dev/null | grep -oP '\d+' | head -1)
                        if [[ -n "$pg_version" ]]; then
                            local pg_log="/var/log/postgresql/postgresql-$pg_version-main.log"
                            if [[ -f "$pg_log" ]]; then
                                warn "Last 10 lines of PostgreSQL log:"
                                sudo tail -10 "$pg_log"
                            fi
                        fi
                        
                        info "Attempting PostgreSQL cluster recreation..."
                        if sudo pg_dropcluster --stop $pg_version main 2>/dev/null; then
                            sudo pg_createcluster $pg_version main --start
                            sleep 3
                        fi
                    fi
                    
                    if ! prompt_yes_no "Continue anyway?"; then
                        return 1
                    fi
                    return 0
                }
                sudo systemctl enable postgresql 2>/dev/null || true
                sleep 2
                success "PostgreSQL service started"
            elif [[ "$OS" == "macos" ]]; then
                info "Starting PostgreSQL service..."
                if command -v brew >/dev/null 2>&1; then
                    local pg_service="postgresql"
                    if brew list postgresql@16 &>/dev/null; then
                        pg_service="postgresql@16"
                    elif brew list postgresql@15 &>/dev/null; then
                        pg_service="postgresql@15"
                    elif brew list postgresql@14 &>/dev/null; then
                        pg_service="postgresql@14"
                    fi
                    
                    info "Attempting to start PostgreSQL service: $pg_service"
                    brew services start "$pg_service" || {
                        error "Failed to start PostgreSQL service: $pg_service"
                        if ! prompt_yes_no "Continue anyway?"; then
                            return 1
                        fi
                        return 0
                    }
                    sleep 2
                    success "PostgreSQL service started: $pg_service"
                fi
            fi
        else
            warn "PostgreSQL must be running for database setup"
            if ! prompt_yes_no "Continue without database setup?"; then
                return 1
            fi
            return 0
        fi
    else
        success "PostgreSQL is running"
    fi
    
    info "Checking if database '$DB_NAME' already exists..."
    local db_exists
    if [[ "$OS" == "macos" ]]; then
        db_exists=$(psql postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null || echo "0")
    else
        db_exists=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null || echo "0")
    fi
    
    if [[ "$db_exists" == "1" ]]; then
        warn "Database '$DB_NAME' already exists!"
        
        local table_count
        if [[ "$OS" == "macos" ]]; then
            table_count=$(psql "$DB_NAME" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo "0")
        else
            table_count=$(sudo -u postgres psql "$DB_NAME" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo "0")
        fi
        
        if [[ "$table_count" -gt "0" ]]; then
            warn "Database '$DB_NAME' contains $table_count existing tables"
            warn "These tables may have incorrect ownership/permissions"
            
            echo ""
            echo "Options:"
            echo "  1) Drop and recreate database (recommended - clean start)"
            echo "  2) Fix ownership of existing tables"
            echo "  3) Skip database setup"
            echo ""
            read -p "Choose option [1/2/3]: " db_option
            
            case "$db_option" in
                1)
                    info "Dropping existing database..."
                    if [[ "$OS" == "macos" ]]; then
                        echo "DROP DATABASE IF EXISTS \"$DB_NAME\";" | psql postgres
                    else
                        echo "DROP DATABASE IF EXISTS \"$DB_NAME\";" | sudo -u postgres psql
                    fi
                    info "Database dropped, will create new one"
                    db_exists="0"
                ;;
                2)
                    info "Fixing ownership of existing tables..."
                    local PG_SUPER_CMD=""
                    if [[ "$OS" == "macos" ]]; then
                        if sudo -u postgres psql -c '\q' 2>/dev/null; then
                            PG_SUPER_CMD="sudo -u postgres psql"
                        elif psql -U $(whoami) postgres -c '\q' 2>/dev/null; then
                            PG_SUPER_CMD="psql -U $(whoami) postgres"
                        else
                            PG_SUPER_CMD="psql postgres"
                        fi
                    else
                        PG_SUPER_CMD="sudo -u postgres psql"
                    fi
                    
                    local fix_ownership_sql="
DO \$\$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'ALTER TABLE public.' || quote_ident(r.tablename) || ' OWNER TO \"$DB_USER\";';
    END LOOP;
    FOR r IN (SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public') LOOP
        EXECUTE 'ALTER SEQUENCE public.' || quote_ident(r.sequence_name) || ' OWNER TO \"$DB_USER\";';
    END LOOP;
    FOR r IN (SELECT table_name FROM information_schema.views WHERE table_schema = 'public') LOOP
        EXECUTE 'ALTER VIEW public.' || quote_ident(r.table_name) || ' OWNER TO \"$DB_USER\";';
    END LOOP;
END
\$\$;
"
                    if echo "$fix_ownership_sql" | eval $PG_SUPER_CMD -d "$DB_NAME" 2>&1; then
                        success "Table ownership transferred to $DB_USER"
                        
                        info "Granting all privileges on schema and tables..."
                        local grant_all_sql="
GRANT ALL ON SCHEMA public TO \"$DB_USER\";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"$DB_USER\";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"$DB_USER\";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"$DB_USER\";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO \"$DB_USER\";
"
                        echo "$grant_all_sql" | eval $PG_SUPER_CMD -d "$DB_NAME" 2>&1
                        success "Permissions fixed for existing database"
                    else
                        error "Failed to fix table ownership"
                        if ! prompt_yes_no "Continue anyway?"; then
                            return 1
                        fi
                        return 0
                    fi
                ;;
                3)
                    warn "Skipping database setup"
                    if ! prompt_yes_no "Continue anyway?"; then
                        return 1
                    fi
                    return 0
                ;;
                *)
                    error "Invalid option"
                    return 1
                ;;
            esac
        elif [[ "$table_count" -eq "0" ]]; then
            warn "Database '$DB_NAME' exists but is empty"
            
            if prompt_yes_no "Drop and recreate empty database?"; then
                info "Dropping existing empty database..."
                if [[ "$OS" == "macos" ]]; then
                    echo "DROP DATABASE IF EXISTS \"$DB_NAME\";" | psql postgres
                else
                    echo "DROP DATABASE IF EXISTS \"$DB_NAME\";" | sudo -u postgres psql
                fi
                info "Database dropped, will create new one"
                db_exists="0"
            else
                error "Cannot proceed with empty database"
                if ! prompt_yes_no "Continue anyway?"; then
                    return 1
                fi
                return 0
            fi
        fi
    else
        info "Database '$DB_NAME' does not exist, will create it"
    fi
    
    local PG_SUPER_CMD=""
    if [[ "$OS" == "macos" ]]; then
        if sudo -u postgres psql -c '\q' 2>/dev/null; then
            PG_SUPER_CMD="sudo -u postgres psql"
        elif psql -U $(whoami) postgres -c '\q' 2>/dev/null; then
            PG_SUPER_CMD="psql -U $(whoami) postgres"
        else
            PG_SUPER_CMD="psql postgres"
        fi
    elif sudo -u postgres psql -c '\q' 2>/dev/null; then
        PG_SUPER_CMD="sudo -u postgres psql"
    else
        PG_SUPER_CMD="psql postgres"
    fi
    
    info "Creating/updating PostgreSQL user: $DB_USER"
    
    local user_sql="
DO \$\$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$DB_USER') THEN
        ALTER USER \"$DB_USER\" WITH PASSWORD '$DB_PASSWORD' CREATEDB LOGIN;
    ELSE
        CREATE USER \"$DB_USER\" WITH PASSWORD '$DB_PASSWORD' CREATEDB LOGIN;
    END IF;
END
\$\$;
"
    
    if ! echo "$user_sql" | eval $PG_SUPER_CMD 2>&1; then
        error "Failed to create/update database user"
        if prompt_yes_no "Continue anyway?"; then
            warn "Continuing - you'll need to configure the database manually"
            return 0
        fi
        return 1
    fi
    
    success "PostgreSQL user configured"
    
    info "Fixing collation version mismatches (if present)..."
    
    local collation_output
    collation_output=$(eval $PG_SUPER_CMD -c "SELECT 1" 2>&1 || true)
    
    if echo "$collation_output" | grep -q "collation version mismatch"; then
        warn "Detected collation version mismatch - applying comprehensive fix"
        
        info "Fixing template0..."
        echo "UPDATE pg_database SET datallowconn = TRUE WHERE datname = 'template0';" | eval $PG_SUPER_CMD 2>/dev/null || true
        echo "ALTER DATABASE template0 REFRESH COLLATION VERSION;" | eval $PG_SUPER_CMD -d template0 2>/dev/null || true
        echo "UPDATE pg_database SET datallowconn = FALSE WHERE datname = 'template0';" | eval $PG_SUPER_CMD 2>/dev/null || true
        
        info "Fixing template1..."
        echo "ALTER DATABASE template1 REFRESH COLLATION VERSION;" | eval $PG_SUPER_CMD -d template1 2>/dev/null || true
        
        info "Reindexing template1 system catalogs..."
        echo "REINDEX SYSTEM template1;" | eval $PG_SUPER_CMD -d template1 2>/dev/null || true
        
        info "Fixing postgres database..."
        echo "ALTER DATABASE postgres REFRESH COLLATION VERSION;" | eval $PG_SUPER_CMD 2>/dev/null || true
        
        success "Collation version fixes applied"
        
        if (eval $PG_SUPER_CMD -c "SELECT 1" 2>&1 || true) | grep -q "collation version mismatch"; then
            warn "Collation warnings persist but continuing - this may not affect functionality"
        fi
    else
        info "No collation version mismatches detected"
    fi
    
    if [[ "$db_exists" != "1" ]]; then
        info "Creating database: $DB_NAME"
        local create_output
        create_output=$(echo "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";" | eval $PG_SUPER_CMD 2>&1)
        local create_status=$?
        
        if [[ $create_status -ne 0 ]]; then
            local error_lines
            error_lines=$(echo "$create_output" | grep -i "^ERROR:" || true)
            
            if [[ -n "$error_lines" ]]; then
                error "Failed to create database"
                error "Details: $error_lines"
                
                if echo "$error_lines" | grep -qi "collation"; then
                    warn "This appears to be a collation-related error"
                    info "Attempting to create database with explicit template..."
                    
                    create_output=$(echo "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\" TEMPLATE template0;" | eval $PG_SUPER_CMD 2>&1)
                    if [[ $? -eq 0 ]] && ! echo "$create_output" | grep -qi "^ERROR:"; then
                        success "Database created using template0"
                    else
                        error "Failed even with template0: $create_output"
                        if prompt_yes_no "Continue anyway?"; then
                            warn "Continuing without database - you'll need to set it up manually"
                            return 0
                        fi
                        return 1
                    fi
                else
                    if prompt_yes_no "Continue anyway?"; then
                        warn "Continuing without database - you'll need to set it up manually"
                        return 0
                    fi
                    return 1
                fi
            else
                success "Database created (with warnings)"
            fi
        else
            success "Database created"
        fi
    fi
    
    info "Granting comprehensive database privileges..."
    local grant_sql="
GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$DB_USER\";
"
    echo "$grant_sql" | eval $PG_SUPER_CMD 2>&1
    
    info "Configuring schema privileges..."
    local schema_grant_sql="
GRANT ALL ON SCHEMA public TO \"$DB_USER\";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"$DB_USER\";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"$DB_USER\";
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO \"$DB_USER\";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"$DB_USER\";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO \"$DB_USER\";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO \"$DB_USER\";
"
    if ! echo "$schema_grant_sql" | eval $PG_SUPER_CMD -d "$DB_NAME" 2>&1; then
        warn "Could not grant schema privileges using superuser method"
    else
        success "Comprehensive schema privileges granted"
    fi
    
    info "Testing database connection..."
    if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
        success "Database connection verified"
    else
        error "Cannot connect to database with provided credentials"
        error "Connection string: postgresql://$DB_USER:***@$DB_HOST:$DB_PORT/$DB_NAME"
        
        info "Attempting to diagnose connection issue..."
        
        if echo "SELECT rolname FROM pg_roles WHERE rolname='$DB_USER';" | eval $PG_SUPER_CMD -tA | grep -q "$DB_USER"; then
            info "User '$DB_USER' exists in PostgreSQL"
        else
            error "User '$DB_USER' does NOT exist in PostgreSQL"
        fi
        
        info "Checking PostgreSQL authentication configuration..."
        if [[ "$OS" == "linux" ]]; then
            warn "You may need to update /etc/postgresql/*/main/pg_hba.conf"
            warn "Ensure this line exists: host all all 127.0.0.1/32 md5"
            
            if [[ "$DISTRO" == "raspbian" ]]; then
                info "Raspbian: Checking pg_hba.conf configuration..."
                local pg_version=$(psql --version 2>/dev/null | grep -oP '\d+' | head -1)
                if [[ -n "$pg_version" ]]; then
                    local hba_file="/etc/postgresql/$pg_version/main/pg_hba.conf"
                    if [[ -f "$hba_file" ]]; then
                        if ! sudo grep -q "host.*all.*all.*127.0.0.1/32.*md5" "$hba_file"; then
                            warn "pg_hba.conf may need configuration"
                            if prompt_yes_no "Automatically configure pg_hba.conf for local access?"; then
                                sudo cp "$hba_file" "$hba_file.backup"
                                echo "host all all 127.0.0.1/32 md5" | sudo tee -a "$hba_file" >/dev/null
                                sudo systemctl reload postgresql
                                sleep 2
                                success "pg_hba.conf updated and PostgreSQL reloaded"
                            fi
                        fi
                    fi
                fi
            fi
        elif [[ "$OS" == "macos" ]]; then
            warn "Check Homebrew PostgreSQL configuration if authentication fails"
        fi
        
        if prompt_yes_no "Continue anyway?"; then
            warn "Continuing - you'll need to fix database authentication manually"
            echo ""
            echo "Manual fix commands:"
            echo "  sudo -u postgres psql -c \"ALTER USER $DB_USER WITH PASSWORD '$DB_PASSWORD';\""
            echo "  PGPASSWORD='$DB_PASSWORD' psql -h localhost -U $DB_USER -d $DB_NAME -c 'SELECT 1;'"
            return 0
        fi
        return 1
    fi
}

create_backend_env() {
    step "Creating backend environment configuration..."
    
    local backend_dir="$REPO_DIR/apps/backend"
    if [[ ! -d "$backend_dir" ]]; then
        error "Backend directory not found: $backend_dir"
        if prompt_yes_no "Continue anyway?"; then
            warn "Skipping backend configuration"
            return 0
        fi
        return 1
    fi
    
    local env_file="$backend_dir/.env"
    local database_url="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
    
    cat > "$env_file" <<EOF
# AntiHunter Command Center - Backend Configuration
# Generated by local setup script on $(date)

DATABASE_URL=$database_url
PORT=$BACKEND_PORT
HTTPS_ENABLED=false
HTTP_PREFIX=api
LOG_LEVEL=info

SITE_ID=$SITE_ID
SITE_NAME=$SITE_NAME

EOF
    
    if [[ "$SERIAL_DEVICE" != "skip" ]]; then
        cat >> "$env_file" <<EOF
SERIAL_DEVICE=$SERIAL_DEVICE
SERIAL_BAUD=$SERIAL_BAUD
SERIAL_DATA_BITS=8
SERIAL_PARITY=none
SERIAL_STOP_BITS=1
SERIAL_DELIMITER=\\n
SERIAL_RECONNECT_BASE_MS=1000
SERIAL_RECONNECT_MAX_MS=15000
SERIAL_RECONNECT_JITTER=0.2
SERIAL_RECONNECT_MAX_ATTEMPTS=0
SERIAL_PROTOCOL=meshtastic-rewrite
EOF
    fi
    
    cat >> "$env_file" <<EOF

ALLOW_FOREVER=true
ALLOW_ERASE_FORCE=false

FPV_DECODER_ENABLED=true
DRONES_RECORD_INVENTORY=true

CLUSTER_WORKERS=1
EOF
    
    success "Backend environment configured at $env_file"
}

setup_database() {
    step "Setting up database schema..."
    
    info "Verifying database connection..."
    if ! PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
        error "Cannot connect to database. Prisma migrations will fail."
        error "Database URL: postgresql://$DB_USER:***@$DB_HOST:$DB_PORT/$DB_NAME"
        
        if prompt_yes_no "Attempt to fix database authentication now?"; then
            info "Resetting database user password..."
            if [[ "$OS" == "macos" ]]; then
                echo "ALTER USER \"$DB_USER\" WITH PASSWORD '$DB_PASSWORD';" | psql postgres
            else
                echo "ALTER USER \"$DB_USER\" WITH PASSWORD '$DB_PASSWORD';" | sudo -u postgres psql
            fi
            
            sleep 1
            
            if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
                success "Database connection restored"
            else
                error "Still cannot connect. Manual intervention required."
                if ! prompt_yes_no "Continue anyway?"; then
                    return 1
                fi
            fi
        else
            if ! prompt_yes_no "Continue without database setup?"; then
                return 1
            fi
            return 0
        fi
    else
        success "Database connection verified"
        
        info "Checking if database needs Prisma initialization..."
        local has_migrations_table
        has_migrations_table=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_prisma_migrations');" 2>/dev/null || echo "f")
        
        if [[ "$has_migrations_table" == "f" ]]; then
            info "Prisma migrations table not found - this appears to be a fresh database"
            warn "Database needs schema initialization before migrations can run"
            info "Will initialize schema after changing to backend directory"
        fi
    fi
    
    if ! command -v pnpm >/dev/null 2>&1; then
        warn "pnpm not available, skipping database setup"
        return 0
    fi
    
    local backend_dir="$REPO_DIR/apps/backend"
    if [[ ! -d "$backend_dir" ]]; then
        warn "Backend directory not found, skipping database setup"
        return 0
    fi
    
    cd "$backend_dir" || {
        error "Cannot change to backend directory"
        if prompt_yes_no "Continue anyway?"; then
            return 0
        fi
        return 1
    }
    
    if [[ "$has_migrations_table" == "f" ]]; then
        info "Initializing database schema with prisma db push..."
        
        if [[ "$DISTRO" == "raspbian" ]]; then
            warn "Raspbian: Database initialization may take longer on ARM hardware"
        fi
        
        if pnpm prisma db push; then
            success "Database schema initialized with db push"
            has_migrations_table="db_push_used"
        else
            error "Failed to initialize database schema"
            if prompt_yes_no "Continue anyway?"; then
                warn "Continuing without proper database initialization"
            else
                return 1
            fi
        fi
    fi
    
    info "Generating Prisma client..."
    
    if [[ "$DISTRO" == "raspbian" ]]; then
        warn "Raspbian: Prisma client generation may take several minutes on ARM"
    fi
    
    pnpm prisma:generate || pnpm prisma generate || {
        error "Failed to generate Prisma client"
        if prompt_yes_no "Continue anyway?"; then
            warn "Continuing - you'll need to run: pnpm prisma generate"
            return 0
        fi
        return 1
    }
    
    info "Running database migrations..."
    
    if [[ "$has_migrations_table" == "db_push_used" ]]; then
        info "Database was initialized with db push - setting up migration tracking..."
        if pnpm prisma migrate dev --name init --create-only; then
            if pnpm prisma migrate resolve --applied "init"; then
                success "Migration tracking established successfully"
            else
                warn "Could not mark migration as applied, but schema is synchronized"
            fi
        else
            warn "Could not create initial migration, but schema is synchronized via db push"
        fi
    elif [[ "$has_migrations_table" == "f" ]]; then
        info "Fresh database detected - creating initial migration..."
        if pnpm prisma migrate dev --name init; then
            success "Initial migration created and applied successfully"
        else
            warn "Initial migration failed, trying db push as fallback..."
            if pnpm prisma db push; then
                success "Database schema pushed successfully"
                warn "Note: Using db push instead of migrations - migration tracking may not work properly"
            else
                error "Both migration methods failed"
                if prompt_yes_no "Continue anyway?"; then
                    warn "Continuing - you'll need to set up migrations manually"
                    return 0
                fi
                return 1
            fi
        fi
    else
        if pnpm prisma migrate deploy; then
            success "Database migrations applied successfully"
        else
            warn "migrate deploy failed, trying migrate reset..."
            if pnpm prisma migrate reset --force; then
                success "Database reset and migrated successfully"
            else
                error "Migration methods failed"
                if prompt_yes_no "Continue anyway?"; then
                    warn "Continuing - you'll need to run migrations manually"
                    return 0
                fi
                return 1
            fi
        fi
    fi
    
    info "Seeding database..."
    export ADMIN_EMAIL="$ADMIN_EMAIL"
    export ADMIN_PASSWORD="$ADMIN_PASSWORD"
    export SITE_ID="$SITE_ID"
    export SITE_NAME="$SITE_NAME"
    
    pnpm prisma db seed || pnpm db:seed || {
        warn "Seeding reported an error, checking if admin user was created..."
        
        if command -v psql >/dev/null 2>&1; then
            local user_count
            user_count=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM \"User\" WHERE email = '$ADMIN_EMAIL';" 2>/dev/null || echo "0")
            
            if [[ "$user_count" -eq 0 ]]; then
                error "Database seeding failed"
                if prompt_yes_no "Continue anyway?"; then
                    warn "Continuing - you'll need to seed the database manually"
                    return 0
                fi
                return 1
            else
                success "Database seeded (admin user verified)"
            fi
        else
            warn "Cannot verify seeding without psql, assuming success"
        fi
    }
    
    success "Database setup complete"
}

print_summary() {
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}  Setup Complete!${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    local creds_file="$REPO_DIR/local-setup-credentials.txt"
    cat > "$creds_file" <<EOF
AntiHunter Command Center - Local Setup Credentials
Generated: $(date)

Repository: $REPO_DIR
Admin Email: $ADMIN_EMAIL
Admin Password: $ADMIN_PASSWORD

Database: $DB_NAME
DB User: $DB_USER
DB Password: $DB_PASSWORD

Site ID: $SITE_ID
Site Name: $SITE_NAME

Backend: http://localhost:$BACKEND_PORT
Frontend: http://localhost:$FRONTEND_PORT

IMPORTANT: Keep this file secure or delete it after saving credentials!
EOF
    
    chmod 600 "$creds_file" 2>/dev/null
    warn "Credentials saved to: $creds_file"
    
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}  Next Steps - Running AntiHunter${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${BLUE}1. Navigate to repository:${NC}"
    echo "   cd $REPO_DIR"
    echo ""
    echo -e "${BLUE}2. Start the application (choose one):${NC}"
    echo ""
    echo -e "   ${GREEN}Standard mode (backend + frontend with logs):${NC}"
    echo "   pnpm AHCC"
    echo ""
    echo -e "   ${GREEN}Silent mode (minimal console output):${NC}"
    echo "   pnpm AHCC:silent"
    echo ""
    echo -e "   ${GREEN}Cluster mode (multi-core, set workers):${NC}"
    echo "   CLUSTER_WORKERS=4 pnpm AHCC:cluster"
    echo ""
    echo -e "${BLUE}3. Access the web interface:${NC}"
    echo "   Open: ${CYAN}http://localhost:$FRONTEND_PORT${NC}"
    echo ""
    echo -e "${BLUE}4. Login credentials:${NC}"
    echo "   Email:    ${CYAN}$ADMIN_EMAIL${NC}"
    echo "   Password: ${CYAN}$ADMIN_PASSWORD${NC}"
    echo ""
    echo -e "${YELLOW}Note: Backend API runs on port $BACKEND_PORT${NC}"
    echo -e "${YELLOW}      Frontend dev server runs on port $FRONTEND_PORT${NC}"
    echo ""
    
    if [[ "$DISTRO" == "raspbian" ]]; then
        echo ""
        echo -e "${MAGENTA}╔═══════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${MAGENTA}  Raspberry Pi Specific Notes${NC}"
        echo -e "${MAGENTA}╚═══════════════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${YELLOW}Performance Tips:${NC}"
        echo "  - First startup may be slow as caches are built"
        echo "  - Consider using AHCC:silent mode to reduce resource usage"
        echo "  - Monitor temperature: vcgencmd measure_temp"
        echo ""
        echo -e "${YELLOW}Resource Management:${NC}"
        echo "  - Ensure adequate cooling for extended operation"
        echo "  - Monitor system resources with: htop"
        echo "  - Check PostgreSQL performance if slow"
        echo ""
        echo -e "${YELLOW}Troubleshooting:${NC}"
        echo "  - If compilation fails: ensure swap is enabled"
        echo "  - Low memory warnings: close other applications"
        echo "  - Serial device permissions: sudo usermod -a -G dialout $USER"
        echo ""
    fi
}

check_build_tools() {
    step "Checking build tools..."
    
    local missing_tools=()
    local needs_installation=false
    
    if ! command -v gcc >/dev/null 2>&1; then
        missing_tools+=("gcc")
        needs_installation=true
    else
        local gcc_version=$(gcc -dumpversion | cut -d'.' -f1)
        if [[ "$ARCH_TYPE" == "armv6" ]] || [[ "$ARCH_TYPE" == "armv7" ]] || [[ "$ARCH_TYPE" == "arm64" ]]; then
            if [[ -n "$gcc_version" ]] && [[ "$gcc_version" -lt 5 ]]; then
                warn "GCC version $gcc_version detected - argon2 requires GCC >= 5"
                warn "Native module compilation may fail"
            fi
        fi
    fi
    
    if ! command -v g++ >/dev/null 2>&1; then
        missing_tools+=("g++")
        needs_installation=true
    fi
    
    if ! command -v make >/dev/null 2>&1; then
        missing_tools+=("make")
        needs_installation=true
    fi
    
    if ! command -v python3 >/dev/null 2>&1; then
        missing_tools+=("python3")
        needs_installation=true
    fi
    
    if ! command -v pkg-config >/dev/null 2>&1; then
        missing_tools+=("pkg-config")
        needs_installation=true
    fi
    
    if [[ "$ARCH_TYPE" == "armv6" ]] || [[ "$ARCH_TYPE" == "armv7" ]] || [[ "$ARCH_TYPE" == "arm64" ]]; then
        if [[ "$PKG_MANAGER" == "apt" ]]; then
            if ! command -v python3-config >/dev/null 2>&1 && ! dpkg -l | grep -q "python3.*-dev"; then
                missing_tools+=("python3-dev")
                needs_installation=true
            fi
        fi
    fi
    
    if [[ "$needs_installation" == "false" ]]; then
        success "Build tools are installed"
        return 0
    fi
    
    warn "Missing build tools: ${missing_tools[*]}"
    info "These are required for native Node.js modules (argon2, serialport, etc.)"
    
    if ! prompt_yes_no "Install build tools automatically?"; then
        warn "Build tools required for native dependencies"
        if prompt_yes_no "Continue anyway?"; then
            return 0
        fi
        return 1
    fi
    
    case "$PKG_MANAGER" in
        apt)
            info "Installing build tools via apt..."
            info "Distribution: $DISTRO, Architecture: $ARCH_TYPE"
            
            sudo apt-get update || warn "apt-get update failed, continuing anyway"
            
            local apt_packages="build-essential pkg-config libssl-dev python3 make gcc g++"
            
            if [[ "$ARCH_TYPE" == "armv6" ]] || [[ "$ARCH_TYPE" == "armv7" ]] || [[ "$ARCH_TYPE" == "arm64" ]]; then
                info "Installing ARM-specific build dependencies for node-gyp..."
                apt_packages="$apt_packages python3-dev python3-pip libatomic1"
                
                if apt-cache show libnode-dev >/dev/null 2>&1; then
                    apt_packages="$apt_packages libnode-dev"
                fi
                
                if [[ "$DISTRO" == "raspbian" ]]; then
                    info "Raspbian detected - adding Raspberry Pi specific packages"
                    apt_packages="$apt_packages libraspberrypi-dev"
                    
                    local total_mem=$(grep MemTotal /proc/meminfo | awk '{print $2}')
                    local mem_mb=$((total_mem / 1024))
                    
                    if [[ $mem_mb -lt 2048 ]]; then
                        warn "Low memory detected: ${mem_mb}MB"
                        warn "Native module compilation requires significant RAM"
                        
                        if ! swapon --show | grep -q .; then
                            warn "No swap detected"
                            if prompt_yes_no "Enable swap for compilation? (Highly recommended)"; then
                                if [[ -f /etc/dphys-swapfile ]]; then
                                    info "Configuring swap file..."
                                    sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
                                    sudo dphys-swapfile setup
                                    sudo dphys-swapfile swapon
                                    success "Swap enabled (2GB)"
                                else
                                    warn "dphys-swapfile not found, creating manual swap..."
                                    sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
                                    sudo chmod 600 /swapfile
                                    sudo mkswap /swapfile
                                    sudo swapon /swapfile
                                    success "Manual swap created (2GB)"
                                fi
                            fi
                        fi
                    fi
                fi
            fi
            
            apt_packages="$apt_packages libudev-dev"
            
            info "Installing: $apt_packages"
            if sudo apt-get install -y $apt_packages; then
                success "Build tools installed successfully"
            else
                error "Some packages failed to install"
                warn "Trying again without optional packages..."
                sudo apt-get install -y build-essential pkg-config libssl-dev python3 make gcc g++ python3-dev libatomic1 || {
                    error "Failed to install essential build tools"
                    return 1
                }
            fi
        ;;
        yum|dnf)
            info "Installing build tools via $PKG_MANAGER..."
            sudo $PKG_MANAGER groupinstall -y "Development Tools" || warn "Development Tools group install failed"
            sudo $PKG_MANAGER install -y python3 python3-devel pkg-config openssl-devel libudev-devel
        ;;
        pacman)
            info "Installing build tools via pacman..."
            sudo pacman -S --noconfirm base-devel python python-pip pkg-config openssl
        ;;
        brew)
            info "Installing build tools via Homebrew..."
            if ! xcode-select -p >/dev/null 2>&1; then
                info "Installing Xcode Command Line Tools..."
                xcode-select --install || warn "Xcode Command Line Tools installation initiated"
                warn "You may need to complete the Xcode installation and re-run this script"
            fi
            brew install pkg-config python3 || warn "Some Homebrew packages failed to install"
        ;;
        *)
            error "Cannot auto-install build tools for your system"
            echo ""
            echo "Please install manually based on your system:"
            echo ""
            echo "For Debian/Ubuntu/Raspbian:"
            echo "  sudo apt-get install -y build-essential pkg-config libssl-dev python3 python3-dev make gcc g++ libatomic1"
            echo ""
            echo "For RedHat/CentOS/Fedora:"
            echo "  sudo dnf groupinstall -y 'Development Tools'"
            echo "  sudo dnf install -y python3 python3-devel pkg-config openssl-devel"
            echo ""
            echo "For macOS:"
            echo "  xcode-select --install"
            echo "  brew install pkg-config python3"
            echo ""
            return 1
        ;;
    esac
    
    if [[ $? -eq 0 ]]; then
        success "Build tools installed"
        
        hash -r
        if command -v gcc >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
            success "Build tools verified"
            return 0
        else
            warn "Build tools installed but not immediately available in PATH"
            warn "You may need to restart your shell or re-run this script"
            return 0
        fi
    else
        error "Failed to install build tools"
        return 1
    fi
}

print_diagnostic_info() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}  System Diagnostic Information${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "OS: $OS ($DISTRO_NAME ${DISTRO_VERSION:-})"
    echo "Architecture: $ARCH_TYPE ($ARCH)"
    echo "Package Manager: $PKG_MANAGER"
    
    if [[ "$DISTRO" == "raspbian" ]]; then
        echo ""
        echo "Raspberry Pi Hardware Info:"
        if command -v vcgencmd >/dev/null 2>&1; then
            echo "  Temperature: $(vcgencmd measure_temp 2>/dev/null || echo 'N/A')"
            echo "  CPU Speed: $(vcgencmd measure_clock arm 2>/dev/null | awk -F'=' '{printf "%.0f MHz\n", $2/1000000}' || echo 'N/A')"
        fi
        local total_mem=$(grep MemTotal /proc/meminfo | awk '{print $2}')
        local mem_mb=$((total_mem / 1024))
        echo "  Total RAM: ${mem_mb}MB"
        local swap_total=$(grep SwapTotal /proc/meminfo | awk '{print $2}')
        local swap_mb=$((swap_total / 1024))
        echo "  Swap: ${swap_mb}MB"
    fi
    
    echo ""
    echo "Installed Tools:"
    echo -n "  bash: "
    bash --version 2>/dev/null | head -1 || echo "not found"
    echo -n "  node: "
    node --version 2>/dev/null || echo "not found"
    echo -n "  npm: "
    npm --version 2>/dev/null || echo "not found"
    echo -n "  pnpm: "
    pnpm --version 2>/dev/null || echo "not found"
    echo -n "  gcc: "
    gcc --version 2>/dev/null | head -1 || echo "not found"
    echo -n "  g++: "
    g++ --version 2>/dev/null | head -1 || echo "not found"
    echo -n "  python3: "
    python3 --version 2>/dev/null || echo "not found"
    echo -n "  make: "
    make --version 2>/dev/null | head -1 || echo "not found"
    echo -n "  pkg-config: "
    pkg-config --version 2>/dev/null || echo "not found"
    echo -n "  psql: "
    psql --version 2>/dev/null || echo "not found"
    echo ""
}

main() {
    echo -e "${BLUE}"
    cat <<'EOF'
    ___          __  _ __  __            __
    /   |  ____  / /_(_) / / /_  ______  / /____  _____
    / /| | / __ \/ __/ / /_/ / / / / __ \/ __/ _ \/ ___/
/ ___ |/ / / / /_/ / __  / /_/ / / / / /_/  __/ /
/_/  |_/_/ /_/\__/_/_/ /_/\__,_/_/ /_/\__/\___/_/

        Command & Control Pro - Local Setup
EOF
    echo -e "${NC}"
    
    detect_os
    print_diagnostic_info
    
    check_build_tools
    check_git
    clone_repository
    prompt_configuration
    
    echo ""
    log "Starting local setup..."
    echo ""
    
    check_node
    check_pnpm
    check_node_gyp
    check_postgresql
    
    setup_postgresql
    install_dependencies
    create_backend_env
    setup_database
    
    print_summary
}

main "$@"
