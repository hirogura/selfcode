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
const OC_BIN = process.env.OPENCODE_BIN || "opencode";
const MEMO_FILE = process.env.SELFCODE_MEMO || "/opt/lxd-data/note/selfcode-memo.md";
const RESTART_CMD = process.env.SELFCODE_RESTART_CMD || "systemctl restart selfcode";
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

const oc = { port: null, password: OC_PASS, ready: false, child: null, version: null };

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
  const port = await findFreePort();
  if (!oc.password) oc.password = crypto.randomBytes(24).toString("base64url");
  const env = { ...process.env, OPENCODE_SERVER_PASSWORD: oc.password, OPENCODE_SERVER_USERNAME: OC_USER };
  const child = spawn(OC_BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
    env,
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  oc.child = child;
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
    console.log(`[selfcode] opencode exited (${code}), restarting in 3s`);
    oc.ready = false;
    oc.port = null;
    setTimeout(startOpencode, 3000);
  });
}

async function waitOpencode() {
  if (oc.ready) return;
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

// ================= GitHub 連携 =================
// 設定（ユーザー名・トークン・登録リポジトリ）はサーバー側の JSON に保存し、トークンをブラウザに返さない。
// git 操作はワークスペース内（コンテナ内ではコンテナ側）で実行する。
const GITHUB_CONFIG = process.env.SELFCODE_GITHUB_CONFIG || "/opt/lxd-data/note/selfcode-github.json";
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
      if (!st || !st.isDirectory()) return res.status(400).json({ error: "フォルダが見つかりません: " + p });
    }
    const chk = await runGit(p, ["rev-parse", "--is-inside-work-tree"], 10000);
    if (chk.code !== 0 || chk.stdout.trim() !== "true") {
      const detail = (chk.stderr || "").trim();
      return res.status(400).json({ error: "git リポジトリではありません: " + p + (detail ? "（" + detail + "）" : "") });
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
    if (!["status", "fetch", "pull", "log", "commit", "push"].includes(action)) {
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
    const args = action === "log" ? ["log", "--oneline", "-10"] : [action];
    const r = await runGit(repo.path, args, action === "pull" ? 120000 : 60000);
    const output = (r.stdout + r.stderr).trim();
    res.json({ ok: r.code === 0, action, code: r.code, output });
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
function findBin(name, pathStr) {
  const dirs = (pathStr || process.env.PATH || "").split(":").filter(Boolean);
  const candidates = dirs.map((d) => path.join(d, name));
  if (name === "lxc") candidates.push("/snap/bin/lxc", "/usr/bin/lxc", "/usr/local/bin/lxc");
  if (name === "docker") candidates.push("/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker");
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
    'export PATH="$HOME/.opencode/bin:$PATH"; curl -fsSL https://opencode.ai/install | bash',
  freebuff:
    'if [ "$(id -u)" = "0" ]; then npm install -g freebuff; else sudo npm install -g freebuff; fi',
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
  const ocBin = path.dirname(process.env.OPENCODE_BIN && path.isAbsolute(process.env.OPENCODE_BIN) ? process.env.OPENCODE_BIN : OC_BIN);
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
      else if (msg.type === "exec") execCmd(msg.cwd, msg.cmd).catch((e) => broadcast({ type: "data", data: "\r\n\x1b[31m[selfcode] " + e.message + "\x1b[0m\r\n" }));
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
      // opencode は ~/.opencode/bin にインストールされるため、コンテナ内の PATH にも追加しておく
      // （インストール判定と実行で同じ PATH にする）
      const inner = `${dir ? `cd ${shq(dir)} 2>/dev/null || true; ` : ""}export PATH="$HOME/.opencode/bin:$PATH"; exec ${procCmd}${argStr}`;
      bin = containerBin(containerCtx.runtime);
      args = [...containerExecArgs(containerCtx.runtime, containerCtx.name, true), "sh", "-c", inner];
      cwd = ROOT;
    } else {
      const curUser = process.env.USER || (os.userInfo && os.userInfo().username) || "root";
      if (procUser && procUser !== curUser) {
        // 別ユーザーでシェルを起動する（root から一般ユーザーへの切り替えのみ可能）。
        // su -c だと bash が端末のプロセスグループを設定できずジョブ制御が無効になるため、
        // exec で直接置き換わる setpriv を使う（cwd は pty 側で指定する）。
        if (!IS_ROOT) throw new Error(`ユーザー ${procUser} への切り替えは root 権限が必要です`);
        bin = "setpriv";
        args = ["--reuid=" + procUser, "--regid=" + procUser, "--init-groups", "--", procCmd, ...(procArgs || [])];
        cwd = dir;
        procEnv = { ...procEnv, HOME: userHomeOf(procUser), USER: procUser, LOGNAME: procUser, SHELL: procCmd };
      } else {
        bin = procCmd;
        args = procArgs || [];
        cwd = dir;
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

  async function execCmd(target, cmdRaw) {
    const cmd = String(cmdRaw || "freebuff");
    if (!/^[a-zA-Z0-9._/+-]+$/.test(cmd)) throw new Error("invalid command");
    if (containerCtx) {
      const dir = String(target || "");
      await runContainer(["sh", "-c", `test -d ${shq(dir || ".")}`], { timeoutMs: 10000 });
      // コンテナ内にコマンドが無ければ確認してからインストールする（ホスト側と同様）
      if (INSTALL_CMDS[cmd]) {
        let found = false;
        try {
          // opencode は ~/.opencode/bin にインストールされるため、インストール判定の PATH にも追加する
          const { stdout } = await runContainer(["sh", "-c", 'export PATH="$HOME/.opencode/bin:$PATH"; command -v ' + cmd], { timeoutMs: 8000 });
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
    // 未インストールのコマンド（opencode / freebuff）は確認してからインストールする
    // （判定はターミナルが実際に使う PATH = env.PATH で行う）
    if (!findBin(cmd, env.PATH) && INSTALL_CMDS[cmd]) {
      spawnInstallFlow(dir, cmd, INSTALL_CMDS[cmd], rec.user);
      rec.cmd = cmd;
      broadcast({ type: "started", cmd, cwd: dir, installing: true });
      return;
    }
    spawnTermProc(dir, cmd, [], rec.user);
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
  startOpencode();
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
