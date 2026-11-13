import http from "node:http";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import express from "express";
import { WebSocketServer } from "ws";

// node-pty はネイティブモジュール (node-gyp ビルド) のため、ビルド漏れでは
// 起動直後に分かりにくいスタックトレースで落ちる。原因を明示して終了する。
const require = createRequire(import.meta.url);
let pty;
try {
  pty = require("node-pty");
} catch (e) {
  console.error("[selfcode] node-pty ネイティブモジュールを読み込めません: " + (e && e.message ? e.message : e));
  console.error("[selfcode] 次を実行して再ビルドしてください: npm install-scripts approve node-pty && npm rebuild node-pty");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3339);
// 既定は localhost のみ待受（LAN 非公開）。Tailscale serve で Tailnet 内に HTTPS 公開する想定
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(process.env.ROOT || "/");
const SELF_USER = process.env.SELFCODE_USERNAME || "selfcode";
const SELF_PASS = process.env.SELFCODE_PASSWORD || "";
const OC_BIN_RAW = process.env.OPENCODE_BIN || "opencode";
// beacon.sh (Agent Beacon): AIコーディングエージェントの共通記憶層。
// 収集データの置き場と CLI の所在は環境変数で上書きできる（既定は /opt/lxd-data/beacon）。
const BEACON_DATA_DIR = process.env.BEACON_DATA_DIR || "/opt/lxd-data/beacon";
const BEACON_BIN_RAW = process.env.BEACON_BIN || "beacon";
const BEACON_HARNESSES = process.env.BEACON_HARNESSES || "opencode,claude,codex,cline";
const BEACON_SERVICE = process.env.BEACON_COLLECTOR_SERVICE || "beacon-collector";
// selfcode が自分で管理するデータ（メモ・ターミナル状態・SSH状態・
// GitHub 連携設定・テンプレート）の保存先ディレクトリ。
// /opt/lxd-data/note は別アプリからも見える共有場所のため、専用ディレクトリへ分離する。
const SELFCODE_CONFIG_DIR = process.env.SELFCODE_CONFIG_DIR || "/opt/lxd-data/selfcode-config";
// 旧バージョン（v.2.9.x 以前）が使っていた保存先。起動時に新ディレクトリへ自動移行する。
const LEGACY_CONFIG_DIR = process.env.SELFCODE_LEGACY_CONFIG_DIR || "/opt/lxd-data/note/selfcode";
const MEMO_FILE = process.env.SELFCODE_MEMO || SELFCODE_CONFIG_DIR + "/selfcode-memo.md";
const RESTART_CMD = process.env.SELFCODE_RESTART_CMD || "systemctl restart selfcode";
const UPDATE_TIMEOUT_MS = Number(process.env.SELFCODE_UPDATE_TIMEOUT || 900000); // アップデートのタイムアウト（既定 15 分）
const HIDDEN = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", ".cache"]);

// プロセスが root で動いているか（systemd サービスは root で起動する）
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

// 稼働ディストロの判別（Ubuntu/Debian と Arch/CachyOS でパッケージ操作を切り替えるため）。
// /etc/os-release の ID を見る。取得できなければ "unknown"。
function detectDistro() {
  try {
    const text = fs.readFileSync("/etc/os-release", "utf8");
    const m = text.match(/^ID=(.+)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, "").toLowerCase();
  } catch {}
  return "unknown";
}
const DISTRO = detectDistro();

// ホスト側ターミナルの既定ユーザー。SELFCODE_TERM_USER が指定されていればそれを使い、
// 無ければ現在のプロセスユーザー（root なら /etc/passwd から uid 1000..65533 の最初の実ユーザーを探す）。
// システムユーザー（nobody や nologin シェル）は除外する。
function defaultTermUser() {
  if (process.env.SELFCODE_TERM_USER) return process.env.SELFCODE_TERM_USER;
  const cur = process.env.USER || (os.userInfo && os.userInfo().username);
  if (cur && cur !== "root") return cur;
  try {
    const passwd = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const parts = line.split(":");
      if (parts.length < 7) continue;
      const name = parts[0];
      const uid = Number(parts[2]);
      const shell = parts[6];
      if (!name || name === "root" || name === "nobody") continue;
      if (!Number.isFinite(uid) || uid < 1000 || uid >= 65534) continue;
      if (shell && (shell.includes("nologin") || shell === "/bin/false" || shell === "/usr/sbin/nologin")) continue;
      return name;
    }
  } catch {}
  return "root";
}
const TERM_USER = defaultTermUser();

// 指定ユーザーのホームディレクトリを /etc/passwd から引く（setpriv でユーザーを切り替える際に HOME を設定するため）
function userHomeOf(name) {
  try {
    const passwd = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const parts = line.split(":");
      if (parts.length >= 6 && parts[0] === name) return parts[5];
    }
  } catch {}
  return "/home/" + name;
}

// 指定ユーザーの uid を /etc/passwd から引く（D-Bus や XDG_RUNTIME_DIR の特定用）
function userUidOf(name) {
  try {
    const passwd = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const parts = line.split(":");
      if (parts.length >= 3 && parts[0] === name) {
        const uid = Number(parts[2]);
        if (Number.isFinite(uid)) return uid;
      }
    }
  } catch {}
  return 1000;
}

// code-server と同じ挙動にする：HOME が未設定（systemd 起動時など）なら os.homedir() で補完し、
// ホームディレクトリ自体が存在しない場合（極小コンテナ等）は mkdir -p で作成する。
// プロセス全体の環境に設定しておくことで、ターミナルと opencode の両方に HOME が渡る。
if (!process.env.HOME) process.env.HOME = os.homedir();
try {
  fs.mkdirSync(process.env.HOME, { recursive: true });
} catch (e) {
  console.error(`[selfcode] HOME を作成できませんでした: ${process.env.HOME} (${e.message})`);
}

// beacon.sh のデータ置き場（BEACON_DATA_DIR）を確保しておく。
// プロセス全体の環境にも設定しておくことで、ターミナルで動く beacon CLI / AI ハーネスにも伝わる。
if (!process.env.BEACON_DATA_DIR) process.env.BEACON_DATA_DIR = BEACON_DATA_DIR;
try {
  fs.mkdirSync(BEACON_DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`[selfcode] BEACON_DATA_DIR を作成できませんでした: ${BEACON_DATA_DIR} (${e.message})`);
}

const app = express();
app.use(express.json({ limit: "64mb" }));

// プロセス起動ごとに変わる識別子。クライアントが再起動の完了（新プロセスへの置き換わり）を
// 検知するために /api/status で返す（単なる死活では短い再起動を見逃すため）。
const BOOT_ID = Date.now().toString(36) + "-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");

function resolveRel(p) {
  const rel = String(p || "").replace(/^\/+/, "");
  const target = path.resolve(ROOT, rel);
  if (ROOT !== "/" && target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    const err = new Error("forbidden path");
    err.status = 403;
    throw err;
  }
  return target;
}

function relOf(abs) {
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

function resolveDirRel(rel) {
  const r = String(rel || "").replace(/^\/+/, "");
  const dir = path.resolve(ROOT, r);
  if (ROOT !== "/" && dir !== ROOT && !dir.startsWith(ROOT + path.sep)) {
    const err = new Error("forbidden path");
    err.status = 403;
    throw err;
  }
  return dir;
}

// ワークスペースのルート自体に対する破壊的操作（削除・移動）を拒否する。
// path 未指定時に resolveRel("") が ROOT を返し、rm -rf で全削除する事故を防ぐ。
function assertNotRoot(abs) {
  if (abs === ROOT) {
    const err = new Error("workspace root itself cannot be modified");
    err.status = 400;
    throw err;
  }
}

app.use(async (req, res, next) => {
  if (!SELF_PASS) return next();
  const b = req.headers.authorization || "";
  const m = b.match(/^Basic (.+)$/);
  if (!m) return res.status(401).setHeader("WWW-Authenticate", "Basic realm=\"selfcode\"").end();
  let user = "";
  let pass = "";
  try {
    const dec = Buffer.from(m[1], "base64").toString();
    // パスワードに ":" が含まれていても正しく扱えるよう最初の ":" で分割する
    const idx = dec.indexOf(":");
    if (idx < 0) return res.status(401).end();
    user = dec.slice(0, idx);
    pass = dec.slice(idx + 1);
  } catch {
    return res.status(401).end();
  }
  const a = crypto.createHash("sha256").update(user).digest();
  const bd = crypto.createHash("sha256").update(pass).digest();
  const ea = crypto.createHash("sha256").update(SELF_USER).digest();
  const eb = crypto.createHash("sha256").update(SELF_PASS).digest();
  if (!crypto.timingSafeEqual(a, ea) || !crypto.timingSafeEqual(bd, eb)) return res.status(401).end();
  next();
});

app.get("/api/status", (req, res) => {
  res.json({
    name: "selfcode",
    version: "3.3.0",
    bootId: BOOT_ID,
    workspace: ROOT,
    distro: DISTRO,
    container: containerCtx ? { name: containerCtx.name, runtime: containerCtx.runtime } : null,
    termUser: TERM_USER,
    termIsRoot: IS_ROOT,
  });
});

// ================= beacon.sh（AIエージェントの共通記憶層） =================
// Agent Beacon (beacon.sh) は opencode / Claude Code / Codex など 20+ ハーネスの
// セッションを集約する記憶層。CLI は公式リリースの install.sh から導入し、収集データの
// 置き場は BEACON_DATA_DIR（ローカルファースト）で管理する。ハーネスの計測設定は
// beacon endpoint install --harness <BEACON_HARNESSES> で行う。

// runCmd と違い終了コードを問わず出力を返す（systemctl is-active の "inactive" 判定などで使う）
function runOut(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    const to = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("command timed out"));
    }, timeoutMs || 8000);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => { clearTimeout(to); reject(e); });
    child.on("close", (code) => {
      clearTimeout(to);
      resolve({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") });
    });
  });
}

// BEACON_BIN（既定 "beacon"）を解決する。絶対パス指定ならその実体を確認。
function beaconBinPath() {
  if (path.isAbsolute(BEACON_BIN_RAW)) {
    try {
      fs.accessSync(BEACON_BIN_RAW, fs.constants.X_OK);
      return BEACON_BIN_RAW;
    } catch {
      return null;
    }
  }
  const termHome = TERM_USER ? userHomeOf(TERM_USER) : null;
  return findBin(BEACON_BIN_RAW, process.env.PATH || "", termHome);
}

// beacon CLI / エンドポイント用の実行環境（BEACON_DATA_DIR と tarball 導入場所の PATH 追加。
// 接続ユーザーの D-Bus / XDG_RUNTIME_DIR / キーリングも引き継ぐ（systemctl --user 用）
function beaconEnv() {
  const env = { ...process.env, BEACON_DATA_DIR };
  const home = process.env.HOME || os.homedir();
  for (const dir of [`${home}/.local/bin`, "/opt/beacon/bin", "/usr/local/bin"]) {
    if (fs.existsSync(dir) && !String(env.PATH || "").split(":").includes(dir)) env.PATH = `${dir}:${env.PATH}`;
  }
  const uid = process.getuid ? process.getuid() : 0;
  const runUserDir = `/run/user/${uid}`;
  if (fs.existsSync(runUserDir)) {
    if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = runUserDir;
    if (!env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync(`${runUserDir}/bus`)) {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runUserDir}/bus`;
    }
    if (!env.GNOME_KEYRING_CONTROL && fs.existsSync(`${runUserDir}/keyring`)) {
      env.GNOME_KEYRING_CONTROL = `${runUserDir}/keyring`;
    }
  }
  return env;
}

// beacon-collector（エンドポイントの systemd サービス）の状態取得
async function beaconServiceInfo() {
  if (!fs.existsSync("/run/systemd/system")) {
    return { name: BEACON_SERVICE, available: false, active: false, state: null };
  }
  try {
    const r = await runOut("systemctl", ["is-active", BEACON_SERVICE], 5000);
    const state = (r.out || "").trim().split("\n").filter(Boolean).pop() || "unknown";
    return { name: BEACON_SERVICE, available: true, active: state === "active", state };
  } catch (e) {
    return { name: BEACON_SERVICE, available: true, active: false, state: "unknown", error: e.message };
  }
}

// コンテナ内の beacon 状態を 1 回の sh -c プローブで取得する。
// 出力は bin:<絶対パス｜空> / ver:<1行目> / sysd:0|1 / svc:<is-active の値> / data:0|1 の行。
// コンテナ内では BEACON_BIN（ホスト用の絶対パス上書き）は無視して PATH から探す。
const BEACON_CONTAINER_PROBE =
  'export PATH="$HOME/.local/bin:/opt/beacon/bin:/usr/local/bin:$PATH"; ' +
  'B="$(command -v beacon)"; ' +
  'echo "bin:$B"; ' +
  'if [ -n "$B" ]; then echo "ver:$("$B" version 2>/dev/null | head -n 1)"; fi; ' +
  'if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then ' +
  'echo "sysd:1"; echo "svc:$(systemctl is-active ' + BEACON_SERVICE + ' 2>/dev/null || true)"; ' +
  'else echo "sysd:0"; fi; ' +
  '[ -d ' + shq(BEACON_DATA_DIR) + ' ] && echo "data:1" || echo "data:0"';

// 上記プローブをパースしてコンテナ内の beacon 状態にする
function parseBeaconContainerProbe(out, err) {
  const lines = String((out || "") + "\n" + (err || "")).split("\n").map((l) => l.trim()).filter(Boolean);
  const info = { binPath: null, version: null, systemd: false, service: null, active: false, dataDirExists: false };
  for (const line of lines) {
    if (line.startsWith("bin:")) info.binPath = line.slice(4) || null;
    else if (line.startsWith("ver:")) info.version = line.slice(4).trim() || null;
    else if (line.startsWith("sysd:")) info.systemd = line.slice(5) === "1";
    else if (line.startsWith("svc:")) info.service = line.slice(4).trim() || null;
    else if (line.startsWith("data:")) info.dataDirExists = line.slice(5) === "1";
  }
  if (info.service) info.active = info.service === "active";
  return info;
}

// コンテナ内の beacon 状態（インストール有無・バージョン・サービス・記憶データ有無）。
// systemd 無しのコンテナが多く、その場合はサービスを「停止中（systemd 無し）」扱いにする。
async function beaconContainerStatus() {
  const info = { binPath: null, version: null, systemd: false, service: null, active: false, dataDirExists: false };
  let probeError = null;
  try {
    const r = await runContainer(["sh", "-c", BEACON_CONTAINER_PROBE], { timeoutMs: 20000 });
    Object.assign(info, parseBeaconContainerProbe(r.stdout.toString("utf8"), r.stderr.toString("utf8")));
  } catch (e) {
    probeError = e.message;
  }
  return {
    installed: !!info.binPath,
    binPath: info.binPath,
    version: info.version,
    versionError: null,
    harnesses: BEACON_HARNESSES,
    dataDir: { path: BEACON_DATA_DIR, exists: info.dataDirExists },
    service: {
      name: BEACON_SERVICE,
      available: info.systemd,
      active: info.active,
      state: info.service,
      // systemd 無し（コンテナでよくある）は「状態不明」ではなく「停止中」として扱う
      stopped: !info.systemd || info.service !== "active",
    },
    probeError,
  };
}

// オンデマンドインストールの進捗管理（UI からロック取得 → バックグラウンド実行 → status でポーリング）
const beaconInstall = { running: false, startedAt: null, finishedAt: null, ok: null, log: [], child: null, target: null };
const BEACON_INSTALL_LOG_MAX = 200;

function beaconLogPush(chunk) {
  for (const line of String(chunk || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    beaconInstall.log.push(line.slice(0, 500));
  }
  if (beaconInstall.log.length > BEACON_INSTALL_LOG_MAX) {
    beaconInstall.log.splice(0, beaconInstall.log.length - BEACON_INSTALL_LOG_MAX);
  }
}

function finishBeaconInstall(ok) {
  beaconInstall.running = false;
  beaconInstall.ok = ok;
  beaconInstall.finishedAt = Date.now();
  beaconInstall.child = null;
  console.log(`[selfcode] beacon install ${ok ? "finished" : "failed"}`);
}

// beacon CLI の導入手順（公式 install.sh が apt/dnf/yum 系専用のため、非対応ディストロ
// （Arch/CachyOS 等）では tarball から ~/.local/bin に導入する）。1要素 = 1文として
// 定義しており、API 用は改行結合、ターミナルの確認フロー用は "; " で結合して使い回す。
const BEACON_TARBALL_STEPS = [
  "b_ver=\"$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/asymptote-labs/agent-beacon/releases/latest)\"",
  "b_ver=\"${b_ver##*/}\"",
  "b_ver=\"${b_ver#v}\"",
  "case \"$(uname -m)\" in x86_64|amd64) b_arch=amd64 ;; aarch64|arm64) b_arch=arm64 ;; *) echo \"[selfcode] 未対応のCPUアーキテクチャです: $(uname -m)\" >&2; exit 1 ;; esac",
  "b_dir=\"$(mktemp -d)\"",
  "cd \"$b_dir\" || exit 1",
  "curl -fsSL -o \"beacon_${b_ver}_linux_${b_arch}.tar.gz\" \"https://github.com/asymptote-labs/agent-beacon/releases/download/v${b_ver}/beacon_${b_ver}_linux_${b_arch}.tar.gz\"",
  "curl -fsSL -o checksums.txt \"https://github.com/asymptote-labs/agent-beacon/releases/download/v${b_ver}/checksums.txt\"",
  "grep \"beacon_${b_ver}_linux_${b_arch}.tar.gz\" checksums.txt | sha256sum -c - || echo \"[selfcode] checksums.txt の検証に失敗しました（このまま進めます）\"",
  "tar -xzf \"beacon_${b_ver}_linux_${b_arch}.tar.gz\"",
  "mkdir -p \"$HOME/.local/bin\"",
  "for b_bin in beacon beacon-hooks beacon-otelcol; do if [ -f \"$b_bin\" ]; then mv -f \"$b_bin\" \"$HOME/.local/bin/\"; fi; done",
  "echo \"[selfcode] beacon ${b_ver} を $HOME/.local/bin に導入しました\"",
];

// ハーネス計測（エンドポイント）の設定。user scope bus の無い環境（コンテナ等）では
// user モードで失敗するため、root / sudo なら --system で再試行する。
// beacon CLI は BEACON_DATA_DIR 環境変数を参照しないため、セッション記録を
// BEACON_DATA_DIR 下に書き込ませるには --log-path を明示する必要がある。
// $B には先行して解決した beacon CLI の絶対パス（無ければ "beacon"）が入っている。
const BEACON_LOG_PATH = BEACON_DATA_DIR + "/runtime.jsonl";
const BEACON_ENDPOINT_STEP =
  "mkdir -p \"$BEACON_DATA_DIR\" 2>/dev/null || true; " +
  "if ! \"$B\" endpoint install --log-path '" + BEACON_LOG_PATH + "' --harness '" + BEACON_HARNESSES + "'; then " +
  "echo '[selfcode] user モードでの設定に失敗したため、--system で再試行します…'; " +
  "if [ \"$(id -u)\" = \"0\" ]; then \"$B\" endpoint install --log-path '" + BEACON_LOG_PATH + "' --harness '" + BEACON_HARNESSES + "' --system || echo '[selfcode] beacon endpoint install に失敗しました（beacon endpoint doctor で確認できます）'; " +
  "else sudo -n \"$B\" endpoint install --log-path '" + BEACON_LOG_PATH + "' --harness '" + BEACON_HARNESSES + "' --system || echo '[selfcode] beacon endpoint install に失敗しました（beacon endpoint doctor で確認、または手動で再試行してください）'; fi; fi";

// インストールスクリプト（公式 install.sh → tarball フォールバック → beacon endpoint install）。
// 改行区切りの配列を sh -c に渡すため、各行は単一引用符の中で完結させて書くこと。
function buildBeaconInstallScript() {
  return [
    "set -e",
    "export BEACON_DATA_DIR=" + shq(BEACON_DATA_DIR),
    "export PATH=\"$HOME/.local/bin:/opt/beacon/bin:/usr/local/bin:$PATH\"",
    "echo '[selfcode] beacon.sh (Agent Beacon) のインストールを開始します…'",
    "if ! command -v beacon >/dev/null 2>&1; then",
    "echo '[selfcode] 公式インストーラ（.deb/.rpm）を試します…'",
    "curl -fsSL https://github.com/asymptote-labs/agent-beacon/releases/latest/download/install.sh | bash || true",
    "fi",
    "if ! command -v beacon >/dev/null 2>&1; then",
    "echo '[selfcode] パッケージマネージャが非対応のため tarball からインストールします…'",
    ...BEACON_TARBALL_STEPS,
    "fi",
    "if command -v beacon >/dev/null 2>&1; then",
    // sudo は PATH をリセットするため、CLI は絶対パス（解決できないなら beacon）で呼ぶ
    "B=\"$(command -v beacon || echo beacon)\"",
    "$B version",
    "echo '[selfcode] エンドポイント（ハーネス計測）を設定します…'",
    BEACON_ENDPOINT_STEP,
    "if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/beacon-collector.service ]; then",
    // endpoint install が自動で有効化しない環境があるため、コレクタを有効化・起動する
    "systemctl enable --now beacon-collector 2>/dev/null || [ \"$(id -u)\" = \"0\" ] || (command -v sudo >/dev/null 2>&1 && sudo -n systemctl enable --now beacon-collector) || true",
    "echo \"[selfcode] beacon-collector サービス: $(systemctl is-active beacon-collector 2>/dev/null || echo 不明)\"",
    "fi",
    "echo \"[selfcode] セッション記録の書き込み先: $(ls \"" + BEACON_DATA_DIR + "/runtime.jsonl\" 2>/dev/null || echo \"" + BEACON_LOG_PATH + "（最初のイベント検出時に作成）\")\"",
    "echo '[selfcode] インストールが完了しました'",
    "else",
    "echo '[selfcode] beacon CLI が見つかりません。インストールに失敗した可能性があります' >&2",
    "exit 1",
    "fi",
  ].join("\n");
}

// コンテナ内向けのインストールスクリプト。systemd 無し環境が多いため公式 install.sh
// （.deb/.rpm + beacon-collector サービス構成）は使わず tarball 導入 → エンドポイント設定 のみ。
function buildBeaconContainerInstallScript() {
  return [
    "set -e",
    "export BEACON_DATA_DIR=" + shq(BEACON_DATA_DIR),
    "export PATH=\"$HOME/.local/bin:/opt/beacon/bin:/usr/local/bin:$PATH\"",
    "echo '[selfcode] beacon.sh (Agent Beacon) をコンテナ内にインストールします…'",
    ...BEACON_TARBALL_STEPS,
    "B=\"$(command -v beacon || echo beacon)\"",
    "$B version",
    "echo '[selfcode] エンドポイント（ハーネス計測）を設定します…'",
    // sudo が無い環境では --system 再試行が飛ばされ、失敗理由がログに残って継続する
    BEACON_ENDPOINT_STEP,
    "echo '[selfcode] インストールが完了しました'",
  ].join("\n");
}

function startBeaconInstall() {
  if (beaconInstall.running) return;
  beaconInstall.running = true;
  beaconInstall.startedAt = Date.now();
  beaconInstall.finishedAt = null;
  beaconInstall.ok = null;
  beaconInstall.log = [];
  // コンテナ選択中はコンテナ内に導入する（ホストには何もしない）
  beaconInstall.target = containerCtx ? { name: containerCtx.name, runtime: containerCtx.runtime } : null;
  console.log("[selfcode] beacon install started" + (beaconInstall.target ? ` (container: ${beaconInstall.target.name})` : ""));
  let child;
  if (beaconInstall.target) {
    child = spawn(containerBin(beaconInstall.target.runtime), containerExecArgs(beaconInstall.target.runtime, beaconInstall.target.name, false).concat(["sh", "-c", buildBeaconContainerInstallScript()]), {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    child = spawn("bash", ["-c", buildBeaconInstallScript()], {
      env: beaconEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  beaconInstall.child = child;
  child.stdout.on("data", (d) => beaconLogPush(d));
  child.stderr.on("data", (d) => beaconLogPush(d));
  child.on("error", (e) => {
    beaconLogPush("[selfcode] インストールの起動に失敗しました: " + e.message);
    finishBeaconInstall(false);
  });
  child.on("close", (code) => {
    if (code === 0) {
      beaconLogPush("[selfcode] インストールが完了しました。AI設定パネルの「状態更新」で反映されます");
      finishBeaconInstall(true);
    } else {
      beaconLogPush(`[selfcode] インストールに失敗しました (exit ${code})`);
      finishBeaconInstall(false);
    }
  });
}

async function beaconStatus() {
  const target = containerCtx ? { name: containerCtx.name, runtime: containerCtx.runtime } : null;
  let installed = false;
  let binPath = null;
  let version = null;
  let versionError = null;
  let service;
  let dataDir;
  let probeError = null;
  if (target) {
    // コンテナ選択中はコンテナ内の状態を見る（ホストに導入済みでもコンテナ内で動いていなければ意味が無い）
    const c = await beaconContainerStatus();
    installed = c.installed;
    binPath = c.binPath;
    version = c.version;
    service = c.service;
    dataDir = c.dataDir;
    probeError = c.probeError;
  } else {
    binPath = beaconBinPath();
    installed = !!binPath;
    dataDir = { path: BEACON_DATA_DIR, exists: fs.existsSync(BEACON_DATA_DIR) };
    service = await beaconServiceInfo();
    if (installed) {
      try {
        const r = await runOut(binPath, ["version"], 8000);
        version = ((r.out || "") + (r.err || "")).trim().split("\n").filter(Boolean)[0] || null;
      } catch (e) {
        versionError = e.message;
      }
    }
  }
  return {
    installed,
    binPath,
    version,
    versionError,
    harnesses: BEACON_HARNESSES,
    dataDir,
    target,
    service,
    probeError,
    install: {
      running: beaconInstall.running,
      ok: beaconInstall.ok,
      target: beaconInstall.target,
      startedAt: beaconInstall.startedAt,
      finishedAt: beaconInstall.finishedAt,
      log: beaconInstall.log.slice(-40).join("\n"),
    },
  };
}

// beacon.sh の状態（インストール有無・バージョン・サービス・インストール進捗）
app.get("/api/beacon/status", async (req, res, next) => {
  try {
    res.json(await beaconStatus());
  } catch (e) {
    next(e);
  }
});

// beacon-collector サービス（エンドポイントの常駐プロセス）の再起動
app.post("/api/beacon/restart", async (req, res, next) => {
  try {
    if (containerCtx) {
      // コンテナ選択中はコンテナ内の beacon-collector をいじる
      const info = await beaconContainerStatus();
      if (!info.installed) {
        return res.status(400).json({ error: `コンテナ「${containerCtx.name}」内に beacon がインストールされていません。「インストール」ボタンから導入してください` });
      }
      if (!info.service.available) {
        return res.status(500).json({ error: `コンテナ「${containerCtx.name}」内では systemd が利用できないため ${BEACON_SERVICE} を再起動できません` });
      }
      await runContainer(["sh", "-c", "systemctl restart " + BEACON_SERVICE], { timeoutMs: 60000 });
    } else {
      if (!beaconBinPath()) {
        return res.status(400).json({ error: "beacon がインストールされていません。「AI設定」の「インストール」ボタンから導入してください" });
      }
      const svc = await beaconServiceInfo();
      if (!svc.available) {
        return res.status(500).json({ error: `systemd が利用できないため ${BEACON_SERVICE} を再起動できません` });
      }
      // サービス操作は root 権限が必要。systemd 管理下の selfcode は root で動くため通常は直接、
      // user 実行時は password-less sudo で再試行する（sudo -n なので対話待ちはしない）。
      await runCmd(IS_ROOT ? "systemctl" : "sudo", IS_ROOT ? ["restart", BEACON_SERVICE] : ["-n", "systemctl", "restart", BEACON_SERVICE], 60000);
    }
    console.log("[selfcode] beacon collector restart requested" + (containerCtx ? ` (container: ${containerCtx.name})` : ""));
    res.json({ ok: true, target: containerCtx ? { name: containerCtx.name, runtime: containerCtx.runtime } : null });
  } catch (e) {
    if (res.headersSent) return next(e);
    res.status(500).json({ error: `${BEACON_SERVICE} の再起動に失敗しました: ${e.message}` });
  }
});

// beacon-collector サービス（エンドポイントの常駐プロセス）の停止・無効化（使用をやめるとき）。
// 再開は「再起動」か「再インストール」（endpoint install と enable --now で復帰する）。
app.post("/api/beacon/stop", async (req, res, next) => {
  try {
    if (containerCtx) {
      // コンテナ選択中はコンテナ内の beacon-collector をいじる
      const info = await beaconContainerStatus();
      if (!info.installed) {
        return res.status(400).json({ error: `コンテナ「${containerCtx.name}」内に beacon がインストールされていません` });
      }
      if (!info.service.available) {
        return res.status(500).json({ error: `コンテナ「${containerCtx.name}」内では systemd が利用できないため ${BEACON_SERVICE} を停止できません` });
      }
      await runContainer(["sh", "-c", "systemctl disable --now " + BEACON_SERVICE], { timeoutMs: 60000 });
    } else {
      if (!beaconBinPath()) {
        return res.status(400).json({ error: "beacon がインストールされていません" });
      }
      const svc = await beaconServiceInfo();
      if (!svc.available) {
        return res.status(500).json({ error: `systemd が利用できないため ${BEACON_SERVICE} を停止できません` });
      }
      // サービス操作は root 権限が必要。systemd 管理下の selfcode は root で動くため通常は直接、
      // user 実行時は password-less sudo で再試行する（sudo -n なので対話待ちはしない）。
      await runCmd(IS_ROOT ? "systemctl" : "sudo", IS_ROOT ? ["disable", "--now", BEACON_SERVICE] : ["-n", "systemctl", "disable", "--now", BEACON_SERVICE], 60000);
    }
    console.log("[selfcode] beacon collector stop requested" + (containerCtx ? ` (container: ${containerCtx.name})` : ""));
    res.json({ ok: true, target: containerCtx ? { name: containerCtx.name, runtime: containerCtx.runtime } : null });
  } catch (e) {
    if (res.headersSent) return next(e);
    res.status(500).json({ error: `${BEACON_SERVICE} の停止に失敗しました: ${e.message}` });
  }
});

// オンデマンドインストール（バックグラウンド実行。進捗は /api/beacon/status で取得）
app.post("/api/beacon/install", (req, res) => {
  if (beaconInstall.running) {
    return res.status(409).json({ error: "beacon のインストールが進行中です" });
  }
  startBeaconInstall();
  res.json({ ok: true });
});

// ================= 一時SSH（agy などの OAuth 認証を手元 PC から行えるようにする） =================
// 選択中の LXD コンテナ（未選択ならホスト）の sshd に対して、一時パスワードの設定と
// パスワード認証・root ログインの一時有効化を行い、OFF で元に戻す。
// ホストPCの場合はキーリング（D-Bus / Secret Service）を読み取れる環境変数設定も行う。
// 状態はサーバー再起動後も保持する（ON のまま再起動しても復元対象を失わないように）。
const SSH_TEMP_STATE_FILE = process.env.SELFCODE_SSH_STATE || SELFCODE_CONFIG_DIR + "/selfcode-ssh.json";
let sshTemp = { on: false, target: null }; // target: { type: "container", name } | { type: "host" }

// コンテナ内用の一時SSH有効化スクリプト（コンテナ内は既存動作のまま）
const SSH_TEMP_ON_CONTAINER = `
set -e
if [ ! -f /etc/ssh/sshd_config ]; then
  echo "[selfcode] sshd (openssh-server) がインストールされていません" >&2
  exit 1
fi
echo 'root:selfcode' | chpasswd
cp -a /etc/ssh/sshd_config /etc/ssh/sshd_config.selfcode-bak
cp -a /etc/shadow /etc/shadow.selfcode-bak
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/; s/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
mkdir -p /etc/ssh/sshd_config.d
printf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/00-selfcode-temp.conf
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || service sshd restart 2>/dev/null || true
# systemd が無いコンテナ等で再起動できなかった場合も、sshd を直接起動して反映する
sshd_bin="$(command -v sshd 2>/dev/null || true)"
if [ -n "$sshd_bin" ] && ! (pgrep -x sshd >/dev/null 2>&1 || pidof sshd >/dev/null 2>&1); then
  "$sshd_bin" >/dev/null 2>&1 || true
fi
echo "[selfcode] sshd を再起動しました"
`;

// コンテナ内用の一時SSH無効化スクリプト
const SSH_TEMP_OFF_CONTAINER = `
set -e
if [ -f /etc/ssh/sshd_config.selfcode-bak ]; then
  mv -f /etc/ssh/sshd_config.selfcode-bak /etc/ssh/sshd_config
fi
if [ -f /etc/shadow.selfcode-bak ]; then
  mv -f /etc/shadow.selfcode-bak /etc/shadow
fi
rm -f /etc/ssh/sshd_config.d/00-selfcode-temp.conf
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || service sshd restart 2>/dev/null || true
echo "[selfcode] SSH 設定を元に戻しました"
`;

// ホストPC用の一時SSH有効化スクリプト（パスワードは変更せず既存パスワードを使用、キーリング連携設定を含む）
function getSshTempOnHostScript() {
  return `
set -e
if [ ! -f /etc/ssh/sshd_config ]; then
  echo "[selfcode] sshd (openssh-server) がインストールされていません" >&2
  exit 1
fi
cp -a /etc/ssh/sshd_config /etc/ssh/sshd_config.selfcode-bak
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/; s/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
mkdir -p /etc/ssh/sshd_config.d
printf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/00-selfcode-temp.conf
# SSH ログイン時に対話シェル等で D-Bus / Secret Service キーリングを読み取れるよう profile.d に設定
mkdir -p /etc/profile.d
cat << 'EOF' > /etc/profile.d/00-selfcode-keyring.sh
# selfcode: SSH セッション等でユーザーの D-Bus / キーリング（Secret Service）を読み取れるようにする
_uid="$(id -u)"
if [ -d "/run/user/$_uid" ]; then
  [ -z "$XDG_RUNTIME_DIR" ] && export XDG_RUNTIME_DIR="/run/user/$_uid"
  [ -z "$DBUS_SESSION_BUS_ADDRESS" ] && [ -S "/run/user/$_uid/bus" ] && export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$_uid/bus"
  [ -z "$GNOME_KEYRING_CONTROL" ] && [ -d "/run/user/$_uid/keyring" ] && export GNOME_KEYRING_CONTROL="/run/user/$_uid/keyring"
fi
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ] && command -v dbus-launch >/dev/null 2>&1; then
  eval $(dbus-launch --sh-syntax 2>/dev/null || true)
fi
unset _uid
EOF
chmod 644 /etc/profile.d/00-selfcode-keyring.sh
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || service sshd restart 2>/dev/null || true
sshd_bin="$(command -v sshd 2>/dev/null || true)"
if [ -n "$sshd_bin" ] && ! (pgrep -x sshd >/dev/null 2>&1 || pidof sshd >/dev/null 2>&1); then
  "$sshd_bin" >/dev/null 2>&1 || true
fi
echo "[selfcode] sshd を再起動し、キーリング連携を設定しました（ホストのパスワードは変更していません）"
`;
}

// ホストPC用の一時SSH無効化スクリプト
const SSH_TEMP_OFF_HOST = `
set -e
if [ -f /etc/ssh/sshd_config.selfcode-bak ]; then
  mv -f /etc/ssh/sshd_config.selfcode-bak /etc/ssh/sshd_config
fi
rm -f /etc/ssh/sshd_config.d/00-selfcode-temp.conf
rm -f /etc/profile.d/00-selfcode-keyring.sh
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || service sshd restart 2>/dev/null || true
echo "[selfcode] SSH 設定およびキーリング連携設定を元に戻しました"
`;

const sshTempTargetLabel = (t) => (t && t.type === "container" ? `コンテナ「${t.name}」` : "ホスト");

async function runSshTempScript(script, target) {
  if (target.type === "container") {
    await runContainer(["sh", "-c", script], { timeoutMs: 60000 });
  } else {
    await runCmd("sh", ["-c", script], 60000);
  }
}

// 対象に sshd（openssh-server）が導入済みか判定する
async function sshdInstalled(target) {
  const check = "command -v sshd >/dev/null 2>&1 || test -f /etc/ssh/sshd_config";
  try {
    if (target.type === "container") await runContainer(["sh", "-c", check], { timeoutMs: 15000 });
    else await runCmd("sh", ["-c", check], 15000);
    return true;
  } catch {
    return false;
  }
}

// openssh-server をインストールする（未導入時に y が選ばれた場合）。
// Ubuntu/Debian (apt) と Arch/CachyOS (pacman) を自動判別し、その他 (apk/dnf/yum) にも対応する。
async function installOpensshServer(target) {
  const cmd =
    'if command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm openssh; ' +
    'elif command -v apt-get >/dev/null 2>&1; then apt-get update || true; DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server; ' +
    'elif command -v apk >/dev/null 2>&1; then apk add --no-cache openssh; ' +
    'elif command -v dnf >/dev/null 2>&1; then dnf install -y openssh-server; ' +
    'elif command -v yum >/dev/null 2>&1; then yum install -y openssh-server; ' +
    'else echo "[selfcode] 対応するパッケージマネージャが見つかりません（手動で openssh-server / openssh を導入してください）" >&2; exit 1; fi';
  if (target.type === "container") await runContainer(["sh", "-c", cmd], { timeoutMs: 300000 });
  else await runCmd("sh", ["-c", cmd], 300000);
}

// ホストの Tailscale マジックDNS名（tailnet 内のホスト名）を取得する。取得できなければ null
async function tailscaleMagicDns() {
  try {
    const bin = findBin("tailscale") || "tailscale";
    const out = await runCmd(bin, ["status", "--json"], 8000);
    const j = JSON.parse(out.toString("utf8"));
    const name = j && j.Self && j.Self.DNSName ? String(j.Self.DNSName).replace(/\.+$/, "") : "";
    return name || null;
  } catch {
    return null;
  }
}

async function sshTempGuideOn(target) {
  const isContainer = target && target.type === "container";
  const magic = await tailscaleMagicDns();
  if (isContainer) {
    const label = `コンテナ「${target.name}」`;
    const magicLine = magic
      ? `     Tailscale 利用時はマジックDNS名（ホスト名）でも接続できます:\r\n    例: ssh -L 8080:localhost:8080 root@${magic}\r\n`
      : "";
    return (
      `— 一時SSH: 有効化しました（対象: ${label}）—\r\n` +
      `  root パスワード : selfcode\r\n` +
      `  SSH ポート     : 22\r\n` +
      `\r\n` +
      `  1) 手元PCのターミナルで、コンテナへ SSH 接続して認証URLのコールバックポートを転送する:\r\n` +
      `       ssh -L <PORT>:localhost:<PORT> root@<コンテナのIP>\r\n` +
      `     例: ssh -L 8080:localhost:8080 root@192.168.1.10\r\n` +
      magicLine +
      `  2) 接続したら「agy」と入力して認証を開始する（認証 URL が表示される）\r\n` +
      `  3) 手元PCのブラウザで認証 URL を開いて認証する\r\n` +
      `\r\n` +
      `認証完了後は「一時SSH」ボタンをもう一度押して OFF にしてください。\r\n` +
      `コンテナに直接届かない場合（NAT配下など）は、ホスト側で sshd(22) を lxc config device proxy で転送してください。`
    );
  }

  // ホストPCの場合: パスワードは変更せず、既存パスワードで接続＆キーリングを読み取る案内
  const loginUser = TERM_USER || "user";
  const magicLine = magic
    ? `     Tailscale 利用時はマジックDNS名（ホスト名）でも接続できます:\r\n    例: ssh -L 8080:localhost:8080 ${loginUser}@${magic}\r\n`
    : "";
  return (
    `— 一時SSH: 有効化しました（対象: ホスト）—\r\n` +
    `  SSH 接続ユーザー: ${loginUser}\r\n` +
    `  SSH パスワード  : （${loginUser} の現在のログインパスワード）\r\n` +
    `  SSH ポート      : 22\r\n` +
    `  キーリング連携  : 有効（D-Bus / Secret Service 経由でキーリングを読み取ります）\r\n` +
    `\r\n` +
    `  1) 手元PCのターミナルで、ホストへ SSH 接続して認証URLのコールバックポートを転送する:\r\n` +
    `       ssh -L <PORT>:localhost:<PORT> ${loginUser}@<ホストのIP>\r\n` +
    `     例: ssh -L 8080:localhost:8080 ${loginUser}@192.168.1.10\r\n` +
    magicLine +
    `  2) 接続したら「agy」と入力して認証を開始する（認証 URL が表示されます）\r\n` +
    `     ※ ホスト側のキーリングを読み取れる状態で実行され、認証トークンが保存されます\r\n` +
    `  3) 手元PCのブラウザで認証 URL を開いて認証する\r\n` +
    `\r\n` +
    `認証完了後は「一時SSH」ボタンをもう一度押して OFF にしてください（SSH / キーリング設定を元に戻します）。`
  );
}

app.get("/api/ssh-temp", (req, res) => {
  res.json({
    on: sshTemp.on,
    target: sshTemp.target,
    container: containerCtx ? { name: containerCtx.name, runtime: containerCtx.runtime } : null,
    termUser: TERM_USER,
  });
});

app.post("/api/ssh-temp", async (req, res, next) => {
  try {
    const on = !!req.body.on;
    // 既に同じ状態なら何もしない（ON の再実行でバックアップを上書きしないようにする）
    if (on === sshTemp.on) {
      return res.json({ ok: true, on: sshTemp.on, target: sshTemp.target });
    }
    const target = on ? (containerCtx ? { type: "container", name: containerCtx.name } : { type: "host" }) : sshTemp.target || (containerCtx ? { type: "container", name: containerCtx.name } : { type: "host" });
    if (on && target.type === "host" && !IS_ROOT) {
      return res.status(403).json({ error: "ホスト側の一時SSHには root 権限が必要です" });
    }
    if (on) {
      // openssh-server 未導入なら何も変更せず、インストールするか確認するための応答を返す
      if (!req.body.installSshd && !(await sshdInstalled(target))) {
        return res.status(409).json({ error: "openssh-server がインストールされていません", needSshdInstall: true, target });
      }
      // y（installSshd）が選ばれたら openssh-server をインストールしてから有効化する
      if (req.body.installSshd) {
        await installOpensshServer(target);
      }
      const script = target.type === "container" ? SSH_TEMP_ON_CONTAINER : getSshTempOnHostScript();
      await runSshTempScript(script, target);
      sshTemp = { on: true, target };
    } else {
      const script = target.type === "container" ? SSH_TEMP_OFF_CONTAINER : SSH_TEMP_OFF_HOST;
      await runSshTempScript(script, target);
      sshTemp = { on: false, target: null };
    }
    writeStateFile(SSH_TEMP_STATE_FILE, sshTemp).catch(() => {});
    res.json({ ok: true, on: sshTemp.on, target: sshTemp.target, guide: on ? await sshTempGuideOn(target) : "— 一時SSH: 無効化しました（SSH 設定を元に戻しました）—" });
  } catch (e) {
    next(e);
  }
});

// サーバー起動時に前回の状態を復元する（ON のまま再起動された場合もボタンと復元対象を維持）
readStateFile(SSH_TEMP_STATE_FILE, null).then((s) => {
  if (s && s.on) sshTemp = { on: true, target: s.target || null };
});

app.get("/api/tree", async (req, res, next) => {
  try {
    const showHidden = req.query.hidden === "1";
    if (containerCtx) return res.json(await containerTree(req.query.path || "", showHidden));
    const abs = resolveRel(req.query.path || "");
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) return res.status(400).json({ error: "not a directory" });
    const names = await fsp.readdir(abs);
    const entries = [];
    for (const name of names) {
      if (!showHidden && (name.startsWith(".") || HIDDEN.has(name))) continue;
      const full = path.join(abs, name);
      let type = "file";
      try {
        const s = await fsp.stat(full);
        type = s.isDirectory() ? "dir" : "file";
      } catch {
        continue;
      }
      entries.push({ name, type, path: relOf(full) });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    res.json({ path: relOf(abs), entries });
  } catch (e) {
    next(e);
  }
});

app.get("/api/file", async (req, res, next) => {
  try {
    if (!String(req.query.path || "")) return res.status(400).json({ error: "path required" });
    if (containerCtx) {
      const p = String(req.query.path || "");
      const { stdout } = await runContainer(["cat", p], { timeoutMs: 60000 });
      if (req.query.download === "1") {
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-disposition", `attachment; filename="${path.posix.basename(p)}"`);
        res.setHeader("content-length", stdout.length);
        return res.end(stdout);
      }
      const isBinary = stdout.includes(0);
      if (isBinary) {
        return res.json({ path: p, type: "binary", size: stdout.length, mtime: Date.now(), base64: stdout.toString("base64") });
      }
      return res.json({ path: p, type: "text", content: stdout.toString("utf8"), size: stdout.length, mtime: Date.now() });
    }
    const abs = resolveRel(req.query.path);
    const buf = await fsp.readFile(abs);
    const st = await fsp.stat(abs);
    if (req.query.download === "1") {
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", `attachment; filename="${path.basename(abs)}"`);
      res.setHeader("content-length", buf.length);
      return res.end(buf);
    }
    const isBinary = buf.includes(0);
    if (isBinary) {
      res.json({ path: relOf(abs), type: "binary", size: st.size, mtime: st.mtimeMs, base64: buf.toString("base64") });
    } else {
      res.json({ path: relOf(abs), type: "text", content: buf.toString("utf8"), size: st.size, mtime: st.mtimeMs });
    }
  } catch (e) {
    next(e);
  }
});

app.put("/api/file", async (req, res, next) => {
  try {
    const { path: p, content, base64 } = req.body;
    if (!p) return res.status(400).json({ error: "path required" });
    if (containerCtx) {
      const buf = base64 ? Buffer.from(base64, "base64") : Buffer.from(String(content ?? ""), "utf8");
      const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      if (parent) await runContainer(["mkdir", "-p", parent]);
      await runContainer(["tee", p], { input: buf });
      return res.json({ ok: true, path: p });
    }
    const abs = resolveRel(p);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (base64) await fsp.writeFile(abs, Buffer.from(base64, "base64"));
    else await fsp.writeFile(abs, String(content ?? ""));
    res.json({ ok: true, path: relOf(abs) });
  } catch (e) {
    next(e);
  }
});

// アップロード: raw body をそのままファイルに書き込む（JSON ベースの PUT /api/file より大きなファイル向け）
app.post("/api/file/upload", express.raw({ type: "application/octet-stream", limit: "512mb" }), async (req, res, next) => {
  try {
    const dir = String(req.query.dir || "");
    const name = path.posix.basename(String(req.query.name || ""));
    if (!name) return res.status(400).json({ error: "name required" });
    if (containerCtx) {
      const target = dir ? dir + "/" + name : name;
      if (dir) await runContainer(["mkdir", "-p", dir]);
      await runContainer(["tee", target], { input: req.body });
      return res.json({ ok: true, path: target });
    }
    const abs = resolveRel(dir ? dir + "/" + name : name);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, req.body);
    res.json({ ok: true, path: relOf(abs) });
  } catch (e) {
    next(e);
  }
});

app.post("/api/file/rename", async (req, res, next) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).json({ error: "from and to required" });
    if (containerCtx) {
      const parent = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
      if (parent) await runContainer(["mkdir", "-p", parent]);
      await runContainer(["mv", from, to]);
      return res.json({ ok: true });
    }
    const a = resolveRel(from);
    const b = resolveRel(to);
    assertNotRoot(a);
    assertNotRoot(b);
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post("/api/file/mkdir", async (req, res, next) => {
  try {
    if (containerCtx) {
      const p = String(req.body.path || "");
      await runContainer(["mkdir", "-p", p]);
      return res.json({ ok: true, path: p });
    }
    const abs = resolveRel(req.body.path || "");
    await fsp.mkdir(abs, { recursive: true });
    res.json({ ok: true, path: relOf(abs) });
  } catch (e) {
    next(e);
  }
});

app.delete("/api/file", async (req, res, next) => {
  try {
    if (!String(req.query.path || "")) return res.status(400).json({ error: "path required" });
    if (containerCtx) {
      await runContainer(["rm", "-rf", String(req.query.path || "")]);
      return res.json({ ok: true });
    }
    const abs = resolveRel(req.query.path);
    assertNotRoot(abs);
    await fsp.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---- フォルダの ZIP ダウンロード（STORE・無圧縮の最小実装、依存ライブラリなし） ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

app.get("/api/file/zip", async (req, res, next) => {
  try {
    if (containerCtx) {
      // コンテナ内は tar -C で直接 tar.gz をストリーミングする
      const p = String(req.query.path || "");
      const base = p.split("/").filter(Boolean).pop() || "root";
      const child = spawn(containerBin(containerCtx.runtime), containerExecArgs(containerCtx.runtime, containerCtx.name, false).concat(["tar", "-C", p || "/", "-czf", "-", "."]), {
        stdio: ["ignore", "pipe", "ignore"],
      });
      res.setHeader("content-type", "application/gzip");
      res.setHeader("content-disposition", `attachment; filename="${base}.tar.gz"`);
      child.stdout.pipe(res);
      child.on("error", (e) => {
        if (!res.headersSent) res.status(500).json({ error: e.message });
        else res.destroy();
      });
      return;
    }
    const abs = resolveRel(req.query.path || "");
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) return res.status(400).json({ error: "not a directory" });

    // ツリー全体を収集する（隠しファイルも含む）
    const entries = []; // { name, data|null }
    const base = path.basename(abs);
    async function walk(dir, rel) {
      const names = await fsp.readdir(dir);
      for (const name of names) {
        const full = path.join(dir, name);
        const relName = rel ? rel + "/" + name : name;
        let s;
        try {
          s = await fsp.stat(full);
        } catch {
          continue;
        }
        if (s.isDirectory()) {
          entries.push({ name: relName + "/", data: null });
          await walk(full, relName);
        } else {
          entries.push({ name: relName, data: await fsp.readFile(full) });
        }
      }
    }
    await walk(abs, "");

    const { time, date } = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    const addEntry = (name, data) => {
      const nameBuf = Buffer.from(name, "utf8");
      const size = data ? data.length : 0;
      const crc = data ? crc32(data) : 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); // local file header signature
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0, 6); // flags
      local.writeUInt16LE(0, 8); // method: store
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(size, 18); // compressed size
      local.writeUInt32LE(size, 22); // uncompressed size
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28); // extra field length
      chunks.push(local, nameBuf);
      if (data) chunks.push(data);
      central.push({ nameBuf, crc, size, offset });
      offset += 30 + nameBuf.length + size;
    };

    for (const e of entries) addEntry(e.name, e.data);

    const cdStart = offset;
    const cdChunks = [];
    for (const c of central) {
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(0x02014b50, 0); // central directory signature
      rec.writeUInt16LE(20, 4); // version made by
      rec.writeUInt16LE(20, 6); // version needed
      rec.writeUInt16LE(0, 8); // flags
      rec.writeUInt16LE(0, 10); // method
      rec.writeUInt16LE(time, 12);
      rec.writeUInt16LE(date, 14);
      rec.writeUInt32LE(c.crc, 16);
      rec.writeUInt32LE(c.size, 20);
      rec.writeUInt32LE(c.size, 24);
      rec.writeUInt16LE(c.nameBuf.length, 28);
      rec.writeUInt16LE(0, 30); // extra field length
      rec.writeUInt16LE(0, 32); // comment length
      rec.writeUInt16LE(0, 34); // disk number start
      rec.writeUInt16LE(0, 36); // internal attrs
      rec.writeUInt32LE(0, 38); // external attrs
      rec.writeUInt32LE(c.offset, 42); // local header offset
      cdChunks.push(rec, c.nameBuf);
    }
    const cdBuf = Buffer.concat(cdChunks);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // cd disk number
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20); // comment length

    const zip = Buffer.concat([...chunks, cdBuf, eocd]);
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-disposition", `attachment; filename="${base}.zip"`);
    res.setHeader("content-length", zip.length);
    res.end(zip);
  } catch (e) {
    next(e);
  }
});

// メモ機能: 固定パスのメモファイルを読み書きする（ワークスペース外でも使えるように専用エンドポイント）
app.get("/api/memo", async (req, res, next) => {
  try {
    await fsp.mkdir(path.dirname(MEMO_FILE), { recursive: true });
    let content = "";
    try {
      content = (await fsp.readFile(MEMO_FILE)).toString("utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await fsp.writeFile(MEMO_FILE, "");
    }
    res.json({ path: MEMO_FILE, content });
  } catch (e) {
    next(e);
  }
});

app.put("/api/memo", async (req, res, next) => {
  try {
    await fsp.mkdir(path.dirname(MEMO_FILE), { recursive: true });
    await fsp.writeFile(MEMO_FILE, String(req.body.content ?? ""));
    res.json({ ok: true, path: MEMO_FILE });
  } catch (e) {
    next(e);
  }
});

// ================= セッション状態の共有 =================
// 別のPCから同じ selfcode を開いても同じセッション（ターミナル）に
// 接続できるよう、ブラウザの localStorage にしか無かった状態をサーバー側にも保存する。
const TERM_STATE_FILE = process.env.SELFCODE_TERM_STATE || SELFCODE_CONFIG_DIR + "/selfcode-term.json";

// JSON ファイルを読み込む（無ければ fallback を返す）
async function readStateFile(file, fallback) {
  try {
    return JSON.parse((await fsp.readFile(file)).toString("utf8"));
  } catch {
    return fallback;
  }
}

async function writeStateFile(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2));
}

// ターミナルのペイン構成（分割・cwd・id・フォーカス）。id ごとにサーバー側の
// プロセスが保持されているため、別のPCから同じ構成で接続すると同じターミナルに繋がる。
app.get("/api/term/state", async (req, res, next) => {
  try {
    res.json({ state: await readStateFile(TERM_STATE_FILE, null) });
  } catch (e) {
    next(e);
  }
});

app.put("/api/term/state", async (req, res, next) => {
  try {
    const state = req.body && req.body.state;
    if (state === undefined) return res.status(400).json({ error: "state required" });
    await writeStateFile(TERM_STATE_FILE, state);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ================= GitHub 連携 =================
// 設定（ユーザー名・トークン・登録リポジトリ）はサーバー側の JSON に保存し、トークンをブラウザに返さない。
// git 操作はワークスペース内（コンテナ内ではコンテナ側）で実行する。
const GITHUB_CONFIG = process.env.SELFCODE_GITHUB_CONFIG || SELFCODE_CONFIG_DIR + "/selfcode-github.json";
// 設定1/設定2 の2プロファイルを保持し、アクティブな方を GitHub 連携（API・git 認証・リポジトリ登録）に使用する
let githubCfg = { active: 0, settings: [{ username: "", token: "", repos: [] }, { username: "", token: "", repos: [] }] };

function normalizeGithubData(d) {
  // コミット設定（git config --global の user.name / user.email）もプロファイルごとに保持する
  // （ユーザーが一度も保存していない場合は undefined → JSON には出力されず、
  //   「未保存」を判別して実gitconfigの値へフォールバック表示する）
  const mk = (x = {}) => ({
    username: String(x.username || ""),
    token: String(x.token || ""),
    repos: Array.isArray(x.repos) ? x.repos : [],
    ...(x.commitName != null ? { commitName: String(x.commitName) } : {}),
    ...(x.commitEmail != null ? { commitEmail: String(x.commitEmail) } : {}),
  });
  const settings = [mk(d && d.settings && d.settings[0]), mk(d && d.settings && d.settings[1])];
  // 旧形式（単一設定ファイル）は設定1に引き継ぐ
  if (!Array.isArray(d && d.settings) && d && (d.username || d.token || (d.repos && d.repos.length))) {
    settings[0] = mk(d);
  }
  const active = d && (d.active === 0 || d.active === 1) ? d.active : 0;
  return { active, settings };
}

async function loadGithubConfig() {
  try {
    const raw = await fsp.readFile(GITHUB_CONFIG, "utf8");
    const d = JSON.parse(raw);
    githubCfg = normalizeGithubData(d);
  } catch {}
}

async function saveGithubConfig() {
  await fsp.mkdir(path.dirname(GITHUB_CONFIG), { recursive: true });
  await fsp.writeFile(GITHUB_CONFIG, JSON.stringify(githubCfg, null, 2));
}

// 現在アクティブな設定（設定1 / 設定2）
function ghCur() {
  if (!githubCfg.settings || githubCfg.settings.length !== 2) {
    githubCfg = normalizeGithubData(githubCfg);
  }
  return githubCfg.settings[githubCfg.active];
}

// GitHub REST API（トークンはサーバー側でのみ使用）
async function ghApi(p, opts = {}) {
  const cur = ghCur();
  if (!cur.token) {
    const e = new Error("GitHub トークンが設定されていません");
    e.status = 400;
    throw e;
  }
  let res;
  try {
    res = await fetch("https://api.github.com" + p, {
      method: opts.method || "GET",
      headers: {
        authorization: "Bearer " + cur.token,
        accept: "application/vnd.github+json",
        "user-agent": "selfcode",
        "x-github-api-version": "2022-11-28",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    const err = new Error("GitHub API に接続できません: " + e.message);
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    let msg = "GitHub API " + res.status;
    try {
      const d = await res.json();
      if (d && d.message) msg = d.message;
    } catch {}
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// トークンを git の認証に使うための引数。ヘッダはそのコマンドの実行時だけ渡し、
// .git/config には保存しない。送信先は github.com のみに限定する（他ホストへトークンを送らない）。
function gitAuthArgs(url) {
  const cur = ghCur();
  if (!cur.token || !String(url || "").includes("github.com")) return [];
  // 登録済みユーザー名とPATを使う（GitHub は基本認証のユーザー名を検証しないため、
  // ユーザー名未登録時は慣例の x-access-token にフォールバックする）
  const user = cur.username || "x-access-token";
  const auth = "basic " + Buffer.from(user + ":" + cur.token).toString("base64");
  return ["-c", "credential.helper=", "-c", "core.askPass=true", "-c", "http.extraheader=AUTHORIZATION: " + auth];
}

// 所有権が異なるリポジトリ（例: root で稼働するサーバーから別ユーザー所有のリポジトリを操作）でも
// git が拒否しないよう safe.directory を付与する（dubious ownership 対策）。
const GIT_SAFE_DIR = ["-c", "safe.directory=*"];

// git バイナリを解決する。PATH に無い環境（systemd の縮小 PATH 等）でも一般的な場所を探す。
function gitBin() {
  const found = findBin("git");
  if (found) return found;
  for (const c of ["/usr/bin/git", "/usr/local/bin/git", "/snap/bin/git", "/opt/homebrew/bin/git"]) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return "git";
}

function runGitSpawn(cwd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(gitBin(), [...GIT_SAFE_DIR, ...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e.message) });
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const to = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs || 60000);
    child.on("error", (e) => {
      clearTimeout(to);
      let msg = String(e.message);
      if (e.code === "ENOENT") {
        msg = "git コマンドが見つかりません。サーバー側で git をインストールするか、PATH を確認してください";
      }
      resolve({ code: -1, stdout: out, stderr: err + msg });
    });
    child.on("close", (code) => {
      clearTimeout(to);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

// コンテナ内で git を実行する（cwd はコンテナ内の /）
function runGitInContainer(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(containerBin(containerCtx.runtime), [...containerExecArgs(containerCtx.runtime, containerCtx.name, false), "git", ...GIT_SAFE_DIR, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e.message) });
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const to = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs || 60000);
    child.on("error", (e) => {
      clearTimeout(to);
      resolve({ code: -1, stdout: out, stderr: err + String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(to);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

// 登録済みリポジトリ（ワークスペース内の相対パス）で git コマンドを実行する。
async function gitOriginUrl(relDir) {
  if (containerCtx) {
    const r = await runGitInContainer(["-C", relDir, "config", "--get", "remote.origin.url"], 10000);
    return (r.stdout || "").trim();
  }
  const r = await runGitSpawn(resolveDirRel(relDir), ["config", "--get", "remote.origin.url"], 10000);
  return (r.stdout || "").trim();
}

async function runGit(relDir, args, timeoutMs) {
  const origin = await gitOriginUrl(relDir).catch(() => "");
  const auth = gitAuthArgs(origin);
  if (containerCtx) return runGitInContainer([...auth, "-C", relDir, ...args], timeoutMs);
  return runGitSpawn(resolveDirRel(relDir), [...auth, ...args], timeoutMs);
}

// git status -sb の出力から ブランチ・ahead/behind・変更ファイル（数と一覧）を取り出す
async function repoGitStatus(relDir) {
  const r = await runGit(relDir, ["status", "-sb"], 30000);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "git status failed").trim());
  const lines = (r.stdout || "").split("\n");
  let branch = "";
  let ahead = 0;
  let behind = 0;
  const files = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (i === 0) {
      const first = line.trim();
      if (first.startsWith("## ")) {
        let rest = first.slice(3);
        // コミットがまだ無いリポジトリ ("## No commits yet on main") はそのままブランチ名にする
        const mInit = rest.match(/^(?:No commits yet on|Initial commit on)\s+(\S+)/);
        if (mInit) {
          branch = mInit[1];
          rest = "";
        } else {
          const mUp = rest.match(/^(.+?)\.\.\.(.*)$/);
          if (mUp) {
            branch = mUp[1].trim();
            rest = mUp[2];
          } else {
            const mBr = rest.match(/^(\S+)/);
            branch = mBr ? mBr[1] : rest;
            rest = "";
          }
          const mB = rest.match(/\[([^\]]*)\]$/);
          if (mB) {
            for (const part of mB[1].split(",")) {
              const p = part.trim();
              let mm = p.match(/^ahead (\d+)$/);
              if (mm) ahead = Number(mm[1]);
              mm = p.match(/^behind (\d+)$/);
              if (mm) behind = Number(mm[1]);
            }
          }
        }
      }
    } else if (line.trim()) {
      files.push(parseStatusFileLine(line));
    }
  }
  const dirty = files.length;
  return { branch, ahead, behind, dirty, files };
}

// リモート（origin）の既定ブランチ名を取得する。取得できない場合は空文字。
async function remoteDefaultBranch(relDir) {
  const r = await runGit(relDir, ["ls-remote", "--symref", "origin", "HEAD"], 30000);
  if (r.code !== 0) return "";
  const m = (r.stdout || "").match(/^ref:\s+refs\/heads\/([^\s]+)/m);
  return m ? m[1] : "";
}

// git status -sb の変更ファイル行（" M foo.txt" / "M  foo.txt" / "?? new.txt" / "R  old -> new" など）から
// 状態コードとパスを取り出す
function parseStatusFileLine(line) {
  let f = line.slice(3);
  // リネーム/コピーは "旧 -> 新" 形式なので新しいパスを採用する
  const arrow = f.indexOf(" -> ");
  if (arrow >= 0) f = f.slice(arrow + 4);
  // core.quotepath による引用符（C エスケープ）を外す
  if (f.startsWith('"') && f.endsWith('"')) {
    try { f = JSON.parse(f); } catch { f = f.slice(1, -1); }
  }
  return { code: line.slice(0, 2).trim() || "?", path: f };
}

// "Deleted branch foo (was ...)" / "Would delete branch foo (was ...)" の出力から
// ブランチ名を取り出す（git branch --delete-merged 用。Git 2.56+）
function parseDeleteMergedOutput(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/(?:Would delete|Deleted) branch (\S+) \(was [0-9a-f]+\)/);
    if (m) out.push(m[1].replace(/\.$/, ""));
  }
  return out;
}

// git branch --delete-merged が使えない古い git か判定する
function isDeleteMergedUnsupported(r) {
  const t = (r.stdout || "") + "\n" + (r.stderr || "");
  return /unknown option|unknown.*delete-merged|not a (valid|git)|invalid/i.test(t);
}

function githubRepoId() {
  return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function sanitizeRel(p) {
  if (String(p).split("/").some((x) => x === "..")) {
    const e = new Error("パスに .. は使えません");
    e.status = 400;
    throw e;
  }
}

// 設定の状態（トークン自体は返さない。設定1/設定2 両方の状態とアクティブ番号を返す）
app.get("/api/github/status", (req, res) => {
  const cur = ghCur();
  res.json({
    configured: !!(cur.username && cur.token),
    username: cur.username || null,
    hasToken: !!cur.token,
    repos: cur.repos.map((r) => ({ id: r.id, name: r.name, path: r.path, url: r.url })),
    active: githubCfg.active,
    profiles: githubCfg.settings.map((s) => ({
      configured: !!(s.username && s.token),
      username: s.username || null,
      hasToken: !!s.token,
      reposCount: (s.repos || []).length,
    })),
  });
});

// ユーザー名・トークンを保存（アクティブな設定に対して適用。
// トークン欄が空で保存済みトークンがあれば既存を維持）。保存後に検証も行う。
app.put("/api/github/settings", async (req, res, next) => {
  try {
    const cur = ghCur();
    const username = String(req.body.username || "").trim();
    let token = String(req.body.token || "").trim();
    if (!token && cur.token) token = cur.token;
    if (!username) return res.status(400).json({ error: "ユーザー名を入力してください" });
    if (!token) return res.status(400).json({ error: "トークンを入力してください" });
    cur.username = username;
    cur.token = token;
    await saveGithubConfig();
    let user = null;
    let verifyErr = null;
    try {
      user = await ghApi("/user");
    } catch (e) {
      verifyErr = e.message;
    }
    res.json({
      ok: true,
      configured: true,
      verified: !!user,
      user: user ? { login: user.login, name: user.name } : null,
      error: verifyErr,
      active: githubCfg.active,
    });
  } catch (e) {
    next(e);
  }
});

// アクティブな設定を切り替える（設定1 / 設定2）。
// 切替後、新しいプロファイルにコミット設定が保存済みなら git config --global へ再適用する。
app.post("/api/github/settings/active", async (req, res, next) => {
  try {
    const index = req.body.index | 0;
    if (index !== 0 && index !== 1) return res.status(400).json({ error: "index は 0 または 1 を指定してください" });
    githubCfg.active = index;
    await saveGithubConfig();
    const cur = ghCur();
    let commitApplied = null;
    let commitApplyError = null;
    if (cur.commitName != null || cur.commitEmail != null) {
      try {
        await runGitConfigSet("user.name", cur.commitName || "");
        await runGitConfigSet("user.email", cur.commitEmail || "");
        commitApplied = { name: cur.commitName || "", email: cur.commitEmail || "", target: gitConfigTargetLabel() };
      } catch (err) {
        commitApplyError = err.message;
      }
    }
    res.json({
      ok: true,
      active: index,
      configured: !!(cur.username && cur.token),
      username: cur.username || null,
      hasToken: !!cur.token,
      commitApplied,
      commitApplyError,
    });
  } catch (e) {
    next(e);
  }
});

// 設定（ユーザー名・トークン）をクリア（アクティブな設定を対象）
app.delete("/api/github/settings", async (req, res, next) => {
  try {
    const cur = ghCur();
    cur.username = "";
    cur.token = "";
    await saveGithubConfig();
    res.json({ ok: true, configured: false, active: githubCfg.active });
  } catch (e) {
    next(e);
  }
});

// git config --global user.name / user.email の取得・保存
// コンテナ選択中はそのコンテナ内の git config --global を対象にする
function gitConfigTargetLabel() {
  return containerCtx ? `コンテナ「${containerCtx.name}」` : "ホスト";
}

async function runGitConfigGet(key) {
  if (containerCtx) {
    const r = await runGitInContainer(["config", "--global", key], 10000);
    return r.code === 0 ? (r.stdout || "").trim() : "";
  }
  const { code, stdout } = await new Promise((resolve) => {
    const child = spawn("git", ["config", "--global", key], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve({ code: -1, stdout: "" }));
    child.on("close", (code) => resolve({ code, stdout: out }));
  });
  return code === 0 ? stdout.trim() : "";
}

async function runGitConfigSet(key, value) {
  if (containerCtx) {
    const args = value ? ["config", "--global", key, value] : ["config", "--global", "--unset", key];
    await runGitInContainer(args, 10000);
    return;
  }
  if (!value) {
    await new Promise((resolve) => {
      const child = spawn("git", ["config", "--global", "--unset", key], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", () => {});
      child.on("close", () => resolve());
    });
    return;
  }
  await new Promise((resolve) => {
    const child = spawn("git", ["config", "--global", key, value], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.on("close", () => resolve());
  });
}

app.get("/api/github/git-config", async (req, res, next) => {
  try {
    // プロファイルにコミット設定を保存済みならその値を返す。
    // タブ切替だけで表示が変わるようにするための優先表示。
    const cur = ghCur();
    if (cur.commitName != null || cur.commitEmail != null) {
      return res.json({ name: cur.commitName || "", email: cur.commitEmail || "", target: gitConfigTargetLabel() });
    }
    const name = await runGitConfigGet("user.name");
    const email = await runGitConfigGet("user.email");
    res.json({ name, email, target: gitConfigTargetLabel() });
  } catch (e) {
    next(e);
  }
});

app.put("/api/github/git-config", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    const email = String(req.body.email ?? "").trim();
    // 実gitconfigに反映しつつ、アクティブなプロファイルにも保存する（切替時に再適用できるように）
    await runGitConfigSet("user.name", name);
    await runGitConfigSet("user.email", email);
    const cur = ghCur();
    cur.commitName = name;
    cur.commitEmail = email;
    await saveGithubConfig();
    res.json({ ok: true, name, email, target: gitConfigTargetLabel() });
  } catch (e) {
    next(e);
  }
});

// 現在の場所（ホストまたは選択中のコンテナ）の git config --global --list を表示
app.get("/api/github/git-config/list", async (req, res, next) => {
  try {
    const r = containerCtx
      ? await runGitInContainer(["config", "--global", "--list"], 10000)
      : await runGitSpawn(ROOT, ["config", "--global", "--list"], 10000);
    const output = ((r.stdout || "") + (r.stderr || "")).trim();
    res.json({ ok: r.code === 0, target: gitConfigTargetLabel(), output });
  } catch (e) {
    next(e);
  }
});

// 入力中の user.name / user.email を全ユーザーの ~/.gitconfig に適用する。
// 対象は root と実ユーザー（uid 1000..65533、ログインシェル持ち）。他ユーザー分は
// git config --file で各ホームの .gitconfig に直接書き込み、所有者をそのユーザーに戻す。
function listGitTargetUsers() {
  const users = [];
  try {
    const passwd = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const parts = line.split(":");
      if (parts.length < 7) continue;
      const name = parts[0];
      const uid = Number(parts[2]);
      const gid = Number(parts[3]);
      const home = parts[5];
      const shell = parts[6];
      if (!name || !home) continue;
      if (!Number.isFinite(uid) || !Number.isFinite(gid)) continue;
      const isRoot = uid === 0 && name === "root";
      const isRealUser = uid >= 1000 && uid < 65534;
      if (!isRoot && !isRealUser) continue;
      if (shell && (shell.includes("nologin") || shell === "/bin/false" || shell === "/usr/sbin/nologin")) continue;
      users.push({ name, uid, gid, home });
    }
  } catch {}
  return users;
}

async function runGitConfigArgs(args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, err: e.message }));
    child.on("close", (code) => resolve({ code, err }));
  });
}

async function applyGitConfigToUser(u, name, email) {
  try {
    if (!fs.existsSync(u.home)) return { user: u.name, ok: false, error: "ホームディレクトリがありません" };
    const myUid = typeof process.getuid === "function" ? process.getuid() : -1;
    const isSelf = u.uid === myUid;
    if (!isSelf && !IS_ROOT) return { user: u.name, ok: false, error: "root 権限が必要です" };
    const file = path.join(u.home, ".gitconfig");
    for (const [key, value] of [["user.name", name], ["user.email", email]]) {
      if (isSelf) {
        // 自分自身にはこれまで通り git config --global を使う
        await runGitConfigSet(key, value);
        continue;
      }
      const args = value ? ["config", "--file", file, key, value] : ["config", "--file", file, "--unset", key];
      const { code, err } = await runGitConfigArgs(args);
      // --unset はキーが存在しなくても失敗扱いにしない
      if (code !== 0 && value) {
        return { user: u.name, ok: false, error: (err || "").trim() || `git config ${key} 失敗` };
      }
    }
    if (!isSelf) {
      try { fs.chownSync(file, u.uid, u.gid); } catch {}
    }
    return { user: u.name, ok: true };
  } catch (e) {
    return { user: u.name, ok: false, error: e.message };
  }
}

app.post("/api/github/git-config/apply-all", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    const email = String(req.body.email ?? "").trim();
    // 非 root で動いている場合は自分以外の適用が失敗するので、その結果をそのまま返す
    const targets = listGitTargetUsers();
    const results = [];
    for (const u of targets) results.push(await applyGitConfigToUser(u, name, email));
    res.json({ ok: results.every((r) => r.ok), results });
  } catch (e) {
    next(e);
  }
});

// トークンの接続確認（GitHub ユーザー情報を取得）
app.get("/api/github/user", async (req, res, next) => {
  try {
    const u = await ghApi("/user");
    res.json({ login: u.login, name: u.name, avatar_url: u.avatar_url, html_url: u.html_url });
  } catch (e) {
    next(e);
  }
});

// 自分のリポジトリ一覧（追加フォームの「自分のリポジトリから選ぶ」用）
app.get("/api/github/repos", async (req, res, next) => {
  try {
    const per = Math.min(Number(req.query.per_page) || 100, 100);
    const data = await ghApi("/user/repos?per_page=" + per + "&sort=updated");
    res.json(
      (Array.isArray(data) ? data : []).map((r) => ({
        full_name: r.full_name,
        clone_url: r.clone_url,
        html_url: r.html_url,
        default_branch: r.default_branch,
        private: !!r.private,
        description: r.description || "",
      }))
    );
  } catch (e) {
    next(e);
  }
});

// 登録済みリポジトリ一覧（ブランチ・ahead/behind・変更数も付ける）
app.get("/api/github/repos/registered", async (req, res, next) => {
  try {
    const out = [];
    for (const r of ghCur().repos) {
      let st = null;
      try {
        st = await repoGitStatus(r.path);
      } catch (e) {
        st = { error: e.message };
      }
      out.push({ id: r.id, name: r.name, path: r.path, url: r.url, ...(st || {}) });
    }
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// リポジトリをクローンして登録（owner/repo 形式も受け付ける）
app.post("/api/github/repos", async (req, res, next) => {
  try {
    let url = String(req.body.url || "").trim();
    const dir = String(req.body.dir || "").trim().replace(/^\/+|\/+$/g, "");
    if (!url) return res.status(400).json({ error: "リポジトリの URL を入力してください" });
    if (!/^https?:\/\//.test(url)) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(url)) {
        return res.status(400).json({ error: "URL または owner/repo 形式で入力してください" });
      }
      url = "https://github.com/" + url + ".git";
    }
    const m = url.match(/\/([^\/]+?)(?:\.git)?\/?$/);
    const defaultName = (m && m[1]) || "repo";
    const target = dir || defaultName;
    sanitizeRel(target);
    let r;
    if (containerCtx) {
      try {
        await runContainer(["test", "-e", target]);
        return res.status(400).json({ error: "フォルダが既に存在します: " + target });
      } catch {}
      r = await runGitInContainer([...gitAuthArgs(url), "clone", url, target], 180000);
    } else {
      const abs = resolveDirRel(target);
      try {
        await fsp.access(abs);
        return res.status(400).json({ error: "フォルダが既に存在します: " + target });
      } catch {}
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      r = await runGitSpawn(ROOT, [...gitAuthArgs(url), "clone", url, target], 180000);
    }
    if (r.code !== 0) {
      return res.status(500).json({ error: "クローンに失敗しました", output: (r.stdout + r.stderr).trim() });
    }
    // リモートの既定ブランチ改名に気づけるよう fetch.followRemoteHEAD を有効化する
    // （値は create/warn/always/never の列挙型。warn = HEAD 差異を警告＋無ければ作成）
    await runGit(target, ["config", "fetch.followRemoteHEAD", "warn"], 10000).catch(() => {});
    const repo = { id: githubRepoId(), name: defaultName, path: target, url };
    ghCur().repos.push(repo);
    await saveGithubConfig();
    res.json({ ok: true, repo });
  } catch (e) {
    next(e);
  }
});

// ワークスペース内の既存フォルダ（git リポジトリ）を登録
app.post("/api/github/repos/existing", async (req, res, next) => {
  try {
    const p = String(req.body.path || "").trim().replace(/^\/+|\/+$/g, "");
    if (!p) return res.status(400).json({ error: "パスを入力してください" });
    sanitizeRel(p);
    if (!containerCtx) {
      const abs = resolveDirRel(p);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isDirectory()) {
        if (!req.body.init) return res.status(400).json({ error: "フォルダが見つかりません: " + p });
        await fsp.mkdir(abs, { recursive: true });
      }
    }
    const chk = await runGit(p, ["rev-parse", "--is-inside-work-tree"], 10000);
    if (chk.code !== 0 || chk.stdout.trim() !== "true") {
      if (!req.body.init) {
        const detail = (chk.stderr || "").trim();
        return res.status(400).json({ error: "git リポジトリではありません: " + p + (detail ? "（" + detail + "）" : "") });
      }
      const initR = containerCtx
        ? await runGitInContainer(["init", p], 10000)
        : await runGitSpawn(resolveDirRel(p), ["init"], 10000);
      if (initR.code !== 0) {
        if (!containerCtx) { try { await fsp.rm(resolveDirRel(p), { recursive: true, force: true }); } catch {} }
        return res.status(500).json({ error: "git init に失敗しました: " + (initR.stderr || "").trim() });
      }
    }
    if (ghCur().repos.some((r) => r.path === p)) return res.status(400).json({ error: "既に登録済みです: " + p });
    const origin = await gitOriginUrl(p).catch(() => "");
    const name = p.split("/").filter(Boolean).pop() || p || "repo";
    const repo = { id: githubRepoId(), name, path: p, url: origin };
    ghCur().repos.push(repo);
    await saveGithubConfig();
    res.json({ ok: true, repo });
  } catch (e) {
    next(e);
  }
});

// 登録済みリポジトリの操作（status / fetch / pull / log）
app.post("/api/github/repos/:id/action", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    const action = String(req.body.action || "");
    const repo = ghCur().repos.find((r) => r.id === id);
    if (!repo) return res.status(404).json({ error: "リポジトリが見つかりません" });
    if (!["status", "fetch", "pull", "log", "commit", "cancel", "push", "force-push", "branch", "cleanup", "force-pull"].includes(action)) {
      return res.status(400).json({ error: "不明な操作です" });
    }
    if (action === "status") {
      const st = await repoGitStatus(repo.path).catch((e) => ({ error: e.message }));
      const bits = [];
      if (st.branch) bits.push("branch: " + st.branch);
      if (st.ahead) bits.push("ahead " + st.ahead);
      if (st.behind) bits.push("behind " + st.behind);
      if (st.dirty) bits.push("変更 " + st.dirty + " ファイル");
      if (st.error) bits.push("エラー: " + st.error);
      let output = bits.join(" ・ ") || "クリーン";
      // 変更ファイル名の一覧を追記する（M=変更, A=追加, D=削除, R=リネーム, ??=未追跡, UU=競合）
      if (Array.isArray(st.files) && st.files.length) {
        output += "\n" + st.files.map((f) => f.code + " " + f.path).join("\n");
      }
      return res.json({ ok: !st.error, action, output, repo: { id: repo.id, ...st } });
    }
    if (action === "commit") {
      const message = String(req.body.message || "").trim();
      if (!message) return res.status(400).json({ error: "コミットメッセージを入力してください" });
      // 全変更をステージしてコミットする
      const addR = await runGit(repo.path, ["add", "-A"], 30000);
      if (addR.code !== 0) {
        return res.json({ ok: false, action, output: (addR.stdout + addR.stderr).trim() });
      }
      const r = await runGit(repo.path, ["commit", "-m", message], 60000);
      const output = (r.stdout + r.stderr).trim();
      return res.json({ ok: r.code === 0, action, output });
    }
    if (action === "cancel") {
      const r1 = await runGit(repo.path, ["reset", "--hard", "HEAD^"], 30000);
      const r2 = await runGit(repo.path, ["clean", "-fd"], 30000);
      const output = ((r1.stdout + r1.stderr) + "\n" + (r2.stdout + r2.stderr)).trim();
      return res.json({ ok: r1.code === 0 && r2.code === 0, action, output });
    }
    if (action === "log") {
      const r = await runGit(repo.path, ["log", "--oneline", "-10"], 60000);
      const output = (r.stdout + r.stderr).trim();
      return res.json({ ok: r.code === 0, action, code: r.code, output });
    }
    if (action === "branch") {
      const target = String(req.body.branch || "").trim();
      if (!target) {
        // ブランチ一覧を返す
        const r = await runGit(repo.path, ["branch", "--no-color"], 10000);
        if (r.code !== 0) return res.json({ ok: false, action, output: (r.stdout + r.stderr).trim() });
        const branches = (r.stdout || "").split("\n").map((l) => l.replace(/^\*?\s+/, "").trim()).filter(Boolean);
        return res.json({ ok: true, action, branches });
      }
      // ブランチ切替 or 作成
      // 既存ブランチか確認
      const listR = await runGit(repo.path, ["branch", "--no-color"], 10000);
      const branches = (listR.stdout || "").split("\n").map((l) => l.replace(/^\*?\s+/, "").trim()).filter(Boolean);
      if (branches.includes(target)) {
        // 切替
        const swR = await runGit(repo.path, ["checkout", target], 30000);
        const output = (swR.stdout + swR.stderr).trim();
        return res.json({ ok: swR.code === 0, action, output });
      }
      // 新規作成して切替
      const crR = await runGit(repo.path, ["checkout", "-b", target], 30000);
      const output = (crR.stdout + crR.stderr).trim();
      return res.json({ ok: crR.code === 0, action, output });
    }
    if (action === "cleanup") {
      const preview = !!req.body.preview;
      // git fetch --prune でリモートの最新状態を取得
      await runGit(repo.path, ["fetch", "--prune"], 60000);
      // 現在チェックアウト中のブランチを取得
      const curBr = await runGit(repo.path, ["branch", "--show-current"], 5000);
      const currentBranch = (curBr.stdout || "").trim();
      // (1) [origin/...: gone] となっているブランチを検出（リモートで削除済み）
      const listR = await runGit(repo.path, ["branch", "-vv", "--no-color"], 10000);
      if (listR.code !== 0) {
        return res.json({ ok: false, action, output: (listR.stdout + listR.stderr).trim() });
      }
      // [origin/...: gone] となっているブランチを検出
      const lines = (listR.stdout || "").split("\n");
      const gone = [];
      for (const line of lines) {
        const m = line.match(/^\*?\s+(\S+)\s+\S+\s+\[origin\/[^:]+:\s+gone\]/);
        if (m) {
          const branchName = m[1];
          if (branchName !== currentBranch) gone.push(branchName);
        }
      }
      // (2) upstream に取り込み済みのブランチを検出（Git 2.56+ の --delete-merged）。
      // リモート枝が残っていても作業が upstream 到達済みなら整理対象になる。
      // upstream 未設定の枝・checkout 中の枝は安全のため対象外になる。
      // 古い git では対応しないためスキップする（gone 削除のみ行う）。
      let merged = [];
      let mergedUnsupported = false;
      const dryR = await runGit(repo.path, ["branch", "--delete-merged", "origin/*", "--dry-run"], 30000);
      if (dryR.code === 0) {
        merged = parseDeleteMergedOutput(dryR.stdout).filter((b) => b !== currentBranch);
      } else if (isDeleteMergedUnsupported(dryR)) {
        mergedUnsupported = true;
      } else {
        // dry-run 自体の失敗は致命的にしない（gone 削除は続行する）
        merged = [];
      }
      if (preview) {
        const bits = [];
        if (gone.length) bits.push("リモート削除済み: " + gone.join(", "));
        if (merged.length) bits.push("取り込み済み: " + merged.join(", "));
        if (mergedUnsupported) bits.push("※取り込み済み検出は git 2.56+ が必要です（この環境では無効）");
        return res.json({
          ok: true, action, preview: true, gone, merged, mergedUnsupported,
          deleted: [],
          output: bits.length ? bits.join("\n") : "削除するブランチはありません",
        });
      }
      const deleted = [];
      const goneDeleted = [];
      const mergedDeleted = [];
      const errors = [];
      for (const b of gone) {
        const r = await runGit(repo.path, ["branch", "-d", b], 30000);
        if (r.code === 0) {
          deleted.push(b);
          goneDeleted.push(b);
        } else {
          errors.push(b + ": " + (r.stdout + r.stderr).trim());
        }
      }
      if (!mergedUnsupported && merged.length) {
        const r = await runGit(repo.path, ["branch", "--delete-merged", "origin/*"], 30000);
        if (r.code === 0) {
          for (const b of parseDeleteMergedOutput(r.stdout)) {
            if (!deleted.includes(b)) deleted.push(b);
            if (!mergedDeleted.includes(b)) mergedDeleted.push(b);
          }
        } else if (isDeleteMergedUnsupported(r)) {
          mergedUnsupported = true;
        } else {
          errors.push("取り込み済み削除: " + (r.stdout + r.stderr).trim());
        }
      }
      const output = deleted.length ? "削除: " + deleted.join(", ") : "";
      const errOutput = errors.length ? "\n削除失敗:\n" + errors.join("\n") : "";
      const note = mergedUnsupported ? "\n※取り込み済み検出は git 2.56+ が必要です（この環境では無効）" : "";
      return res.json({ ok: true, action, deleted, goneDeleted, mergedDeleted, mergedUnsupported, output: (output + errOutput + note).trim() || "完了" });
    }
    if (action === "pull") {
      let r = await runGit(repo.path, ["pull"], 120000);
      let errText = "";
      if (r.code !== 0) {
        errText = (r.stdout + r.stderr).trim();
        // upstream 未設定の場合は origin/ブランチ を明示して再試行
        if (/does not appear to be a git repository|no tracking information|please specify which branch|git branch --set-upstream-to/i.test(errText)) {
          const br = await runGit(repo.path, ["branch", "--show-current"], 5000);
          const curBranch = (br.stdout || "").trim() || "main";
          r = await runGit(repo.path, ["pull", "origin", curBranch], 120000);
          if (r.code === 0) {
            await runGit(repo.path, ["branch", "--set-upstream-to=origin/" + curBranch], 5000).catch(() => {});
          }
        }
        // 現在のブランチがリモートに存在しない場合（ローカル master / リモート main など）は
        // リモートの既定ブランチへ切り替えて pull し直す（未コミット＝コミットが無い場合に限る）
        const retryErr = errText + "\n" + ((r.stdout || "") + (r.stderr || ""));
        if (r.code !== 0 && /couldn'?t find remote ref|no such ref was fetched/i.test(retryErr)) {
          const defBr = await remoteDefaultBranch(repo.path);
          if (defBr) {
            const br2 = await runGit(repo.path, ["branch", "--show-current"], 5000);
            const curBranch2 = (br2.stdout || "").trim();
            const headChk = await runGit(repo.path, ["rev-parse", "--verify", "HEAD"], 5000);
            const unborn = headChk.code !== 0;
            const heads = curBranch2 ? await runGit(repo.path, ["ls-remote", "--heads", "origin", curBranch2], 30000) : { stdout: "" };
            const remoteHasCur = !!(heads.stdout || "").trim();
            const canSwitch = unborn && (!curBranch2 || !remoteHasCur) && defBr !== curBranch2;
            if (canSwitch) {
              const sw = await runGit(repo.path, ["checkout", "-B", defBr, "origin/" + defBr], 60000);
              if (sw.code === 0) {
                r = await runGit(repo.path, ["pull"], 120000);
              } else {
                // 未追跡ファイルの衝突などで切替できない場合は、修復ダイアログ用の情報を返す
                await runGit(repo.path, ["fetch", "origin"], 180000);
                return res.json({
                  ok: false, action, code: sw.code,
                  output: ((sw.stdout || "") + (sw.stderr || "")).trim() ||
                    "ブランチ " + curBranch2 + " はリモートに存在しません。既定ブランチ " + defBr + " への同期が必要です。",
                  defaultBranch: defBr,
                  needForceSync: true,
                });
              }
            }
          }
        }
      }
      const output = (r.stdout + r.stderr).trim();
      // 失敗時はリモートの既定ブランチを検出して添える（GUI の修復ダイアログの初期値に使う）
      if (r.code !== 0 && /couldn'?t find remote ref|no such ref was fetched/i.test(output)) {
        return res.json({ ok: false, action, code: r.code, output, defaultBranch: (await remoteDefaultBranch(repo.path)) || undefined });
      }
      return res.json({ ok: r.code === 0, action, code: r.code, output });
    }
    if (action === "force-push") {
      // 登録済みのユーザー名とPATを利用して、リモート履歴をローカルの内容で強制的に上書きpushする
      // （--force-with-lease のため、リモートが想定外の状態に進んでいた場合は拒否される）。
      // 対象ブランチは現在のブランチ（取得できなければ main）を使う。
      const brR = await runGit(repo.path, ["branch", "--show-current"], 5000);
      const curBranch = (brR.stdout || "").trim() || "main";
      const r = await runGit(repo.path, ["push", "--force-with-lease", "origin", curBranch], 180000);
      const output = (r.stdout + r.stderr).trim();
      return res.json({ ok: r.code === 0, action, code: r.code, output });
    }
    if (action === "force-pull") {
      // ローカルの変更（未コミット・未push・未追跡ファイル）をすべて破棄し、リモートの最新状態に合わせる
      const parts = [];
      const f = await runGit(repo.path, ["fetch", "origin", "--prune"], 180000);
      parts.push(((f.stdout || "") + (f.stderr || "")).trim());
      if (f.code !== 0) {
        return res.json({ ok: false, action, output: parts.filter(Boolean).join("\n") });
      }
      // 目標ブランチを決める（現在のブランチがリモートに無ければ既定ブランチへ）
      const br = await runGit(repo.path, ["branch", "--show-current"], 5000);
      const cur = (br.stdout || "").trim();
      let target = cur;
      let needCheckout = false;
      if (!cur) {
        target = (await remoteDefaultBranch(repo.path)) || "main";
        needCheckout = true;
      } else {
        const heads = await runGit(repo.path, ["ls-remote", "--heads", "origin", cur], 30000);
        if (!(heads.stdout || "").trim()) {
          target = (await remoteDefaultBranch(repo.path)) || "main";
          needCheckout = true;
        }
      }
      if (needCheckout) {
        const sw = await runGit(repo.path, ["checkout", "-B", target, "origin/" + target], 60000);
        parts.push(((sw.stdout || "") + (sw.stderr || "")).trim());
        if (sw.code !== 0) {
          return res.json({ ok: false, action, output: parts.filter(Boolean).join("\n") });
        }
      } else {
        const rs = await runGit(repo.path, ["reset", "--hard", "origin/" + target], 60000);
        parts.push(((rs.stdout || "") + (rs.stderr || "")).trim());
        if (rs.code !== 0) {
          return res.json({ ok: false, action, output: parts.filter(Boolean).join("\n") });
        }
      }
      const cl = await runGit(repo.path, ["clean", "-fd"], 30000);
      parts.push(((cl.stdout || "") + (cl.stderr || "")).trim());
      return res.json({ ok: cl.code === 0, action, output: parts.filter(Boolean).join("\n") || "完了しました" });
    }
    const r = await runGit(repo.path, [action], 60000);
    const output = (r.stdout + r.stderr).trim();
    res.json({ ok: r.code === 0, action, code: r.code, output });
  } catch (e) {
    next(e);
  }
});

// 登録済みリポジトリのルートに .gitignore / AGENTS.md を作成する際のテンプレート。
// 「テンプレート」セクションから編集でき、サーバー側の JSON に保存する（未保存なら既定値を使う）。
const TEMPLATES_CONFIG = process.env.SELFCODE_TEMPLATES_CONFIG || SELFCODE_CONFIG_DIR + "/selfcode-templates.json";
const DEFAULT_GITIGNORE_TEMPLATE = [
  ".env",
  ".env.*",
  "!.env.example",
  "",
  "credentials.*",
  "secrets.*",
  ".git-credentials",
  "",
  "*.db",
  "*.sqlite",
  "*.sqlite3",
  "*.sql",
  "*.dump",
  "*.backup",
  "*.bak",
  "",
  ".DS_Store",
  "Thumbs.db",
  "",
  "*.log",
  "logs/",
  "backup/",
  "backups/",
  "data/",
  "uploads/",
  "",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "",
  ".ai-bridge/",
  "",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "out/",
  "coverage/",
  "",
  ".venv/",
  "__pycache__/",
  "*.pyc",
  "",
  ".idea/",
  ".vscode/",
  "*.swp",
  "*~",
  "",
].join("\n");

app.post("/api/github/repos/:id/gitignore", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    const repo = ghCur().repos.find((r) => r.id === id);
    if (!repo) return res.status(404).json({ error: "リポジトリが見つかりません" });
    const target = (repo.path || "").replace(/\/+$/, "") + "/.gitignore";
    // 既に存在する場合は作成しない
    let exists = false;
    if (containerCtx) {
      try { await runContainer(["test", "-e", target]); exists = true; } catch {}
    } else {
      try { await fsp.access(resolveRel(target)); exists = true; } catch {}
    }
    if (exists) return res.json({ ok: false, existed: true, path: target });
    if (containerCtx) {
      await runContainer(["tee", target], { input: Buffer.from(await currentGitignoreTemplate(), "utf8") });
    } else {
      const abs = resolveRel(target);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, await currentGitignoreTemplate());
    }
    res.json({ ok: true, created: true, path: target });
  } catch (e) {
    next(e);
  }
});

// 登録済みリポジトリのルートに AGENTS.md を作成する（既に存在する場合は何もしない）
const DEFAULT_AGENTS_MD_TEMPLATE = [
  "# 作業ルール",
  "",
  "## 応答言語",
  "- ユーザーへの返答・確認・質問はすべて日本語で行うこと。英語や中国語で返答しないこと。",
  "- ただし、コード・コマンド・ファイル内容・固有名詞など、原文のままが適切なものは翻訳しないこと。",
  "",
  "## コミットメッセージ",
  "- `Co-Authored-By:` / `Co-authored-by:` トレーラーを付けないこと。",
  "- `Generated with Codebuff` のような帰属行・宣伝文を付けないこと。",
  "- AI がコミットメッセージを生成した場合は、本文のみにして末尾の2行 (帰属行 + Co-Authored-By) を必ず削除してからコミットすること。",
  "",
  "## コミット前の個人情報チェック",
  "- コミット前に `git diff` (必要なら `git diff --cached`) の内容を確認し、個人情報が含まれていないかチェックすること。",
  "- 対象の例: LXD コンテナ名、Tailnet アドレス / MagicDNS ホスト名、IP アドレス、メールアドレス、API キー・トークンなどの秘密情報。",
  "- 見つけた場合は、その箇所をマスク・ダミー値に置き換えるか、ファイルをコミット対象から外すこと。判断に迷う場合は勝手にコミットせず、ユーザーに確認すること。",
  "",
].join("\n");

app.post("/api/github/repos/:id/agents-md", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    const repo = ghCur().repos.find((r) => r.id === id);
    if (!repo) return res.status(404).json({ error: "リポジトリが見つかりません" });
    const target = (repo.path || "").replace(/\/+$/, "") + "/AGENTS.md";
    // 既に存在する場合は作成しない
    let exists = false;
    if (containerCtx) {
      try { await runContainer(["test", "-e", target]); exists = true; } catch {}
    } else {
      try { await fsp.access(resolveRel(target)); exists = true; } catch {}
    }
    if (exists) return res.json({ ok: false, existed: true, path: target });
    if (containerCtx) {
      await runContainer(["tee", target], { input: Buffer.from(await currentAgentsMdTemplate(), "utf8") });
    } else {
      const abs = resolveRel(target);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, await currentAgentsMdTemplate());
    }
    res.json({ ok: true, created: true, path: target });
  } catch (e) {
    next(e);
  }
});

// テンプレートの取得・保存・リセット（「テンプレート」セクションから編集する）
let customTemplates = { gitignore: null, agentsMd: null };

async function loadCustomTemplates() {
  try {
    const raw = await fsp.readFile(TEMPLATES_CONFIG, "utf8");
    const d = JSON.parse(raw);
    if (d && typeof d.gitignore === "string") customTemplates.gitignore = d.gitignore;
    if (d && typeof d.agentsMd === "string") customTemplates.agentsMd = d.agentsMd;
  } catch {}
}

async function saveCustomTemplates() {
  await fsp.mkdir(path.dirname(TEMPLATES_CONFIG), { recursive: true });
  await fsp.writeFile(TEMPLATES_CONFIG, JSON.stringify(customTemplates, null, 2));
}

async function currentGitignoreTemplate() {
  if (customTemplates.gitignore !== null) return customTemplates.gitignore;
  await loadCustomTemplates();
  return customTemplates.gitignore !== null ? customTemplates.gitignore : DEFAULT_GITIGNORE_TEMPLATE;
}

async function currentAgentsMdTemplate() {
  if (customTemplates.agentsMd !== null) return customTemplates.agentsMd;
  await loadCustomTemplates();
  return customTemplates.agentsMd !== null ? customTemplates.agentsMd : DEFAULT_AGENTS_MD_TEMPLATE;
}

loadCustomTemplates().catch(() => {});

app.get("/api/github/templates", async (req, res, next) => {
  try {
    res.json({ gitignore: await currentGitignoreTemplate(), agentsMd: await currentAgentsMdTemplate() });
  } catch (e) {
    next(e);
  }
});

app.put("/api/github/templates", async (req, res, next) => {
  try {
    const { gitignore, agentsMd } = req.body || {};
    if (typeof gitignore !== "string" || typeof agentsMd !== "string") {
      return res.status(400).json({ error: "gitignore と agentsMd を文字列で指定してください" });
    }
    customTemplates = { gitignore, agentsMd };
    await saveCustomTemplates();
    res.json({ ok: true, gitignore, agentsMd });
  } catch (e) {
    next(e);
  }
});

app.post("/api/github/templates/reset", async (req, res, next) => {
  try {
    customTemplates = { gitignore: null, agentsMd: null };
    try { await fsp.rm(TEMPLATES_CONFIG, { force: true }); } catch {}
    res.json({ ok: true, gitignore: DEFAULT_GITIGNORE_TEMPLATE, agentsMd: DEFAULT_AGENTS_MD_TEMPLATE });
  } catch (e) {
    next(e);
  }
});

// リモートURLの追加/更新とトラッキングブランチの設定
app.post("/api/github/repos/:id/remote", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    const repo = ghCur().repos.find((r) => r.id === id);
    if (!repo) return res.status(404).json({ error: "リポジトリが見つかりません" });
    const url = String(req.body.url || "").trim();
    const branch = String(req.body.branch || "main").trim() || "main";
    if (!url) return res.status(400).json({ error: "リモートURLを入力してください" });
    // 既に origin が存在するか確認
    const existR = await runGit(repo.path, ["remote", "get-url", "origin"], 10000);
    if (existR.code === 0) {
      // 既存 → URLを更新
      const setR = await runGit(repo.path, ["remote", "set-url", "origin", url], 10000);
      if (setR.code !== 0) return res.json({ ok: false, output: (setR.stdout + setR.stderr).trim() });
    } else {
      // 新規追加
      const addR = await runGit(repo.path, ["remote", "add", "origin", url], 10000);
      if (addR.code !== 0) return res.json({ ok: false, output: (addR.stdout + addR.stderr).trim() });
    }
    // 強制同期オプション: チェックされたステップを対象フォルダで順番に実行
    const fsOpt = (req.body && typeof req.body.forceSync === "object" && req.body.forceSync) || {};
    const steps = [];
    if (fsOpt.fetch) steps.push({ n: "#1", args: ["fetch", "origin"], timeout: 180000 });
    if (fsOpt.checkout) steps.push({ n: "#2", args: ["checkout", "-B", branch, "origin/" + branch], timeout: 30000 });
    if (fsOpt.reset) steps.push({ n: "#3", args: ["reset", "--hard", "origin/" + branch], timeout: 30000 });
    let syncOutput = "";
    let syncFailed = false;
    for (const st of steps) {
      let r = await runGit(repo.path, st.args, st.timeout);
      let o = ((r.stdout || "") + (r.stderr || "")).trim();
      // checkout -B は未追跡ファイルがリモート内容と競合すると失敗する。
      // リモートで上書き（#3）に同意済みなら、リセットしてから切替を再試行する。
      if (r.code !== 0 && st.args[0] === "checkout" && st.args[1] === "-B" && fsOpt.reset) {
        const rr = await runGit(repo.path, ["reset", "--hard", "origin/" + branch], st.timeout);
        o += "\n  # 競合のため git reset --hard origin/" + branch + " を実行: " + (((rr.stdout || "") + (rr.stderr || "")).trim() || "(完了)");
        if (rr.code === 0) {
          r = await runGit(repo.path, st.args, st.timeout);
          o += "\n  # 切替を再試行: " + (((r.stdout || "") + (r.stderr || "")).trim() || "(完了)");
        } else {
          r = rr;
        }
      }
      syncOutput += st.n + " $ git " + st.args.join(" ") + "\n" + (o || "(完了)") + "\n\n";
      if (r.code !== 0) { syncFailed = true; break; }
    }
    if (syncFailed) {
      return res.json({ ok: false, output: ("リモートは設定しましたが、強制同期に失敗しました:\n\n" + syncOutput).trim() });
    }
    // トラッキングブランチを設定（現在のブランチが存在する場合のみ）
    const brR = await runGit(repo.path, ["branch", "--show-current"], 5000);
    const curBranch = (brR.stdout || "").trim();
    let upOutput = "";
    if (curBranch) {
      const upR = await runGit(repo.path, ["branch", "--set-upstream-to=origin/" + branch, curBranch], 10000);
      upOutput = (upR.stdout + upR.stderr).trim();
    }
    // repoのURLも更新
    repo.url = url;
    await saveGithubConfig();
    res.json({ ok: true, output: (syncOutput + (upOutput || ("リモートを設定しました: origin → " + url + "\nトラッキング: origin/" + branch))).trim() });
  } catch (e) {
    next(e);
  }
});

// 初回push（リモート未設定のリポジトリに origin を追加して push -u する）
app.post("/api/github/repos/:id/first-push", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    const repo = ghCur().repos.find((r) => r.id === id);
    if (!repo) return res.status(404).json({ error: "リポジトリが見つかりません" });
    const url = String(req.body.url || "").trim();
    const branch = String(req.body.branch || "").trim() || "main";
    if (!url) return res.status(400).json({ error: "リモートURLを入力してください" });
    const parts = [];
    // origin が既にあれば URL を更新、なければ追加
    const existR = await runGit(repo.path, ["remote", "get-url", "origin"], 10000);
    const remArgs = existR.code === 0 ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url];
    const remR = await runGit(repo.path, remArgs, 10000);
    parts.push("$ git remote " + (existR.code === 0 ? "set-url" : "add") + " origin " + url + "\n" +
      (((remR.stdout || "") + (remR.stderr || "")).trim() || "(完了)"));
    if (remR.code !== 0) {
      return res.json({ ok: false, output: parts.join("\n\n") });
    }
    const pushR = await runGit(repo.path, ["push", "-u", "origin", branch], 180000);
    parts.push("$ git push -u origin " + branch + "\n" + ((pushR.stdout || "") + (pushR.stderr || "")).trim());
    if (pushR.code === 0) {
      repo.url = url;
      await saveGithubConfig();
      // リモートの既定ブランチ改名に気づけるよう fetch.followRemoteHEAD を有効化する
      await runGit(repo.path, ["config", "fetch.followRemoteHEAD", "warn"], 10000).catch(() => {});
    }
    res.json({ ok: pushR.code === 0, output: parts.filter(Boolean).join("\n\n") });
  } catch (e) {
    next(e);
  }
});

// 登録を解除（ファイルは削除しない）
app.delete("/api/github/repos/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    const before = ghCur().repos.length;
    ghCur().repos = ghCur().repos.filter((r) => r.id !== id);
    if (ghCur().repos.length === before) return res.status(404).json({ error: "リポジトリが見つかりません" });
    await saveGithubConfig();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ================= コンテナ連携 (LXD / Docker) =================
// 現在「入っている」コンテナ。null ならホスト上で操作する。
let containerCtx = null; // { name, runtime, shell }

// 実行バイナリを PATH と既知の絶対パスから探す。systemd サービスでは PATH に /snap/bin が
// 含まれないことがあるため、snap 版 lxc なども見つけられるようにする。
// pathStr を渡すとその PATH で判定する（ターミナルは makeShellEnv の PATH で起動するため、
// インストール済み判定もそれに合わせる）。
function findBin(name, pathStr, extraHome) {
  const dirs = (pathStr || process.env.PATH || "").split(":").filter(Boolean);
  const candidates = dirs.map((d) => path.join(d, name));
  if (name === "lxc") candidates.push("/snap/bin/lxc", "/usr/bin/lxc", "/usr/local/bin/lxc");
  if (name === "docker") candidates.push("/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker");
  // opencode は ~/.opencode/bin にインストールされる（PATH に無くても検出できるようにしておく）
  if (name === "opencode") {
    const homes = [process.env.HOME || os.homedir(), extraHome].filter(Boolean);
    for (const h of homes) candidates.push(path.join(h, ".opencode/bin/opencode"));
    candidates.push("/usr/local/bin/opencode");
  }
  // Antigravity CLI (agy) は ~/.local/bin にインストールされる（PATH に無くても検出できるようにしておく。
  // extraHome = ターミナルの実行ユーザーのホーム。ユーザー切替でインストールされた場所も検出する）
  if (name === "agy") {
    const homes = [process.env.HOME || os.homedir(), extraHome].filter(Boolean);
    for (const h of homes) candidates.push(path.join(h, ".local/bin/agy"));
    candidates.push("/usr/local/bin/agy", "/usr/bin/agy");
  }
  // beacon.sh (Agent Beacon) の CLI。deb/rpm 経由では /usr/local/bin に、
  // tarball 経由では ~/.local/bin または /opt/beacon/bin に置かれる。
  if (name === "beacon") {
    const homes = [process.env.HOME || os.homedir(), extraHome].filter(Boolean);
    for (const h of homes) candidates.push(path.join(h, ".local/bin/beacon"));
    candidates.push("/usr/local/bin/beacon", "/opt/beacon/bin/beacon", "/usr/bin/beacon");
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return null;
}

function containerBin(runtime) {
  const name = runtime === "docker" ? "docker" : "lxc";
  return findBin(name) || name;
}

// ターミナルから起動する CLI のインストール方法（未インストール時に確認してからインストールする）。
// install はシェルスクリプトに埋め込まれるため、単一のコマンドラインで書くこと。
const INSTALL_CMDS = {
  opencode:
    'export PATH="$HOME/.opencode/bin:$PATH"; curl -fsSL https://opencode.ai/v2/install | bash; if [ "$(id -u)" = "0" ] && [ -f /root/.opencode/bin/opencode ]; then cp -f /root/.opencode/bin/opencode /usr/local/bin/opencode 2>/dev/null && chmod 755 /usr/local/bin/opencode 2>/dev/null || true; fi',
  // freebuff / cline は npm グローバルインストール。npm / node が無い環境（LXD コンテナ等）でも
  // パッケージマネージャ（pacman / apt / apk / dnf / yum）から nodejs / npm を自動インストールしてから進める。
  // freebuff CLI は Node.js 18+ 必須のため、バージョンも確認する。
  freebuff:
    "if ! command -v npm >/dev/null 2>&1; then echo '[selfcode] npm が見つかりません。nodejs / npm をインストールします…'; " +
      "if command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm nodejs npm; " +
      "elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq nodejs npm; " +
      "elif command -v apk >/dev/null 2>&1; then apk add --no-cache nodejs npm; " +
      "elif command -v dnf >/dev/null 2>&1; then dnf install -y nodejs npm; " +
      "elif command -v yum >/dev/null 2>&1; then yum install -y nodejs npm; " +
      "else echo '[selfcode] 対応するパッケージマネージャがありません。nodejs / npm を手動でインストールしてください'; exit 1; fi; fi; " +
      "if ! command -v node >/dev/null 2>&1 || ! node -e \"if(Number(process.versions.node.split('.')[0])<18)process.exit(1)\"; then " +
      "echo '[selfcode] Node.js 18 以上が必要です。古い Node が入っている場合は更新してください'; exit 1; fi; " +
      'if [ "$(id -u)" = "0" ]; then npm install -g freebuff; else sudo npm install -g freebuff; fi',
  // cline も npm グローバルインストール（npm install -g cline）。nodejs / npm が無ければ自動導入する。
  cline:
    "if ! command -v npm >/dev/null 2>&1; then echo '[selfcode] npm が見つかりません。nodejs / npm をインストールします…'; " +
      "if command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm nodejs npm; " +
      "elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq nodejs npm; " +
      "elif command -v apk >/dev/null 2>&1; then apk add --no-cache nodejs npm; " +
      "elif command -v dnf >/dev/null 2>&1; then dnf install -y nodejs npm; " +
      "elif command -v yum >/dev/null 2>&1; then yum install -y nodejs npm; " +
      "else echo '[selfcode] 対応するパッケージマネージャがありません。nodejs / npm を手動でインストールしてください'; exit 1; fi; fi; " +
      'if [ "$(id -u)" = "0" ]; then npm install -g cline; else sudo npm install -g cline; fi',
  agy:
    'export PATH="$HOME/.local/bin:$PATH"; curl -fsSL https://antigravity.google/cli/install.sh | bash; if [ "$(id -u)" = "0" ] && [ -f /root/.local/bin/agy ]; then cp -f /root/.local/bin/agy /usr/local/bin/agy 2>/dev/null && chmod 755 /usr/local/bin/agy 2>/dev/null || true; fi',
  // beacon.sh (Agent Beacon) は公式リリースの install.sh から導入する（systemd 環境では
  // .deb/.rpm が beacon-collector サービスまで構成する）。非対応ディストロでは tarball で導入。
  // BEACON_TARBALL_STEPS / BEACON_ENDPOINT_STEP（beacon.sh 管理セクションで定義）を使い回す。
  beacon: [
    "export PATH=\"$HOME/.local/bin:/opt/beacon/bin:/usr/local/bin:$PATH\"",
    ...BEACON_TARBALL_STEPS,
    "B=\"$(command -v beacon || echo beacon)\"",
    "$B version",
    BEACON_ENDPOINT_STEP,
  ].join("; "),
};

// コンテナ内でコマンドを実行するための CLI 引数（tty: ターミナル用に疑似端末を割り当てる）
// lxc exec / docker exec はデフォルトでホームディレクトリから起動するため、--cwd / を付けて
// コンテナ内のルートから起動する（エクスプローラのルートをコンテナ内の / に合わせる）。
// あわせて BEACON_DATA_DIR を引き継がせる（コンテナ内で動く AI エージェントに記憶データ置き場を伝える）
function containerExecArgs(runtime, name, tty) {
  if (runtime === "docker") return tty ? ["exec", "-it", "-w", "/", "-e", "BEACON_DATA_DIR=" + BEACON_DATA_DIR, name] : ["exec", "-i", "-w", "/", "-e", "BEACON_DATA_DIR=" + BEACON_DATA_DIR, name];
  return tty ? ["exec", "-t", "--cwd", "/", "--env", "BEACON_DATA_DIR=" + BEACON_DATA_DIR, name, "--"] : ["exec", "--cwd", "/", "--env", "BEACON_DATA_DIR=" + BEACON_DATA_DIR, name, "--"];
}

// sh -c に埋め込むためのシングルクォートエスケープ
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// コンテナ内でコマンドを実行して完了を待つ（ファイル操作向け）
function runContainer(cmdArgs, opts = {}) {
  if (!containerCtx) return Promise.reject(new Error("no container selected"));
  return new Promise((resolve, reject) => {
    const child = spawn(containerBin(containerCtx.runtime), containerExecArgs(containerCtx.runtime, containerCtx.name, false).concat(cmdArgs), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    const to = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("container command timed out"));
    }, opts.timeoutMs || 30000);
    child.on("error", (e) => { clearTimeout(to); reject(e); });
    child.on("close", (code) => {
      clearTimeout(to);
      const stdout = Buffer.concat(out);
      if (code !== 0) {
        const msg = Buffer.concat(err).toString("utf8").trim() || `exit code ${code}`;
        const e = new Error(msg);
        e.exitCode = code;
        reject(e);
      } else {
        resolve({ stdout, stderr: Buffer.concat(err) });
      }
    });
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

// ホスト上でコマンドを実行して完了を待つ（コンテナ一覧取得用）
function runCmd(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    const to = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("command timed out"));
    }, timeoutMs || 10000);
    child.on("error", (e) => { clearTimeout(to); reject(e); });
    child.on("close", (code) => {
      clearTimeout(to);
      if (code !== 0) reject(new Error(Buffer.concat(err).toString("utf8").trim() || `exit code ${code}`));
      else resolve(Buffer.concat(out));
    });
  });
}

// 稼働中のコンテナ一覧（LXD と Docker を併せて返す）。
// 失敗を握りつぶさず errors に積んで返す（フロントで理由を表示できるようにする）。
async function listContainers() {
  const result = [];
  const errors = [];
  const lxcBin = findBin("lxc");
  if (lxcBin) {
    try {
      const out = await runCmd(lxcBin, ["list", "--format", "json"], 15000);
      const arr = JSON.parse(out.toString("utf8") || "[]");
      for (const c of Array.isArray(arr) ? arr : []) {
        if (c.status === "Running") result.push({ name: c.name, runtime: "lxd" });
      }
    } catch (e) {
      errors.push("LXD: " + e.message);
    }
  } else {
    errors.push("LXD: lxc コマンドが見つかりません（PATH に /snap/bin を追加するか、LXD をインストールしてください）");
  }
  const dockerBin = findBin("docker");
  if (dockerBin) {
    try {
      const out = await runCmd(dockerBin, ["ps", "--format", "{{.Names}}"], 8000);
      for (const line of out.toString("utf8").split("\n")) {
        const n = line.trim();
        if (n) result.push({ name: n, runtime: "docker" });
      }
    } catch (e) {
      errors.push("Docker: " + e.message);
    }
  }
  return { containers: result, errors };
}

// ターミナルプロセスをすべて終了する（コンテナ切替時に古いコンテナのプロセスを残さない）
function killAllTerminals() {
  for (const rec of terminals.values()) {
    try {
      if (rec.term && rec.term.pid && process.getpgid(rec.term.pid) === rec.term.pid) process.kill(-rec.term.pid, "SIGHUP");
    } catch {}
    try { rec.term && rec.term.kill(); } catch {}
  }
  terminals.clear();
}

// コンテナ内のツリー一覧（ls -1Ap の出力をパース。ディレクトリは末尾に / が付く）
async function containerTree(relDir, showHidden) {
  const dir = String(relDir || "");
  const { stdout } = await runContainer(["ls", "-1Ap", dir || "/"]);
  const entries = [];
  for (const line of stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    const isDir = line.endsWith("/");
    const name = isDir ? line.slice(0, -1) : line;
    if (!showHidden && (name.startsWith(".") || HIDDEN.has(name))) continue;
    entries.push({ name, type: isDir ? "dir" : "file", path: (dir ? dir + "/" : "") + name });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: dir, entries };
}

app.get("/api/container/list", async (req, res, next) => {
  try {
    res.json(await listContainers());
  } catch (e) {
    next(e);
  }
});

app.post("/api/container/select", async (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || "");
    const runtime = String((req.body && req.body.runtime) || "");
    if (!name || (runtime !== "lxd" && runtime !== "docker")) {
      return res.status(400).json({ error: "name and runtime required" });
    }
    const found = (await listContainers()).containers.find((c) => c.name === name && c.runtime === runtime);
    if (!found) return res.status(404).json({ error: "コンテナが見つからないか、稼働していません" });
    containerCtx = { name, runtime, shell: "sh" };
    // コンテナに bash があればターミナルで使う
    try {
      const { stdout } = await runContainer(["sh", "-c", "command -v bash"], { timeoutMs: 8000 });
      if (stdout.toString("utf8").trim()) containerCtx.shell = "bash -l";
    } catch {}
    killAllTerminals();
    res.json({ ok: true, container: { name, runtime } });
  } catch (e) {
    next(e);
  }
});

app.post("/api/container/exit", (req, res) => {
  containerCtx = null;
  killAllTerminals();
  res.json({ ok: true });
});

// 再起動: systemd サービスを再起動する。成功時は自分のプロセスが systemctl に停止されるため
// クライアントは接続断または { ok: true } を「再起動開始」の合図にし、
// /api/status の bootId/version の変化で再起動の完了を確認する。
// 注意: systemctl クライアントの終了は実際の停止より先に起きることがあるため、
// close 時の成否応答がレースで先に届いても、クライアント側の bootId 確認で正しく判定できる。
// spawn 自体の失敗（error）と非ゼロ終了（close code !== 0）は再起動が起きない確定なので即時 500 を返す。
app.post("/api/restart", (req, res) => {
  console.log("[selfcode] restart requested: " + RESTART_CMD);
  const child = spawn(RESTART_CMD, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("error", (e) => {
    if (!res.headersSent) res.status(500).json({ error: "再起動コマンドを実行できませんでした: " + e.message });
  });
  child.on("close", (code) => {
    if (res.headersSent) return;
    // 非ゼロ終了 = ジョブ投入に失敗（停止は起きない確定）→ 即時 500。
    // 終了コード 0 = 再起動ジョブ投入済み → 200 で応答（直後に SIGTERM で停止する。
    // 応答書き込み中に停止した場合はクライアント側で接続断になるが、それも正常系として扱う）。
    if (code !== 0) res.status(500).json({ error: "再起動に失敗しました (exit " + code + "): " + out.trim() });
    else res.json({ ok: true });
  });
});

// アップデート: 公式インストールスクリプトの取得 → 実行。
// スクリプト内で git pull / npm install が行われ、完了後に「リスタート」で新コードへ切り替わる。
// root 以外の所有者リポジトリでも動くよう safe.directory を事前に登録する。
// 取得元は SELFCODE_UPDATE_URL で上書き可（既定は本家 selfcode。Ubuntu/CachyOS 共通）。
const UPDATE_URL_DEFAULT = "https://raw.githubusercontent.com/hirogura/selfcode/main/install-selfcode.sh";
function buildUpdateScript(force) {
  const url = process.env.SELFCODE_UPDATE_URL || UPDATE_URL_DEFAULT;
  const forceFlag = force ? " --force" : "";
  return `
set -e
git config --global --add safe.directory '${__dirname}' >/dev/null 2>&1 || true
update_tmp="$(mktemp /tmp/selfcode-install-XXXXXX.sh)"
trap 'rm -f "$update_tmp"' EXIT
curl -fsSL ${shq(url)} -o "$update_tmp"
bash "$update_tmp"${forceFlag}
`;
}

app.post("/api/update", async (req, res, next) => {
  const force = !!(req.body && req.body.force);
  console.log("[selfcode] update requested" + (force ? " (force)" : ""));
  try {
    const out = await runCmd("bash", ["-c", buildUpdateScript(force)], UPDATE_TIMEOUT_MS);
    const log = out.toString("utf8").trim();
    console.log("[selfcode] update finished\n" + log.split("\n").slice(-10).join("\n"));
    res.json({ ok: true, log, force });
  } catch (e) {
    const msg = e.message || String(e);
    // ローカルの変更で pull が失敗した場合は強制アップデートで復旧できるため、
    // フロントで確認表示を出せるよう needForce フラグを付けて 409 で返す
    const needForce = !force && /would be overwritten|local changes|stash them|Your local changes/i.test(msg);
    res.status(needForce ? 409 : 500).json({ error: "アップデートに失敗しました: " + msg, needForce });
  }
});

app.use("/monaco/vs", express.static(path.join(__dirname, "node_modules/monaco-editor/min/vs")));
app.use("/monaco", express.static(path.join(__dirname, "node_modules/monaco-editor/min/vs")));
app.use("/xterm", express.static(path.join(__dirname, "node_modules/@xterm/xterm/lib")));
app.use("/xterm-css", express.static(path.join(__dirname, "node_modules/@xterm/xterm/css")));
app.use("/xterm-fit", express.static(path.join(__dirname, "node_modules/@xterm/addon-fit/lib")));

app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || String(err) });
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/terminal" });

// id -> { id, term, buf, conns, cmd } （ページリロードや接続断でもプロセスを保持し、再接続時に出力を再送する）
const terminals = new Map();
const TERM_BUF_MAX = 512 * 1024; // 再接続時の再送分として保持する出力の上限
const TERM_WELCOME = "\r\n\x1b[90m— selfcode terminal (opencode も使えます、Shift+dragで選択 → 右クリックでコピー/貼り付け) —\x1b[0m\r\n";

function makeShellEnv() {
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  // systemd サービス等では $HOME が未設定の場合があるため補完する（git config --global などが動くように）
  if (!env.HOME) env.HOME = os.homedir();
  const termHome = TERM_USER ? userHomeOf(TERM_USER) : null;
  const resolvedOcBin = findBin(OC_BIN_RAW, process.env.PATH || "", termHome) || OC_BIN_RAW;
  const ocBin = path.dirname(process.env.OPENCODE_BIN && path.isAbsolute(process.env.OPENCODE_BIN) ? process.env.OPENCODE_BIN : resolvedOcBin);
  const ocDir = path.dirname(process.execPath);
  for (const dir of [ocBin, ocDir]) {
    if (dir && dir !== "." && !env.PATH.split(":").includes(dir)) env.PATH = `${dir}:${env.PATH}`;
  }
  return env;
}

wss.on("connection", (ws, req) => {
  // クライアントがペインごとに持つ安定した id で端末を識別する（無ければ新規生成）
  const q = new URL(req.url || "/", "http://localhost").searchParams;
  const id = q.get("id") || crypto.randomUUID();
  const shell = process.env.SHELL || (fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
  const env = makeShellEnv();
  // 分割したターミナルを最初から同じディレクトリで起動できるよう ?cwd= を受け付ける（再接続時は無視）
  // コンテナモードでは cwd はコンテナ内の相対パス（"" = ルート）として扱う
  let startDir = containerCtx ? (q.get("cwd") || "") : ROOT;
  if (!containerCtx) {
    try {
      const c = q.get("cwd");
      if (c != null) startDir = resolveDirRel(c);
    } catch {}
  }

  let rec = terminals.get(id);
  const fresh = !rec || !rec.term;

  const broadcast = (o) => {
    const s = JSON.stringify(o);
    for (const c of Array.from(rec.conns)) {
      if (c.readyState === c.OPEN) {
        try { c.send(s); } catch {}
      }
    }
  };
  const killTermGroup = (t) => {
    try {
      if (t && t.pid && process.getpgid(t.pid) === t.pid) process.kill(-t.pid, "SIGHUP");
    } catch {}
  };
  const wireTerm = (t) => {
    t.onData((data) => {
      rec.buf += data;
      if (rec.buf.length > TERM_BUF_MAX) rec.buf = rec.buf.slice(rec.buf.length - TERM_BUF_MAX);
      broadcast({ type: "data", data });
    });
    t.onExit(({ exitCode }) => {
      // _respawn は spawnTerm による入れ替え時の古いプロセス。ここでは終了通知しない
      if (t._respawn) {
        t._respawn = false;
        return;
      }
      if (terminals.get(rec.id) === rec && rec.term === t) terminals.delete(rec.id);
      killTermGroup(t);
      broadcast({ type: "exit", code: exitCode });
    });
  };

  // ホスト側ターミナルで使うユーザー（コンテナ内ではコンテナ側のユーザーになるため無視）
  const user = containerCtx ? null : (q.get("user") || TERM_USER);

  if (fresh) {
    const procShell = containerCtx ? (containerCtx.shell || "sh") : shell;
    let term;
    try {
      term = spawnTermProc(startDir, procShell, shell.endsWith("bash") ? ["-l"] : [], user);
    } catch (e) {
      // ユーザー切替不可などのエラーは接続を張らずにメッセージだけ返す
      ws.send(JSON.stringify({ type: "data", data: "\r\n\x1b[31m[selfcode] " + e.message + "\x1b[0m\r\n" }));
      try { ws.close(); } catch {}
      return;
    }
    rec = { id, term, buf: "", conns: new Set(), cmd: "", user };
    terminals.set(id, rec);
  }
  rec.conns.add(ws);
  if (fresh) wireTerm(rec.term);
  // 初回接続ならウェルカム、再接続なら保持していた出力を再送して画面を復元する
  ws.send(JSON.stringify({ type: "data", data: fresh ? TERM_WELCOME : rec.buf }));
  ws.send(JSON.stringify({ type: "state", cmd: rec.cmd }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      const t = rec.term;
      if (!t) return;
      if (msg.type === "input") t.write(msg.data);
      else if (msg.type === "resize") t.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
      else if (msg.type === "cwd") setTermCwd(msg.cwd).catch((e) => broadcast({ type: "data", data: "\r\n\x1b[31m[selfcode] " + e.message + "\x1b[0m\r\n" }));
      else if (msg.type === "exec") execCmd(msg.cwd, msg.cmd, msg.root, msg.args).catch((e) => broadcast({ type: "data", data: "\r\n\x1b[31m[selfcode] " + e.message + "\x1b[0m\r\n" }));
      else if (msg.type === "user") setTermUser(msg.user, msg.cwd).catch((e) => broadcast({ type: "data", data: "\r\n\x1b[31m[selfcode] " + e.message + "\x1b[0m\r\n" }));
      else if (msg.type === "kill") {
        // ペインを閉じるときの明示的な終了（切断だけではプロセスが残るため）
        try { t.kill(); killTermGroup(t); } catch {}
        terminals.delete(id);
        try { ws.close(); } catch {}
      }
    } catch {
      ws.send(JSON.stringify({ type: "data", data: "\r\n[selfcode] invalid message\r\n" }));
    }
  });
  ws.on("close", () => {
    // プロセスは保持したまま再接続に備える（終了は kill メッセージ or プロセス自体の exit で行う）
    rec.conns.delete(ws);
  });

  // ターミナルのプロセスを起動する（ホスト: シェルを直接 or setpriv 経由、コンテナ: lxc/docker exec 経由で起動）
  function spawnTermProc(dir, procCmd, procArgs, procUser) {
    const old = rec && rec.term;
    const cols = old ? old.cols : 100;
    const rows = old ? old.rows : 30;
    if (old) {
      old._respawn = true;
      try {
        old.kill();
      } catch {}
    }
    let bin, args, cwd, procEnv = env;
    if (containerCtx) {
      // 保存済みの cwd がコンテナ内に無い場合でもシェルは起動するように cd 失敗は無視する
      // procArgs もシェルエスケープして埋め込む（インストール確認スクリプトの起動用）
      const argStr = procArgs && procArgs.length ? " " + procArgs.map(shq).join(" ") : "";
      // opencode は ~/.opencode/bin、Antigravity CLI (agy) は ~/.local/bin にインストールされるため、
      // コンテナ内の PATH にも追加しておく（インストール判定と実行で同じ PATH にする）
      const inner = `${dir ? `cd ${shq(dir)} 2>/dev/null || true; ` : ""}export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"; exec ${procCmd}${argStr}`;
      bin = containerBin(containerCtx.runtime);
      args = [...containerExecArgs(containerCtx.runtime, containerCtx.name, true), "sh", "-c", inner];
      cwd = ROOT;
    } else {
      const curUser = process.env.USER || (os.userInfo && os.userInfo().username) || "root";
      const targetUser = (procUser && procUser !== curUser) ? procUser : curUser;
      const uid = userUidOf(targetUser);
      const runUserDir = `/run/user/${uid}`;
      const keyringEnv = {};
      if (fs.existsSync(runUserDir)) {
        keyringEnv.XDG_RUNTIME_DIR = runUserDir;
        if (fs.existsSync(`${runUserDir}/bus`)) {
          keyringEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runUserDir}/bus`;
        }
        if (fs.existsSync(`${runUserDir}/keyring`)) {
          keyringEnv.GNOME_KEYRING_CONTROL = `${runUserDir}/keyring`;
        }
      }

      if (procUser && procUser !== curUser) {
        // 別ユーザーでシェルを起動する（root から一般ユーザーへの切り替えのみ可能）。
        // su -c だと bash が端末のプロセスグループを設定できずジョブ制御が無効になるため、
        // exec で直接置き換わる setpriv を使う（cwd は pty 側で指定する）。
        if (!IS_ROOT) throw new Error(`ユーザー ${procUser} への切り替えは root 権限が必要です`);
        bin = "setpriv";
        args = ["--reuid=" + procUser, "--regid=" + procUser, "--init-groups", "--", procCmd, ...(procArgs || [])];
        cwd = dir;
        const home = userHomeOf(procUser);
        procEnv = { ...procEnv, ...keyringEnv, HOME: home, USER: procUser, LOGNAME: procUser, SHELL: procCmd };
        // opencode は ~/.opencode/bin、Antigravity CLI などは ~/.local/bin にインストールされる。
        // root の PATH（/root/.opencode/bin）は一般ユーザーから辿れないため、実行ユーザーのものを先頭に追加する。
        procEnv = { ...procEnv, PATH: `${home}/.opencode/bin:${home}/.local/bin:${procEnv.PATH}` };
      } else {
        bin = procCmd;
        args = procArgs || [];
        cwd = dir;
        // 同上: 実行ユーザーの ~/.opencode/bin と ~/.local/bin を PATH に追加
        // （opencode と agy などを、シェルの設定ファイルに依存せず直接起動できるように）
        const home = userHomeOf(curUser);
        procEnv = { ...procEnv, ...keyringEnv, PATH: `${home}/.opencode/bin:${home}/.local/bin:${procEnv.PATH}` };
      }
    }
    const child = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: procEnv,
    });
    if (rec) {
      rec.term = child;
      rec.buf = ""; // 新しいプロセスの出力だけを保持する
      wireTerm(child);
    }
    return child;
  }

  async function setTermCwd(target) {
    if (containerCtx) {
      const dir = String(target || "");
      await runContainer(["sh", "-c", `test -d ${shq(dir || ".")}`], { timeoutMs: 10000 });
      spawnTermProc(dir, containerCtx.shell || "sh", []);
      rec.cmd = "";
      broadcast({ type: "reset", cwd: dir });
      broadcast({ type: "data", data: TERM_WELCOME });
      return;
    }
    const dir = resolveDirRel(target);
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) throw new Error("not a directory");
    spawnTermProc(dir, shell, shell.endsWith("bash") ? ["-l"] : [], rec.user);
    rec.cmd = "";
    broadcast({ type: "reset", cwd: dir });
    broadcast({ type: "data", data: TERM_WELCOME });
  }

  // ホスト側ターミナルのユーザーを切り替える（コンテナ内では不可）
  async function setTermUser(targetUser, target) {
    if (containerCtx) throw new Error("コンテナ内ではユーザー切り替えはできません");
    const u = String(targetUser || "");
    if (!/^[a-z_][a-z0-9_-]*$/i.test(u)) throw new Error("invalid user");
    const dir = resolveDirRel(target);
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) throw new Error("not a directory");
    rec.user = u;
    spawnTermProc(dir, shell, shell.endsWith("bash") ? ["-l"] : [], u);
    rec.cmd = "";
    broadcast({ type: "reset", cwd: dir, user: u });
    broadcast({ type: "data", data: TERM_WELCOME });
  }

  async function execCmd(target, cmdRaw, forceRoot, argsRaw) {
    const cmd = String(cmdRaw || "freebuff");
    if (!/^[a-zA-Z0-9._/+-]+$/.test(cmd)) throw new Error("invalid command");
    // AI連携などからプロンプトを引数付きで起動できるよう、引数はシェルクォートして渡す
    const args = Array.isArray(argsRaw) ? argsRaw.map((a) => String(a ?? "")) : [];
    const full = args.length ? cmd + " " + args.map(shq).join(" ") : cmd;
    if (containerCtx) {
      const dir = String(target || "");
      await runContainer(["sh", "-c", `test -d ${shq(dir || ".")}`], { timeoutMs: 10000 });
      // コンテナ内にコマンドが無ければ確認してからインストールする（ホスト側と同様）
      if (INSTALL_CMDS[cmd]) {
        let found = false;
        try {
          // opencode は ~/.opencode/bin、Antigravity CLI (agy) は ~/.local/bin にインストールされるため、インストール判定の PATH にも追加する
          const { stdout } = await runContainer(["sh", "-c", 'export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"; command -v ' + cmd], { timeoutMs: 8000 });
          found = stdout.toString("utf8").trim().length > 0;
        } catch {}
        if (!found) {
          spawnInstallFlow(dir, cmd, INSTALL_CMDS[cmd], null);
          rec.cmd = cmd;
          broadcast({ type: "started", cmd, cwd: dir, installing: true });
          return;
        }
      }
      spawnTermProc(dir, cmd, args);
      rec.cmd = cmd;
      broadcast({ type: "started", cmd, cwd: dir });
      return;
    }
    const dir = resolveDirRel(target);
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) throw new Error("not a directory");
    // root モードが ON の場合は root で実行する
    const execUser = (forceRoot && IS_ROOT) ? "root" : rec.user;
    // 未インストールのコマンド（opencode / freebuff / cline / agy）は確認してからインストールする
    // （判定はターミナルが実際に使う PATH = env.PATH で行う。agy は端末ユーザーの ~/.local/bin も対象）
    const userHome = execUser ? userHomeOf(execUser) : (process.env.HOME || os.homedir());
    if (!findBin(cmd, env.PATH, userHome) && INSTALL_CMDS[cmd]) {
      spawnInstallFlow(dir, cmd, INSTALL_CMDS[cmd], execUser);
      rec.cmd = cmd;
      broadcast({ type: "started", cmd, cwd: dir, installing: true });
      return;
    }
    // シェル経由で起動して、シェルの初始化（profile 読み込み・PATH 設定）を行う。
    // これにより、opencode の内部シェルも正しく動作する。
    const userShell = process.env.SHELL || (fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
    spawnTermProc(dir, userShell, ["-l", "-c", full], execUser);
    rec.cmd = cmd;
    broadcast({ type: "started", cmd, cwd: dir });
  }

  // 未インストールのコマンドを、確認してからインストールして起動する（ホスト/コンテナ共通）。
  // pty 上でシェルスクリプトを起動し、[Y/n] の確認（Enter で y = インストール）→ インストール → 起動 を行う。
  function spawnInstallFlow(dir, cmd, installCmd, procUser) {
    // コンテナ内ではコンテナ側のシェルで、ホスト側では rec.user で起動する
    const procShell = containerCtx ? (containerCtx.shell || "sh") : shell;
    const script = [
      "printf '\\r\\n\\x1b[33m[selfcode] " + cmd + " がインストールされていません。インストールしますか？ [Y/n] \\x1b[0m'",
      "IFS= read -r ans",
      'case "${ans:-y}" in',
      "  y|Y|'')",
      "    echo '[selfcode] インストールを開始します…'",
      "    " + installCmd,
      "    if command -v " + cmd + " >/dev/null 2>&1; then",
      // beacon は常駐エージェントではないためインストール後に CLI を起動せず、シェルに戻す
      cmd === "beacon"
        ? "      echo '[selfcode] インストールが完了しました。beacon-collector サービスの状態は「AI設定」の beacon.sh カードで確認できます'"
        : "      echo '[selfcode] インストールが完了しました。" + cmd + " を起動します…'\n      exec " + cmd,
      "    else",
      "    echo '[selfcode] インストールに失敗しました。もう一度お試しください'",
      "    fi",
      "    ;;",
      "  *)",
      "    echo '[selfcode] インストールをスキップしました'",
      "    ;;",
      "esac",
      "exec " + procShell,
    ].join("\n");
    spawnTermProc(dir, procShell, ["-c", script], procUser);
  }
});

// 旧保存先（/opt/lxd-data/note/selfcode）に置かれていた自己管理データを新ディレクトリへ移行する。
// アップデートで新バージョン（v.3.0.0+）が起動しても設定を見失わないための処理。
// 新側に未作成のファイルだけをコピーし（旧側のファイルは残す）、既存値を壊さない。
const SELF_MANAGED_CONFIG_FILES = [
  "selfcode-memo.md",
  "selfcode-ssh.json",
  "selfcode-term.json",
  "selfcode-github.json",
  "selfcode-templates.json",
];

async function migrateLegacyConfigFiles() {
  for (const name of SELF_MANAGED_CONFIG_FILES) {
    const from = LEGACY_CONFIG_DIR + "/" + name;
    const to = SELFCODE_CONFIG_DIR + "/" + name;
    try {
      await fsp.access(to);
      continue; // 新側に既にあるファイルは触らない（自分の環境で先に移行済みのケース）
    } catch {}
    try {
      const raw = await fsp.readFile(from);
      await fsp.mkdir(SELFCODE_CONFIG_DIR, { recursive: true });
      await fsp.writeFile(to, raw);
      console.log(`[selfcode] migrated config file: ${from} -> ${to}`);
    } catch {}
  }
}

migrateLegacyConfigFiles()
  .catch((e) => console.error("[selfcode] legacy config migration failed: " + e.message))
  .then(() => loadGithubConfig())
  .catch((e) => console.error("[selfcode] GitHub config load failed: " + e.message));

server.listen(PORT, HOST, () => {
  console.log(`[selfcode] listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`[selfcode] root: ${ROOT}`);
  if (SELF_PASS) console.log(`[selfcode] basic auth enabled (user: ${SELF_USER})`);
});

function shutdown() {
  console.log("\n[selfcode] shutting down");
  for (const r of terminals.values()) {
    try {
      r.term.kill();
    } catch {}
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
