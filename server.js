import http from "node:http";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3339);
// 既定は localhost のみ待受（LAN 非公開）。Tailscale serve で Tailnet 内に HTTPS 公開する想定
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(process.env.ROOT || "/");
const SELF_USER = process.env.SELFCODE_USERNAME || "selfcode";
const SELF_PASS = process.env.SELFCODE_PASSWORD || "";
const OC_USER = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const OC_PASS = process.env.OPENCODE_SERVER_PASSWORD || "";
const OC_BIN_RAW = process.env.OPENCODE_BIN || "opencode";
const MEMO_FILE = process.env.SELFCODE_MEMO || "/opt/lxd-data/note/selfcode/selfcode-memo.md";
const RESTART_CMD = process.env.SELFCODE_RESTART_CMD || "systemctl restart selfcode";
const UPDATE_TIMEOUT_MS = Number(process.env.SELFCODE_UPDATE_TIMEOUT || 900000); // アップデートのタイムアウト（既定 15 分）
const HIDDEN = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", ".cache"]);

// プロセスが root で動いているか（systemd サービスは root で起動する）
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

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

const app = express();
app.use((req, res, next) => {
  if (req.path.startsWith("/opencode")) return next();
  return express.json({ limit: "64mb" })(req, res, next);
});

const oc = { port: null, password: OC_PASS, ready: false, child: null, version: null, manualStop: false };

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function startOpencode() {
  if (oc.manualStop) return; // 手動停止済みなら再起動しない
  if (oc.child) return; // 既に起動済み
  // root で動いている場合、PATH にユーザーの ~/.opencode/bin が含まれないため、
  // findBin でフルパスを解決する
  const termHome = TERM_USER ? userHomeOf(TERM_USER) : null;
  const binPath = findBin(OC_BIN_RAW, process.env.PATH || "", termHome) || OC_BIN_RAW;
  const port = await findFreePort();
  if (!oc.password) oc.password = crypto.randomBytes(24).toString("base64url");
  const env = { ...process.env, OPENCODE_SERVER_PASSWORD: oc.password, OPENCODE_SERVER_USERNAME: OC_USER };
  const child = spawn(binPath, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
    env,
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  oc.child = child;
  child.on("error", (err) => {
    console.error(`[selfcode] opencode 起動エラー: ${err.message}`);
    oc.ready = false;
    oc.port = null;
    oc.child = null;
  });
  child.stdout.on("data", (d) => {
    const m = String(d).match(/listening on (http:\/\/[^\s]+)/);
    if (m) {
      oc.port = new URL(m[1]).port;
      oc.ready = true;
      console.log(`[selfcode] opencode ready on 127.0.0.1:${oc.port}`);
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(`[opencode] ${String(d).trimEnd()}\n`));
  child.on("exit", (code) => {
    oc.ready = false;
    oc.port = null;
    if (oc.manualStop) {
      console.log(`[selfcode] opencode stopped manually (${code})`);
      return;
    }
    console.log(`[selfcode] opencode exited (${code}), restarting in 3s`);
    setTimeout(startOpencode, 3000);
  });
}

function stopOpencode() {
  if (!oc.child) return;
  oc.manualStop = true;
  try { oc.child.kill("SIGTERM"); } catch {}
  oc.child = null;
  oc.ready = false;
  oc.port = null;
  console.log("[selfcode] opencode stopped");
}

async function waitOpencode() {
  if (oc.ready) return;
  oc.manualStop = false; // プロキシ要求時 = チャットパネルが開かれたので再起動を許可
  startOpencode(); // 未起動なら起動する
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (oc.ready) {
        clearInterval(t);
        resolve();
      }
    }, 250);
    setTimeout(() => {
      clearInterval(t);
      resolve();
    }, 60000);
  });
}

const ocAuthHeader = () => "Basic " + Buffer.from(`${OC_USER}:${oc.password}`).toString("base64");

function proxyOpencode(req, res, next) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    return res.sendStatus(204);
  }
  if (!oc.ready) {
    waitOpencode().then(() => {
      if (oc.ready) doProxy(req, res);
      else res.status(503).json({ error: "opencode server not ready" });
    });
    return;
  }
  doProxy(req, res);
}

function doProxy(req, res) {
  const target = new URL(req.originalUrl.replace(/^\/opencode\/?/, "/") || "/", `http://127.0.0.1:${oc.port}`);
  const headers = { ...req.headers, host: target.host, authorization: ocAuthHeader() };
  const isEvent = String(req.url).includes("/event");
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
      agent: isEvent ? false : undefined,
    },
    (up) => {
      const fwd = { ...up.headers };
      delete fwd["connection"];
      delete fwd["keep-alive"];
      delete fwd["transfer-encoding"];
      delete fwd["content-length"];
      res.writeHead(up.statusCode || 502, fwd);
      up.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.status(502).json({ error: "opencode proxy error" });
    else res.destroy();
  });
  req.pipe(upstream);
  const cleanup = () => upstream.destroy();
  res.on("close", cleanup);
  req.on("aborted", cleanup);
  upstream.on("close", () => {
    if (!res.writableEnded) res.destroy();
  });
}

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

app.use(async (req, res, next) => {
  if (!SELF_PASS) return next();
  const b = req.headers.authorization || "";
  const m = b.match(/^Basic (.+)$/);
  if (!m) return res.status(401).setHeader("WWW-Authenticate", "Basic realm=\"selfcode\"").end();
  let user = "";
  let pass = "";
  try {
    const dec = Buffer.from(m[1], "base64").toString();
    [user, pass] = dec.split(":");
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
    version: "0.1.0",
    workspace: ROOT,
    container: containerCtx ? { name: containerCtx.name, runtime: containerCtx.runtime } : null,
    opencode: { ready: oc.ready, version: oc.version },
    termUser: TERM_USER,
    termIsRoot: IS_ROOT,
  });
});

app.post("/api/opencode/stop", (req, res) => {
  stopOpencode();
  res.json({ ok: true });
});

// opencode がインストールされているかどうかを返す
app.get("/api/opencode/check", (req, res) => {
  // root で動いている場合、process.env.HOME は /root になるが、
  // ターミナルユーザーのホーム（例: /home/user）にもインストールされることがあるため、
  // 両方のホームディレクトリを検出対象にする
  const termHome = TERM_USER ? userHomeOf(TERM_USER) : null;
  const installed = !!findBin("opencode", process.env.PATH || "", termHome);
  res.json({ installed });
});

// ================= 一時SSH（agy などの OAuth 認証を手元 PC から行えるようにする） =================
// 選択中の LXD コンテナ（未選択ならホスト）の sshd に対して、一時パスワードの設定と
// パスワード認証・root ログインの一時有効化を行い、OFF で元に戻す。
// ホストPCの場合はキーリング（D-Bus / Secret Service）を読み取れる環境変数設定も行う。
// 状態はサーバー再起動後も保持する（ON のまま再起動しても復元対象を失わないように）。
const SSH_TEMP_STATE_FILE = process.env.SELFCODE_SSH_STATE || "/opt/lxd-data/note/selfcode/selfcode-ssh.json";
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

// openssh-server を apt でインストールする（未導入時に y が選ばれた場合）
async function installOpensshServer(target) {
  const cmd =
    'command -v apt-get >/dev/null 2>&1 || { echo "[selfcode] apt-get が見つかりません（Ubuntu/Debian 以外では手動で openssh-server を導入してください）" >&2; exit 1; }; ' +
    "apt-get update || true; " +
    "DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server";
  if (target.type === "container") await runContainer(["sh", "-c", cmd], { timeoutMs: 300000 });
  else await runCmd("sh", ["-c", cmd], 300000);
}

// ホストの Tailscale マジックDNS名（tailnet 内のホスト名）を取得する。取得できなければ null
async function tailscaleMagicDns() {
  try {
    const bin = findBin("tailscale") || "tailscale";
    const out = await runCmd(bin, ["status", "--json"], 8000);
    const j = JSON.parse(out.toString("utf8"));
    const name = j && j.Self && j.Self.DNSName ? String(j.Self.DNSName).replace(/\\.+$/, "") : "";
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
    if (containerCtx) {
      await runContainer(["rm", "-rf", String(req.query.path || "")]);
      return res.json({ ok: true });
    }
    const abs = resolveRel(req.query.path);
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
// 別のPCから同じ selfcode を開いても同じセッション（ターミナル・チャット選択）に
// 接続できるよう、ブラウザの localStorage にしか無かった状態をサーバー側にも保存する。
const TERM_STATE_FILE = process.env.SELFCODE_TERM_STATE || "/opt/lxd-data/note/selfcode/selfcode-term.json";
const CHAT_STATE_FILE = process.env.SELFCODE_CHAT_STATE || "/opt/lxd-data/note/selfcode/selfcode-chat.json";

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

// チャットパネルで選択中の opencode セッションとワークスペース（ディレクトリ）
app.get("/api/chat/state", async (req, res, next) => {
  try {
    res.json(await readStateFile(CHAT_STATE_FILE, {}));
  } catch (e) {
    next(e);
  }
});

app.put("/api/chat/state", async (req, res, next) => {
  try {
    const { sessionId, directory } = req.body || {};
    await writeStateFile(CHAT_STATE_FILE, { sessionId: sessionId || null, directory: directory || "" });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ================= GitHub 連携 =================
// 設定（ユーザー名・トークン・登録リポジトリ）はサーバー側の JSON に保存し、トークンをブラウザに返さない。
// git 操作はワークスペース内（コンテナ内ではコンテナ側）で実行する。
const GITHUB_CONFIG = process.env.SELFCODE_GITHUB_CONFIG || "/opt/lxd-data/note/selfcode/selfcode-github.json";
let githubCfg = { username: "", token: "", repos: [] };

async function loadGithubConfig() {
  try {
    const raw = await fsp.readFile(GITHUB_CONFIG, "utf8");
    const d = JSON.parse(raw);
    githubCfg = {
      username: String((d && d.username) || ""),
      token: String((d && d.token) || ""),
      repos: Array.isArray(d && d.repos) ? d.repos : [],
    };
  } catch {}
}

async function saveGithubConfig() {
  await fsp.mkdir(path.dirname(GITHUB_CONFIG), { recursive: true });
  await fsp.writeFile(GITHUB_CONFIG, JSON.stringify(githubCfg, null, 2));
}

// GitHub REST API（トークンはサーバー側でのみ使用）
async function ghApi(p, opts = {}) {
  if (!githubCfg.token) {
    const e = new Error("GitHub トークンが設定されていません");
    e.status = 400;
    throw e;
  }
  let res;
  try {
    res = await fetch("https://api.github.com" + p, {
      method: opts.method || "GET",
      headers: {
        authorization: "Bearer " + githubCfg.token,
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
  if (!githubCfg.token || !String(url || "").includes("github.com")) return [];
  const auth = "basic " + Buffer.from("x-access-token:" + githubCfg.token).toString("base64");
  return ["-c", "credential.helper=", "-c", "core.askPass=true", "-c", "http.extraheader=AUTHORIZATION: " + auth];
}

// 所有権が異なるリポジトリ（例: root で稼働するサーバーから別ユーザー所有のリポジトリを操作）でも
// git が拒否しないよう safe.directory を付与する（dubious ownership 対策）。
const GIT_SAFE_DIR = ["-c", "safe.directory=*"];

function runGitSpawn(cwd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", [...GIT_SAFE_DIR, ...args], {
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
      resolve({ code: -1, stdout: out, stderr: err + String(e.message) });
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

// 設定の状態（トークン自体は返さない）
app.get("/api/github/status", (req, res) => {
  res.json({
    configured: !!(githubCfg.username && githubCfg.token),
    username: githubCfg.username || null,
    hasToken: !!githubCfg.token,
    repos: githubCfg.repos.map((r) => ({ id: r.id, name: r.name, path: r.path, url: r.url })),
  });
});

// ユーザー名・トークンを保存（トークン欄が空で保存済みトークンがあれば既存を維持）。保存後に検証も行う。
app.put("/api/github/settings", async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim();
    let token = String(req.body.token || "").trim();
    if (!token && githubCfg.token) token = githubCfg.token;
    if (!username) return res.status(400).json({ error: "ユーザー名を入力してください" });
    if (!token) return res.status(400).json({ error: "トークンを入力してください" });
    githubCfg.username = username;
    githubCfg.token = token;
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
    });
  } catch (e) {
    next(e);
  }
});

// 設定（ユーザー名・トークン）をクリア
app.delete("/api/github/settings", async (req, res, next) => {
  try {
    githubCfg.username = "";
    githubCfg.token = "";
    await saveGithubConfig();
    res.json({ ok: true, configured: false });
  } catch (e) {
    next(e);
  }
});

// git config --global user.name / user.email の取得・保存
async function runGitConfigGet(key) {
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
    const name = await runGitConfigGet("user.name");
    const email = await runGitConfigGet("user.email");
    res.json({ name, email });
  } catch (e) {
    next(e);
  }
});

app.put("/api/github/git-config", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    const email = String(req.body.email ?? "").trim();
    await runGitConfigSet("user.name", name);
    await runGitConfigSet("user.email", email);
    res.json({ ok: true, name, email });
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
    for (const r of githubCfg.repos) {
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
    const repo = { id: githubRepoId(), name: defaultName, path: target, url };
    githubCfg.repos.push(repo);
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
    if (githubCfg.repos.some((r) => r.path === p)) return res.status(400).json({ error: "既に登録済みです: " + p });
    const origin = await gitOriginUrl(p).catch(() => "");
    const name = p.split("/").filter(Boolean).pop() || p || "repo";
    const repo = { id: githubRepoId(), name, path: p, url: origin };
    githubCfg.repos.push(repo);
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
    const repo = githubCfg.repos.find((r) => r.id === id);
    if (!repo) return res.status(404).json({ error: "リポジトリが見つかりません" });
    if (!["status", "fetch", "pull", "log", "commit", "cancel", "push", "branch", "cleanup"].includes(action)) {
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
      // git fetch --prune でリモートの最新状態を取得
      await runGit(repo.path, ["fetch", "--prune"], 60000);
      // 現在チェックアウト中のブランチを取得
      const curBr = await runGit(repo.path, ["branch", "--show-current"], 5000);
      const currentBranch = (curBr.stdout || "").trim();
      // ブランチ一覧を取得（追跡情報を含む）
      const listR = await runGit(repo.path, ["branch", "-vv", "--no-color"], 10000);
      if (listR.code !== 0) {
        return res.json({ ok: false, action, output: (listR.stdout + listR.stderr).trim() });
      }
      // [origin/...: gone] となっているブランチを検出
      const lines = (listR.stdout || "").split("\n");
      const toDelete = [];
      for (const line of lines) {
        const m = line.match(/^\*?\s+(\S+)\s+\S+\s+\[origin\/[^:]+:\s+gone\]/);
        if (m) {
          const branchName = m[1];
          if (branchName !== currentBranch) toDelete.push(branchName);
        }
      }
      if (!toDelete.length) {
        return res.json({ ok: true, action, deleted: [], output: "削除するブランチはありません" });
      }
      const deleted = [];
      const errors = [];
      for (const b of toDelete) {
        const r = await runGit(repo.path, ["branch", "-d", b], 30000);
        if (r.code === 0) {
          deleted.push(b);
        } else {
          errors.push(b + ": " + (r.stdout + r.stderr).trim());
        }
      }
      const output = deleted.length ? "削除: " + deleted.join(", ") : "";
      const errOutput = errors.length ? "\n削除失敗:\n" + errors.join("\n") : "";
      return res.json({ ok: true, action, deleted, output: (output + errOutput).trim() || "完了" });
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
    const r = await runGit(repo.path, [action], 60000);
    const output = (r.stdout + r.stderr).trim();
    res.json({ ok: r.code === 0, action, code: r.code, output });
  } catch (e) {
    next(e);
  }
});

// リモートURLの追加/更新とトラッキングブランチの設定
app.post("/api/github/repos/:id/remote", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    const repo = githubCfg.repos.find((r) => r.id === id);
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

// 登録を解除（ファイルは削除しない）
app.delete("/api/github/repos/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    const before = githubCfg.repos.length;
    githubCfg.repos = githubCfg.repos.filter((r) => r.id !== id);
    if (githubCfg.repos.length === before) return res.status(404).json({ error: "リポジトリが見つかりません" });
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
    'export PATH="$HOME/.opencode/bin:$PATH"; curl -fsSL https://opencode.ai/install | bash; if [ "$(id -u)" = "0" ] && [ -f /root/.opencode/bin/opencode ]; then cp -f /root/.opencode/bin/opencode /usr/local/bin/opencode 2>/dev/null && chmod 755 /usr/local/bin/opencode 2>/dev/null || true; fi',
  // freebuff は npm グローバルインストール。npm / node が無い環境（LXD コンテナ等）でも
  // パッケージマネージャ（apt / apk / dnf / yum）から nodejs / npm を自動インストールしてから進める。
  // freebuff CLI は Node.js 18+ 必須のため、バージョンも確認する。
  freebuff:
    "if ! command -v npm >/dev/null 2>&1; then echo '[selfcode] npm が見つかりません。nodejs / npm をインストールします…'; " +
      "if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq nodejs npm; " +
      "elif command -v apk >/dev/null 2>&1; then apk add --no-cache nodejs npm; " +
      "elif command -v dnf >/dev/null 2>&1; then dnf install -y nodejs npm; " +
      "elif command -v yum >/dev/null 2>&1; then yum install -y nodejs npm; " +
      "else echo '[selfcode] 対応するパッケージマネージャがありません。nodejs / npm を手動でインストールしてください'; exit 1; fi; fi; " +
      "if ! command -v node >/dev/null 2>&1 || ! node -e \"if(Number(process.versions.node.split('.')[0])<18)process.exit(1)\"; then " +
      "echo '[selfcode] Node.js 18 以上が必要です。古い Node が入っている場合は更新してください'; exit 1; fi; " +
      'if [ "$(id -u)" = "0" ]; then npm install -g freebuff; else sudo npm install -g freebuff; fi',
  agy:
    'export PATH="$HOME/.local/bin:$PATH"; curl -fsSL https://antigravity.google/cli/install.sh | bash; if [ "$(id -u)" = "0" ] && [ -f /root/.local/bin/agy ]; then cp -f /root/.local/bin/agy /usr/local/bin/agy 2>/dev/null && chmod 755 /usr/local/bin/agy 2>/dev/null || true; fi',
};

// コンテナ内でコマンドを実行するための CLI 引数（tty: ターミナル用に疑似端末を割り当てる）
// lxc exec / docker exec はデフォルトでホームディレクトリから起動するため、--cwd / を付けて
// コンテナ内のルートから起動する（エクスプローラのルートをコンテナ内の / に合わせる）
function containerExecArgs(runtime, name, tty) {
  if (runtime === "docker") return tty ? ["exec", "-it", "-w", "/", name] : ["exec", "-i", "-w", "/", name];
  return tty ? ["exec", "-t", "--cwd", "/", name, "--"] : ["exec", "--cwd", "/", name, "--"];
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
// 応答は返らずクライアント側の接続断が「再起動開始」の合図になる。失敗時のみエラーを返す。
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
    // ここまで生き残っている = 再起動に失敗（成功時は systemctl が自分のプロセスを停止する）
    if (!res.headersSent) res.status(500).json({ error: "再起動に失敗しました (exit " + code + "): " + out.trim() });
  });
});

// アップデート: 公式インストールスクリプトの取得 → 実行。
// スクリプト内で git pull / npm install が行われ、完了後に「リスタート」で新コードへ切り替わる。
// root 以外の所有者リポジトリでも動くよう safe.directory を事前に登録する。
const UPDATE_SCRIPT = `
set -e
git config --global --add safe.directory '${__dirname}' >/dev/null 2>&1 || true
update_tmp="$(mktemp /tmp/selfcode-install-XXXXXX.sh)"
trap 'rm -f "$update_tmp"' EXIT
curl -fsSL https://raw.githubusercontent.com/hirogura/selfcode/main/install-selfcode.sh -o "$update_tmp"
bash "$update_tmp"
`;

app.post("/api/update", async (req, res, next) => {
  console.log("[selfcode] update requested");
  try {
    const out = await runCmd("bash", ["-c", UPDATE_SCRIPT], UPDATE_TIMEOUT_MS);
    const log = out.toString("utf8").trim();
    console.log("[selfcode] update finished\n" + log.split("\n").slice(-10).join("\n"));
    res.json({ ok: true, log });
  } catch (e) {
    res.status(500).json({ error: "アップデートに失敗しました: " + (e.message || e) });
  }
});

app.use("/monaco/vs", express.static(path.join(__dirname, "node_modules/monaco-editor/min/vs")));
app.use("/monaco", express.static(path.join(__dirname, "node_modules/monaco-editor/min/vs")));
app.use("/xterm", express.static(path.join(__dirname, "node_modules/@xterm/xterm/lib")));
app.use("/xterm-css", express.static(path.join(__dirname, "node_modules/@xterm/xterm/css")));
app.use("/xterm-fit", express.static(path.join(__dirname, "node_modules/@xterm/addon-fit/lib")));

app.use("/opencode", proxyOpencode);
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
      else if (msg.type === "exec") execCmd(msg.cwd, msg.cmd, msg.root).catch((e) => broadcast({ type: "data", data: "\r\n\x1b[31m[selfcode] " + e.message + "\x1b[0m\r\n" }));
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
        // ~/.local/bin にインストールされる CLI（Antigravity CLI など）を直接起動できるように PATH にも追加する
        procEnv = { ...procEnv, PATH: `${home}/.local/bin:${procEnv.PATH}` };
      } else {
        bin = procCmd;
        args = procArgs || [];
        cwd = dir;
        // 同上: 実行ユーザーの ~/.local/bin を PATH に追加（インストール済みの agy などを直接起動できるように）
        procEnv = { ...procEnv, ...keyringEnv, PATH: `${userHomeOf(curUser)}/.local/bin:${procEnv.PATH}` };
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

  async function execCmd(target, cmdRaw, forceRoot) {
    const cmd = String(cmdRaw || "freebuff");
    if (!/^[a-zA-Z0-9._/+-]+$/.test(cmd)) throw new Error("invalid command");
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
      spawnTermProc(dir, cmd, []);
      rec.cmd = cmd;
      broadcast({ type: "started", cmd, cwd: dir });
      return;
    }
    const dir = resolveDirRel(target);
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) throw new Error("not a directory");
    // root モードが ON の場合は root で実行する
    const execUser = (forceRoot && IS_ROOT) ? "root" : rec.user;
    // 未インストールのコマンド（opencode / freebuff / agy）は確認してからインストールする
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
    spawnTermProc(dir, userShell, ["-l", "-c", cmd], execUser);
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
      "      echo '[selfcode] インストールが完了しました。" + cmd + " を起動します…'",
      "      exec " + cmd,
      "    fi",
      "    echo '[selfcode] インストールに失敗しました。もう一度お試しください'",
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

loadGithubConfig().catch((e) => console.error("[selfcode] GitHub config load failed: " + e.message));

server.listen(PORT, HOST, () => {
  console.log(`[selfcode] listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`[selfcode] root: ${ROOT}`);
  if (SELF_PASS) console.log(`[selfcode] basic auth enabled (user: ${SELF_USER})`);
  // opencode はチャットパネルが開かれたとき（プロキシ初回要求時）に自動起動する
});

function shutdown() {
  console.log("\n[selfcode] shutting down");
  try {
    oc.child && oc.child.kill("SIGTERM");
  } catch {}
  for (const r of terminals.values()) {
    try {
      r.term.kill();
    } catch {}
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
