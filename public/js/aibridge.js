/* AI連携: cline(PM) × opencode(実装) の自動進行オーケストレーター。
 * 方式: ターミナル2ペインで非対話ラン + 作業ディレクトリ直下の .ai-bridge/ ファイル群を伝言板にする。
 *   task.md         人間の最初の指示（ブリッジが作成）
 *   instruction.md  cline(PM)が作成する詳細指示書 → opencodeへ引き継ぎ
 *   instruction-question.md opencodeが指示書の不備を見つけた場合の質問 → clineが修正
 *   done.md         opencodeが実装完了時に書く完了報告 → clineへ引き継ぎ
 *   review-ok.md    clineがレビューOK時に書く承認 → 人間に通知
 *   instruction2.md clineが修正を求める場合の追加指示 → opencodeへ再実行
 *   follow-<side>-*.md 実行中の人間からの追加指示に対する各AIの報告（side-task 完了検知用）
 * 各AIはプロンプトをコマンドライン引数で受けて実行し、終了する
 * （cline "prompt" / opencode run [--auto] "prompt"）。完了検知は終了通知＋ファイル安定確認。
 * v2.3.0: 指示書は簡潔・短時間で作成し、工程の引き継ぎは「実行終了＋ファイル安定」で判定する。
 * 指示書の不備・レビュー差し戻しはAI同士で直接やり取りし、人間には最終確認のみ求める。
 */
window.AIBridge = (() => {
  const $ = (id) => document.getElementById(id);
  const BRIDGE = ".ai-bridge";
  const POLL_MS = 2500;
  const STALL_HINT_MS = 5 * 60 * 1000;
  // 工程引き継ぎのゲート: 書きかけのファイルを拾って早期開始しないよう、
  // 「実行終了＋内容が安定（連続ポーリングで同一内容）＋最低文字数」を満たして初めて引き継ぐ。
  const STABLE_ROUNDS = 2;
  const MIN_ARTIFACT_LEN = 20;

  const S = {
    running: false,
    phase: "idle", // idle | wait-instruction | wait-done | wait-review | done
    dir: "",
    task: "",
    clineId: null,
    opencodeId: null,
    pollTimer: null,
    exitUnsub: null,
    currentRun: null, // { pane: "cline"|"opencode", kind: "pm"|"dev"|"review"|"fix"|"troubleshoot" }
    runExited: false,
    exitCode: null,
    phaseSince: 0,
    hinted: false,
    failNotified: false,
    lastInstruction: null,
    lastDone: null,
    lastReview: null,
    lastFix: null,
    lastQuestion: null,
    stable: {}, // ゲート用: key -> { text, hits }
    handoffNotified: {}, // ゲート用: key -> 検出済み内容（「作成を検出、完了確認中」の重複ログ防止）
    lastLimitRetry: 0,
    limitNotified: false,
    limitResetUntil: 0, // 制限解除予定時刻（ms epoch）。相対表記から算出した場合は初回検知時にラッチする
    limitResetLabel: "", // 表示用ラベル（例: "15:30（あと25分）"）
    limitRaw: "", // 解除時間の根拠となった出力抜粋
    // 実行中の追加指示（人間→PM/実装）用。担当外ペイン宛は進行フローと独立に追跡する。
    followRun: null, // { pane: "cline"|"opencode", file, active, exited, code, notified }
    // 成果物なし終了時の相互リカバリー用
    recovering: false, // もう1つのAIにトラブル解決を問いかけ中
    recoverFor: null, // "instruction" | "done" | "review"
    recoverAttempts: 0, // 現フェーズでのリカバリー試行回数
    lastTrouble: null,
  };

  const normDir = (d) => String(d || "").trim().replace(/^\/+|\/+$/g, "");
  const bp = (name) => (S.dir ? S.dir + "/" + BRIDGE + "/" + name : BRIDGE + "/" + name);
  const autoApprove = () => ($("aibridge-autopermit") ? $("aibridge-autopermit").checked : true);
  const autoResume = () => ($("aibridge-autoresume") ? $("aibridge-autoresume").checked : true);
  const VIS_KEY = "selfcode.aibridgeVisible";
  const RESUME_KEY = "selfcode.aibridge.autoresume";
  // opencode の使用制限に達したときの出力パターン（レートリミット / セッションリミット等）。
  // 429 や quota 系の文言を広めに検知する（ターミナル出力の末尾に対して判定する）。
  const LIMIT_RE = /rate[\s_\-]*limit|session[\s_\-]*limit|usage[\s_\-]*limit|too many requests|\b429\b|quota|retry after|try again later|limit (reached|exceeded|hit)|reached.{0,20}limit|exceeded.{0,20}quota|セッション.{0,10}リミット|レートリミット|使用制限|利用制限/i;
  // リミット回復待ちの再実行間隔（短すぎると制限を悪化させるため最低60秒空ける）
  const LIMIT_RETRY_MS = 60 * 1000;
  // 成果物なし終了時に、もう1つのAIへトラブル解決を依頼する上限（無限ループ防止）
  const MAX_RECOVER = 2;
  // どうしても人間の確認・返答が必要そうな出力パターン（権限・認証・曖昧な指示への質問など）。
  // これに当たったら自動再実行せず、人間にターミナルでの返答を促す。
  const HUMAN_RE = /approve|permission|allow\?|confirm|confirmation|human.*(confirm|approve|check|input|reply)|need.*(human|approval|confirm|auth)|auth.*(required|failed|expired|error)|login|sign[\s_\-]*in|unauthoriz|forbidden|api[\s_\-]*key|token.*(invalid|expired|missing|required)|2fa|mfa|otp|承認|許可|確認が必要|人間の(確認|承認|判断|入力|対応)|認証(が必要|に失敗|エラー)|ログイン|再ログイン|トークン|有効期限|権限が(必要|ありません|不足)|対話的に|手動で|聞き返|質問に答え/i;
  // 実行中なのに人間の返答待ちっぽいパターン（y/n・選択肢・質問文）。停滞ヒントで人間に返答を促す用。
  const ASK_RE = /\[y\/n\]|\(y\/n\)|\[Y\/n\]|\(yes\/no\)|yes\/no|press (enter|any key)|press \[|choose (one|an option)|select (one|an option)|continue\?|proceed\?|are you sure|do you want|shall I|may I|承認しますか|続行しますか|実行しますか|よろしいですか|入力してください|選択してください|答えてください|教えてください|\?\s*$/i;

  function toast(msg, isErr) {
    let t = $("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle("err", !!isErr);
    t.style.opacity = "1";
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.style.opacity = "0"), 3000);
  }

  function log(msg) {
    const box = $("aibridge-log");
    if (!box) return;
    const line = document.createElement("div");
    line.className = "aibridge-log-line";
    const time = new Date().toLocaleTimeString("ja-JP", { hour12: false });
    line.textContent = `[${time}] ${msg}`;
    box.prepend(line);
    while (box.children.length > 80) box.lastChild.remove();
  }

  function setStatus(text, active) {
    const el = $("aibridge-status");
    if (el) {
      el.textContent = text;
      el.classList.toggle("on", !!active);
    }
    const btn = $("btn-aibridge");
    // ボタン表示は「パネル表示中」または「連携実行中」の OR。作業中もターミナルが見えるようパネル化したため。
    if (btn) btn.classList.toggle("active", !!active || visible());
  }

  function visible() {
    const el = $("aibridge");
    return !!el && !el.classList.contains("hidden");
  }

  function notifyHuman(title, body) {
    toast(title, false);
    log(title + (body ? " — " + String(body).slice(0, 200) : ""));
    try {
      if ("Notification" in window) {
        if (Notification.permission === "granted") {
          new Notification(title, { body: String(body || "").slice(0, 300) });
        } else if (Notification.permission !== "denied") {
          Notification.requestPermission().then((p) => {
            if (p === "granted") {
              try { new Notification(title, { body: String(body || "").slice(0, 300) }); } catch {}
            }
          }).catch(() => {});
        }
      }
    } catch {}
  }

  async function readText(rel) {
    try {
      const d = await API.readFile(rel);
      if (d && d.type === "text") return d.content || "";
      return null;
    } catch {
      return null; // 未作成など
    }
  }

  function stripAnsi(s) {
    return String(s || "")
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\x1b[()][0-9A-Z]/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  }

  function paneTail(paneId, n) {
    try {
      const raw = window.App.termLog(paneId, n || 3000) || "";
      return stripAnsi(raw).trim();
    } catch {
      return "";
    }
  }

  function setPhase(phase, statusText) {
    S.phase = phase;
    S.phaseSince = Date.now();
    S.hinted = false;
    S.failNotified = false;
    S.runExited = false;
    S.exitCode = null;
    S.limitNotified = false;
    S.limitResetUntil = 0;
    S.limitResetLabel = "";
    S.limitRaw = "";
    S.recovering = false;
    S.recoverFor = null;
    S.recoverAttempts = 0;
    S.lastTrouble = null;
    S.stable = {};
    S.handoffNotified = {};
    if (statusText) setStatus(statusText, true);
  }

  function humanNeededReason(text) {
    const t = String(text || "");
    if (!t) return null;
    const m = t.match(HUMAN_RE);
    return m ? m[0] : null;
  }

  function isAskingHuman(text) {
    return ASK_RE.test(String(text || ""));
  }

  // ---- 工程引き継ぎゲート（早期開始・完了誤判定の防止） ----
  // 書きかけ検出を防ぐため、引き継ぎは次の3点をすべて満たしたときのみ行う。
  //   1. 担当AIの実行が終了している（S.runExited）
  //   2. 内容が最低文字数以上で、前回引き継ぎ済みと異なる
  //   3. 同一内容が連続 STABLE_ROUNDS 回観測されている（保存中の部分書き込みを拾わない）
  function artifactReady(key, content, lastSeen) {
    const text = String(content || "");
    if (!text.trim() || text.trim().length < MIN_ARTIFACT_LEN) {
      S.stable[key] = null;
      return false;
    }
    if (lastSeen != null && text === lastSeen) {
      S.stable[key] = null;
      return false;
    }
    const prev = S.stable[key];
    if (prev && prev.text === text) {
      prev.hits += 1;
    } else {
      S.stable[key] = { text, hits: 1 };
      const nkey = key + "@" + text.slice(0, 64);
      if (!S.handoffNotified[nkey]) {
        S.handoffNotified[nkey] = true;
        log("成果物ファイルの作成を検出しました。実行終了と内容の安定を確認中です…");
      }
      return false;
    }
    if (S.stable[key].hits < STABLE_ROUNDS) return false;
    if (!S.runExited) return false;
    S.stable[key] = null;
    return true;
  }

  // フェーズごとのトラブル報告ファイル名（相互リカバリーの伝言板）
  function troubleFileFor(kind) {
    if (kind === "instruction") return "trouble-instruction.md";
    if (kind === "review") return "trouble-review.md";
    return "trouble-done.md";
  }

  function isLimitHit(text) {
    return LIMIT_RE.test(String(text || ""));
  }

  // ---- 使用制限の解除時間の抽出・表示 ----
  // ターミナルの出力末尾から「あと何分」「何時に解除」といった情報を抜き出す。
  // 相対表記（in 25 minutes / retry after 30s / あと5分）と絶対表記（resets at 15:30 / ISO日時）の両方に対応する。
  function unitToMs(n, unit) {
    const u = String(unit || "s").toLowerCase();
    if (u.startsWith("day") || u === "d") return n * 86400000;
    if (u.startsWith("hour") || u.startsWith("hr") || u === "h") return n * 3600000;
    if (u.startsWith("min") || u === "m") return n * 60000;
    return n * 1000; // sec / s
  }

  function formatDurJa(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return `${s}秒`;
    const m = Math.floor(s / 60);
    if (m < 60) {
      const rs = s % 60;
      return rs ? `${m}分${rs}秒` : `${m}分`;
    }
    const h = Math.floor(m / 60);
    if (h < 48) {
      const rm = m % 60;
      return rm ? `${h}時間${rm}分` : `${h}時間`;
    }
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? `${d}日${rh}時間` : `${d}日`;
  }

  function formatResetJa(resetAtMs) {
    const d = new Date(resetAtMs);
    const now = new Date();
    const hm = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
    if (d.toDateString() === now.toDateString()) return hm;
    return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function formatLimitLabel(resetAtMs, now) {
    if (!resetAtMs) return "";
    const diff = resetAtMs - (now || Date.now());
    const when = formatResetJa(resetAtMs);
    if (diff <= 0) return `${when}（まもなく解除見込み）`;
    return `${when}（あと${formatDurJa(diff)}）`;
  }

  // "15:30" や "3:30 PM" を今日/明日の時刻として解釈する（過去時刻は明日扱い）
  function parseClockTime(s) {
    const m = String(s || "").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]\.?M\.?)?/i);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2]);
    const sec = Number(m[3] || 0);
    const ap = (m[4] || "").toUpperCase();
    if (ap.startsWith("P") && h < 12) h += 12;
    if (ap.startsWith("A") && h === 12) h = 0;
    if (h > 23 || min > 59 || sec > 59) return null;
    const now = new Date();
    const d = new Date(now);
    d.setHours(h, min, sec, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // 日本語の日付（10月5日 15:30 等）を解釈する。過ぎていれば来年扱い。
  function parseJaDate(m) {
    const now = new Date();
    const mo = Number(m[1]);
    const day = Number(m[2]);
    const h = m[3] !== undefined ? Number(m[3]) : 0;
    const min = m[4] !== undefined ? Number(m[4]) : 0;
    if (!(mo >= 1 && mo <= 12 && day >= 1 && day <= 31 && h <= 23 && min <= 59)) return null;
    const ts = new Date(now.getFullYear(), mo - 1, day, h, min, 0, 0).getTime();
    if (ts > now.getTime()) return ts;
    return new Date(now.getFullYear() + 1, mo - 1, day, h, min, 0, 0).getTime();
  }

  // 出力末尾から解除時間情報を抜き出す。{ waitMs, resetAtMs, absolute, raw } または null。
  function parseLimitReset(text) {
    const t = String(text || "");
    if (!t) return null;
    const scope = t.slice(-5000);
    const snippet = (idx, len) => scope.slice(Math.max(0, idx - 80), idx + (len || 0) + 80).replace(/\s+/g, " ").trim().slice(0, 200);
    let m;
    // 1) ISO日時（絶対）
    m = scope.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}| ?(?:UTC|JST))?)/);
    if (m) {
      const ts = Date.parse(m[1].replace(" ", "T"));
      if (Number.isFinite(ts)) return { waitMs: null, resetAtMs: ts, absolute: true, raw: snippet(m.index, m[0].length) };
    }
    // 2) epoch秒/ミリ秒
    m = scope.match(/(?:reset|retry|available|after|at)[^\d\n]{0,20}(\d{10,13})(?!\d)/i);
    if (m) {
      let ts = Number(m[1]);
      if (Number.isFinite(ts)) {
        if (m[1].length === 10) ts *= 1000;
        const now = Date.now();
        if (ts > now - 60000 && ts < now + 7 * 86400000) return { waitMs: null, resetAtMs: ts, absolute: true, raw: snippet(m.index, m[0].length) };
      }
    }
    // 3) 時刻 HH:MM（絶対・今日/明日として解釈）
    m = scope.match(/(?:resets?|resetting|available|try again|retry|back|after|at)[^\n\d]{0,20}?(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]\.?M\.?)?)/i);
    if (m) {
      const ts = parseClockTime(m[1]);
      if (ts) return { waitMs: null, resetAtMs: ts, absolute: true, raw: snippet(m.index, m[0].length) };
    }
    // 4) 英語の日付（October 5 等）
    m = scope.match(/(?:resets?|reset|renews?|renewal|available)[^\n]{0,30}?\bon\s+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)/i);
    if (m) {
      let ts;
      if (/,?\s*\d{4}/.test(m[1])) {
        ts = Date.parse(m[1]);
      } else {
        // 年なし（"October 5" 等）は今年の日付として解釈する（Date.parse 既定の2001年を避ける）。
        // 序数接尾辞（1st / 2nd / 3rd / 4th）は Date.parse が NaN になるため除去する。
        const dayOnly = m[1].replace(/(\d{1,2})(st|nd|rd|th)\b/i, "$1");
        ts = Date.parse(dayOnly + " " + new Date().getFullYear());
      }
      if (Number.isFinite(ts)) {
        if (ts < Date.now()) ts = new Date(ts).setFullYear(new Date(ts).getFullYear() + 1);
        return { waitMs: null, resetAtMs: ts, absolute: true, raw: snippet(m.index, m[0].length) };
      }
    }
    // 5) 日本語の日付（10月5日 15:30 等）
    m = scope.match(/(\d{1,2})月\s*(\d{1,2})日(?:\s*(\d{1,2})[時:：](\d{1,2})?)?/);
    if (m) {
      const ts = parseJaDate(m);
      if (ts) return { waitMs: null, resetAtMs: ts, absolute: true, raw: snippet(m.index, m[0].length) };
    }
    // 6) 相対: retry after N[unit]（単位省略時は秒）
    m = scope.match(/retry[\s_\-]*after\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m(?!s)|hours?|hrs?|h|days?|d)?\b/i);
    if (m) {
      const waitMs = unitToMs(parseFloat(m[1]), m[2] || "s");
      if (Number.isFinite(waitMs) && waitMs > 0 && waitMs < 30 * 86400000)
        return { waitMs, resetAtMs: Date.now() + waitMs, absolute: false, raw: snippet(m.index, m[0].length) };
    }
    // 7) 相対: in N unit（"1h 20m" のような複数単位も合算）
    m = scope.match(/\bin\s+(\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m(?!s)|hours?|hrs?|h|days?|d)(?:\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m(?!s)|hours?|hrs?|h|days?|d))*)/i);
    if (m) {
      let total = 0;
      const re = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m(?!s)|hours?|hrs?|h|days?|d)/gi;
      let mm;
      while ((mm = re.exec(m[1]))) total += unitToMs(parseFloat(mm[1]), mm[2]);
      if (total > 0 && total < 30 * 86400000)
        return { waitMs: total, resetAtMs: Date.now() + total, absolute: false, raw: snippet(m.index, m[0].length) };
    }
    // 8) 相対: "N unit until reset / remaining" 等
    m = scope.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\s+(?:until|to\s+reset|before(?:\s+retry)?|remaining)/i);
    if (m) {
      const waitMs = unitToMs(parseFloat(m[1]), m[2]);
      if (Number.isFinite(waitMs) && waitMs > 0 && waitMs < 30 * 86400000)
        return { waitMs, resetAtMs: Date.now() + waitMs, absolute: false, raw: snippet(m.index, m[0].length) };
    }
    // 9) 日本語の相対（あと5分 / 5分後）
    m = scope.match(/(?:あと\s*(\d+(?:\.\d+)?)\s*(秒|分|時間|日))|((\d+(?:\.\d+)?)\s*(秒|分|時間|日)\s*(後|待ち|で(?:解除|回復)|後に(?:解除|回復)))/);
    if (m) {
      const num = parseFloat(m[1] || m[4]);
      const unit = m[2] || m[5];
      const mult = unit === "秒" ? 1000 : unit === "分" ? 60000 : unit === "時間" ? 3600000 : 86400000;
      const waitMs = num * mult;
      if (Number.isFinite(waitMs) && waitMs > 0 && waitMs < 30 * 86400000)
        return { waitMs, resetAtMs: Date.now() + waitMs, absolute: false, raw: snippet(m.index, m[0].length) };
    }
    return null;
  }

  // ターミナル出力から解除時間情報を取り出し、S にラッチして表示ラベルを返す。
  // 相対表記は初回検知時の時刻基準で固定する（毎ポーリング now+wait では未来へ漂移するため）。
  // テスト用に window.__parseLimitReset として公開する。
  function currentLimitInfo(tail) {
    const parsed = parseLimitReset(tail);
    if (parsed && parsed.absolute && parsed.resetAtMs) {
      S.limitResetUntil = parsed.resetAtMs;
      S.limitRaw = parsed.raw || "";
    } else if (parsed && parsed.resetAtMs && !S.limitResetUntil) {
      S.limitResetUntil = parsed.resetAtMs;
      S.limitRaw = parsed.raw || "";
    }
    if (S.limitResetUntil) {
      S.limitResetLabel = formatLimitLabel(S.limitResetUntil, Date.now());
      return { resetAtMs: S.limitResetUntil, label: S.limitResetLabel, raw: S.limitRaw };
    }
    if (parsed && parsed.raw) return { resetAtMs: null, label: "", raw: parsed.raw };
    return { resetAtMs: null, label: "", raw: "" };
  }
  try { window.__parseLimitReset = parseLimitReset; } catch {}

  // 使用制限（レート/セッションリミット）を検知したら、解除時間付きで表示し、
  // 設定に応じて自動再開する。true を返したら通常の失敗通知はスキップする。
  function limitCheck(label, paneId, rerun) {
    const tail = paneTail(paneId, 5000);
    if (!isLimitHit(tail)) return false;
    const info = currentLimitInfo(tail);
    const resetPart = info.label ? ` 制限解除予定: ${info.label}` : "（解除時間不明）";
    const waitingStatus = `連携中: ${label} リミット回復待ち${info.label ? `（解除予定 ${info.label}）` : ""}`;
    if (!autoResume()) {
      if (!S.limitNotified) {
        S.limitNotified = true;
        log(`${label} が使用制限に達したようです（自動再開OFF）。${resetPart}`);
        if (info.raw) log(`制限メッセージ抜粋: ${info.raw}`);
        notifyHuman(`AI連携: ${label} が使用制限に達しました。${resetPart}`, (info.raw ? info.raw + " / " : "") + (tail.slice(-300) || "回復後に再実行してください"));
      }
      setStatus(waitingStatus + "・回復後に「再実行」を押してください", true);
      return true;
    }
    // 自動再開ON: 実行中なら回復待ち（重複起動しない）、終了済みなら解除予定まで待って再実行
    if (S.runExited) {
      const now = Date.now();
      if (S.limitResetUntil && now < S.limitResetUntil) {
        if (!S.limitNotified) {
          S.limitNotified = true;
          log(`${label} が使用制限に達したようです。${resetPart} 回復後に自動で再開します。`);
          if (info.raw) log(`制限メッセージ抜粋: ${info.raw}`);
        }
        setStatus(waitingStatus + "・自動再開…", true);
        S.runExited = false; // 制限中の終了は失敗扱いにせず、次ポーリングで再判定する
        return true;
      }
      if (now - S.lastLimitRetry >= LIMIT_RETRY_MS) {
        S.lastLimitRetry = now;
        S.runExited = false;
        S.failNotified = false;
        S.limitNotified = false;
        S.phaseSince = now;
        log(`${label} が使用制限に達したため、自動で再開します。${resetPart}`);
        setStatus(waitingStatus + "・自動再開…", true);
        S.limitResetUntil = 0;
        S.limitResetLabel = "";
        S.limitRaw = "";
        rerun();
      } else {
        setStatus(waitingStatus + "・自動再開…", true);
      }
    } else {
      if (!S.limitNotified) {
        S.limitNotified = true;
        log(`${label} が使用制限に達したようです。回復を待っています（自動再開ON）。${resetPart}`);
        if (info.raw) log(`制限メッセージ抜粋: ${info.raw}`);
      }
      setStatus(waitingStatus + "…", true);
    }
    return true;
  }

  // ---- 各フェーズの非対話ラン ----

  function runClinePM() {
    const args = autoApprove() ? [pmPrompt(S.task)] : ["--auto-approve", "false", pmPrompt(S.task)];
    S.currentRun = { pane: "cline", kind: "pm" };
    log("ターミナル1で cline(PM) を実行します（指示書作成）。");
    if (!window.App.termExecIn(S.clineId, "cline", args)) {
      toast("ターミナル1への起動に失敗しました", true);
    }
  }

  function runOpencodeDev(instruction) {
    const prompt = devPrompt(instruction);
    const args = autoApprove() ? ["run", "--auto", prompt] : ["run", prompt];
    S.currentRun = { pane: "opencode", kind: S.lastFix ? "fix" : "dev" };
    log("ターミナル2で opencode を実行します（実装）。");
    if (!window.App.termExecIn(S.opencodeId, "opencode", args)) {
      toast("ターミナル2への起動に失敗しました", true);
    }
  }

  function runClineReview(done) {
    const args = autoApprove() ? [reviewPrompt(done)] : ["--auto-approve", "false", reviewPrompt(done)];
    S.currentRun = { pane: "cline", kind: "review" };
    log("ターミナル1で cline(PM) を実行します（レビュー）。");
    if (!window.App.termExecIn(S.clineId, "cline", args)) {
      toast("ターミナル1への起動に失敗しました", true);
    }
  }

  // opencodeからの指示書質問を受けて cline(PM) に修正させる（AI同士の直接やり取り）
  function runClineRevise(question) {
    const prompt = pmRevisePrompt(question, S.lastInstruction || "");
    const args = autoApprove() ? [prompt] : ["--auto-approve", "false", prompt];
    S.currentRun = { pane: "cline", kind: "pm-revise" };
    log("opencodeからの質問を受け、cline(PM)に指示書の修正を依頼します（AI同士で解決）。");
    if (!window.App.termExecIn(S.clineId, "cline", args)) {
      toast("ターミナル1への起動に失敗しました", true);
    }
  }

  function onExit(pane, code) {
    if (!S.running || !pane) return;
    const role = pane.id === S.clineId ? "cline" : pane.id === S.opencodeId ? "opencode" : null;
    if (!role) return;
    if (S.followRun && S.followRun.active && S.followRun.pane === role) {
      S.followRun.exited = true;
      S.followRun.code = code;
      const flabel = role === "cline" ? "cline(PM)" : "opencode";
      log(`${flabel} の追加指示の実行が終了しました (exit ${code ?? "?"})。結果を確認します。`);
      return;
    }
    if (S.currentRun && S.currentRun.pane === role) {
      S.runExited = true;
      S.exitCode = code;
      const label = role === "cline" ? "cline(PM)" : "opencode";
      log(`${label} の実行が終了しました (exit ${code ?? "?"})。成果物を確認します。`);
    }
  }

  // ---- プロンプト ----

  function pmPrompt(task) {
    return (
      `あなたはこのプロジェクトのPMです。簡潔に・短時間で指示書を作ってください。` +
      `まず「${BRIDGE}/task.md」を読んでください（人間の最初の指示。参考: ${task}）。\n\n` +
      `【速さの約束】\n` +
      `1. 最小限の調査だけ行い、深掘り・全体検証・テスト実行はしないでください（目安5分以内）。\n` +
      `2. 指示書は要点のみ・簡潔に（目安30行以内）。目的 / 変更対象ファイル / 手順（番号付き・最小限）/ 受け入れ条件（確認方法のみ）だけ書いてください。\n` +
      `3. 不明点は推測で補わず「要確認」として1行で残してください（opencode側が質問してAI同士で解決します）。\n` +
      `4. 「${BRIDGE}/instruction.md」を作成したら速やかに終了してください。長考・再検証は不要です。`
    );
  }

  function pmRevisePrompt(question, instruction) {
    const q = String(question || "").slice(0, 2000);
    return (
      `あなたはPMです。簡潔に・短時間で指示書を修正してください。\n\n` +
      `プログラマー（opencode）から指示書への質問・指摘が「${BRIDGE}/instruction-question.md」に届きました。\n` +
      `【質問・指摘】\n${q}\n\n` +
      `1. 質問内容と「${BRIDGE}/instruction.md」「${BRIDGE}/task.md」を読んでください。\n` +
      `2. 指摘が正しければ instruction.md を簡潔に修正し、誤解なら質問への回答を instruction.md に1〜3行で追記してください。\n` +
      `3. 修正後は速やかに終了してください（再検証は不要です）。人間への確認は求めないでください。`
    );
  }

  function devPrompt(instruction) {
    const head = String(instruction || "").slice(0, 6000);
    return (
      `あなたはプログラマー担当です。簡潔に・速やかに実装してください。\n\n` +
      `まず「${BRIDGE}/instruction.md」の全文を読んでください（以下は抜粋です）。\n` +
      `【指示書の抜粋】\n${head}\n\n` +
      `【ルール】\n` +
      `1. 指示書におかしい点・不明点・矛盾があれば、推測で進めず「${BRIDGE}/instruction-question.md」に質問・問題点を書いて終了してください（PMが修正します。人間への確認は不要です）。\n` +
      `2. 問題なければ受け入れ条件を満たすまで実装・テストを進めてください。\n` +
      `3. 完了したら「${BRIDGE}/done.md」に簡潔に書いて終了してください: ` +
      `変更ファイル一覧 / 実施内容 / テスト結果 / 残課題（無ければ「なし」）。\n` +
      `4. 追加の検証・長考は不要です。done.md の作成が完了条件です。`
    );
  }

  function reviewPrompt(done) {
    const head = String(done || "").slice(0, 4000);
    return (
      `あなたはPMです。簡潔に・短時間でレビューしてください。\n\n` +
      `まず「${BRIDGE}/done.md」の全文を読んでください（以下は抜粋です）。\n` +
      `【完了報告の抜粋】\n${head}\n\n` +
      `1. done.md と実際の変更（git diff 等）を最小限で確認してください（深掘り・再検証は不要です）。\n` +
      `2. 問題なければ「${BRIDGE}/review-ok.md」にOKの根拠を1〜3行で書いて終了してください。\n` +
      `3. 修正が必要なら「${BRIDGE}/instruction2.md」に具体的な追加指示を簡潔に書いて終了してください（opencodeが対応します。人間への確認は不要です）。\n` +
      `4. OKと修正指示の両方は書かないでください。どちらか一方だけ作成し、速やかに終了してください。`
    );
  }

  function fixPrompt(fix) {
    return (
      `PM から修正指示が出ました。簡潔に・速やかに対応してください。「${BRIDGE}/instruction2.md」の全文を読んでください。` +
      `（「${BRIDGE}/instruction.md」も合わせて参照してください）\n\n` +
      `【修正指示の抜粋】\n${String(fix || "").slice(0, 4000)}\n\n` +
      `対応完了後は「${BRIDGE}/done.md」を簡潔に更新して速やかに終了してください（更新が完了条件です）。` +
      `指示書におかしい点があれば推測で進めず「${BRIDGE}/instruction-question.md」に書いて終了してください。`
    );
  }

  // ---- 実行中の追加指示（人間 → PM / 実装） ----
  // 連携実行中に、人間がどちら側かを指定して追加の作業を投げる。
  // 進行中のフェーズ担当と同じペイン宛なら「差し替え」（現在の実行を中断し、追加指示付きで担当継続）、
  // 空いている側宛なら「side-task」（結果ファイルで完了を検知し、人間に通知）として扱う。

  function followPromptFor(target, text, file, dutyNote, guardNote) {
    const side = target === "cline" ? "PM（cline）" : "プログラマー（opencode）";
    return (
      `AI連携の実行中に、人間からあなた（${side}）への追加指示が届きました。\n\n` +
      `【追加指示】\n${String(text || "").slice(0, 4000)}\n\n` +
      `【参考】まず「${BRIDGE}/task.md」を読んでください。` +
      (target === "cline"
        ? `「${BRIDGE}/instruction.md」「${BRIDGE}/done.md」があれば合わせて読んでください。\n\n`
        : `「${BRIDGE}/instruction.md」（無ければ task.md のみ）を読んで背景を把握してください。\n\n`) +
      (dutyNote ? `【進行中の担当】\n${dutyNote}\n\n` : "") +
      (guardNote ? `【注意】\n${guardNote}\n\n` : "") +
      `【あなたの仕事】\n` +
      `1. 追加指示の内容に対応してください（調査・ファイル編集・テスト等、必要に応じて実行）。\n` +
      `2. 対応が終わったら結果を「${BRIDGE}/${file}」に必ず書いてください。` +
      `形式: 対応内容 / 変更ファイル一覧 / 残課題（無ければ「なし」）。\n` +
      `3. 結果ファイルの作成があなたの完了条件です。作成したら終了してください。`
    );
  }

  // 差し替え時（担当ペイン宛）に、元の担当も続けさせるための一文
  function followDutyNote(target) {
    if (target === "cline" && S.phase === "wait-instruction")
      return `あなたは指示書作成の担当です。追加指示への対応とあわせ、指示書「${BRIDGE}/instruction.md」の作成・更新も進めてください（指示書の完成が本来の完了条件です）。`;
    if (target === "cline" && S.phase === "wait-review")
      return `あなたはレビューの担当です。追加指示への対応とあわせ、完了報告の確認と「${BRIDGE}/review-ok.md」または「${BRIDGE}/instruction2.md」の作成も進めてください。`;
    if (target === "opencode" && S.phase === "wait-done")
      return `あなたは実装の担当です。追加指示への対応とあわせ、本来の実装作業も進め、完了したら「${BRIDGE}/done.md」を作成・更新してください（done.md の完成が本来の完了条件です）。`;
    return "";
  }

  async function sendFollow() {
    if (!S.running) {
      toast("AI連携が実行中ではありません", true);
      return;
    }
    const target = ($("aibridge-follow-target") && $("aibridge-follow-target").value === "opencode") ? "opencode" : "cline";
    const text = ($("aibridge-follow-text") ? $("aibridge-follow-text").value : "").trim();
    if (!text) {
      toast("追加指示を入力してください", true);
      return;
    }
    const paneId = target === "cline" ? S.clineId : S.opencodeId;
    if (!paneId) {
      toast("対象のターミナルが確保されていません", true);
      return;
    }
    const label = target === "cline" ? "cline(PM)" : "opencode";
    const isMainPane = !!(S.currentRun && S.currentRun.pane === target && !S.runExited);
    const isFollowBusy = !!(S.followRun && S.followRun.active && S.followRun.pane === target && !S.followRun.exited);
    if (isMainPane || isFollowBusy) {
      const busyWhat = isMainPane ? "現在のフェーズの作業" : "前回の追加指示";
      if (typeof confirm === "function" && !confirm(`${label} は${busyWhat}を実行中です。追加指示を送ると現在の実行を中断します。よろしいですか？`)) return;
    }
    const file = `follow-${target}-${Date.now().toString(36)}.md`;
    try { await API.writeFile(bp(file), ""); } catch (e) {
      toast("結果ファイルの作成に失敗: " + (e.message || e), true);
      return;
    }
    const redirect = isMainPane; // 担当ペイン宛 = 差し替え、それ以外 = side-task
    const dutyNote = redirect ? followDutyNote(target) : "";
    const guardNote = redirect ? "" : "進行中の連携フロー（他方のAIの作業・伝言ファイル）は壊さないでください。instruction.md / done.md / review-ok.md / instruction2.md は、追加指示で明示された場合を除き上書きしないでください。";
    const prompt = followPromptFor(target, text, file, dutyNote, guardNote);
    const args = target === "cline"
      ? (autoApprove() ? [prompt] : ["--auto-approve", "false", prompt])
      : (autoApprove() ? ["run", "--auto", prompt] : ["run", prompt]);
    if (!window.App.termExecIn(paneId, target === "cline" ? "cline" : "opencode", args)) {
      toast(`${label} への送信に失敗しました`, true);
      return;
    }
    if (redirect) {
      // トラブル解決の問いかけを中断した場合、回復フローは取り消して通常監視に戻す
      if (S.recovering) {
        S.recovering = false;
        S.recoverFor = null;
        S.lastTrouble = null;
      }
      S.currentRun = { pane: target, kind: "follow" };
      S.runExited = false;
      S.exitCode = null;
      S.failNotified = false;
      S.phaseSince = Date.now();
      log(`${label} の実行を中断し、追加指示を送りました（担当継続）。結果は ${file} に報告させます。`);
    } else {
      S.followRun = { pane: target, file, active: true, exited: false, code: null, notified: false };
      log(`${label} に追加指示を送りました。結果は ${file} に報告させます。`);
    }
    if (target === "opencode" && S.limitResetUntil && Date.now() < S.limitResetUntil) {
      log(`注意: opencode は使用制限の回復待ちです（解除予定 ${S.limitResetLabel || "不明"}）。制限中の実行は失敗する可能性があります。`);
    }
    const ta = $("aibridge-follow-text");
    if (ta) ta.value = "";
  }

  // side-task の追加指示の完了を監視する。結果ファイルが出たら人間に通知する。
  async function pollFollow() {
    const f = S.followRun;
    if (!f || !f.active) return;
    const label = f.pane === "cline" ? "cline(PM)" : "opencode";
    const content = await readText(bp(f.file));
    if (content && content.trim()) {
      S.followRun = null;
      log(`${label} が追加指示に対応しました（${f.file}）。`);
      notifyHuman(`AI連携: ${label} が追加指示に対応しました`, content.slice(0, 300));
      return;
    }
    if (f.exited && !f.notified) {
      f.notified = true;
      S.followRun = null;
      const tail = paneTail(f.pane === "cline" ? S.clineId : S.opencodeId, 3000).slice(-800);
      log(`${label} の追加指示の実行が終了しましたが報告ファイルがありません。ターミナルで出力を確認してください。`);
      notifyHuman(`AI連携: ${label} の追加指示が報告なしで終了しました`, tail.slice(-300) || "出力を確認してください");
    }
  }

  // もう1つのAIへ投げるトラブル解決プロンプト。
  // 失敗した側の出力末尾と期待ファイルを渡し、解決可能なら直して再実行の下地を作らせる。
  // どうしても人間の確認が必要な場合だけ、その旨を trouble ファイルに書かせる。
  function troubleshootPromptFor(kind, failedLabel, expectedName, tail) {
    const troubleName = troubleFileFor(kind);
    const tailHead = String(tail || "").slice(-1500) || "(出力なし)";
    const common =
      `あなたはAI連携のトラブル解決担当です。別のAI（${failedLabel}）が「${expectedName}」を作らずに終了しました。\n\n` +
      `【失敗したAIの出力末尾】\n${tailHead}\n\n` +
      `【あなたの仕事】\n` +
      `1. 「${BRIDGE}/task.md」と既存の伝言ファイル（instruction.md / done.md / review-ok.md / instruction2.md）を読んでください。\n` +
      `2. 作業ディレクトリの内容・エラー内容を調査し、原因を特定してください。` +
      `依存不足・コマンド不足・権限・パス間違い・単純なエラーなど、あなたが解決できるものは可能な範囲で直接解決してください。\n` +
      `3. あなたが解決・対応したら、その内容を踏まえて本来の担当AIが再実行できる状態にしてください。\n` +
      `4. 調査結果を「${BRIDGE}/${troubleName}」に必ず書いてください。` +
      `形式: 原因 / あなたが行った対応 / 再実行への助言（次の実行者が読む具体的な指示）。\n` +
      `5. どうしても人間の確認・返答が必要な場合（権限承認・認証・ログイン・課金・曖昧な仕様の判断など、AIだけでは進めない場合）に限り、` +
      `trouble ファイルの先頭に「HUMAN-NEEDED: 」で始まる行を書き、人間に何をしてほしいか（ターミナルで返答すべき内容・確認手順）を明記してください。\n` +
      `6. trouble ファイルの作成があなたの完了条件です。作成したら終了してください。`;
    return common;
  }

  function runTroubleshoot(kind, failedLabel, expectedName, tail) {
    const prompt = troubleshootPromptFor(kind, failedLabel, expectedName, tail);
    if (kind === "instruction" || kind === "review") {
      // cline(PM)が失敗 → もう1つのAI=opencode に問いかける
      S.currentRun = { pane: "opencode", kind: "troubleshoot" };
      log(`成果物なしのため、もう1つのAI（opencode）にトラブル解決を問いかけます（${failedLabel} の失敗を調査）。`);
      const args = autoApprove() ? ["run", "--auto", prompt] : ["run", prompt];
      if (!window.App.termExecIn(S.opencodeId, "opencode", args)) {
        toast("opencode への問いかけに失敗しました", true);
        return false;
      }
      return true;
    }
    // opencode(実装)が失敗 → もう1つのAI=cline(PM) に問いかける
    S.currentRun = { pane: "cline", kind: "troubleshoot" };
    log(`成果物なしのため、もう1つのAI（cline PM）にトラブル解決を問いかけます（${failedLabel} の失敗を調査）。`);
    const args = autoApprove() ? [prompt] : ["--auto-approve", "false", prompt];
    if (!window.App.termExecIn(S.clineId, "cline", args)) {
      toast("cline への問いかけに失敗しました", true);
      return false;
    }
    return true;
  }

  // トラブル解決を踏まえた再実行（本来の担当AIをもう一度走らせる）
  function rerunAfterTrouble(kind, trouble) {
    const hint = String(trouble || "").slice(0, 2000);
    S.recovering = false;
    S.recoverFor = null;
    S.runExited = false;
    S.failNotified = false;
    S.phaseSince = Date.now();
    if (kind === "instruction") {
      log("トラブル解決の結果を踏まえて cline(PM) を再実行します。");
      S.currentRun = { pane: "cline", kind: "pm" };
      const base = pmPrompt(S.task);
      const args = autoApprove() ? [base + `\n\n【前回の失敗とトラブル解決の報告】\n${hint}`] : ["--auto-approve", "false", base + `\n\n【前回の失敗とトラブル解決の報告】\n${hint}`];
      window.App.termExecIn(S.clineId, "cline", args);
      setStatusKeepRecover("連携中: cline(PM) が指示書を作成中…（再実行）");
    } else if (kind === "done") {
      log("トラブル解決の結果を踏まえて opencode を再実行します。");
      const prompt = devPrompt(S.lastFix || S.lastInstruction || "") + `\n\n【前回の失敗とトラブル解決の報告】\n${hint}`;
      const args = autoApprove() ? ["run", "--auto", prompt] : ["run", prompt];
      S.currentRun = { pane: "opencode", kind: S.lastFix ? "fix" : "dev" };
      window.App.termExecIn(S.opencodeId, "opencode", args);
      setStatusKeepRecover("連携中: opencode が実装中…（再実行）");
    } else {
      log("トラブル解決の結果を踏まえて cline(PM:レビュー) を再実行します。");
      const prompt = reviewPrompt(S.lastDone || "") + `\n\n【前回の失敗とトラブル解決の報告】\n${hint}`;
      const args = autoApprove() ? [prompt] : ["--auto-approve", "false", prompt];
      S.currentRun = { pane: "cline", kind: "review" };
      window.App.termExecIn(S.clineId, "cline", args);
      setStatusKeepRecover("連携中: cline がレビュー中…（再実行）");
    }
  }

  // setPhase のリカバリー状態リセットを避けてステータスだけ変える（再実行時の表示用）
  function setStatusKeepRecover(text) {
    S.phaseSince = Date.now();
    S.hinted = false;
    setStatus(text, true);
  }

  // ---- 監視ループ ----

  async function poll() {
    if (!S.running) return;
    try {
      // 追加指示（side-task）の完了を進行フローと独立に確認する
      await pollFollow();
      // もう1つのAIがトラブル解決中なら、そちらを優先監視する
      if (S.recovering && S.recoverFor) {
        await pollRecovering();
        return;
      }
      if (S.phase === "wait-instruction") {
        if (limitCheck("cline(PM)", S.clineId, () => runClinePM())) return;
        const ins = await readText(bp("instruction.md"));
        // 書きかけ拾い防止: 実行終了＋安定した内容になって初めて引き継ぐ
        if (artifactReady("instruction", ins, S.lastInstruction)) {
          S.lastInstruction = ins;
          log("cline が指示書を作成しました。opencode に引き継ぎます。");
          runOpencodeDev(ins);
          setPhase("wait-done", "連携中: opencode が実装中…");
          return;
        }
        await stallOrFailCheck("instruction", "cline(PM)", S.clineId, "instruction.md");
      } else if (S.phase === "wait-done") {
        // 指示書への質問はAI同士で解決する（人間には通知しない）。差し戻し相当として最優先で扱う。
        const q = await readText(bp("instruction-question.md"));
        if (artifactReady("question", q, S.lastQuestion)) {
          S.lastQuestion = q;
          log("opencode が指示書に質問を出しました。cline に修正を依頼します（AI同士で解決）。");
          try { await API.writeFile(bp("instruction-question.md"), ""); } catch {}
          S.stable["question"] = null;
          runClineRevise(q);
          setPhase("wait-instruction", "連携中: cline(PM) が指示書を修正中…（AI同士で解決）");
          return;
        }
        const done = await readText(bp("done.md"));
        if (artifactReady("done", done, S.lastDone)) {
          S.lastDone = done;
          log("opencode が完了報告を出しました。cline にレビューを依頼します。");
          runClineReview(done);
          setPhase("wait-review", "連携中: cline がレビュー中…");
          return;
        }
        if (limitCheck("opencode", S.opencodeId, () =>
          runOpencodeDev(S.lastFix || S.lastInstruction || "")
        )) return;
        await stallOrFailCheck("done", "opencode", S.opencodeId, "done.md");
      } else if (S.phase === "wait-review") {
        // 差し戻しをOKより優先する: 同じランで両方が書かれた場合も修正を確実に拾う。
        // どちらも「実行終了＋安定」ゲートを通ったものだけ受け付ける。
        const fix = await readText(bp("instruction2.md"));
        const fixReady = artifactReady("fix", fix, S.lastFix) && fix !== S.lastInstruction;
        const ok = await readText(bp("review-ok.md"));
        const okReady = artifactReady("review-ok", ok, S.lastReview);
        if (fixReady) {
          S.lastFix = fix;
          log("cline が修正指示を出しました。opencode に再実行させます（AI同士で解決）。");
          S.currentRun = { pane: "opencode", kind: "fix" };
          const args = autoApprove() ? ["run", "--auto", fixPrompt(fix)] : ["run", fixPrompt(fix)];
          window.App.termExecIn(S.opencodeId, "opencode", args);
          setPhase("wait-done", "連携中: opencode が修正中…");
          return;
        }
        if (okReady) {
          S.lastReview = ok;
          S.phase = "done";
          setStatus("連携完了: 人間の確認待ち", false);
          finish();
          notifyHuman("AI連携が完了しました。人間の確認をお願いします", ok.slice(0, 300));
          log("cline がレビューOKを出しました。人間の確認をお願いします。");
          return;
        }
        if (limitCheck("cline(PM:レビュー)", S.clineId, () =>
          runClineReview(S.lastDone || "")
        )) return;
        await stallOrFailCheck("review", "cline(PM:レビュー)", S.clineId, "review-ok.md / instruction2.md");
      }
    } catch (e) {
      log("ポーリングエラー: " + (e.message || e));
    }
  }

  // もう1つのAIによるトラブル解決中の監視。
  // trouble ファイルが出たら人間の確認が必要か判定し、必要なら人間に通知して返答を促す。
  // 解決可能なら本来の担当AIを再実行する。解決側も失敗したら人間に通知する。
  async function pollRecovering() {
    const kind = S.recoverFor;
    const troubleName = troubleFileFor(kind);
    const trouble = await readText(bp(troubleName));
    if (trouble && trouble.trim() && trouble !== S.lastTrouble) {
      S.lastTrouble = trouble;
      if (/^\s*HUMAN-NEEDED/m.test(trouble) || humanNeededReason(trouble)) {
        S.recovering = false;
        S.failNotified = true;
        S.runExited = false;
        log("もう1つのAIが「人間の確認が必要」と判断しました。ターミナルと報告を確認して返答してください。");
        notifyHuman("AI連携: 人間の確認が必要です", trouble.slice(0, 300));
        setStatus("要確認: 人間の返答待ち", true);
        return;
      }
      log("もう1つのAIがトラブル報告を出しました。本来の工程を再実行します。");
      rerunAfterTrouble(kind, trouble);
      return;
    }
    // トラブル解決側が使用制限に達した場合は回復待ち（失敗扱いにしない）
    const troublePane = (kind === "done") ? S.clineId : S.opencodeId;
    const tail = paneTail(troublePane, 5000);
    if (isLimitHit(tail)) {
      const tinfo = currentLimitInfo(tail);
      const treset = tinfo.label ? ` 制限解除予定: ${tinfo.label}` : "（解除時間不明）";
      if (!S.limitNotified) {
        S.limitNotified = true;
        log(`トラブル解決中のAIが使用制限に達したようです。回復を待っています。${treset}`);
        if (tinfo.raw) log(`制限メッセージ抜粋: ${tinfo.raw}`);
      }
      setStatus(`連携中: トラブル解決AIのリミット回復待ち${tinfo.label ? `（解除予定 ${tinfo.label}）` : ""}…`, true);
      // 制限中に終了していたら再開できるようフラグだけ戻す（次ポーリングで再判定）
      if (S.runExited) S.runExited = false;
      return;
    }
    if (S.runExited && !S.failNotified) {
      S.failNotified = true;
      S.recovering = false;
      S.runExited = false;
      const tailShort = paneTail(troublePane, 3000).slice(-800);
      const reason = humanNeededReason(tailShort);
      log("トラブル解決の問いかけも成果物なしで終了しました。ターミナルで出力を確認してください。");
      notifyHuman(
        reason ? "AI連携: 人間の確認が必要です（トラブル解決中）" : "AI連携: トラブル解決も失敗しました。人間の確認をお願いします",
        (reason ? `人間の確認が必要な可能性があります（${reason}）。` : "") + (tailShort.slice(-300) || "出力を確認してください")
      );
      setStatus("要確認: トラブル解決も失敗・人間の返答待ち", true);
      return;
    }
    if (!S.hinted && Date.now() - S.phaseSince > STALL_HINT_MS) {
      S.hinted = true;
      const t = paneTail(troublePane, 3000).slice(-800);
      if (isAskingHuman(t) || humanNeededReason(t)) {
        log("ヒント: トラブル解決中のAIが人間の返答待ちのようです。ターミナルで内容を確認して返答してください。");
        notifyHuman("AI連携: トラブル解決AIが人間の返答待ちです", t.slice(-300));
      } else {
        log("ヒント: トラブル解決に5分以上かかっています。「ターミナルの状態を表示」で出力を確認してください。");
      }
    }
  }

  // 成果物なし終了時は、まず人間の確認が必要か判定し、不要ならもう1つのAIに
  // 問いかけて解決・再実行させる。解決不能／上限超過のときだけ人間に通知して返答させる。
  async function stallOrFailCheck(kind, label, paneId, expectedName) {
    const now = Date.now();
    if (S.runExited && !S.failNotified) {
      const tail = paneTail(paneId, 3000).slice(-800);
      const reason = humanNeededReason(tail);
      if (reason) {
        S.failNotified = true;
        log(`${label} は人間の確認が必要な内容で終了したようです（${reason}）。ターミナルで確認して返答してください。`);
        notifyHuman(`AI連携: ${label} が人間の確認待ちで終了しました`, `確認が必要な内容: ${reason} / ` + (tail.slice(-300) || "出力を確認してください"));
        setStatus("要確認: 人間の返答待ち", true);
        return;
      }
      if (S.recoverAttempts < MAX_RECOVER) {
        S.recoverAttempts++;
        S.recovering = true;
        S.recoverFor = kind;
        S.runExited = false;
        S.failNotified = false;
        S.hinted = false;
        S.limitNotified = false;
        S.phaseSince = now;
        S.lastTrouble = "";
        try { await API.writeFile(bp(troubleFileFor(kind)), ""); } catch {}
        setStatus(`連携中: ${label} の失敗をもう1つのAIが調査中…（${S.recoverAttempts}/${MAX_RECOVER}）`, true);
        const ok = runTroubleshoot(kind, label, expectedName, tail);
        if (!ok) {
          S.recovering = false;
          S.failNotified = true;
          notifyHuman(`AI連携: ${label} が成果物なしで終了しました`, tail.slice(-300) || "出力を確認してください");
        }
        return;
      }
      S.failNotified = true;
      log(`${label} は終了しましたが成果物がまだありません（${MAX_RECOVER}回の相互解決も失敗）。ターミナルで出力を確認してください。`);
      notifyHuman(`AI連携: ${label} が成果物なしで終了しました`, tail.slice(-300) || "出力を確認してください");
      setStatus("要確認: 成果物なし・人間の返答待ち", true);
      return;
    }
    if (!S.hinted && now - S.phaseSince > STALL_HINT_MS) {
      S.hinted = true;
      const tail = paneTail(paneId, 3000).slice(-800);
      if (isAskingHuman(tail) || humanNeededReason(tail)) {
        log(`ヒント: ${label} が人間の返答待ちのようです。ターミナルで内容を確認して返答してください（許可・認証・質問など）。`);
        notifyHuman(`AI連携: ${label} が人間の返答待ちです`, tail.slice(-300) || "ターミナルで確認して返答してください");
      } else {
        log(`ヒント: ${label} の処理が5分以上続いています。進みが無い場合は「ターミナルの状態を表示」で出力を確認し、必要なら「現在のフェーズを再実行」を押してください。`);
      }
    }
  }

  function finish() {
    S.running = false;
    S.currentRun = null;
    clearInterval(S.pollTimer);
    S.pollTimer = null;
    if (S.exitUnsub) { try { S.exitUnsub(); } catch {} S.exitUnsub = null; }
  }

  // ---- 開始・停止・再実行・診断 ----

  async function start() {
    if (S.running) {
      toast("AI連携は既に実行中です");
      return;
    }
    const task = ($("aibridge-task") ? $("aibridge-task").value : "").trim();
    if (!task) {
      toast("最初の指示を入力してください", true);
      return;
    }
    S.dir = normDir($("aibridge-dir") ? $("aibridge-dir").value : "");
    S.task = task;
    try {
      await API.mkdir(S.dir ? S.dir + "/" + BRIDGE : BRIDGE);
    } catch (e) {
      toast("作業フォルダの作成に失敗: " + e.message, true);
      return;
    }
    // 古い伝言ファイルをリセット（task は残す）
    for (const f of ["instruction.md", "instruction-question.md", "done.md", "review-ok.md", "instruction2.md", "approval.md", "trouble-instruction.md", "trouble-done.md", "trouble-review.md"]) {
      try { await API.writeFile(bp(f), ""); } catch {}
    }
    try {
      await API.writeFile(bp("task.md"), task + "\n");
    } catch (e) {
      toast("task.md の作成に失敗: " + e.message, true);
      return;
    }

    // ターミナル1=cline、ターミナル2=opencode のペインを確保（起動は各フェーズで行う）
    let ids;
    try {
      ids = window.App.termEnsureBridge(S.dir, { launch: false });
    } catch (e) {
      toast("ターミナルの起動に失敗: " + (e.message || e), true);
      return;
    }
    S.clineId = ids && ids.cline;
    S.opencodeId = ids && ids.opencode;
    if (!S.clineId || !S.opencodeId) {
      toast("ターミナル2ペインの確保に失敗しました", true);
      return;
    }
    try {
      if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission().catch(() => {});
      }
    } catch {}

    S.running = true;
    S.lastInstruction = S.lastDone = S.lastReview = S.lastFix = S.lastQuestion = null;
    S.stable = {};
    S.handoffNotified = {};
    S.currentRun = null;
    S.followRun = null;
    S.lastLimitRetry = 0;
    S.limitNotified = false;
    S.limitResetUntil = 0;
    S.limitResetLabel = "";
    S.limitRaw = "";
    setPhase("wait-instruction", "連携中: cline(PM) が指示書を作成中…");
    log(`連携開始（作業: ${S.dir || "/"} / ターミナル1:cline PM / ターミナル2:opencode 実装 / 自動承認:${autoApprove() ? "ON" : "OFF"} / リミット後自動再開:${autoResume() ? "ON" : "OFF"}）`);

    if (S.exitUnsub) { try { S.exitUnsub(); } catch {} S.exitUnsub = null; }
    if (window.App.onTermExit) S.exitUnsub = window.App.onTermExit(onExit);

    clearInterval(S.pollTimer);
    S.pollTimer = setInterval(poll, POLL_MS);
    runClinePM();
  }

  function stop() {
    if (!S.running && !S.pollTimer) {
      setStatus("停止中", false);
      return;
    }
    S.followRun = null;
    finish();
    S.phase = "idle";
    setStatus("停止中", false);
    log("AI連携を停止しました。（ターミナル・伝言ファイルは残っています）");
  }

  function resend() {
    if (!S.running) {
      toast("AI連携が実行中ではありません", true);
      return;
    }
    S.runExited = false;
    S.failNotified = false;
    S.limitNotified = false;
    S.limitResetUntil = 0;
    S.limitResetLabel = "";
    S.limitRaw = "";
    S.recovering = false;
    S.recoverFor = null;
    S.stable = {};
    S.handoffNotified = {};
    S.phaseSince = Date.now();
    if (S.phase === "wait-instruction") {
      log("現在のフェーズ（cline:指示書作成）を再実行します。");
      runClinePM();
    } else if (S.phase === "wait-done") {
      log("現在のフェーズ（opencode:実装）を再実行します。");
      runOpencodeDev(S.lastFix || S.lastInstruction || "");
    } else if (S.phase === "wait-review") {
      log("現在のフェーズ（cline:レビュー）を再実行します。");
      runClineReview(S.lastDone || "");
    } else {
      toast("再実行できるフェーズがありません");
    }
  }

  function diag() {
    const c = paneTail(S.clineId, 3000).slice(-600);
    const o = paneTail(S.opencodeId, 3000).slice(-600);
    log("— ターミナル1(cline)の出力末尾 —\n" + (c || "(出力なし)"));
    log("— ターミナル2(opencode)の出力末尾 —\n" + (o || "(出力なし)"));
  }

  function open() {
    show();
  }

  function close() {
    hide();
  }

  function toggle() {
    if (visible()) hide();
    else show();
  }

  function show() {
    const panel = $("aibridge");
    const div = $("divider-aibridge");
    if (!panel) return;
    // 現在のターミナルの場所を作業ディレクトリの初期値にする。
    // cwd はホスト時はワークスペース相対、コンテナ選択時はコンテナ内相対パスなのでそのまま使える。
    try {
      const cur = window.App.termActive ? window.App.termActive() : null;
      const dirInput = $("aibridge-dir");
      if (cur && dirInput && !dirInput.value) {
        try {
          const saved = localStorage.getItem("selfcode.aibridge.dir");
          dirInput.value = cur.cwd || saved || "";
        } catch {
          dirInput.value = cur.cwd || "";
        }
      }
    } catch {}
    panel.classList.remove("hidden");
    if (div) div.classList.remove("hidden");
    const btn = $("btn-aibridge");
    if (btn) btn.classList.add("active");
    try { localStorage.setItem(VIS_KEY, "1"); } catch {}
  }

  function hide() {
    const panel = $("aibridge");
    const div = $("divider-aibridge");
    if (panel) panel.classList.add("hidden");
    if (div) div.classList.add("hidden");
    const btn = $("btn-aibridge");
    // 実行中はボタン点灯を維持する
    if (btn) btn.classList.toggle("active", !!S.running);
    try { localStorage.setItem(VIS_KEY, "0"); } catch {}
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btnClose = $("btn-aibridge-close");
    if (btnClose) btnClose.onclick = hide;
    const btnStart = $("aibridge-start");
    if (btnStart) btnStart.onclick = () => { start().catch((e) => toast(e.message || String(e), true)); };
    const btnStop = $("aibridge-stop");
    if (btnStop) btnStop.onclick = stop;
    const btnResend = $("aibridge-resend");
    if (btnResend) btnResend.onclick = resend;
    const btnDiag = $("aibridge-diag");
    if (btnDiag) btnDiag.onclick = diag;
    const btnFollow = $("aibridge-follow-send");
    if (btnFollow) btnFollow.onclick = () => { sendFollow().catch((e) => toast(e.message || String(e), true)); };
    const btnHint = $("aibridge-hint-toggle");
    const hintBox = $("aibridge-hint");
    if (btnHint && hintBox) btnHint.onclick = () => {
      const collapsed = hintBox.classList.toggle("collapsed");
      hintBox.hidden = collapsed;
      btnHint.textContent = collapsed ? "▲" : "▼";
      btnHint.title = collapsed ? "説明を表示" : "説明を折りたたむ";
    };
    try {
      const saved = localStorage.getItem("selfcode.aibridge.dir");
      if (saved && $("aibridge-dir") && !$("aibridge-dir").value) $("aibridge-dir").value = saved;
    } catch {}
    const dirInput = $("aibridge-dir");
    if (dirInput) dirInput.addEventListener("change", () => {
      try { localStorage.setItem("selfcode.aibridge.dir", dirInput.value); } catch {}
    });
    // リミット後自動再開チェックボックスの状態を保持する（デフォルトはON）
    try {
      const savedResume = localStorage.getItem(RESUME_KEY);
      if ($("aibridge-autoresume") && savedResume !== null) $("aibridge-autoresume").checked = savedResume !== "0";
    } catch {}
    const resumeInput = $("aibridge-autoresume");
    if (resumeInput) resumeInput.addEventListener("change", () => {
      try { localStorage.setItem(RESUME_KEY, resumeInput.checked ? "1" : "0"); } catch {}
      log(`リミット後の自動再開を${resumeInput.checked ? "ON" : "OFF"}にしました。`);
    });
    try {
      if (localStorage.getItem(VIS_KEY) === "1") show();
    } catch {}
  });

  return { open, close, show, hide, toggle, start, stop, resend, diag, follow: sendFollow };
})();
