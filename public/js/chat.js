const Chat = (() => {
  const $ = (id) => document.getElementById(id);
  let current = null;
  let sessions = [];
  let connected = false;
  let busy = false;
  let order = [];
  let tempCount = 0;
  let pollTimer = null;
  let pollTick = 0;
  let prevSig = "";
  let renderedPerms = new Set();
  let lastErr = 0;
  let directory = "";
  let healing = false;
  let workingEl = null;

  const el = {
    status: $("oc-status"),
    statusLabel: $("oc-status").querySelector(".label"),
    sessionSel: $("chat-session"),
    agentSel: $("chat-agent"),
    modelSel: $("chat-model"),
    messages: $("chat-messages"),
    input: $("chat-input"),
    sendBtn: $("btn-chat-send"),
    stopBtn: $("btn-chat-stop"),
    newBtn: $("btn-new-session"),
    delBtn: $("btn-del-session"),
    dirLabel: $("chat-dir-label"),
  };

  function scrollBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
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

  function setStatus(on) {
    connected = on;
    el.status.classList.toggle("connected", on);
    el.status.classList.toggle("error", !on);
    el.statusLabel.textContent = on ? "opencode ready" : "opencode offline";
  }

  function setBusy(on) {
    busy = on;
    el.sendBtn.disabled = on;
    el.sendBtn.textContent = on ? "" : "Send";
    el.sendBtn.classList.toggle("busy", on);
    el.stopBtn.classList.toggle("hidden", !on);
    el.status.classList.toggle("working", on);
    setWorkingIndicator(on);
  }

  function setWorkingIndicator(on) {
    if (on) {
      if (workingEl) return;
      workingEl = document.createElement("div");
      workingEl.className = "working-indicator";
      workingEl.innerHTML = '<span class="wi-dots"><i></i><i></i><i></i></span><span>作業中…</span>';
      el.messages.appendChild(workingEl);
      scrollBottom();
    } else if (workingEl) {
      workingEl.remove();
      workingEl = null;
    }
  }

  function normDir(d) {
    return String(d || "").replace(/\/+$/, "") || "/";
  }

  function refreshSessionSelect() {
    const prev = current;
    el.sessionSel.innerHTML = "";
    for (const s of sessions) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.title || s.id.slice(0, 12);
      el.sessionSel.appendChild(opt);
    }
    if (prev && sessions.some((s) => s.id === prev)) {
      el.sessionSel.value = prev;
    }
    if (el.sessionSel.selectedIndex === -1 && el.sessionSel.options.length) {
      el.sessionSel.selectedIndex = 0;
      current = el.sessionSel.options[0].value;
    }
  }

  function titleOf(id) {
    const s = sessions.find((x) => x.id === id);
    return s ? s.title || s.id.slice(0, 12) : "new session";
  }

  async function refreshSessions(selectId) {
    try {
      const all = await API.oc.sessions();
      const nd = normDir(directory);
      sessions = (Array.isArray(all) ? all : []).filter((s) => normDir(s.directory) === nd);
      if (selectId) {
        current = sessions.some((s) => s.id === selectId) ? selectId : sessions[0] ? sessions[0].id : null;
      } else if (current && sessions.some((s) => s.id === current)) {
        /* keep */
      } else {
        current = sessions[0] ? sessions[0].id : null;
      }
      refreshSessionSelect();
    } catch (e) {
      console.error(e);
    }
  }

  function ensureSession() {
    if (current) return Promise.resolve(current);
    return API.oc.createSession(titleOf("new")).then((s) => {
      current = s.id;
      refreshSessions(s.id);
      loadMessages(s.id);
      return s.id;
    });
  }

  async function heal() {
    if (healing) return;
    healing = true;
    try {
      clearView();
      setBusy(false);
      await refreshSessions();
      if (current) await loadMessages(current);
      else await ensureSession();
      setStatus(true);
    } catch (e) {
      console.error("chat heal failed", e);
    } finally {
      healing = false;
    }
  }

  async function setDirectory(dir) {
    if (!dir) return;
    const nd = normDir(String(dir));
    if (nd === normDir(directory)) return;
    directory = nd;
    API.oc.setDirectory(directory);
    if (el.dirLabel) {
      el.dirLabel.textContent = directory;
      el.dirLabel.title = "チャットのワークスペース（クリックで変更）: " + directory;
    }
    toast("チャットワークスペース: " + directory);
    await heal();
  }

  async function newSession() {
    const s = await API.oc.createSession("new session");
    current = s.id;
    await refreshSessions(s.id);
    await loadMessages(s.id);
  }

  async function deleteSession() {
    if (!current) return;
    if (!confirm(`セッション「${titleOf(current)}」を削除しますか？`)) return;
    try {
      await API.oc.deleteSession(current);
    } catch (e) {
      console.error(e);
    }
    sessions = sessions.filter((s) => s.id !== current);
    current = sessions[0] ? sessions[0].id : null;
    refreshSessionSelect();
    await loadMessages(current);
  }

  function clearView() {
    el.messages.innerHTML = "";
    workingEl = null;
    order = [];
    renderedPerms = new Set();
    window.__pv = window.__pv || new Map();
    for (const k of Array.from(window.__pv.keys())) window.__pv.delete(k);
  }

  function partStore() {
    if (!window.__pv) window.__pv = new Map();
    return window.__pv;
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

  function messageEl(info) {
    const role = info.role || "assistant";
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    wrap.dataset.id = info.id;
    const head = document.createElement("div");
    head.className = "msg-role";
    const badge = document.createElement("span");
    badge.className = "role-badge";
    badge.textContent = role === "user" ? "you" : "assistant";
    const meta = document.createElement("span");
    const model = info.model ? info.model.id : "";
    meta.textContent = [info.agent, model].filter(Boolean).join(" · ");
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "⧉";
    copyBtn.title = "コピー";
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      const txt = wrap.querySelector(".msg-body").innerText || "";
      copyText(txt).then(() => toast("コピーしました")).catch(() => toast("コピーに失敗しました", true));
    };
    head.append(badge, meta, copyBtn);
    const body = document.createElement("div");
    body.className = "msg-body";
    wrap.append(head, body);
    return wrap;
  }

  function upsertMessage(info, parts) {
    if (!info || info.sessionID !== current) return;
    const store = partStore();
    let wrap = document.querySelector(`.msg[data-id="${info.id}"]`);
    const isNew = !wrap;
    if (isNew) {
      wrap = messageEl(info);
      if (workingEl) el.messages.insertBefore(wrap, workingEl);
      else el.messages.appendChild(wrap);
      order.push(info.id);
    }
    if (info.error) {
      let errEl = wrap.querySelector(".error-line");
      if (!errEl) {
        errEl = document.createElement("div");
        errEl.className = "error-line";
        wrap.querySelector(".msg-body").appendChild(errEl);
      }
      errEl.textContent = (info.error.data && info.error.data.message) || info.error.message || "error";
    }
    if (parts) {
      for (const p of parts) upsertPart(p, wrap, store);
    }
    if (isNew) scrollBottom();
  }

  function upsertPart(part, wrap, store) {
    if (!part) return;
    const body = wrap ? wrap.querySelector(".msg-body") : document.querySelector(`.msg[data-id="${part.messageID}"] .msg-body`);
    if (!body) return;
    store = store || partStore();
    let entry = store.get(part.id);
    if (entry) {
      entry.update(part);
      return;
    }
    const maker = partMaker(part, wrap);
    if (!maker) return;
    body.appendChild(maker.el);
    store.set(part.id, maker);
    scrollBottom();
  }

  function removePart(partID) {
    const store = partStore();
    const entry = store.get(partID);
    if (entry) {
      entry.el.remove();
      store.delete(partID);
    }
  }

  function removeMessage(messageID) {
    const m = document.querySelector(`.msg[data-id="${messageID}"]`);
    if (m) m.remove();
    order = order.filter((x) => x !== messageID);
  }

  function removeTemps() {
    const store = partStore();
    document.querySelectorAll(".msg.temp").forEach((m) => {
      for (const k of Array.from(store.keys())) {
        if (store.get(k).el.closest(".msg.temp")) store.delete(k);
      }
      m.remove();
    });
  }

  function addTempUser(text) {
    const wrap = document.createElement("div");
    wrap.className = "msg user temp";
    const head = document.createElement("div");
    head.className = "msg-role";
    const badge = document.createElement("span");
    badge.className = "role-badge";
    badge.textContent = "you";
    head.appendChild(badge);
    const body = document.createElement("div");
    body.className = "msg-body";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    body.appendChild(bubble);
    wrap.append(head, body);
    el.messages.appendChild(wrap);
    scrollBottom();
  }

  function partMaker(part, wrap) {
    switch (part.type) {
      case "text": {
        const el = document.createElement("div");
        if (wrap && wrap.classList.contains("user")) {
          el.className = "bubble";
        } else {
          el.className = "part-text";
        }
        return { el, update: (p) => { el.textContent = p.text || ""; } };
      }
      case "reasoning": {
        const el = document.createElement("div");
        el.className = "reasoning";
        return { el, update: (p) => { el.textContent = p.text || ""; el.classList.toggle("hidden", !p.text); } };
      }
      case "tool": {
        const el = document.createElement("div");
        el.className = "tool-card";
        const head = document.createElement("div");
        head.className = "tool-head";
        const name = document.createElement("span");
        name.className = "tool-name";
        const title = document.createElement("span");
        title.className = "tool-title";
        const status = document.createElement("span");
        status.className = "tool-status";
        head.append(name, title, status);
        const out = document.createElement("div");
        out.className = "tool-output";
        out.classList.add("hidden");
        el.append(head, out);
        return {
          el,
          update: (p) => {
            const st = p.state || {};
            name.textContent = p.tool || "tool";
            title.textContent = st.title || "";
            status.textContent = st.status || "";
            status.className = "tool-status " + (st.status || "");
            if (st.status === "completed") {
              out.textContent = (st.output || "").slice(0, 2000);
              out.classList.toggle("hidden", !st.output);
            } else if (st.status === "error") {
              out.textContent = st.error || "";
              out.classList.toggle("hidden", !st.error);
            } else {
              out.textContent = "";
              out.classList.add("hidden");
            }
          },
        };
      }
      case "step-start": {
        const el = document.createElement("div");
        el.className = "chip step";
        el.innerHTML = '<span class="dotc"></span>step';
        return { el, update: () => {} };
      }
      case "patch": {
        const el = document.createElement("div");
        el.className = "chip changed";
        el.innerHTML = `<span class="dotc"></span><span class="chip-label"></span>`;
        return {
          el,
          update: (p) => {
            const n = (p.files || []).length;
            el.querySelector(".chip-label").textContent = `${n} file${n === 1 ? "" : "s"} changed`;
            if (p.files && p.files.length) el.title = p.files.join("\n");
          },
        };
      }
      case "file": {
        const el = document.createElement("div");
        el.className = "chip";
        el.innerHTML = '<span class="dotc" style="background:#bc8cff"></span><span class="chip-label"></span>';
        return {
          el,
          update: (p) => {
            const label = p.filename || (p.source && p.source.path) || "file";
            el.querySelector(".chip-label").textContent = "file: " + label;
            if (window.App && p.source && p.source.path) {
              el.style.cursor = "pointer";
              el.onclick = () => App.openFile(p.source.path);
            }
          },
        };
      }
      case "agent": {
        const el = document.createElement("div");
        el.className = "chip";
        el.innerHTML = '<span class="dotc" style="background:#3fb950"></span><span class="chip-label"></span>';
        return { el, update: (p) => { el.querySelector(".chip-label").textContent = "agent: " + p.name; } };
      }
      case "subtask": {
        const el = document.createElement("div");
        el.className = "chip";
        el.innerHTML = '<span class="dotc" style="background:#d29922"></span><span class="chip-label"></span>';
        return { el, update: (p) => { el.querySelector(".chip-label").textContent = "subtask: " + (p.description || p.agent || ""); } };
      }
      case "step-finish": {
        const el = document.createElement("div");
        el.className = "chip";
        el.innerHTML = '<span class="dotc" style="background:#8b949e"></span>step finished';
        return { el, update: () => {} };
      }
      case "compaction":
      case "snapshot":
      case "retry":
        return null;
      default:
        return null;
    }
  }

  function showError(msg) {
    const now = Date.now();
    if (now - lastErr < 500) return;
    lastErr = now;
    const div = document.createElement("div");
    div.className = "error-line";
    div.textContent = String(msg || "error");
    el.messages.appendChild(div);
    scrollBottom();
  }

  function showPermission(perm) {
    if (!perm || !perm.id) return;
    if (renderedPerms.has(perm.id)) return;
    renderedPerms.add(perm.id);
    const wrap = document.createElement("div");
    wrap.className = "permission-card";
    wrap.dataset.perm = perm.id;
    const title = document.createElement("div");
    title.className = "perm-title";
    title.textContent = perm.title || "permission requested";
    const meta = document.createElement("div");
    meta.className = "perm-meta";
    meta.textContent = [perm.type, perm.pattern && (Array.isArray(perm.pattern) ? perm.pattern.join(", ") : perm.pattern)].filter(Boolean).join(" — ");
    const actions = document.createElement("div");
    actions.className = "perm-actions";
    const respond = (response) => {
      API.oc.replyPermission(perm.sessionID, perm.id, response).catch((e) => showError(e.message));
      actions.innerHTML = "";
      const done = document.createElement("span");
      done.className = "chip";
      done.textContent = response;
      actions.appendChild(done);
    };
    const allow = document.createElement("button");
    allow.className = "btn small";
    allow.textContent = "Allow";
    allow.onclick = () => respond("allow");
    const deny = document.createElement("button");
    deny.className = "btn small danger";
    deny.textContent = "Deny";
    deny.onclick = () => respond("deny");
    actions.append(allow, deny);
    wrap.append(title, meta, actions);
    el.messages.appendChild(wrap);
    scrollBottom();
  }

  function sigOf(msgs) {
    const last = msgs[msgs.length - 1] || {};
    let txt = 0;
    let changedFiles = "";
    for (const p of last.parts || []) {
      if (p.type === "text") txt += (p.text || "").length;
      if (p.type === "patch" && p.files) changedFiles = p.files.join(",");
    }
    return (last.info && last.info.id || "") + ":" + msgs.length + ":" + txt + ":" + changedFiles;
  }

  async function loadMessages(id) {
    clearView();
    setBusy(false);
    if (!id) return;
    try {
      const msgs = await API.oc.messages(id, 200);
      if (Array.isArray(msgs)) {
        for (const m of msgs) upsertMessage(m.info, m.parts);
        scrollBottom();
      }
    } catch (e) {
      if (e.status === 404) heal();
      else showError(e.message);
    }
  }

  async function poll() {
    if (!current) {
      heal();
      return;
    }
    pollTick++;
    let wasBusy = busy;
    try {
      const msgs = await API.oc.messages(current, 200);
      if (!Array.isArray(msgs)) return;
      if (msgs.length && msgs[msgs.length - 1].info && msgs[msgs.length - 1].info.role === "user") removeTemps();
      for (const m of msgs) upsertMessage(m.info, m.parts);

      const sig = sigOf(msgs);
      const isBusy = sig !== prevSig;
      prevSig = sig;
      setBusy(isBusy);
      if (wasBusy && !isBusy) {
        if (window.App) App.onSessionIdle();
        const first = document.querySelector(".msg");
        if (first && first.classList.contains("temp")) removeTemps();
      }
    } catch (e) {
      if (e.status === 404) heal();
      else if (busy) setBusy(false);
    }

    if (pollTick % 6 === 0) refreshSessions();

    try {
      const perms = await API.oc.pendingPermissions();
      const seen = new Set();
      if (Array.isArray(perms)) {
        for (const p of perms) {
          seen.add(p.id);
          if (p.id && p.sessionID === current) showPermission(p);
        }
      }
      for (const id of Array.from(renderedPerms)) {
        if (!seen.has(id)) {
          renderedPerms.delete(id);
          const card = document.querySelector(`.permission-card[data-perm="${id}"]`);
          if (card) card.remove();
        }
      }
    } catch (e) {
      /* noop */
    }
  }

  async function loadSelectors() {
    try {
      const agents = await API.oc.agents();
      for (const a of agents) {
        const opt = document.createElement("option");
        opt.value = a.name;
        opt.textContent = a.name + (a.description ? " — " + a.description : "");
        el.agentSel.appendChild(opt);
      }
    } catch (e) {
      console.error(e);
    }
    try {
      const data = await API.oc.providers();
      const connected = new Set(data.connected || []);
      const list = (data.all || []).filter((pr) => connected.has(pr.id));
      for (const pr of list) {
        const optg = document.createElement("optgroup");
        optg.label = pr.id;
        for (const [mid, m] of Object.entries(pr.models || {})) {
          const opt = document.createElement("option");
          opt.value = `${pr.id}/${mid}`;
          opt.textContent = m.name || mid;
          optg.appendChild(opt);
        }
        el.modelSel.appendChild(optg);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function send() {
    const text = el.input.value.trim();
    if (!text) return;
    const id = await ensureSession();
    const opts = {};
    if (el.agentSel.value) opts.agent = el.agentSel.value;
    if (el.modelSel.value) opts.model = el.modelSel.value;
    addTempUser(text);
    el.input.value = "";
    el.input.style.height = "auto";
    setBusy(true);
    try {
      await API.oc.send(id, [{ type: "text", text }], opts);
    } catch (e) {
      showError(e.message);
      setBusy(false);
    }
  }

  async function stop() {
    if (!current) return;
    try {
      await API.oc.abort(current);
    } catch (e) {
      showError(e.message);
    }
  }

  function wire() {
    el.sendBtn.onclick = send;
    el.stopBtn.onclick = stop;
    el.newBtn.onclick = newSession;
    el.delBtn.onclick = deleteSession;
    el.sessionSel.onchange = async () => {
      current = el.sessionSel.value || null;
      await loadMessages(current);
    };
    if (el.dirLabel) {
      el.dirLabel.onclick = async () => {
        const input = prompt("チャットのワークスペース（絶対パス）", directory || "/");
        if (input && input.trim()) await setDirectory(input.trim());
      };
    }
    el.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        send();
      }
    });
    el.input.addEventListener("input", () => {
      el.input.style.height = "auto";
      el.input.style.height = Math.min(el.input.scrollHeight, 160) + "px";
    });
  }

  async function init() {
    wire();
    try {
      const st = await API.status();
      directory = (st.workspace || "/").replace(/\/+$/, "") || "/";
    } catch (e) {
      directory = "/";
    }
    API.oc.setDirectory(directory);
    if (el.dirLabel) {
      el.dirLabel.textContent = directory;
      el.dirLabel.title = "チャットのワークスペース（クリックで変更）: " + directory;
    }
    try {
      await loadSelectors();
      await refreshSessions();
      if (!current) {
        const s = await API.oc.createSession("new session");
        current = s.id;
        await refreshSessions(s.id);
      }
      await loadMessages(current);
      setStatus(true);
    } catch (e) {
      setStatus(false);
      showError(e.message);
    }
    pollTimer = setInterval(() => {
      poll();
    }, 1000);
    poll();
  }

  return { init, setDirectory, onFileChanged: (f) => {}, openFile: (p) => {} };
})();
