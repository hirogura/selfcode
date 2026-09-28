/* AI連携: cline(PM) × opencode(実装) の自動進行オーケストレーター。
 * 方式: ターミナル2ペインで非対話ラン + 作業ディレクトリ直下の .ai-bridge/ ファイル群を伝言板にする。
 *   task.md         人間の最初の指示（ブリッジが作成）
 *   instruction.md  cline(PM)が作成する詳細指示書 → opencodeへ引き継ぎ
 *   done.md         opencodeが実装完了時に書く完了報告 → clineへ引き継ぎ
 *   review-ok.md    clineがレビューOK時に書く承認 → 人間に通知
 *   instruction2.md clineが修正を求める場合の追加指示 → opencodeへ再実行
 * 各AIはプロンプトをコマンドライン引数で受けて実行し、終了する
 * （cline "prompt" / opencode run [--auto] "prompt"）。完了検知は終了通知＋ファイル監視。
 */
window.AIBridge = (() => {
  const $ = (id) => document.getElementById(id);
  const BRIDGE = ".ai-bridge";
  const POLL_MS = 4000;
  const STALL_HINT_MS = 5 * 60 * 1000;

  const S = {
    running: false,
    phase: "idle", // idle | wait-instruction | wait-done | wait-review | done
    dir: "",
    task: "",
    clineId: null,
    opencodeId: null,
    pollTimer: null,
    exitUnsub: null,
    currentRun: null, // { pane: "cline"|"opencode", kind: "pm"|"dev"|"review"|"fix" }
    runExited: false,
    exitCode: null,
    phaseSince: 0,
    hinted: false,
    failNotified: false,
    lastInstruction: null,
    lastDone: null,
    lastReview: null,
    lastFix: null,
  };

  const normDir = (d) => String(d || "").trim().replace(/^\/+|\/+$/g, "");
  const bp = (name) => (S.dir ? S.dir + "/" + BRIDGE + "/" + name : BRIDGE + "/" + name);
  const autoApprove = () => ($("aibridge-autopermit") ? $("aibridge-autopermit").checked : true);

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
    if (btn) btn.classList.toggle("active", !!active);
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
    if (statusText) setStatus(statusText, true);
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

  function onExit(pane, code) {
    if (!S.running || !pane) return;
    const role = pane.id === S.clineId ? "cline" : pane.id === S.opencodeId ? "opencode" : null;
    if (!role) return;
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
      `あなたはこのプロジェクトのPM（プロジェクトマネージャー）です。` +
      `まず「${BRIDGE}/task.md」を読んでください（人間の最初の指示が書かれています。参考: ${task}）。\n\n` +
      `【あなたの仕事】\n` +
      `1. 作業ディレクトリ（カレントディレクトリ）の内容を調査し、タスクを具体的な実装手順に分解してください。\n` +
      `2. 詳細な指示書を「${BRIDGE}/instruction.md」に必ず作成してください。` +
      `ファイル形式: 目的 / 前提 / 変更対象ファイル一覧 / 手順（番号付き）/ 受け入れ条件（テスト・動作確認の方法）/ 注意事項。\n` +
      `3. 指示書ファイルの作成があなたの完了条件です。ファイルを作成したら終了してください。`
    );
  }

  function devPrompt(instruction) {
    const head = String(instruction || "").slice(0, 6000);
    return (
      `あなたはプログラマー担当です。PM（cline）の指示書に従って実装を行ってください。\n\n` +
      `まず「${BRIDGE}/instruction.md」の全文を読んでください（以下は抜粋です）。\n` +
      `【指示書の抜粋】\n${head}\n\n` +
      `【ルール】\n` +
      `1. 受け入れ条件を満たすまで実装・テストを進めてください。\n` +
      `2. 実装が完了したら「${BRIDGE}/done.md」に次の内容を必ず書いてください: ` +
      `変更ファイル一覧 / 実施内容 / テスト結果 / 残課題（無ければ「なし」）。\n` +
      `3. done.md の作成があなたの完了条件です。作成したら終了してください。`
    );
  }

  function reviewPrompt(done) {
    const head = String(done || "").slice(0, 4000);
    return (
      `あなたはPM（プロジェクトマネージャー）です。プログラマー（opencode）の完了報告をレビューしてください。\n\n` +
      `まず「${BRIDGE}/done.md」の全文を読んでください（以下は抜粋です）。\n` +
      `【完了報告の抜粋】\n${head}\n\n` +
      `1. done.md の内容と、実際の変更内容（git diff 等）を確認してください。\n` +
      `2. 問題なければ「${BRIDGE}/review-ok.md」にレビュー結果（OK の根拠）を必ず書いてください。\n` +
      `3. 修正が必要なら「${BRIDGE}/instruction2.md」に具体的な追加指示を書いてください。\n` +
      `4. ファイルの作成があなたの完了条件です。作成したら終了してください。`
    );
  }

  function fixPrompt(fix) {
    return (
      `PM から修正指示が出ました。「${BRIDGE}/instruction2.md」の全文を読んで対応してください。` +
      `（「${BRIDGE}/instruction.md」も合わせて参照してください）\n\n` +
      `【修正指示の抜粋】\n${String(fix || "").slice(0, 4000)}\n\n` +
      `対応完了後は「${BRIDGE}/done.md」を更新してください（更新があなたの完了条件です）。`
    );
  }

  // ---- 監視ループ ----

  async function poll() {
    if (!S.running) return;
    try {
      if (S.phase === "wait-instruction") {
        const ins = await readText(bp("instruction.md"));
        if (ins && ins.trim() && ins !== S.lastInstruction) {
          S.lastInstruction = ins;
          log("cline が指示書を作成しました。opencode に引き継ぎます。");
          runOpencodeDev(ins);
          setPhase("wait-done", "連携中: opencode が実装中…");
          return;
        }
        stallOrFailCheck("cline(PM)", S.clineId, bp("instruction.md"), () => runClinePM());
      } else if (S.phase === "wait-done") {
        const done = await readText(bp("done.md"));
        if (done && done.trim() && done !== S.lastDone) {
          S.lastDone = done;
          log("opencode が完了報告を出しました。cline にレビューを依頼します。");
          runClineReview(done);
          setPhase("wait-review", "連携中: cline がレビュー中…");
          return;
        }
        stallOrFailCheck("opencode", S.opencodeId, bp("done.md"), () =>
          runOpencodeDev(S.lastFix || S.lastInstruction || "")
        );
      } else if (S.phase === "wait-review") {
        const ok = await readText(bp("review-ok.md"));
        if (ok && ok.trim() && ok !== S.lastReview) {
          S.lastReview = ok;
          S.phase = "done";
          setStatus("連携完了: 人間の確認待ち", false);
          finish();
          notifyHuman("AI連携が完了しました。人間の確認をお願いします", ok.slice(0, 300));
          log("cline がレビューOKを出しました。人間の確認をお願いします。");
          return;
        }
        const fix = await readText(bp("instruction2.md"));
        if (fix && fix.trim() && fix !== S.lastFix && fix !== S.lastInstruction) {
          S.lastFix = fix;
          log("cline が修正指示を出しました。opencode に再実行させます。");
          S.currentRun = { pane: "opencode", kind: "fix" };
          const args = autoApprove() ? ["run", "--auto", fixPrompt(fix)] : ["run", fixPrompt(fix)];
          window.App.termExecIn(S.opencodeId, "opencode", args);
          setPhase("wait-done", "連携中: opencode が修正中…");
          return;
        }
        stallOrFailCheck("cline(PM:レビュー)", S.clineId, bp("review-ok.md"), () =>
          runClineReview(S.lastDone || "")
        );
      }
    } catch (e) {
      log("ポーリングエラー: " + (e.message || e));
    }
  }

  // 実行終了後に成果物が無い場合の失敗通知と、長時間停滞時のヒント
  function stallOrFailCheck(label, paneId, expectedFile, rerun) {
    void expectedFile;
    void rerun;
    const now = Date.now();
    if (S.runExited && !S.failNotified) {
      S.failNotified = true;
      const tail = paneTail(paneId, 3000).slice(-800);
      log(`${label} は終了しましたが成果物がまだありません。ターミナルで出力を確認してください。`);
      notifyHuman(`AI連携: ${label} が成果物なしで終了しました`, tail.slice(-300) || "出力を確認してください");
      return;
    }
    if (!S.hinted && now - S.phaseSince > STALL_HINT_MS) {
      S.hinted = true;
      log(`ヒント: ${label} の処理が5分以上続いています。進みが無い場合は「ターミナルの状態を表示」で出力を確認し、必要なら「現在のフェーズを再実行」を押してください。`);
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
    for (const f of ["instruction.md", "done.md", "review-ok.md", "instruction2.md", "approval.md"]) {
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
    S.lastInstruction = S.lastDone = S.lastReview = S.lastFix = null;
    S.currentRun = null;
    setPhase("wait-instruction", "連携中: cline(PM) が指示書を作成中…");
    log(`連携開始（作業: ${S.dir || "/"} / ターミナル1:cline PM / ターミナル2:opencode 実装 / 自動承認:${autoApprove() ? "ON" : "OFF"}）`);

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
    const m = $("aibridge-modal");
    if (!m) return;
    // 現在のターミナルの場所を作業ディレクトリの初期値にする。
    // cwd はホスト時はワークスペース相対、コンテナ選択時はコンテナ内相対パスなのでそのまま使える。
    try {
      const cur = window.App.termActive ? window.App.termActive() : null;
      const dirInput = $("aibridge-dir");
      if (cur && dirInput) {
        dirInput.value = cur.cwd || "";
        try { localStorage.setItem("selfcode.aibridge.dir", dirInput.value); } catch {}
      }
    } catch {}
    m.classList.remove("hidden");
  }

  function close() {
    const m = $("aibridge-modal");
    if (m) m.classList.add("hidden");
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btnClose = $("btn-aibridge-close");
    if (btnClose) btnClose.onclick = close;
    const m = $("aibridge-modal");
    if (m) m.addEventListener("mousedown", (e) => { if (e.target === m) close(); });
    const btnStart = $("aibridge-start");
    if (btnStart) btnStart.onclick = () => { start().catch((e) => toast(e.message || String(e), true)); };
    const btnStop = $("aibridge-stop");
    if (btnStop) btnStop.onclick = stop;
    const btnResend = $("aibridge-resend");
    if (btnResend) btnResend.onclick = resend;
    const btnDiag = $("aibridge-diag");
    if (btnDiag) btnDiag.onclick = diag;
    const modal = $("aibridge-modal");
    if (modal) {
      try {
        const saved = localStorage.getItem("selfcode.aibridge.dir");
        if (saved && $("aibridge-dir") && !$("aibridge-dir").value) $("aibridge-dir").value = saved;
      } catch {}
      const dirInput = $("aibridge-dir");
      if (dirInput) dirInput.addEventListener("change", () => {
        try { localStorage.setItem("selfcode.aibridge.dir", dirInput.value); } catch {}
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  });

  return { open, close, start, stop, resend, diag };
})();
