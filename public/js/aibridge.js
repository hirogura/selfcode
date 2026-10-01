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
    lastLimitRetry: 0,
    limitNotified: false,
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
    S.recovering = false;
    S.recoverFor = null;
    S.recoverAttempts = 0;
    S.lastTrouble = null;
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

  // フェーズごとのトラブル報告ファイル名（相互リカバリーの伝言板）
  function troubleFileFor(kind) {
    if (kind === "instruction") return "trouble-instruction.md";
    if (kind === "review") return "trouble-review.md";
    return "trouble-done.md";
  }

  function isLimitHit(text) {
    return LIMIT_RE.test(String(text || ""));
  }

  // opencode フェーズで使用制限（レート/セッションリミット）を検知したら、
  // 設定に応じて自動再開する。true を返したら通常の失敗通知はスキップする。
  function limitCheck(label, paneId, rerun) {
    const tail = paneTail(paneId, 5000);
    if (!isLimitHit(tail)) return false;
    if (!autoResume()) {
      if (!S.limitNotified) {
        S.limitNotified = true;
        log(`${label} が使用制限に達したようです（自動再開OFF）。回復後に「再実行」を押してください。`);
        notifyHuman(`AI連携: ${label} が使用制限に達しました`, tail.slice(-300) || "回復後に再実行してください");
      }
      return true;
    }
    // 自動再開ON: 実行中なら回復待ち（重複起動しない）、終了済みなら間隔を空けて再実行
    if (S.runExited) {
      const now = Date.now();
      if (now - S.lastLimitRetry >= LIMIT_RETRY_MS) {
        S.lastLimitRetry = now;
        S.runExited = false;
        S.failNotified = false;
        S.limitNotified = false;
        S.phaseSince = now;
        log(`${label} が使用制限に達したため、自動で再開します。`);
        setStatus("連携中: opencode リミット回復待ち・自動再開…", true);
        rerun();
      } else {
        setStatus("連携中: opencode リミット回復待ち・自動再開…", true);
      }
    } else {
      if (!S.limitNotified) {
        S.limitNotified = true;
        log(`${label} が使用制限に達したようです。回復を待っています（自動再開ON）。`);
      }
      setStatus("連携中: opencode リミット回復待ち…", true);
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
      // もう1つのAIがトラブル解決中なら、そちらを優先監視する
      if (S.recovering && S.recoverFor) {
        await pollRecovering();
        return;
      }
      if (S.phase === "wait-instruction") {
        const ins = await readText(bp("instruction.md"));
        if (ins && ins.trim() && ins !== S.lastInstruction) {
          S.lastInstruction = ins;
          log("cline が指示書を作成しました。opencode に引き継ぎます。");
          runOpencodeDev(ins);
          setPhase("wait-done", "連携中: opencode が実装中…");
          return;
        }
        await stallOrFailCheck("instruction", "cline(PM)", S.clineId, "instruction.md");
      } else if (S.phase === "wait-done") {
        const done = await readText(bp("done.md"));
        if (done && done.trim() && done !== S.lastDone) {
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
      if (!S.limitNotified) {
        S.limitNotified = true;
        log("トラブル解決中のAIが使用制限に達したようです。回復を待っています。");
      }
      setStatus("連携中: トラブル解決AIのリミット回復待ち…", true);
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
    for (const f of ["instruction.md", "done.md", "review-ok.md", "instruction2.md", "approval.md", "trouble-instruction.md", "trouble-done.md", "trouble-review.md"]) {
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
    S.lastLimitRetry = 0;
    S.limitNotified = false;
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
    S.recovering = false;
    S.recoverFor = null;
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

  return { open, close, show, hide, toggle, start, stop, resend, diag };
})();
