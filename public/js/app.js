const App = (() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    workspaceLabel: $("workspace-label"),
    tree: $("tree"),
    tabs: $("tabs"),
    editorHost: $("editor-host"),
    emptyState: $("empty-state"),
    showHidden: $("show-hidden"),
    sidebar: $("sidebar"),
    main: $("main"),
    terminal: $("terminal"),
    terminalWorkspace: $("terminal-workspace"),
    chat: $("chat"),
    chatContent: $("chat-content"),
    github: $("github"),
    status: $("oc-status"),
    memo: $("memo"),
    memoInput: $("memo-input"),
  };

  let workspace = "";
  let containerInfo = null; // { name, runtime } | null
  let termUser = "root"; // ホスト側ターミナルの既定ユーザー（/api/status から取得）
  let termIsRoot = false; // サーバーが root で動いているか（root のときのみユーザー切替可能）
  let rootMode = false; // root モード（ON で opencode/freebuff/agy を root で実行）
  let editor = null;
  const docs = new Map();
  const models = new Map();
  let activePath = null;
  let selectedDir = "";
  // タッチ端末（iPad など）では区切り線のドラッグが使いにくいため、ターミナルを開いたときに広げる判定に使う
  const IS_TOUCH = "ontouchstart" in window || navigator.maxTouchPoints > 0;

  // エクスプローラで展開中のフォルダ（リロード後も復元する）
  const expandedDirs = new Set();

  function treeStateKey() {
    return "selfcode.treeExpanded:" + (workspace || "root");
  }

  function saveTreeState() {
    try {
      localStorage.setItem(treeStateKey(), JSON.stringify(Array.from(expandedDirs)));
    } catch {}
  }

  function loadTreeState() {
    expandedDirs.clear();
    try {
      const data = JSON.parse(localStorage.getItem(treeStateKey()));
      if (Array.isArray(data)) for (const p of data) expandedDirs.add(String(p));
    } catch {}
  }

  const EXT_LANG = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    json: "json", jsonc: "json", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
    md: "markdown", py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
    cs: "csharp", cpp: "cpp", cc: "cpp", c: "c", h: "c", hpp: "cpp", php: "php", sql: "sql",
    xml: "xml", svg: "xml", sh: "shell", bash: "shell", zsh: "shell", yaml: "yaml", yml: "yaml",
    toml: "ini", ini: "ini", conf: "ini", vue: "html", svelte: "html", dockerfile: "dockerfile",
  };

  function langOf(p) {
    const base = p.split("/").pop();
    if (base === "Dockerfile") return "dockerfile";
    if (base === "Makefile") return "makefile";
    const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
    return EXT_LANG[ext] || "plaintext";
  }

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
    t._h = setTimeout(() => (t.style.opacity = "0"), 2500);
  }

  function relPath(p) {
    if (!p) return p;
    if (p.startsWith(workspace)) return p.slice(workspace.length).replace(/^\/+/, "");
    return p;
  }

  window.App = {
    onFileChanged: (f) => {
      const rel = relPath(f);
      const doc = docs.get(rel);
      if (doc && !doc.dirty && doc.kind === "text") loadIntoModel(rel, false);
    },
    onSessionIdle: () => {
      refreshTree();
      for (const [path, doc] of Array.from(docs)) {
        if (doc && !doc.dirty && doc.kind === "text") {
          API.readFile(path)
            .then((data) => {
              if (data.type === "text" && data.content !== doc.model.getValue()) loadIntoModel(path, false);
            })
            .catch(() => {});
        }
      }
    },
    openFile: (p) => openFile(relPath(p)),
    openTerminalAt: (p) => openTerminalAt(p || ""),
    revealInExplorer: (p) => revealInExplorer(p || ""),
    // GitHub パネルの Term ボタン用: ターミナルで開き、エクスプローラもそのフォルダへ移動する
    openFolderAt: (p) => openFolderAt(p || ""),
  };

  async function openFile(path) {
    if (!path) return;
    // エディタを隠しているときにファイルを開いたら、エディタを表示し直す
    if (els.editorHost.classList.contains("hidden")) setEditorPanelVisible(true);
    const existing = docs.get(path);
    if (existing) {
      activateTab(path);
      return;
    }
    let data;
    try {
      data = await API.readFile(path);
    } catch (e) {
      toast(e.message, true);
      return;
    }
    if (data.type === "binary") {
      toast("バイナリファイルは表示できません", true);
      return;
    }
    const model = monaco.editor.createModel(data.content || "", langOf(path));
    models.set(path, model);
    docs.set(path, { path, kind: "text", dirty: false, model });
    addTab(path);
    activateTab(path);
    selectTreeNode(path);
  }

  async function loadIntoModel(path, markClean) {
    try {
      const data = await API.readFile(path);
      if (data.type !== "text") return;
      const model = models.get(path);
      if (!model) return;
      const prev = model.getValue();
      const cur = model.getAlternativeVersionId();
      model.setValue(data.content || "");
      const doc = docs.get(path);
      if (doc) doc.dirty = false;
      if (markClean) updateTab(path);
      if (prev !== data.content) toast("ファイルが更新されました: " + path);
      void cur;
    } catch (e) {
      toast(e.message, true);
    }
  }

  function currentDoc() {
    return activePath ? docs.get(activePath) : null;
  }

  async function saveDoc(path) {
    const doc = docs.get(path);
    if (!doc || doc.kind !== "text") return;
    const content = doc.model.getValue();
    try {
      await API.writeFile(path, content);
      doc.dirty = false;
      updateTab(path);
      toast("保存しました: " + path);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function addTab(path) {
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.dataset.path = path;
    const name = document.createElement("span");
    name.textContent = path.split("/").pop();
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    close.onclick = (e) => {
      e.stopPropagation();
      closeTab(path);
    };
    const dot = document.createElement("span");
    dot.className = "dirty-dot";
    dot.textContent = "●";
    dot.onclick = (e) => {
      e.stopPropagation();
      saveDoc(path);
    };
    tab.append(name, dot, close);
    tab.onclick = () => activateTab(path);
    els.tabs.appendChild(tab);
  }

  function updateTab(path) {
    const tab = els.tabs.querySelector(`.tab[data-path="${CSS.escape(path)}"]`);
    if (!tab) return;
    const doc = docs.get(path);
    tab.classList.toggle("dirty", doc && doc.dirty);
  }

  // エディタに開いているファイルが無いときだけ説明(空状態)を表示する。
  // ターミナルが上がってエディタ領域が狭いときは表示しない。
  function updateEmptyState() {
    if (activePath) {
      els.emptyState.style.display = "none";
      return;
    }
    els.emptyState.style.display = els.editorHost.clientHeight >= EMPTY_MIN_H ? "flex" : "none";
  }

  function activateTab(path) {
    activePath = path;
    for (const t of els.tabs.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.path === path);
    const doc = docs.get(path);
    if (doc) {
      editor.setModel(doc.model);
      updateEmptyState();
    }
  }

  async function closeTab(path) {
    const doc = docs.get(path);
    if (!doc) return;
    if (doc.dirty && !confirm(`「${path}」は未保存です。閉じますか？`)) return;
    docs.delete(path);
    const model = models.get(path);
    if (model) model.dispose();
    models.delete(path);
    const tab = els.tabs.querySelector(`.tab[data-path="${CSS.escape(path)}"]`);
    if (tab) tab.remove();
    if (activePath === path) {
      const remaining = Array.from(docs.keys());
      if (remaining.length) activateTab(remaining[remaining.length - 1]);
      else {
        activePath = null;
        editor.setModel(null);
        updateEmptyState();
      }
    }
  }

  function renderTree() {
    els.tree.innerHTML = "";
    const rootName = containerInfo ? containerInfo.name : workspace === "/" ? "/" : workspace.split("/").filter(Boolean).pop() || "workspace";
    const { node: root, children: rootChildren } = nodeEl({ name: rootName, type: "dir", path: "" }, 0);
    root.classList.add("expanded");
    els.tree.appendChild(root);
    els.tree.appendChild(rootChildren);
    populate("", rootChildren, 1);
  }

  function populate(dirPath, container, depth) {
    API.tree(dirPath, els.showHidden.checked)
      .then((res) => {
        if (res.entries.length === 0) {
          const empty = document.createElement("div");
          empty.className = "tree-node";
          empty.style.paddingLeft = 10 + depth * 14 + "px";
          empty.textContent = "(empty)";
          empty.style.color = "var(--fg-dim)";
          container.appendChild(empty);
          return;
        }
        for (const e of res.entries) {
          const { node, children } = nodeEl(e, depth);
          container.appendChild(node);
          container.appendChild(children);
          // 保存済みの展開状態を復元する（展開中だったフォルダは子を読み込んで開いた状態にする）
          if (e.type === "dir" && expandedDirs.has(e.path)) {
            node.classList.add("expanded");
            populate(e.path, children, depth + 1);
          }
        }
      })
      .catch((err) => toast(err.message, true));
  }

  function nodeEl(entry, depth) {
    const pad = 10 + depth * 14;
    const node = document.createElement("div");
    node.className = "tree-node " + entry.type;
    node.dataset.path = entry.path;
    node.style.paddingLeft = pad + "px";
    const children = document.createElement("div");
    children.className = "tree-children";
    if (entry.type === "dir") {
      const caret = document.createElement("span");
      caret.className = "caret";
      caret.textContent = "▸";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.name;
      node.append(caret, name);
      node.onclick = (e) => {
        e.stopPropagation();
        node.classList.toggle("expanded");
        if (node.classList.contains("expanded")) {
          expandedDirs.add(entry.path);
          if (children.childElementCount === 0) populate(entry.path, children, depth + 1);
        } else {
          expandedDirs.delete(entry.path);
        }
        saveTreeState();
      };
      node.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMenu(e.clientX, e.clientY, { type: "dir", path: entry.path });
      };
    } else {
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = "•";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.name;
      node.append(icon, name);
      node.onclick = (e) => {
        e.stopPropagation();
        openFile(entry.path);
      };
      node.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMenu(e.clientX, e.clientY, { type: "file", path: entry.path, dir: dirOf(entry.path) });
      };
    }
    return { node, children };
  }

  function dirOf(p) {
    return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  }

  function selectTreeNode(path) {
    for (const n of els.tree.querySelectorAll(".tree-node")) {
      n.classList.toggle("selected", n.dataset.path === path);
    }
  }

  function ctxMenuEl() {
    let m = $("ctx-menu");
    if (!m) {
      m = document.createElement("div");
      m.id = "ctx-menu";
      document.body.appendChild(m);
    }
    return m;
  }

  function absDir(p) {
    return workspace === "/" ? "/" + (p || "") : workspace + "/" + (p || "");
  }

  function showMenu(x, y, target) {
    const menu = ctxMenuEl();
    menu.innerHTML = "";
    const items = [];
    if (target.type === "file") {
      items.push({ label: "ターミナルで開く", act: () => openTerminalAt(target.dir) });
      items.push({ label: "開く", act: () => openFile(target.path) });
      items.push({ label: "リネーム", act: () => rename(target.path, target.dir) });
      items.push({ sep: true });
      items.push({ label: "ここでチャット", act: () => Chat.setDirectory(absDir(target.dir)) });
      items.push({ label: "ここで opencode", act: () => openOpencodeAt(target.dir) });
      items.push({ label: "ここで freebuff", act: () => openFreebuffAt(target.dir) });
      items.push({ label: "ここで agy", act: () => openAgyAt(target.dir) });
      items.push({ label: "パスをコピー", act: () => copyPath(target.path) });
      items.push({ sep: true });
      items.push({ label: "アップロード", act: () => uploadFiles(target.dir) });
      items.push({ label: "ダウンロード", act: () => download(target.path) });
      items.push({ label: "削除", act: () => remove(target.path), danger: true });
    } else {
      items.push({ label: "ターミナルで開く", act: () => openTerminalAt(target.path) });
      items.push({ label: "ファイル作成", act: () => createFile(target.path) });
      items.push({ label: "フォルダ作成", act: () => createFolder(target.path) });
      items.push({ sep: true });
      items.push({ label: "ここでチャット", act: () => Chat.setDirectory(absDir(target.path)) });
      items.push({ label: "ここで opencode", act: () => openOpencodeAt(target.path) });
      items.push({ label: "ここで freebuff", act: () => openFreebuffAt(target.path) });
      items.push({ label: "ここで agy", act: () => openAgyAt(target.path) });
      items.push({ label: "パスをコピー", act: () => copyPath(target.path) });
      items.push({ sep: true });
      items.push({ label: "アップロード", act: () => uploadFiles(target.path) });
      items.push({ label: containerInfo ? "ダウンロード (tar.gz)" : "ダウンロード (ZIP)", act: () => downloadDir(target.path) });
      items.push({ label: "リネーム", act: () => rename(target.path, dirOf(target.path)) });
      items.push({ label: "削除", act: () => remove(target.path), danger: true });
    }
    for (const it of items) {
      if (it.sep) {
        menu.appendChild(document.createElement("hr"));
        continue;
      }
      const b = document.createElement("button");
      b.textContent = it.label;
      if (it.danger) b.classList.add("danger");
      b.onclick = () => {
        closeMenu();
        it.act();
      };
      menu.appendChild(b);
    }
    menu.style.display = "block";
    menu.style.visibility = "hidden";
    menu.style.left = "0px";
    menu.style.top = "0px";

    const menuRect = menu.getBoundingClientRect();
    const menuW = menuRect.width;
    const menuH = menuRect.height;
    const pad = 8;

    let posX = x;
    let posY = y;

    // 画面下部ではみ出る場合は上に向けて表示
    if (y + menuH > window.innerHeight - pad) {
      posY = Math.max(pad, y - menuH);
    }

    // 画面右端ではみ出る場合は左側に調整
    if (posX + menuW > window.innerWidth - pad) {
      posX = Math.max(pad, window.innerWidth - menuW - pad);
    }

    menu.style.left = posX + "px";
    menu.style.top = posY + "px";
    menu.style.visibility = "visible";
    menu._close = () => closeMenu();
    setTimeout(() => document.addEventListener("click", menu._close, { once: true }), 0);
  }

  function closeMenu() {
    const m = ctxMenuEl();
    m.style.display = "none";
    document.removeEventListener("click", m._close);
  }

  function createFile(dirPath) {
    const name = prompt("ファイル名", "untitled.txt");
    if (!name) return;
    const p = (dirPath ? dirPath + "/" : "") + name;
    API.writeFile(p, "")
      .then(() => {
        refreshTree();
        openFile(p);
      })
      .catch((e) => toast(e.message, true));
  }

  function createFolder(dirPath) {
    const name = prompt("フォルダ名", "newfolder");
    if (!name) return;
    const p = (dirPath ? dirPath + "/" : "") + name;
    API.mkdir(p)
      .then(refreshTree)
      .catch((e) => toast(e.message, true));
  }

  function rename(from, dirPath) {
    const cur = from.split("/").pop();
    const name = prompt("新しい名前", cur);
    if (!name || name === cur) return;
    const to = (dirPath ? dirPath + "/" : "") + name;
    API.rename(from, to)
      .then(() => {
        refreshTree();
        const doc = docs.get(from);
        if (doc) {
          const model = models.get(from);
          models.delete(from);
          docs.delete(from);
          const tab = els.tabs.querySelector(`.tab[data-path="${CSS.escape(from)}"]`);
          if (tab) tab.dataset.path = to;
          if (model) models.set(to, model);
          docs.set(to, { ...doc, path: to });
          if (activePath === from) activePath = to;
        }
      })
      .catch((e) => toast(e.message, true));
  }

  function remove(path) {
    if (!confirm(`「${path}」を削除しますか？`)) return;
    API.remove(path)
      .then(() => {
        refreshTree();
        if (docs.has(path)) closeTab(path);
        for (const p of Array.from(docs.keys())) {
          if (p.startsWith(path + "/")) closeTab(p);
        }
      })
      .catch((e) => toast(e.message, true));
  }

  function download(path) {
    window.location = "/api/file?path=" + encodeURIComponent(path) + "&download=1";
  }

  function downloadDir(path) {
    window.location = "/api/file/zip?path=" + encodeURIComponent(path);
  }

  // ファイル選択ダイアログを開き、選んだファイルを指定フォルダにアップロードする
  function uploadFiles(dirPath) {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      let ok = 0;
      for (const f of files) {
        try {
          await API.upload(dirPath, f.name, f);
          ok++;
        } catch (e) {
          toast(f.name + " のアップロードに失敗: " + e.message, true);
        }
      }
      if (ok) toast(ok + " 個のファイルをアップロードしました");
      refreshTree();
    };
    input.click();
  }

  function copyPath(path) {
    const abs = workspace === "/" ? "/" + path : workspace + "/" + path;
    copyText(abs)
      .then(() => toast("パスをコピーしました: " + abs))
      .catch(() => toast("コピーに失敗しました", true));
  }

  async function refreshTree() {
    els.tree.innerHTML = "";
    populate("", els.tree, 0);
  }

  // 展開中のフォルダをすべて折りたたむ（ルート＝ワークスペース自体は常に展開表示のまま）
  function collapseAll() {
    expandedDirs.clear();
    saveTreeState();
    for (const n of els.tree.querySelectorAll(".tree-node.dir.expanded")) {
      if (n.dataset.path !== "") n.classList.remove("expanded");
    }
  }

  function setupMonaco() {
    window.MonacoEnvironment = {
      getWorkerUrl: (moduleId, label) => {
        const base = location.origin + "/monaco/";
        return (
          "data:text/javascript;charset=utf-8," +
          encodeURIComponent(
            "self.MonacoEnvironment={baseUrl:'" + base + "'};importScripts('" + base + "base/worker/workerMain.js');"
          )
        );
      },
    };
    require.config({ paths: { vs: "/monaco" } });
    require(["vs/editor/editor.main"], () => {
      monaco.editor.defineTheme("selfcode", {
        base: "vs-dark",
        inherit: true,
        rules: [
          { token: "comment", foreground: "8b949e" },
          { token: "keyword", foreground: "ff7b72" },
          { token: "string", foreground: "a5d6ff" },
          { token: "number", foreground: "79c0ff" },
          { token: "type", foreground: "ffa657" },
          { token: "identifier", foreground: "e6edf3" },
        ],
        colors: {
          "editor.background": "#0d1117",
          "editor.foreground": "#e6edf3",
          "editor.lineHighlightBackground": "#161b22",
          "editorLineNumber.foreground": "#484f58",
          "editorLineNumber.activeForeground": "#8b949e",
          "editorIndentGuide.background1": "#21262d",
          "editorCursor.foreground": "#2f81f7",
          "editor.selectionBackground": "#264f78",
        },
      });
      editor = monaco.editor.create(els.editorHost, {
        theme: "selfcode",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        automaticLayout: true,
        tabSize: 2,
        scrollBeyondLastLine: false,
        renderWhitespace: "none",
        smoothScrolling: true,
        wordWrap: "off",
        renderLineHighlight: "line",
        padding: { top: 8 },
      });
      editor.addAction({
        id: "selfcode.save",
        label: "Save",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => saveDoc(activePath),
      });
      editor.onDidChangeModelContent(() => {
        const doc = currentDoc();
        if (doc && !doc.dirty) {
          doc.dirty = true;
          updateTab(doc.path);
        }
      });
      editor.onDidChangeCursorPosition(() => {
        if (activePath) selectTreeNode(activePath);
      });
    });
  }

  // ---- Terminal panes (分割対応) ----
  const termState = { root: null, focused: null, panes: new Map() };

  // ペインごとに安定した id を発行する（crypto.randomUUID は非セキュアコンテキストで使えないためフォールバック付き）
  function genPaneId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function displayDir(rel) {
    if (containerInfo) return rel ? "/" + rel : "/";
    if (rel) return workspace === "/" ? "/" + rel : workspace + "/" + rel;
    return workspace || "/";
  }

  function titleOf(pane) {
    const dir = displayDir(pane.cwd);
    if (containerInfo) return "📦" + containerInfo.name + " — " + dir;
    return (pane.user ? pane.user + "@" : "") + "bash — " + dir;
  }

  function setPaneTitle(pane) {
    if (pane && pane.titleEl) pane.titleEl.textContent = titleOf(pane);
  }

  function updateAllTitles() {
    for (const p of termState.panes.values()) setPaneTitle(p);
  }

  function createPane(cwd, id, user) {
    const pane = {
      id: id || genPaneId(),
      cwd: cwd || "",
      user: user || (rootMode ? "root" : termUser),
      term: null,
      fit: null,
      ws: null,
      outbox: [],
      wsGen: 0,
      running: false,
      closed: false,
      node: null,
      el: null,
      host: null,
      titleEl: null,
    };
    termState.panes.set(pane.id, pane);
    return pane;
  }

  function paneNode(pane) {
    return { kind: "pane", pane, parent: null, el: null };
  }

  function splitNode(kind, a, b) {
    return { kind, children: [a, b], parent: null, el: null, divEl: null };
  }

  function firstPaneIn(node) {
    if (!node) return null;
    if (node.kind === "pane") return node.pane;
    for (const c of node.children) {
      const p = firstPaneIn(c);
      if (p) return p;
    }
    return null;
  }

  function activePane() {
    if (termState.focused && !termState.focused.closed) return termState.focused;
    return firstPaneIn(termState.root);
  }

  function focusPane(pane) {
    if (!pane || pane.closed) return;
    termState.focused = pane;
    for (const p of termState.panes.values()) {
      if (p.el) p.el.classList.toggle("focused", p === pane);
    }
    try { pane.term && pane.term.focus(); } catch {}
    updateFreebuffBtn();
  }

  function buildPaneDom(pane) {
    const el = document.createElement("div");
    el.className = "term-pane";
    const head = document.createElement("div");
    head.className = "term-pane-head";
    const title = document.createElement("span");
    title.className = "term-pane-title";
    const actions = document.createElement("div");
    actions.className = "term-pane-actions";
    const userBtn = document.createElement("button");
    userBtn.className = "btn small user-pane";
    userBtn.title = "ターミナルのユーザーを切り替える";
    const reset = document.createElement("button");
    reset.className = "btn small reset-pane";
    // ターミナルウィンドウのツールバーと同じゴミ箱アイコン（＝このターミナルを閉じる）
    reset.innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
    reset.title = "このターミナルを閉じる";
    actions.append(userBtn, reset);
    head.append(title, actions);
    const host = document.createElement("div");
    host.className = "term-pane-host";
    el.append(head, host);
    pane.el = el;
    pane.host = host;
    pane.titleEl = title;
    if (pane.node) pane.node.el = el;
    el.addEventListener("mousedown", (e) => { if (e.button === 0) focusPane(pane); });
    userBtn.onclick = (e) => {
      e.stopPropagation();
      toggleTermUser(pane);
    };
    reset.onclick = (e) => {
      e.stopPropagation();
      // ゴミ箱 = このターミナルを閉じる。最後の1ペインならウィンドウのゴミ箱と同じ処理（リセットして閉じる）。
      if (termState.panes.size <= 1) {
        resetAndCloseTerminal();
        return;
      }
      closePane(pane);
    };
    setPaneTitle(pane);
    updateUserBtn(pane);
    return el;
  }

  // ユーザー切替ボタンの表示・ラベルを更新する（コンテナ内や非 root では非表示）
  function updateUserBtn(pane) {
    const btn = pane.el && pane.el.querySelector(".term-pane-actions .user-pane");
    if (!btn) return;
    const show = !containerInfo && termIsRoot;
    btn.style.display = show ? "" : "none";
    btn.classList.toggle("root", show && pane.user === "root");
    if (show) btn.textContent = otherTermUser(pane);
  }

  function updateAllUserBtns() {
    for (const p of termState.panes.values()) updateUserBtn(p);
  }

  // 現在のユーザーと反対側のユーザー（root ⇔ 既定ユーザー）
  function otherTermUser(pane) {
    return pane.user === "root" ? termUser : "root";
  }

  // ユーザーを切り替えてターミナルを再起動する
  function toggleTermUser(pane) {
    if (!pane || pane.closed || containerInfo || !termIsRoot) return;
    const target = otherTermUser(pane);
    pane.user = target;
    sendPane(pane, { type: "user", user: target, cwd: pane.cwd });
    setPaneTitle(pane);
    updateUserBtn(pane);
    saveTermState();
  }

  function openPaneTerminal(pane) {
    const Terminal = window.Terminal;
    if (!Terminal) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, Menlo, Consolas, monospace", scrollback: 5000 });
    let fit = null;
    if (window.FitAddon) {
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
    }
    term.open(pane.host);
    pane.term = term;
    pane.fit = fit;
    term.onData((d) => sendPane(pane, { type: "input", data: d }));
    term.onResize(({ cols, rows }) => sendPane(pane, { type: "resize", cols, rows }));
    term.onBinary && term.onBinary((d) => sendPane(pane, { type: "input", data: d }));
    term.attachCustomKeyEventHandler && term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.key === "c" && term.hasSelection()) {
        copySelection(term);
        return false;
      }
      return true;
    });
    pane.host.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        copyText(sel).then(() => toast("コピーしました", false)).catch(() => toast("コピーに失敗しました", true));
      } else {
        navigator.clipboard
          .readText()
          .then((t) => term.paste(t))
          .catch(() => toast("貼り付けられませんでした", true));
      }
    });
    connectPaneWs(pane);
  }

  function wsUrl(pane) {
    const params = new URLSearchParams();
    if (pane.cwd) params.set("cwd", pane.cwd);
    if (pane.user && pane.user !== termUser) params.set("user", pane.user);
    params.set("id", pane.id);
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/terminal?" + params.toString();
  }

  function connectPaneWs(pane) {
    if (pane.closed) return;
    const gen = ++pane.wsGen;
    if (pane.ws) { try { pane.ws.close(); } catch {} }
    const ws = new WebSocket(wsUrl(pane));
    pane.ws = ws;
    ws.onopen = () => {
      if (pane.closed || gen !== pane.wsGen) return;
      // 画面をクリアしてから、サーバーが保持している出力（初回はウェルカム、以降は履歴）を描画する
      try { pane.term.reset(); } catch {}
      fitPane(pane);
      flushPane(pane);
      if (termState.focused === pane) { try { pane.term.focus(); } catch {} }
    };
    ws.onmessage = (e) => {
      if (pane.closed || gen !== pane.wsGen) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "data") pane.term.write(msg.data);
        else if (msg.type === "state") {
          // 再接続時に実行中のコマンド（freebuff など）を復元する
          pane.running = !!msg.cmd;
          pane.runningCmd = msg.cmd || "";
          updateFreebuffBtn();
        } else if (msg.type === "exit") {
          pane.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
          pane.running = false;
          pane.runningCmd = "";
          updateFreebuffBtn();
        } else if (msg.type === "started") {
          pane.running = true;
          pane.runningCmd = msg.cmd || "";
          updateFreebuffBtn();
          if (msg.cmd === "freebuff" || msg.cmd === "agy") {
            const label = msg.cmd === "freebuff" ? "freebuff" : "agy (Antigravity CLI)";
            pane.term.reset();
            pane.term.write(
              msg.installing
                ? "\r\n\x1b[90m— " + label + " が未インストールです。インストールを確認します… —\x1b[0m\r\n"
                : "\r\n\x1b[90m— " + label + " (Ctrl+C で終了、終了後はターミナルに戻ります) —\x1b[0m\r\n"
            );
            fitPane(pane);
            pane.term.focus();
          }
        } else if (msg.type === "reset") {
          pane.term.reset();
          fitPane(pane);
          if (termState.focused === pane) pane.term.focus();
        }
      } catch {}
    };
    ws.onclose = () => {
      if (pane.closed || gen !== pane.wsGen) return;
      try { pane.term.write("\r\n\x1b[31m[接続が切れました。再接続します…]\x1b[0m\r\n"); } catch {}
      setTimeout(() => connectPaneWs(pane), 2000);
    };
  }

  function flushPane(pane) {
    if (!pane.ws || pane.ws.readyState !== 1) return;
    while (pane.outbox.length) {
      const m = pane.outbox[0];
      try { pane.ws.send(JSON.stringify(m)); pane.outbox.shift(); } catch { break; }
    }
  }

  function sendPane(pane, msg) {
    if (!pane) return;
    pane.outbox.push(msg);
    flushPane(pane);
  }

  function splitPane(pane) {
    if (!pane || pane.closed || !pane.node) return;
    const node = pane.node;
    // 親が横並び(row)なら縦に、それ以外は横に分割してグリッド状にする
    const dir = node.parent && node.parent.kind === "row" ? "col" : "row";
    const newPane = createPane(pane.cwd);
    const newNode = paneNode(newPane);
    newPane.node = newNode;
    const wrap = splitNode(dir, node, newNode);
    const parent = node.parent;
    if (parent) {
      const i = parent.children.indexOf(node);
      if (i < 0) return;
      parent.children[i] = wrap;
      wrap.parent = parent;
    } else {
      termState.root = wrap;
    }
    node.parent = wrap;
    newNode.parent = wrap;
    const wrapEl = document.createElement("div");
    wrapEl.className = dir === "row" ? "term-split-row" : "term-split-col";
    const div = document.createElement("div");
    div.className = "term-divider";
    wrap.el = wrapEl;
    wrap.divEl = div;
    buildPaneDom(newPane);
    openPaneTerminal(newPane);
    node.el.replaceWith(wrapEl);
    wrapEl.append(node.el, div, newPane.el);
    initDivider(div, wrapEl, dir);
    updateCloseButtons();
    focusPane(newPane);
    saveTermState();
    requestAnimationFrame(fitAll);
  }

  function closePane(pane) {
    if (!pane || pane.closed) return;
    if (termState.panes.size <= 1) return;
    pane.closed = true;
    // サーバー側のプロセスを明示的に終了してから切断する（切断だけではプロセスが残るため）
    sendPane(pane, { type: "kill" });
    try { pane.ws && pane.ws.close(); } catch {}
    try { pane.term && pane.term.dispose(); } catch {}
    termState.panes.delete(pane.id);
    if (termState.focused === pane) termState.focused = null;
    const node = pane.node;
    const parent = node.parent;
    if (!parent) { termState.root = null; updateCloseButtons(); return; }
    const i = parent.children.indexOf(node);
    const sibling = parent.children[i === 0 ? 1 : 0];
    const gp = parent.parent;
    if (node.el) node.el.remove();
    if (parent.divEl) parent.divEl.remove();
    if (parent.el) parent.el.replaceWith(sibling.el);
    sibling.parent = gp;
    if (gp) {
      const gi = gp.children.indexOf(parent);
      if (gi >= 0) gp.children[gi] = sibling;
    } else {
      termState.root = sibling;
    }
    updateCloseButtons();
    saveTermState();
    const next = firstPaneIn(sibling);
    if (next) focusPane(next);
    requestAnimationFrame(fitAll);
  }

  function updateCloseButtons() {
    const single = termState.panes.size <= 1;
    for (const p of termState.panes.values()) {
      const btn = p.el && p.el.querySelector(".term-pane-actions .reset-pane");
      if (btn) btn.disabled = single;
    }
  }

  // ゴミ箱ボタンの処理: ターミナルをリセットしてウィンドウを閉じる（最後の1ペインのゴミ箱も同じ処理を使う）
  function resetAndCloseTerminal() {
    refreshTerminal();
    hideTerminalPanel();
  }

  // ターミナルウィンドウをリフレッシュする（全ペインのプロセスを終了し、分割を解除して初期状態の1ペインに戻す）
  function refreshTerminal() {
    for (const p of Array.from(termState.panes.values())) {
      p.closed = true; // 切断時の自動再接続を防ぐ
      sendPane(p, { type: "kill" });
      try { p.ws && p.ws.close(); } catch {}
      try { p.term && p.term.dispose(); } catch {}
    }
    termState.panes.clear();
    termState.root = null;
    termState.focused = null;
    els.terminalWorkspace.innerHTML = "";
    // 初期状態（ルート、既定ユーザー）の1ペインを作り直す
    const pane = createPane("");
    const node = paneNode(pane);
    termState.root = node;
    pane.node = node;
    buildPaneDom(pane);
    els.terminalWorkspace.appendChild(pane.el);
    openPaneTerminal(pane);
    focusPane(pane);
    updateCloseButtons();
    saveTermState();
    requestAnimationFrame(fitAll);
    toast("ターミナルをリフレッシュしました", false);
  }

  function initDivider(div, wrapEl, dir) {
    div.style.cursor = dir === "row" ? "col-resize" : "row-resize";
    div.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const kids = Array.from(wrapEl.children).filter((c) => c !== div);
      if (kids.length !== 2) return;
      const [a, b] = kids;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const start = dir === "row" ? e.clientX : e.clientY;
      const sa = dir === "row" ? ra.width : ra.height;
      const sb = dir === "row" ? rb.width : rb.height;
      div.classList.add("active");
      const onMove = (ev) => {
        const d = (dir === "row" ? ev.clientX : ev.clientY) - start;
        const na = clamp(sa + d, 40, sa + sb - 40);
        a.style.flex = `0 0 ${na}px`;
        b.style.flex = "1 1 0";
        fitAll();
      };
      const onUp = () => {
        div.classList.remove("active");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        fitAll();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  function setPaneCwd(pane, rel) {
    if (!pane) return;
    pane.cwd = rel || "";
    setPaneTitle(pane);
    sendPane(pane, { type: "cwd", cwd: pane.cwd });
    saveTermState();
  }

  function execPane(pane, cmd) {
    sendPane(pane, { type: "exec", cmd, cwd: pane.cwd, ...(rootMode ? { root: true } : {}) });
  }

  const TERM_STATE_KEY = "selfcode.termPanes";
  const TERM_FOCUS_KEY = "selfcode.termFocused";
  const TERM_VISIBLE_KEY = "selfcode.termVisible";
  const MEMO_VISIBLE_KEY = "selfcode.memoVisible";

  // ペイン構成（分割・cwd・id）のシリアライズ（localStorage とサーバー共有の両方で使う）
  function serializeTermState() {
    const ser = (node) => {
      if (!node) return null;
      if (node.kind === "pane") return { k: "p", id: node.pane.id, cwd: node.pane.cwd, user: node.pane.user };
      return { k: node.kind === "row" ? "r" : "c", ch: node.children.map(ser) };
    };
    return { root: ser(termState.root), focused: termState.focused ? termState.focused.id : null };
  }

  // サーバー側への保存（デバウンス）。別のPCから開いても同じターミナルに接続できるようにするため。
  let termServerSaveTimer = null;
  let termServerSavePending = null;
  function saveTermStateToServer() {
    termServerSavePending = serializeTermState();
    clearTimeout(termServerSaveTimer);
    termServerSaveTimer = setTimeout(() => {
      const s = termServerSavePending;
      termServerSavePending = null;
      if (!s) return;
      API.put("/api/term/state", { state: s }).catch(() => {});
    }, 300);
  }

  // ペイン構成（分割・cwd・id）を localStorage に保存し、リロード後に復元して再接続できるようにする
  function saveTermState() {
    try {
      localStorage.setItem(TERM_STATE_KEY, JSON.stringify(serializeTermState()));
      if (termState.focused) localStorage.setItem(TERM_FOCUS_KEY, termState.focused.id);
    } catch {}
    saveTermStateToServer();
  }

  // ペイン構成を復元する。サーバー側に保存された構成を優先し（別のPCで使っていた構成）、
  // 無ければこのブラウザの localStorage を使う。どちらも無ければ false を返す。
  async function restoreTermState() {
    let data = null;
    try {
      const d = await API.get("/api/term/state");
      if (d && d.state && typeof d.state === "object") data = d.state;
    } catch {}
    if (!data) {
      try {
        data = JSON.parse(localStorage.getItem(TERM_STATE_KEY));
      } catch {}
    }
    // サーバー形式は { root, focused }、旧 localStorage 形式はツリー直列
    const rootData = data && typeof data === "object" && data.root !== undefined ? data.root : data;
    const fid = (data && data.focused) || localStorage.getItem(TERM_FOCUS_KEY);
    if (!rootData || typeof rootData !== "object" || (rootData.k !== "p" && rootData.k !== "r" && rootData.k !== "c")) return false;
    const build = (d, parent) => {
      if (d.k === "p") {
        const pane = createPane(d.cwd || "", d.id, d.user);
        const node = paneNode(pane);
        pane.node = node;
        node.parent = parent;
        buildPaneDom(pane);
        openPaneTerminal(pane);
        return node;
      }
      const kind = d.k === "r" ? "row" : "col";
      const node = { kind, children: [], parent, el: null, divEl: null };
      const wrapEl = document.createElement("div");
      wrapEl.className = kind === "row" ? "term-split-row" : "term-split-col";
      const div = document.createElement("div");
      div.className = "term-divider";
      node.el = wrapEl;
      node.divEl = div;
      (Array.isArray(d.ch) ? d.ch : []).forEach((cd, i) => {
        const child = build(cd, node);
        node.children.push(child);
        wrapEl.append(child.el);
        if (i === 0) wrapEl.append(div);
      });
      initDivider(div, wrapEl, kind);
      return node;
    };
    const root = build(rootData, null);
    termState.root = root;
    if (root && root.el) els.terminalWorkspace.appendChild(root.el);
    if (fid && termState.panes.has(fid)) termState.focused = termState.panes.get(fid);
    return true;
  }

  async function setupTerminal() {
    const Terminal = window.Terminal;
    if (!Terminal) return;
    // 前回のペイン構成（分割・cwd・id）を復元して、サーバー側で保持しているプロセスに再接続する
    const restored = await restoreTermState();
    if (!restored) {
      const pane = createPane("");
      const node = paneNode(pane);
      termState.root = node;
      pane.node = node;
      buildPaneDom(pane);
      els.terminalWorkspace.appendChild(pane.el);
      openPaneTerminal(pane);
    }
    const focus = termState.focused || firstPaneIn(termState.root);
    if (focus) focusPane(focus);
    updateCloseButtons();
    new ResizeObserver(() => fitAll()).observe(els.terminalWorkspace);
    // 前回ターミナルを開いていたなら同じ状態で表示する
    if (localStorage.getItem(TERM_VISIBLE_KEY) === "1") showTerminalPanel();
  }

  function copySelection(term) {
    const sel = term.getSelection();
    if (sel) copyText(sel).catch(() => {});
  }

  function copyText(text) {
    const fallback = () =>
      new Promise((resolve, reject) => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
          document.execCommand("copy") ? resolve() : reject(new Error("copy failed"));
        } catch (e) {
          reject(e);
        } finally {
          ta.remove();
        }
      });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(fallback);
    }
    return fallback();
  }

  function fitPane(pane) {
    if (!pane || !pane.fit || !pane.term) return;
    try { pane.fit.fit(); } catch {}
  }

  function fitAll() {
    for (const p of termState.panes.values()) fitPane(p);
  }

  function showTerminalPanel() {
    const wasHidden = els.terminal.classList.contains("hidden");
    els.terminal.classList.remove("hidden");
    $("btn-terminal").classList.add("active");
    $("divider-terminal").classList.remove("hidden");
    localStorage.setItem(TERM_VISIBLE_KEY, "1");
    // iPad などタッチ端末では区切り線のドラッグで高さを変えられないため、
    // ターミナルを開いたときはほぼ全高まで広げて使えるようにする
    if (wasHidden && IS_TOUCH) els.terminal.style.height = termMaxH() + "px";
    setTimeout(() => {
      fitAll();
      const p = activePane();
      if (p && p.term) { try { p.term.focus(); } catch {} }
    }, 30);
  }

  function hideTerminalPanel() {
    els.terminal.classList.add("hidden");
    $("btn-terminal").classList.remove("active");
    $("divider-terminal").classList.add("hidden");
    localStorage.setItem(TERM_VISIBLE_KEY, "0");
  }

  function toggleTerminal() {
    if (els.terminal.classList.contains("hidden")) showTerminalPanel();
    else hideTerminalPanel();
  }

  function updateFreebuffBtn() {
    const p = activePane();
    const cmd = p ? p.runningCmd || "" : "";
    $("btn-freebuff").classList.toggle("active", cmd === "freebuff");
    $("btn-opencode").classList.toggle("active", cmd === "opencode");
    $("btn-ag").classList.toggle("active", cmd === "agy");
  }

  // 「freebuff」/「opencode」/「agy」起動処理（ツールバーおよび右クリックメニュー共通）
  // ターミナルウィンドウが開いているときは分割して新しいペインで起動する。
  // 閉じているときは分割せず、最初のサブウィンドウで起動する。
  // relPath が指定された場合は作業ディレクトリ(cwd)を設定する。
  function openToolInTerminal(cmd, relPath) {
    const wasHidden = els.terminal.classList.contains("hidden");
    showTerminalPanel();
    const pane = activePane();
    if (!pane) return;
    if (wasHidden) {
      const first = firstPaneIn(termState.root);
      if (!first) return;
      if (relPath !== undefined) setPaneCwd(first, relPath);
      if (!first.running) execPane(first, cmd);
      focusPane(first);
      return;
    }
    splitPane(pane); // 分割後は新しいペインがフォーカスされる
    const np = activePane();
    if (np) {
      if (relPath !== undefined) setPaneCwd(np, relPath);
      if (!np.running) execPane(np, cmd);
    }
  }

  function openFreebuffTerminal() {
    openToolInTerminal("freebuff");
  }

  function openOpencodeTerminal() {
    openToolInTerminal("opencode");
  }

  function openAgTerminal() {
    openToolInTerminal("agy");
  }

  function toggleRootMode() {
    rootMode = !rootMode;
    $("btn-root").classList.toggle("active", rootMode);
    toast(rootMode ? "Root モード ON: opencode/freebuff/agy が root で実行されます" : "Root モード OFF");
  }

  let sshTempOn = false; // 「一時SSH」ボタンの状態（/api/ssh-temp と同期）
  let updateRunning = false; // アップデート実行中フラグ（二重実行を防ぐ）

  // 「一時SSH」ボタン: agy などの OAuth 認証を手元 PC から行えるよう、
  // 選択中のコンテナ（未選択ならホスト）の SSH パスワード認証を一時的に有効化する
  async function toggleSshTemp() {
    const next = !sshTempOn;
    if (next) {
      const isContainer = !!containerInfo;
      const targetLabel = isContainer ? `コンテナ「${containerInfo.name}」` : "ホスト";
      let confirmMsg = "";
      if (isContainer) {
        confirmMsg =
          "「一時SSH」を ON にします。\n\n" +
          `対象: ${targetLabel}\n` +
          "・root パスワードを「selfcode」に設定\n" +
          "・SSH のパスワード認証・root ログインを一時的に有効化\n" +
          "・sshd を再起動\n\n" +
          "認証が完了したら、もう一度このボタンを押して OFF にしてください。\n" +
          "続行しますか？";
      } else {
        const userDesc = termUser && termUser !== "root" ? `ユーザー「${termUser}」` : "現在のユーザー";
        confirmMsg =
          "「一時SSH」を ON にします。\n\n" +
          `対象: ${targetLabel}\n` +
          "・SSH のパスワード認証を一時的に有効化\n" +
          "・キーリング（D-Bus / Secret Service）連携を有効化\n" +
          "・sshd を再起動\n\n" +
          `※ パスワードは変更しません。${userDesc}の既存パスワードで SSH 接続してください。\n\n` +
          "認証が完了したら、もう一度このボタンを押して OFF にしてください。\n" +
          "続行しますか？";
      }
      const ok = confirm(confirmMsg);
      if (!ok) return;
    }
    try {
      const result = await postSshTemp(next);
      // openssh-server が未導入の場合は確認してからインストール付きで再実行する
      if (result === "need-install") {
        const ok = confirm(
          "openssh-server がインストールされていません。\n" +
            "インストールしてから一時SSHを有効化しますか？（数分かかることがあります）"
        );
        if (!ok) {
          toast("一時SSHは有効化しませんでした");
          return;
        }
        await postSshTemp(next, true);
      }
    } catch (e) {
      toast(e.message, true);
    }
  }

  // /api/ssh-temp に POST し、結果をボタンとターミナルに反映する
  async function postSshTemp(on, installSshd) {
    const r = await fetch("/api/ssh-temp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on, installSshd: !!installSshd }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.needSshdInstall) return "need-install";
    if (!r.ok) throw new Error(j.error || "一時SSHの切り替えに失敗しました");
    sshTempOn = !!j.on;
    $("btn-ssh-temp").classList.toggle("active", sshTempOn);
    if (j.guide) writeTermMessage(j.guide);
    else toast(sshTempOn ? "一時SSHを ON にしました" : "一時SSHを OFF にしました（設定を復元）");
    return "ok";
  }

  // ターミナルに案内メッセージを表示する（一時SSH の使い方など）
  function writeTermMessage(text) {
    showTerminalPanel();
    const pane = activePane();
    if (!pane) return;
    pane.term.write("\r\n\x1b[90m" + String(text).replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") + "\x1b[0m\r\n");
    fitPane(pane);
  }

  // ターミナルで指定フォルダを開く（右クリックメニューおよび GitHub パネル用）
  // ターミナルが既に開いている場合は分割して新しいペインで開き、閉じている場合は最初のペインを使う。
  function openTerminalAt(relPath) {
    const p = relPath || "";
    const wasHidden = els.terminal.classList.contains("hidden");
    showTerminalPanel();
    const pane = activePane();
    if (!pane) return;
    if (wasHidden) {
      const first = firstPaneIn(termState.root);
      if (first) {
        setPaneCwd(first, p);
        focusPane(first);
      }
      return;
    }
    splitPane(pane); // 分割後は新しいペインがフォーカスされる
    const np = activePane();
    if (np) setPaneCwd(np, p);
  }

  // GitHub パネルの Term ボタン用: ターミナルで開き、エクスプローラもそのフォルダへ移動する。
  function openFolderAt(relPath) {
    const p = relPath || "";
    openTerminalAt(p);
    revealInExplorer(p);
  }

  // エクスプローラを指定フォルダまで展開して選択・スクロールする（GitHub パネルの Term ボタン用）
  function revealInExplorer(relPath) {
    const path = String(relPath || "").replace(/^\/+/, "");
    // ルートからターゲットまでの全フォルダ（ターゲット自身も含む）を展開対象にする
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? cur + "/" + part : part;
      expandedDirs.add(cur);
    }
    saveTreeState();
    refreshTree();
    // populate は非同期（階層が深いと複数ラウンド）なので、ノードが現れるまで待ってから選択・スクロールする
    const selectWhenReady = () => {
      let target = null;
      for (const n of els.tree.querySelectorAll(".tree-node")) {
        if (n.dataset.path === path) {
          target = n;
          break;
        }
      }
      if (!target) return false;
      for (const n of els.tree.querySelectorAll(".tree-node")) n.classList.remove("selected");
      target.classList.add("selected");
      try { target.scrollIntoView({ block: "nearest" }); } catch {}
      return true;
    };
    let tries = 0;
    const iv = setInterval(() => {
      if (selectWhenReady() || ++tries > 40) clearInterval(iv);
    }, 100);
  }

  // 指定フォルダを cwd として CLI ツール（opencode / freebuff / agy）を起動する（右クリックメニュー用）
  function openToolAt(cmd, relPath) {
    openToolInTerminal(cmd, relPath);
  }

  function openFreebuffAt(relPath) {
    openToolAt("freebuff", relPath);
  }

  function openOpencodeAt(relPath) {
    openToolAt("opencode", relPath);
  }

  function openAgyAt(relPath) {
    openToolAt("agy", relPath);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  const TERM_H_KEY = "selfcode.termHeight";
  const TERM_H_MIN = 60;
  // 説明(空状態)を表示できる最小のエディタ領域の高さ（ターミナルが上がって狭くなると非表示）
  const EMPTY_MIN_H = 200;
  // ターミナルはタブバーと区切り線を除いたほぼ全高まで広げられるようにする
  function termMaxH() {
    return Math.max(TERM_H_MIN + 1, $("layout").clientHeight - els.tabs.offsetHeight - 5);
  }

  const MEMO_H_KEY = "selfcode.memoHeight";
  const MEMO_H_MIN = 60;
  const MEMO_CHAT_MIN = 120;
  // メモは opencode 側に最低限の高さを残す範囲で伸縮できる
  function memoMaxH() {
    return Math.max(MEMO_H_MIN + 1, els.chat.clientHeight - MEMO_CHAT_MIN);
  }

  function initResizers() {
    const layout = $("layout");
    const state = { mode: null, startX: 0, startY: 0, startW: 0, startH: 0 };


    // 保存済みのターミナル高さを復元（ウィンドウが小さくなった場合に備えて上限でクランプ）
    const saved = parseFloat(localStorage.getItem(TERM_H_KEY));
    if (saved > 0) {
      els.terminal.style.height = clamp(saved, TERM_H_MIN, termMaxH()) + "px";
    }

    // 保存済みのメモ高さを復元（ターミナル同様に上限でクランプ）
    const savedMemo = parseFloat(localStorage.getItem(MEMO_H_KEY));
    if (savedMemo > 0) {
      els.memo.style.height = clamp(savedMemo, MEMO_H_MIN, memoMaxH()) + "px";
    }

    const onMove = (e) => {
      if (!state.mode) return;
      if (state.mode === "sidebar") {
        const w = clamp(state.startW + (e.clientX - state.startX), 180, layout.clientWidth * 0.5);
        els.sidebar.style.width = w + "px";
      } else if (state.mode === "chat") {
        const w = clamp(state.startW + (state.startX - e.clientX), 280, layout.clientWidth * 0.6);
        els.chat.style.width = w + "px";
      } else if (state.mode === "github") {
        const w = clamp(state.startW + (state.startX - e.clientX), 280, layout.clientWidth * 0.6);
        els.github.style.width = w + "px";
      } else if (state.mode === "terminal") {
        const h = clamp(state.startH + (state.startY - e.clientY), TERM_H_MIN, termMaxH());
        els.terminal.style.height = h + "px";
      } else if (state.mode === "memo") {
        // メモは区切り線の上にあるため、ターミナル（区切り線の下）とは向きが逆：
        // 上に引くと opencode 側（下のパネル）が広がり、区切り線がマウスに追従する
        const h = clamp(state.startH + (e.clientY - state.startY), MEMO_H_MIN, memoMaxH());
        els.memo.style.height = h + "px";
      }
    };
    const onUp = () => {
      if (state.mode === "terminal") {
        localStorage.setItem(TERM_H_KEY, els.terminal.style.height);
      } else if (state.mode === "memo") {
        localStorage.setItem(MEMO_H_KEY, els.memo.style.height);
      }
      state.mode = null;
      document.body.classList.remove("resizing-v", "resizing-h");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      fitAll();
    };
    const begin = (e, mode, el) => {
      state.mode = mode;
      const r = el.getBoundingClientRect();
      state.startX = e.clientX;
      state.startY = e.clientY;
      state.startW = r.width;
      state.startH = r.height;
      e.preventDefault();
      document.body.classList.add(mode === "terminal" || mode === "memo" ? "resizing-h" : "resizing-v");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    // pointer イベントを使うことでマウスとタッチ（iPad など）の両方でドラッグできる
    $("divider-sidebar").addEventListener("pointerdown", (e) => begin(e, "sidebar", els.sidebar));
    $("divider-github").addEventListener("pointerdown", (e) => begin(e, "github", els.github));
    $("divider-chat").addEventListener("pointerdown", (e) => begin(e, "chat", els.chat));
    $("divider-terminal").addEventListener("pointerdown", (e) => begin(e, "terminal", els.terminal));
    $("divider-memo").addEventListener("pointerdown", (e) => begin(e, "memo", els.memo));
  }


  // パネル全体（#chat）は opencode 本体かメモのどちらかが表示されていれば出す
  function syncChatPanel() {
    const shown = !els.chatContent.classList.contains("hidden") || !els.memo.classList.contains("hidden");
    els.chat.classList.toggle("hidden", !shown);
    $("divider-chat").classList.toggle("hidden", !shown);
    // memo と opencode の区切り線は両方表示されているときだけ出す
    const both = !els.chatContent.classList.contains("hidden") && !els.memo.classList.contains("hidden");
    $("divider-memo").classList.toggle("hidden", !both);
    // opencode を隠しているときはメモがパネル全体に広がる
    els.memo.classList.toggle("stretch", els.chatContent.classList.contains("hidden"));
  }

  let chatInitialized = false;
  async function initChatOnce() {
    if (chatInitialized) return;
    chatInitialized = true;
    try { await Chat.init(); } catch (e) { console.error("Chat init failed", e); }
  }

  async function toggleChat() {
    const hiding = els.chatContent.classList.toggle("hidden");
    $("btn-chat").classList.toggle("active", !els.chatContent.classList.contains("hidden"));
    syncChatPanel();
    if (!els.chatContent.classList.contains("hidden")) {
      // opencode がインストールされていない場合は、ターミナルでインストールする
      try {
        const check = await API.get("/api/opencode/check");
        if (check && !check.installed) {
          els.chatContent.classList.add("hidden");
          $("btn-chat").classList.remove("active");
          syncChatPanel();
          openOpencodeTerminal();
          return;
        }
      } catch (e) {
        // チェックに失敗してもチャットを開く（サーバー側で自動起動のため）
      }
      initChatOnce();
    } else {
      Chat.stop();
      API.oc.stop().catch(() => {});
    }
  }

  // ---- エクスプローラ / エディタの表示切替（ツールバー左端のボタン） ----
  function toggleExplorer() {
    const show = els.sidebar.classList.contains("hidden");
    els.sidebar.classList.toggle("hidden", !show);
    $("divider-sidebar").classList.toggle("hidden", !show);
    $("btn-explorer").classList.toggle("active", show);
  }

  function setEditorPanelVisible(show) {
    els.editorHost.classList.toggle("hidden", !show);
    els.tabs.classList.toggle("hidden", !show);
    els.main.classList.toggle("editor-hidden", !show);
    $("btn-editor").classList.toggle("active", show);
    if (show) updateEmptyState();
  }

  function toggleEditorPanel() {
    setEditorPanelVisible(els.editorHost.classList.contains("hidden"));
  }

  // ---- コンテナ (LXD/Docker) ----
  function updateContainerUI() {
    const btn = $("btn-container");
    // アイコンを残すためラベルの span だけを書き換える
    const label = btn.querySelector(".btn-label") || btn;
    if (containerInfo) {
      label.textContent = "📦 " + containerInfo.name;
      btn.classList.add("active");
      els.workspaceLabel.textContent = "📦 " + containerInfo.name;
    } else {
      label.textContent = "コンテナ";
      btn.classList.remove("active");
      els.workspaceLabel.textContent = workspace;
    }
  }

  function containerModal() {
    let m = $("container-modal");
    if (!m) {
      m = document.createElement("div");
      m.id = "container-modal";
      m.className = "modal hidden";
      m.innerHTML =
        '<div class="modal-box">' +
        '<div class="modal-head"><span>コンテナを選択</span>' +
        '<button class="btn small" id="btn-container-close" title="閉じる">×</button></div>' +
        '<div id="container-list" class="container-list"></div>' +
        "</div>";
      document.body.appendChild(m);
      m.addEventListener("mousedown", (e) => { if (e.target === m) closeContainerModal(); });
      $("btn-container-close").onclick = closeContainerModal;
    }
    return m;
  }

  function closeContainerModal() {
    const m = $("container-modal");
    if (m) m.classList.add("hidden");
  }

  function openContainerPicker() {
    const modal = containerModal();
    modal.classList.remove("hidden");
    const list = $("container-list");
    list.innerHTML = '<div class="container-loading">読み込み中…</div>';
    API.get("/api/container/list")
      .then((data) => {
        // サーバーは { containers, errors } を返す（旧形式の配列も一応受け付ける）
        const items = Array.isArray(data) ? data : (data && data.containers) || [];
        const errors = (data && data.errors) || [];
        list.innerHTML = "";
        // コンテナ内にいる場合は「ホストに戻る」を先頭に表示する
        if (containerInfo) {
          const host = document.createElement("div");
          host.className = "container-item host";
          const name = document.createElement("span");
          name.className = "container-item-name";
          name.textContent = "ホストに戻る";
          const badge = document.createElement("span");
          badge.className = "container-item-badge";
          badge.textContent = "host";
          host.append(name, badge);
          host.onclick = () => selectContainer(null);
          list.appendChild(host);
        }
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "container-empty";
          empty.textContent = errors.length
            ? "取得に失敗: " + errors.join(" / ")
            : "稼働中のコンテナがありません";
          list.appendChild(empty);
          return;
        }
        for (const c of items) {
          const el = document.createElement("div");
          el.className = "container-item";
          const name = document.createElement("span");
          name.className = "container-item-name";
          name.textContent = c.name;
          const badge = document.createElement("span");
          badge.className = "container-item-badge";
          badge.textContent = c.runtime;
          el.append(name, badge);
          el.onclick = () => selectContainer(c);
          list.appendChild(el);
        }
      })
      .catch((e) => {
        list.innerHTML = "";
        const el = document.createElement("div");
        el.className = "container-empty";
        el.textContent = "一覧の取得に失敗: " + e.message;
        list.appendChild(el);
      });
  }

  async function selectContainer(c) {
    // 切替時はページを再読み込みするため、未保存の編集があれば確認する
    const dirty = Array.from(docs.values()).some((d) => d.dirty);
    if (dirty && !confirm("未保存の変更があります。コンテナを切り替えるとページが再読み込みされ、未保存の変更は失われます。続行しますか？")) return;
    closeContainerModal();
    try {
      if (c) await API.post("/api/container/select", { name: c.name, runtime: c.runtime });
      else await API.post("/api/container/exit", {});
    } catch (e) {
      toast(e.message, true);
      return;
    }
    location.reload();
  }

  // ---- Memo (右上ペインのメモ) ----
  let memoLoaded = false;
  let memoDirty = false;
  let memoAutosaveTimer = null;
  const MEMO_AUTOSAVE_MS = 3000;

  // 未保存の間は Save ボタンを点滅させ、保存されたら通常表示に戻す
  function setMemoDirtyUI() {
    $("btn-memo-save").classList.toggle("dirty", memoDirty);
  }

  // 入力のたびに呼ばれ、数秒後に自動保存する（デバウンス）
  function markMemoDirty() {
    if (!memoDirty) {
      memoDirty = true;
      setMemoDirtyUI();
    }
    clearTimeout(memoAutosaveTimer);
    memoAutosaveTimer = setTimeout(() => saveMemo({ silent: true }), MEMO_AUTOSAVE_MS);
  }

  function showMemoPanel() {
    els.memo.classList.remove("hidden");
    $("btn-memo").classList.add("active");
    syncChatPanel();
    try { localStorage.setItem(MEMO_VISIBLE_KEY, "1"); } catch {}
    if (!memoLoaded) {
      memoLoaded = true;
      API.memo
        .get()
        .then((d) => {
          els.memoInput.value = d.content || "";
        })
        .catch((e) => toast(e.message, true));
    }
    els.memoInput.focus();
  }

  function hideMemoPanel() {
    els.memo.classList.add("hidden");
    $("btn-memo").classList.remove("active");
    syncChatPanel();
    try { localStorage.setItem(MEMO_VISIBLE_KEY, "0"); } catch {}
  }

  function toggleMemo() {
    if (els.memo.classList.contains("hidden")) showMemoPanel();
    else hideMemoPanel();
  }

  async function saveMemo({ silent } = {}) {
    clearTimeout(memoAutosaveTimer);
    memoAutosaveTimer = null;
    const content = els.memoInput.value;
    try {
      await API.memo.put(content);
      // 保存中に入力が変わっていたら未保存状態を保つ（次の自動保存に任せる）
      if (els.memoInput.value === content) {
        memoDirty = false;
        setMemoDirtyUI();
      }
      if (!silent) toast("メモを保存しました");
    } catch (e) {
      toast(e.message, true);
      // 失敗時は未保存状態のまま数秒後に自動リトライする
      if (memoDirty) markMemoDirty();
    }
  }

  // ---- selfcode 再起動 ----
  async function restartSelfcode(skipConfirm) {
    if (!skipConfirm && !confirm("selfcode を再起動しますか？\n未保存の変更は失われる場合があります。")) return;
    try {
      await API.restart();
    } catch (e) {
      // ステータス付きエラー = 再起動に失敗。接続断（タイムアウト等）は再起動開始とみなす
      if (e.status) {
        toast(e.message, true);
        return;
      }
    }
    showRestartOverlay();
  }

  // ---- selfcode アップデート ----
  async function updateSelfcode() {
    if (updateRunning) return;
    if (!confirm("selfcode を最新版に更新しますか？\n完了まで数分かかることがあります。")) return;
    updateRunning = true;
    const ov = showUpdateOverlay();
    try {
      await API.update();
      ov.done();
    } catch (e) {
      ov.error(e.message || String(e));
    } finally {
      updateRunning = false;
    }
  }

  function showUpdateOverlay() {
    let ov = $("update-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "update-overlay";
      ov.className = "hidden";
      ov.innerHTML =
        '<div class="restart-box"><div class="spinner" id="update-spinner"></div>' +
        '<p id="update-message">アップデート中…（完了まで数分かかることがあります）</p>' +
        '<div class="update-actions">' +
        '<button id="btn-update-restart" class="btn primary hidden"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg><span>リスタート</span></button>' +
        '<button id="btn-update-close" class="btn hidden">閉じる</button></div></div>';
      document.body.appendChild(ov);
    }
    const spinner = $("update-spinner");
    const msg = $("update-message");
    const restartBtn = $("btn-update-restart");
    const closeBtn = $("btn-update-close");
    spinner.classList.remove("hidden");
    msg.classList.remove("err");
    msg.textContent = "アップデート中…（完了まで数分かかることがあります）";
    restartBtn.classList.add("hidden");
    closeBtn.classList.add("hidden");
    restartBtn.onclick = () => {
      hideUpdateOverlay();
      restartSelfcode(true);
    };
    closeBtn.onclick = hideUpdateOverlay;
    ov.classList.remove("hidden");
    return {
      done() {
        spinner.classList.add("hidden");
        msg.textContent = "アップデートが完了しました。「リスタート」ボタンを押してください。";
        restartBtn.classList.remove("hidden");
        closeBtn.classList.remove("hidden");
      },
      error(m) {
        spinner.classList.add("hidden");
        msg.classList.add("err");
        msg.textContent = m + "\n（詳細は journalctl -u selfcode を確認してください）";
        closeBtn.classList.remove("hidden");
      },
    };
  }

  function hideUpdateOverlay() {
    const ov = $("update-overlay");
    if (ov) ov.classList.add("hidden");
  }

  function showRestartOverlay() {
    let ov = $("restart-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "restart-overlay";
      ov.className = "hidden";
      ov.innerHTML =
        '<div class="restart-box"><div class="spinner"></div><p>selfcode を再起動しています…</p>' +
        '<button id="btn-restart-reload" class="btn hidden">再読み込み</button></div>';
      document.body.appendChild(ov);
    }
    ov.classList.remove("hidden");
    const reloadBtn = $("btn-restart-reload");
    reloadBtn.classList.add("hidden");
    reloadBtn.onclick = () => location.reload();
    let tries = 0;
    const poll = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch("/api/status", { cache: "no-store", signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) {
          location.reload();
          return;
        }
      } catch {}
      tries++;
      if (tries >= 60) {
        ov.querySelector("p").textContent = "サーバーが応答しません。手動で再読み込みしてください。";
        reloadBtn.classList.remove("hidden");
        return;
      }
      setTimeout(poll, 1000);
    };
    poll();
  }

  async function boot() {
    setupMonaco();
    // エディタ領域の大きさが変わったら（ターミナル開閉・高さ変更）説明の表示状態を更新する
    new ResizeObserver(updateEmptyState).observe(els.editorHost);
    initResizers();
    // 表示状態を復元（メモのみ。opencode チャットは毎回非表示で開始する）
    if (localStorage.getItem(MEMO_VISIBLE_KEY) === "1") showMemoPanel();
    try {
      const st = await API.status();
      workspace = st.workspace;
      containerInfo = st.container || null;
      termUser = st.termUser || "root";
      termIsRoot = !!st.termIsRoot;
      updateContainerUI();
      if (st.opencode && st.opencode.ready) els.status.classList.add("connected");
    } catch (e) {
      console.error(e);
    }
    // termUser が確定してからターミナルを構築する（既定ユーザーを反映するため）
    await setupTerminal();
    updateAllTitles();
    updateAllUserBtns();
    loadTreeState();
    renderTree();

    els.showHidden.addEventListener("change", refreshTree);
    $("btn-refresh").onclick = refreshTree;
    $("btn-tree-collapse").onclick = collapseAll;
    $("btn-container").onclick = openContainerPicker;
    $("btn-new-file").onclick = () => createFile(selectedDir);
    $("btn-new-folder").onclick = () => createFolder(selectedDir);
    $("btn-explorer").onclick = toggleExplorer;
    $("btn-editor").onclick = toggleEditorPanel;
    $("btn-terminal").onclick = toggleTerminal;
    $("btn-chat").onclick = toggleChat;
    $("btn-freebuff").onclick = openFreebuffTerminal;
    $("btn-opencode").onclick = openOpencodeTerminal;
    $("btn-ag").onclick = openAgTerminal;
    $("btn-root").onclick = toggleRootMode;
    $("btn-ssh-temp").onclick = toggleSshTemp;
    // 「一時SSH」ボタンの状態を復元
    fetch("/api/ssh-temp", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        sshTempOn = !!j.on;
        $("btn-ssh-temp").classList.toggle("active", sshTempOn);
      })
      .catch(() => {});
    $("btn-term-clear").onclick = () => { const p = activePane(); if (p && p.term) p.term.clear(); };
    $("btn-term-split").onclick = () => splitPane(activePane());
    $("btn-term-refresh").onclick = resetAndCloseTerminal;
    $("btn-memo").onclick = toggleMemo;
    $("btn-memo-save").onclick = saveMemo;
    $("btn-memo-close").onclick = hideMemoPanel;
    $("btn-restart").onclick = () => restartSelfcode();
    $("btn-update").onclick = updateSelfcode;

    els.memoInput.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveMemo();
      }
    });
    els.memoInput.addEventListener("input", markMemoDirty);

    // ページを離れる直前に未保存のメモ・ターミナル構成をベストエフォートで保存する
    window.addEventListener("beforeunload", () => {
      if (memoDirty) API.memo.put(els.memoInput.value).catch(() => {});
      if (termServerSavePending) {
        try {
          fetch("/api/term/state", {
            method: "PUT",
            keepalive: true,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ state: termServerSavePending }),
          }).catch(() => {});
        } catch {}
      }
    });

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleChat();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleTerminal();
      }
    });

    window.addEventListener("resize", () => {
      // ウィンドウが小さくなった場合にターミナルが画面外にはみ出さないよう高さを上限でクランプ
      const cur = parseFloat(els.terminal.style.height) || 0;
      if (cur > termMaxH()) els.terminal.style.height = termMaxH() + "px";
      // メモも同様に、chat パネル表示中は上限でクランプしてはみ出しを防ぐ
      if (!els.chat.classList.contains("hidden")) {
        const curMemo = parseFloat(els.memo.style.height) || 0;
        if (curMemo > memoMaxH()) els.memo.style.height = memoMaxH() + "px";
      }
      fitAll();
    });

    GithubPanel.init();
  }

  document.addEventListener("DOMContentLoaded", boot);

  return {};
})();
