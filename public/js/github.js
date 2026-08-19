// GitHub 連携パネル（ツールバーの GitHub ボタンで開閉）
// トークンはサーバー側に保存されるため、このパネルではトークンを入力・表示するだけで保持しない。
const GithubPanel = (() => {
  const $ = (id) => document.getElementById(id);
  const KEY = "selfcode.githubVisible";
  let loaded = false;
  let state = { configured: false, username: "", hasToken: false, repos: [] };
  let lastRegistered = [];

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function toast(msg, isErr) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle("err", !!isErr);
    t.style.opacity = "1";
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.style.opacity = "0"), 2500);
  }

  function visible() {
    return !$("github").classList.contains("hidden");
  }

  function show() {
    $("github").classList.remove("hidden");
    $("divider-github").classList.remove("hidden");
    $("btn-github").classList.add("active");
    try { localStorage.setItem(KEY, "1"); } catch {}
    if (!loaded) {
      loaded = true;
      refresh();
    }
  }

  function hide() {
    $("github").classList.add("hidden");
    $("divider-github").classList.add("hidden");
    $("btn-github").classList.remove("active");
    try { localStorage.setItem(KEY, "0"); } catch {}
  }

  function toggle() {
    if (visible()) hide();
    else show();
  }

  // ---- 設定 ----

  function renderSettings() {
    const u = $("gh-username");
    if (document.activeElement !== u) u.value = state.username || "";
    const st = $("gh-settings-status");
    if (state.configured) {
      st.textContent = "接続設定済み: " + state.username + "（トークン保存済み）";
      st.classList.add("ok");
      st.classList.remove("err");
    } else {
      st.textContent = "未設定。ユーザー名と Personal Access Token を入力して保存してください。";
      st.classList.remove("ok", "err");
    }
  }

  function setSettingsStatus(msg, ok) {
    const st = $("gh-settings-status");
    st.textContent = msg;
    st.classList.toggle("ok", ok === true);
    st.classList.toggle("err", ok === false);
  }

  async function saveSettings() {
    const username = $("gh-username").value.trim();
    const token = $("gh-token").value.trim();
    if (!username) return toast("ユーザー名を入力してください", true);
    if (!token && !state.hasToken) return toast("トークンを入力してください", true);
    const btn = $("gh-save");
    btn.classList.add("busy");
    btn.disabled = true;
    try {
      const res = await API.github.saveSettings(username, token);
      $("gh-token").value = "";
      state = { ...state, username, hasToken: true, configured: true };
      if (res.verified && res.user) {
        setSettingsStatus("接続OK: " + res.user.login + (res.user.name ? "（" + res.user.name + "）" : ""), true);
        toast("GitHub に接続しました: " + res.user.login);
      } else {
        setSettingsStatus("保存しました。接続確認に失敗: " + (res.error || "不明なエラー"), false);
        toast("保存しました（接続確認に失敗）", true);
      }
      renderSettings();
    } catch (e) {
      setSettingsStatus("保存に失敗: " + e.message, false);
      toast(e.message, true);
    } finally {
      btn.classList.remove("busy");
      btn.disabled = false;
    }
  }

  async function checkConnection() {
    const st = $("gh-settings-status");
    st.textContent = "確認中…";
    st.classList.remove("ok", "err");
    try {
      const u = await API.github.user();
      setSettingsStatus("接続OK: " + u.login + (u.name ? "（" + u.name + "）" : ""), true);
    } catch (e) {
      setSettingsStatus("接続失敗: " + e.message, false);
    }
  }

  async function clearSettings() {
    if (!confirm("GitHub 設定（ユーザー名・トークン）をクリアしますか？\n登録済みリポジトリは残ります。")) return;
    try {
      await API.github.clearSettings();
      state = { ...state, username: "", hasToken: false, configured: false };
      $("gh-username").value = "";
      $("gh-token").value = "";
      renderSettings();
      toast("GitHub 設定をクリアしました");
    } catch (e) {
      toast(e.message, true);
    }
  }

  function toggleTokenVisible() {
    const t = $("gh-token");
    const show = t.type === "password";
    t.type = show ? "text" : "password";
    $("gh-token-toggle").textContent = show ? "🙈" : "👁";
  }

  // ---- リポジトリ ----

  async function refresh() {
    try {
      const st = await API.github.status();
      state = { configured: st.configured, username: st.username || "", hasToken: !!st.hasToken, repos: st.repos || [] };
    } catch (e) {
      toast(e.message, true);
    }
    renderSettings();
    renderRepos();
  }

  async function renderRepos() {
    const box = $("gh-repos");
    box.innerHTML = '<div class="gh-loading">読み込み中…</div>';
    try {
      const list = await API.github.registered();
      lastRegistered = list;
      box.innerHTML = "";
      if (!list.length) {
        box.innerHTML = '<div class="gh-empty">登録されたリポジトリがありません</div>';
        return;
      }
      for (const r of list) box.appendChild(repoItem(r));
    } catch (e) {
      box.innerHTML = '<div class="gh-empty err">' + esc(e.message) + "</div>";
    }
  }

  function repoItem(r) {
    const div = document.createElement("div");
    div.className = "gh-repo";
    div.dataset.id = r.id;
    const bits = [];
    if (r.branch) bits.push("branch: " + r.branch);
    if (r.ahead) bits.push("ahead " + r.ahead);
    if (r.behind) bits.push("behind " + r.behind);
    if (r.dirty) bits.push("変更 " + r.dirty + " ファイル");
    if (r.error) bits.push("エラー: " + r.error);
    const meta = bits.join(" ・ ") || "クリーン";
    div.innerHTML =
      '<div class="gh-repo-head">' +
      '<span class="gh-repo-name">📁 ' + esc(r.name) + "</span>" +
      '<span class="gh-repo-path" title="' + esc(r.path) + '">' + esc(r.path) + "</span>" +
      '<button class="btn small gh-repo-del" title="登録を解除（ファイルは削除されません）">×</button>' +
      "</div>" +
      '<div class="gh-repo-meta">' + esc(meta) + "</div>" +
      '<div class="gh-repo-actions">' +
      '<button class="btn small" data-act="term" title="ターミナルで開き、エクスプローラもそのフォルダへ移動">Term</button>' +
      '<button class="btn small" data-act="status">状態</button>' +
      '<button class="btn small" data-act="fetch">取得</button>' +
      '<button class="btn small primary" data-act="pull">pull</button>' +
      '<button class="btn small" data-act="log">ログ</button>' +
      '<button class="btn small" data-act="commit">コミット</button>' +
      '<button class="btn small" data-act="push">push</button>' +
      '<button class="btn small" data-act="open">開く</button>' +
      "</div>" +
      '<div class="gh-commit-row hidden">' +
      '<input class="gh-commit-msg" type="text" placeholder="コミットメッセージ（全変更をステージしてコミット）" autocomplete="off">' +
      '<div class="gh-commit-row-actions">' +
      '<button class="btn small primary gh-commit-run">実行</button>' +
      '<button class="btn small gh-commit-cancel">キャンセル</button>' +
      "</div>" +
      "</div>" +
      '<div class="gh-repo-output hidden"></div>';
    return div;
  }

  function onReposClick(e) {
    const del = e.target.closest(".gh-repo-del");
    if (del) {
      removeRepo(del.closest(".gh-repo").dataset.id);
      return;
    }
    const run = e.target.closest(".gh-commit-run");
    if (run) {
      const item = run.closest(".gh-repo");
      const msg = item.querySelector(".gh-commit-msg").value.trim();
      if (!msg) return toast("コミットメッセージを入力してください", true);
      repoAction(item.dataset.id, "commit", msg);
      return;
    }
    const cancel = e.target.closest(".gh-commit-cancel");
    if (cancel) {
      cancel.closest(".gh-commit-row").classList.add("hidden");
      return;
    }
    const btn = e.target.closest(".gh-repo-actions .btn");
    if (!btn) return;
    const id = btn.closest(".gh-repo").dataset.id;
    if (btn.dataset.act === "term") {
      // そのリポジトリのフォルダをターミナルで開き、エクスプローラもその場所へ移動する
      const repo = lastRegistered.find((r) => r.id === id);
      if (repo && window.App && window.App.openFolderAt) window.App.openFolderAt(repo.path);
      return;
    }
    if (btn.dataset.act === "commit") {
      btn.closest(".gh-repo").querySelector(".gh-commit-row").classList.toggle("hidden");
      return;
    }
    repoAction(id, btn.dataset.act);
  }

  function showRemoteDialog(id, repo, pullOutput) {
    const overlay = document.createElement("div");
    overlay.className = "modal";
    overlay.innerHTML =
      '<div class="modal-box" style="min-width:400px">' +
        '<div class="modal-head"><span>リモートを設定</span></div>' +
        '<div style="padding:12px;font-size:13px;line-height:1.6">' +
          '<div style="margin-bottom:8px;color:var(--fg-dim)">pullに失敗しました。リモートリポジトリのURLを設定してください。</div>' +
          '<div style="margin-bottom:4px;font-size:11px;color:var(--fg-dim)">' + esc(pullOutput || "") + '</div>' +
          '<label style="display:block;margin-top:8px;font-size:11px;color:var(--fg-dim)">リモートURL</label>' +
          '<input id="gh-remote-url" type="text" style="width:100%;box-sizing:border-box;padding:5px 8px;margin-top:2px;font-size:13px;background:#000;color:#fff;border:1px solid var(--border)" placeholder="https://github.com/user/repo.git" autocomplete="off">' +
          '<label style="display:block;margin-top:8px;font-size:11px;color:var(--fg-dim)">ブランチ名</label>' +
          '<input id="gh-remote-branch" type="text" style="width:100%;box-sizing:border-box;padding:5px 8px;margin-top:2px;font-size:13px;background:#000;color:#fff;border:1px solid var(--border)" placeholder="main" autocomplete="off">' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:6px;padding:8px 12px;border-top:1px solid var(--border)">' +
          '<button id="gh-remote-cancel" class="btn small">キャンセル</button>' +
          '<button id="gh-remote-ok" class="btn small primary">設定してpull再実行</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const urlInput = $("gh-remote-url");
    const branchInput = $("gh-remote-branch");
    urlInput.value = (repo && repo.url) || "";
    branchInput.value = "main";
    urlInput.focus();
    function close() { overlay.remove(); }
    overlay.querySelector("#gh-remote-cancel").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("#gh-remote-ok").onclick = async () => {
      const url = urlInput.value.trim();
      const branch = branchInput.value.trim() || "main";
      if (!url) { toast("リモートURLを入力してください", true); return; }
      const okBtn = $("gh-remote-ok");
      okBtn.disabled = true;
      okBtn.textContent = "設定中…";
      try {
        const rRes = await API.github.addRemote(id, url, branch);
        if (!rRes.ok) { toast(rRes.output || "リモート設定に失敗しました", true); return; }
        close();
        toast("リモートを設定しました。pullを再実行します…");
        await repoAction(id, "pull");
      } catch (e2) {
        toast(e2.message, true);
      }
    };
  }

  function isPullRemoteError(output) {
    if (!output) return false;
    const lower = output.toLowerCase();
    return lower.includes("does not appear to be a git repository") ||
           lower.includes("no tracking information") ||
           lower.includes("please specify which branch") ||
           lower.includes("git branch --set-upstream-to");
  }

  async function repoAction(id, act, message) {
    if (act === "open") {
      const repo = lastRegistered.find((r) => r.id === id);
      const url = (repo && repo.url) || "";
      window.open(url ? url.replace(/\.git$/, "") : "https://github.com", "_blank");
      return;
    }
    const item = $("gh-repos").querySelector(`.gh-repo[data-id="${CSS.escape(id)}"]`);
    const out = item && item.querySelector(".gh-repo-output");
    const btns = item && item.querySelectorAll(".gh-repo-actions .btn");
    if (out) {
      out.classList.remove("hidden", "err");
      out.textContent = "実行中…";
    }
    if (btns) for (const b of btns) b.disabled = true;
    if (message !== undefined) $("gh-repos").querySelector(`.gh-repo[data-id="${CSS.escape(id)}"]`)?.querySelector(".gh-commit-msg")?.setAttribute("disabled", "true");
    try {
      const res = await API.github.action(id, act, message);
      const outputText = res.output || (res.ok ? "完了しました" : "失敗しました");
      const isErr = !res.ok;
      await renderRepos();
      const item2 = $("gh-repos").querySelector(`.gh-repo[data-id="${CSS.escape(id)}"]`);
      const out2 = item2 && item2.querySelector(".gh-repo-output");
      if (out2) {
        out2.textContent = outputText;
        out2.classList.toggle("err", isErr);
        out2.classList.remove("hidden");
      }
      if (!res.ok && act === "pull" && isPullRemoteError(res.output)) {
        const repo = lastRegistered.find((r) => r.id === id);
        showRemoteDialog(id, repo, res.output);
      }
    } catch (e) {
      if (out) {
        out.textContent = e.message;
        out.classList.add("err");
      }
      toast(e.message, true);
    }
  }

  async function removeRepo(id) {
    if (!confirm("リポジトリの登録を解除しますか？\n（ローカルのファイルは削除されません）")) return;
    try {
      await API.github.remove(id);
      renderRepos();
      toast("登録を解除しました");
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function cloneRepo() {
    const url = $("gh-repo-url").value.trim();
    const dir = $("gh-repo-dir").value.trim();
    if (!url) return toast("URL を入力してください", true);
    const btn = $("gh-clone");
    btn.classList.add("busy");
    btn.disabled = true;
    try {
      const res = await API.github.add(url, dir);
      $("gh-repo-url").value = "";
      $("gh-repo-dir").value = "";
      toast("クローンしました: " + res.repo.path);
      renderRepos();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.classList.remove("busy");
      btn.disabled = false;
    }
  }

  async function registerExisting() {
    const p = $("gh-existing").value.trim();
    if (!p) return toast("パスを入力してください", true);
    const btn = $("gh-register-existing");
    btn.classList.add("busy");
    btn.disabled = true;
    try {
      await API.github.addExisting(p);
      $("gh-existing").value = "";
      toast("登録しました: " + p);
      renderRepos();
    } catch (e) {
      const msg = e.message || "";
      if (msg.includes("git リポジトリではありません") && confirm("このフォルダは git リポジトリではありません。\ngit init を実行して初期化しますか？")) {
        try {
          await API.github.addExisting(p, true);
          $("gh-existing").value = "";
          toast("git init を実行して登録しました: " + p);
          renderRepos();
        } catch (e2) {
          toast(e2.message, true);
        }
      } else {
        toast(msg, true);
      }
    } finally {
      btn.classList.remove("busy");
      btn.disabled = false;
    }
  }

  // 自分のリポジトリ一覧（クリックで URL 欄に入る）
  async function toggleOwnRepos() {
    const box = $("gh-own");
    if (!box.classList.contains("hidden")) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    if (box.dataset.loaded) return;
    box.innerHTML = '<div class="gh-loading">読み込み中…</div>';
    try {
      const list = await API.github.myRepos();
      box.innerHTML = "";
      box.dataset.loaded = "1";
      if (!list.length) {
        box.innerHTML = '<div class="gh-empty">リポジトリがありません</div>';
        return;
      }
      for (const r of list) {
        const row = document.createElement("div");
        row.className = "gh-own-item";
        const name = document.createElement("span");
        name.className = "gh-own-name";
        name.textContent = (r.private ? "🔒 " : "") + r.full_name;
        const badge = document.createElement("span");
        badge.className = "gh-own-branch";
        badge.textContent = r.default_branch || "";
        row.append(name, badge);
        row.title = r.description || r.clone_url;
        row.onclick = () => {
          $("gh-repo-url").value = r.clone_url || "https://github.com/" + r.full_name;
          $("gh-repo-dir").value = "";
          box.classList.add("hidden");
          $("gh-repo-url").focus();
        };
        box.appendChild(row);
      }
    } catch (e) {
      box.innerHTML = '<div class="gh-empty err">' + esc(e.message) + "</div>";
    }
  }

  function init() {
    $("btn-github").onclick = toggle;
    $("btn-github-close").onclick = hide;
    $("gh-save").onclick = saveSettings;
    $("gh-check").onclick = checkConnection;
    $("gh-clear").onclick = clearSettings;
    $("gh-token-toggle").onclick = toggleTokenVisible;
    $("gh-add-toggle").onclick = () => $("gh-add").classList.toggle("hidden");
    $("gh-clone").onclick = cloneRepo;
    $("gh-own-toggle").onclick = toggleOwnRepos;
    $("gh-register-existing").onclick = registerExisting;
    $("gh-repos-refresh").onclick = renderRepos;
    $("gh-repos").addEventListener("click", onReposClick);
    // 初回表示時に読み込んでおく（ボタンで開く前に設定済みかを知るため）。
    // 成功したら表示内容も描画しておく（開いたときに refresh しなくて済む）。
    API.github.status()
      .then((st) => {
        state = { configured: st.configured, username: st.username || "", hasToken: !!st.hasToken, repos: st.repos || [] };
        loaded = true;
        renderSettings();
        renderRepos();
      })
      .catch(() => {});
    if (localStorage.getItem(KEY) === "1") show();
  }

  return { init, show, hide, toggle };
})();

window.GithubPanel = GithubPanel;
