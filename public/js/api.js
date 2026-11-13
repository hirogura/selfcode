const API = (() => {
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
      if (data && data.needForce) err.needForce = true;
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
    update: (force) => API.post("/api/update", { force: !!force }, undefined, 960000),

    github: {
      status: () => API.get("/api/github/status"),
      saveSettings: (username, token) => API.put("/api/github/settings", { username, token }),
      setActive: (index) => API.post("/api/github/settings/active", { index }),
      clearSettings: () => API.del("/api/github/settings"),
      user: () => API.get("/api/github/user"),
      myRepos: () => API.get("/api/github/repos"),
      registered: () => API.get("/api/github/repos/registered"),
      add: (url, dir) => API.post("/api/github/repos", { url, dir }),
      addExisting: (p, init) => API.post("/api/github/repos/existing", { path: p, init: !!init }),
      action: (id, action, message) => API.post("/api/github/repos/" + encodeURIComponent(id) + "/action", { action, message }),
      branch: (id, branch) => API.post("/api/github/repos/" + encodeURIComponent(id) + "/action", { action: "branch", branch }),
      cleanupBranches: (id, preview) => API.post("/api/github/repos/" + encodeURIComponent(id) + "/action", { action: "cleanup", preview: !!preview }),
      createGitignore: (id) => API.post("/api/github/repos/" + encodeURIComponent(id) + "/gitignore"),
      createAgentsMd: (id) => API.post("/api/github/repos/" + encodeURIComponent(id) + "/agents-md"),
      templates: () => API.get("/api/github/templates"),
      saveTemplates: (gitignore, agentsMd) => API.put("/api/github/templates", { gitignore, agentsMd }),
      resetTemplates: () => API.post("/api/github/templates/reset", {}),
      addRemote: (id, url, branch, forceSync) => API.post("/api/github/repos/" + encodeURIComponent(id) + "/remote", { url, branch, forceSync: forceSync || null }),
      firstPush: (id, url, branch) => API.post("/api/github/repos/" + encodeURIComponent(id) + "/first-push", { url, branch }),
      remove: (id) => API.del("/api/github/repos/" + encodeURIComponent(id)),
      gitConfig: () => API.get("/api/github/git-config"),
      gitConfigList: () => API.get("/api/github/git-config/list"),
      saveGitConfig: (name, email) => API.put("/api/github/git-config", { name, email }),
      applyGitConfigAll: (name, email) => API.post("/api/github/git-config/apply-all", { name, email }),
    },
  };
})();
