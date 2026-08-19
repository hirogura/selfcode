const API = (() => {
  let ocDir = "";
  const ocHeaders = () => (ocDir ? { "x-opencode-directory": ocDir } : {});

  async function req(method, url, body, extraHeaders, timeoutMs) {
    const opts = { method, headers: { ...(extraHeaders || {}) } };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    if (timeoutMs) {
      const ctrl = new AbortController();
      opts.signal = ctrl.signal;
      setTimeout(() => ctrl.abort(), timeoutMs);
    }
    const res = await fetch(url, opts);
    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg =
        (data && data.error) ||
        (data && data.data && data.data.message) ||
        `${res.status} ${res.statusText}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    get: (url, headers, timeoutMs) => req("GET", url, undefined, headers, timeoutMs),
    put: (url, body, headers, timeoutMs) => req("PUT", url, body, headers, timeoutMs),
    post: (url, body, headers, timeoutMs) => req("POST", url, body, headers, timeoutMs),
    del: (url, headers, timeoutMs) => req("DELETE", url, undefined, headers, timeoutMs),

    async status() {
      return this.get("/api/status");
    },
    async tree(path, hidden) {
      const q = new URLSearchParams();
      if (path) q.set("path", path);
      if (hidden) q.set("hidden", "1");
      return this.get("/api/tree?" + q.toString());
    },
    async readFile(path) {
      return this.get("/api/file?path=" + encodeURIComponent(path));
    },
    async writeFile(path, content, base64) {
      return this.put("/api/file", { path, content, base64 });
    },
    // ファイルを指定フォルダへアップロードする（raw body をそのまま送る）
    async upload(dirPath, name, blob) {
      const q = new URLSearchParams();
      if (dirPath) q.set("dir", dirPath);
      q.set("name", name);
      const res = await fetch("/api/file/upload?" + q.toString(), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: blob,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!res.ok) {
        const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
        err.status = res.status;
        throw err;
      }
      return data;
    },
    async mkdir(path) {
      return this.post("/api/file/mkdir", { path });
    },
    async rename(from, to) {
      return this.post("/api/file/rename", { from, to });
    },
    async remove(path) {
      return this.del("/api/file?path=" + encodeURIComponent(path));
    },

    memo: {
      get: () => API.get("/api/memo"),
      put: (content) => API.put("/api/memo", { content }),
    },
    restart: () => API.post("/api/restart", {}, undefined, 5000),

    github: {
      status: () => API.get("/api/github/status"),
      saveSettings: (username, token) => API.put("/api/github/settings", { username, token }),
      clearSettings: () => API.del("/api/github/settings"),
      user: () => API.get("/api/github/user"),
      myRepos: () => API.get("/api/github/repos"),
      registered: () => API.get("/api/github/repos/registered"),
      add: (url, dir) => API.post("/api/github/repos", { url, dir }),
      addExisting: (p, init) => API.post("/api/github/repos/existing", { path: p, init: !!init }),
      action: (id, action, message) => API.post("/api/github/repos/" + encodeURIComponent(id) + "/action", { action, message }),
      addRemote: (id, url, branch) => API.post("/api/github/repos/" + encodeURIComponent(id) + "/remote", { url, branch }),
      remove: (id) => API.del("/api/github/repos/" + encodeURIComponent(id)),
    },

    oc: {
      get: (p) => API.get("/opencode" + p, ocHeaders()),
      post: (p, body) => API.post("/opencode" + p, body, ocHeaders()),
      del: (p) => API.del("/opencode" + p, ocHeaders()),
      patch: (p, body) => req("PATCH", "/opencode" + p, body, ocHeaders()),
      stop: () => API.post("/api/opencode/stop"),
      setDirectory: (d) => {
        ocDir = (d || "").trim().replace(/\/+$/, "") || "/";
      },
      async messages(id, limit) {
        return req("GET", "/opencode/session/" + encodeURIComponent(id) + "/message?limit=" + (limit || 200), undefined, ocHeaders(), 20000);
      },

      async health() {
        return this.get("/global/health");
      },
      async sessions() {
        return this.get("/session");
      },
      async createSession(title) {
        return this.post("/session", { title: title || "new session" });
      },
      async deleteSession(id) {
        return this.del("/session/" + encodeURIComponent(id));
      },
      async send(id, parts, opts) {
        const body = { parts, ...(opts || {}) };
        return this.post("/session/" + encodeURIComponent(id) + "/prompt_async", body);
      },
      async abort(id) {
        return this.post("/session/" + encodeURIComponent(id) + "/abort", {});
      },
      async replyPermission(sessionID, permissionID, response, remember) {
        return this.post(`/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`, {
          response,
          remember: !!remember,
        });
      },
      async agents() {
        return this.get("/agent");
      },
      async providers() {
        return this.get("/provider");
      },
      async pendingPermissions() {
        return this.get("/permission");
      },
      // opencode の question ツール（AI からの選択肢つき質問）
      async questions() {
        return this.get("/question");
      },
      async replyQuestion(requestID, answers) {
        return this.post("/question/" + encodeURIComponent(requestID) + "/reply", { answers });
      },
      async rejectQuestion(requestID) {
        return this.post("/question/" + encodeURIComponent(requestID) + "/reject", {});
      },
    },
  };
})();
