#!/usr/bin/env bash
# ============================================================
# selfcode インストールスクリプト
#
# GitHub (https://github.com/hirogura/selfcode) からソースを取得して
# インストールします。opencode / freebuff / Antigravity CLI (agy) は
# インストール後に selfcode アプリ上からインストールしてください。
#
# systemd サービス登録と Tailscale serve 設定は自動で行われます。
#
# 使い方:
#   sudo bash install-selfcode.sh [インストール先ディレクトリ]
#
#   例:
#   sudo bash install-selfcode.sh                 # /opt/lxd-data/selfcode に導入
#   sudo bash install-selfcode.sh /srv/selfcode   # 別の場所に導入
# ============================================================
set -euo pipefail

REPO_URL="https://github.com/hirogura/selfcode.git"
BRANCH="main"
DEFAULT_DIR="/opt/lxd-data/selfcode"

# ---- 引数解析 ----
INSTALL_DIR="$DEFAULT_DIR"
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      echo "使い方: sudo bash install-selfcode.sh [インストール先ディレクトリ]"
      exit 0
      ;;
    *) INSTALL_DIR="$arg" ;;
  esac
done

# ---- 表示ヘルパー ----
info() { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# root でなければ sudo 経由で実行する
maybe_sudo() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

# ---- 前提条件チェック ----
for cmd in git curl node npm; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' が見つかりません。先にインストールしてください (例: sudo apt-get install -y git curl nodejs npm)"
done

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js 18 以上が必要です (現在: $(node --version))"
fi

info "インストール先: $INSTALL_DIR"
info "リポジトリ: $REPO_URL"

# ---- リポジトリ取得（既存なら最新化） ----
if [ -d "$INSTALL_DIR/.git" ]; then
  warn "$INSTALL_DIR に既存のクローンがあります。最新版に更新します。"
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  maybe_sudo mkdir -p "$(dirname "$INSTALL_DIR")"
  maybe_sudo git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# ---- 依存関係のインストール ----
info "npm install を実行中..."
maybe_sudo sh -c "cd '$INSTALL_DIR' && npm install --no-audit --no-fund"

# ---- systemd サービス登録（自動） ----
if [ -d /etc/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  info "systemd サービス (selfcode.service) を登録中..."
  UNIT_SRC="$INSTALL_DIR/selfcode.service"
  UNIT_DST="/etc/systemd/system/selfcode.service"
  # インストール先が既定と異なる場合は WorkingDirectory を書き換える
  if [ "$INSTALL_DIR" != "$DEFAULT_DIR" ]; then
    tmp="$(mktemp)"
    sed "s|$DEFAULT_DIR|$INSTALL_DIR|g" "$UNIT_SRC" > "$tmp"
    maybe_sudo install -m 644 "$tmp" "$UNIT_DST"
    rm -f "$tmp"
  else
    maybe_sudo install -m 644 "$UNIT_SRC" "$UNIT_DST"
  fi
  maybe_sudo systemctl daemon-reload
  maybe_sudo systemctl enable --now selfcode
  info "selfcode サービスを起動しました"
else
  warn "systemd が見つかりません。手動起動は README.md を参照してください。"
fi

# ---- Tailscale serve（自動設定） ----
TAILNET_URL=""
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  TAILNET_DNS=""
  TS_JSON="$(tailscale status --json 2>/dev/null || true)"
  if [ -n "$TS_JSON" ]; then
    TAILNET_DNS="$(printf '%s' "$TS_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);const n=(j.Self&&j.Self.DNSName)||"";console.log(n.replace(/\.$/,""))}catch{}})')"
  fi
  if [ -n "$TAILNET_DNS" ]; then
    info "Tailscale serve を設定中..."
    if tailscale serve --bg --https=3339 http://127.0.0.1:3339 2>/dev/null; then
      TAILNET_URL="https://$TAILNET_DNS:3339"
      info "Tailscale serve を設定しました: $TAILNET_URL"
    else
      warn "tailscale serve の設定に失敗しました。次を実行してください: sudo tailscale serve --bg --https=3339 http://127.0.0.1:3339"
    fi
  else
    warn "Tailnet アドレスを取得できませんでした。serve 設定は手動で行ってください。"
  fi
else
  warn "Tailscale が見つかりません。tailscale serve 設定は手動で行ってください。"
fi

# ---- 完了表示 ----
if [ -n "$TAILNET_URL" ]; then
  BROWSER_LINE=" ブラウザ       : $TAILNET_URL"
  SCOPE_LINE=" 公開範囲       : Tailnet 内のみ（LAN 非公開・https）"
  SERVE_HINT=""
else
  BROWSER_LINE=" ブラウザ       : http://localhost:3339"
  SCOPE_LINE=" 公開範囲       : このマシンのみ（Tailscale serve 未設定）"
  SERVE_HINT=" Tailnet 公開   : sudo tailscale serve --bg --https=3339 http://127.0.0.1:3339"
fi
cat <<EOF

============================================
 selfcode のインストールが完了しました
--------------------------------------------
 インストール先 : $INSTALL_DIR
 ポート         : 3339 (PORT 環境変数で変更可)
$BROWSER_LINE
$SCOPE_LINE$SERVE_HINT

 ログ           : journalctl -u selfcode -f
 停止/再起動    : sudo systemctl stop|restart selfcode
 アンインストール: README.md の「アンインストール」を参照
============================================
EOF
