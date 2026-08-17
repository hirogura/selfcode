#!/usr/bin/env bash
# ============================================================
# selfcode インストールスクリプト
#
# GitHub (https://github.com/hirogura/selfcode) からソースを取得して
# インストールします。opencode / freebuff / Antigravity CLI (agy) が未導入の場合は、
# 確認のうえ一緒にインストールします（Enter / "y" がデフォルト）。
#
# 使い方:
#   sudo bash install-selfcode.sh [インストール先ディレクトリ] [-y]
#
#   -y : すべての確認をスキップして進める
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
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help)
      echo "使い方: sudo bash install-selfcode.sh [インストール先ディレクトリ] [-y]"
      echo "  -y : すべての確認をスキップして進める"
      exit 0
      ;;
    *) INSTALL_DIR="$arg" ;;
  esac
done

# ---- 表示ヘルパー ----
info() { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

confirm() {
  # デフォルトは y。空 Enter も y 扱い。
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  local ans
  printf '%s [Y/n]: ' "$1"
  read -r ans
  case "${ans:-y}" in
    y|Y|yes|Yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

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

# ---- opencode チェック ----
if command -v opencode >/dev/null 2>&1; then
  info "opencode は導入済みです: $(command -v opencode)"
else
  FOUND=""
  for c in "$HOME/.opencode/bin/opencode" /root/.opencode/bin/opencode /usr/local/bin/opencode /usr/bin/opencode; do
    if [ -x "$c" ]; then FOUND="$c"; break; fi
  done
  if [ -n "$FOUND" ]; then
    info "opencode は導入済みです: $FOUND"
    if [ ! -x /usr/local/bin/opencode ] && [ "$FOUND" = "/root/.opencode/bin/opencode" ]; then
      maybe_sudo cp "$FOUND" /usr/local/bin/opencode 2>/dev/null || cp "$FOUND" /usr/local/bin/opencode 2>/dev/null || true
      maybe_sudo chmod 755 /usr/local/bin/opencode 2>/dev/null || chmod 755 /usr/local/bin/opencode 2>/dev/null || true
      info "全ユーザーが利用できるよう /usr/local/bin/opencode にコピーしました"
    fi
  elif confirm "opencode がインストールされていません。一緒にインストールしますか？"; then
    info "opencode をインストール中 (https://opencode.ai/install) ..."
    curl -fsSL https://opencode.ai/install | bash
    # 全ユーザー（root / 一般ユーザー）で使えるように /usr/local/bin にコピーする
    for src in "$HOME/.opencode/bin/opencode" /root/.opencode/bin/opencode; do
      if [ -f "$src" ]; then
        maybe_sudo cp "$src" /usr/local/bin/opencode 2>/dev/null || cp "$src" /usr/local/bin/opencode 2>/dev/null || true
        maybe_sudo chmod 755 /usr/local/bin/opencode 2>/dev/null || chmod 755 /usr/local/bin/opencode 2>/dev/null || true
        break
      fi
    done
    info "opencode をインストールしました: $(command -v opencode || echo "/usr/local/bin/opencode")"
  else
    warn "opencode をスキップします。opencode 連携（チャットパネル）は動作しません。"
  fi
fi

# ---- freebuff チェック ----
if command -v freebuff >/dev/null 2>&1; then
  info "freebuff は導入済みです: $(command -v freebuff)"
elif confirm "freebuff がインストールされていません。一緒にインストールしますか？"; then
  info "freebuff を npm でグローバルインストール中..."
  maybe_sudo npm install -g freebuff
  info "freebuff をインストールしました: $(command -v freebuff)"
else
  warn "freebuff をスキップします。右上の freebuff ボタンは使用できません。"
fi

# ---- Antigravity CLI (agy) チェック ----
if command -v agy >/dev/null 2>&1; then
  info "Antigravity CLI (agy) は導入済みです: $(command -v agy)"
else
  FOUND=""
  for c in "$HOME/.local/bin/agy" /root/.local/bin/agy /usr/local/bin/agy /usr/bin/agy; do
    if [ -x "$c" ]; then FOUND="$c"; break; fi
  done
  if [ -n "$FOUND" ]; then
    info "Antigravity CLI (agy) は導入済みです: $FOUND"
    if [ ! -x /usr/local/bin/agy ] && [ "$FOUND" = "/root/.local/bin/agy" ]; then
      maybe_sudo cp "$FOUND" /usr/local/bin/agy 2>/dev/null || cp "$FOUND" /usr/local/bin/agy 2>/dev/null || true
      maybe_sudo chmod 755 /usr/local/bin/agy 2>/dev/null || chmod 755 /usr/local/bin/agy 2>/dev/null || true
      info "全ユーザーが利用できるよう /usr/local/bin/agy にコピーしました"
    fi
  elif confirm "Antigravity CLI (agy) がインストールされていません。一緒にインストールしますか？"; then
    info "Antigravity CLI (agy) をインストール中 (https://antigravity.google/cli/install.sh) ..."
    curl -fsSL https://antigravity.google/cli/install.sh | bash
    # 全ユーザー（root / 一般ユーザー）で使えるように /usr/local/bin にコピーする
    for src in "$HOME/.local/bin/agy" /root/.local/bin/agy; do
      if [ -f "$src" ]; then
        maybe_sudo cp "$src" /usr/local/bin/agy 2>/dev/null || cp "$src" /usr/local/bin/agy 2>/dev/null || true
        maybe_sudo chmod 755 /usr/local/bin/agy 2>/dev/null || chmod 755 /usr/local/bin/agy 2>/dev/null || true
        break
      fi
    done
    info "Antigravity CLI (agy) をインストールしました: $(command -v agy || echo "/usr/local/bin/agy")"
  else
    warn "Antigravity CLI (agy) をスキップします。右上の agy ボタンは使用できません。"
  fi
fi

# ---- systemd サービス登録 ----
if [ -d /etc/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  if confirm "systemd サービス (selfcode.service) を登録して自動起動しますか？"; then
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
    warn "systemd サービスは登録しません。手動起動は README.md を参照してください。"
  fi
fi

# ---- Tailscale serve（任意）: Tailnet 内のみに HTTPS 公開 ----
TAILNET_URL=""
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  TAILNET_DNS=""
  TS_JSON="$(tailscale status --json 2>/dev/null || true)"
  if [ -n "$TS_JSON" ]; then
    TAILNET_DNS="$(printf '%s' "$TS_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);const n=(j.Self&&j.Self.DNSName)||"";console.log(n.replace(/\.$/,""))}catch{}})')"
  fi
  if [ -n "$TAILNET_DNS" ]; then
    if confirm "Tailscale serve で https://$TAILNET_DNS:3339 として公開しますか？（Tailnet 内のみ・LAN 非公開）"; then
      if tailscale serve --bg --https=3339 http://127.0.0.1:3339 2>/dev/null; then
        TAILNET_URL="https://$TAILNET_DNS:3339"
        info "Tailscale serve を設定しました: $TAILNET_URL"
      else
        warn "tailscale serve の設定に失敗しました。次を実行してください: sudo tailscale serve --bg --https=3339 http://127.0.0.1:3339"
      fi
    fi
  else
    warn "Tailnet アドレスを取得できませんでした。serve 設定は手動で行ってください。"
  fi
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
