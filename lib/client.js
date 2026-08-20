/**
 * provider-proxy — browser half (module-loader bundle, served at
 * /plugins/provider-proxy/client.js).
 *
 * Adds a "Provider Proxy" page to the dsh Settings dialog. The page edits the
 * `provider-proxy` settings namespace and stores it in the normal dsh settings
 * document (~/.dsh/settings.yaml), so the host half can route only the
 * selected provider hosts through an HTTP(S) proxy.
 */
window.__ModuleLoader__.load({
  id: "provider-proxy",
  factory: function (require) {
    const React = require("react");
    const { useState, useEffect, useCallback, useSyncExternalStore } = React;

    const NS = "provider-proxy";
    const name = "provider-proxy";
    // Uses the raw connection RPCs (like the built-in General settings page)
    // instead of the settingsScope service: that service is deliberately
    // memory-only for non-loopback pages (https front), which would make this
    // section permanently "unavailable" there.
    const inject = ["slots", "connection", "remote"];

    const CSS = [
      `[data-provider-proxy]{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}`,
      `[data-provider-proxy] h2{font-size:16px;font-weight:500;margin:0}`,
      `[data-provider-proxy] p{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}`,
      `[data-provider-proxy] .row{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}`,
      `[data-provider-proxy] .row-head{display:flex;align-items:center;gap:8px}`,
      `[data-provider-proxy] input[type=text]{box-sizing:border-box;width:100%;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font-size:13px}`,
      `[data-provider-proxy] input[type=text]:focus{border-color:var(--dsw-alias-brand-primary);outline:none}`,
      `[data-provider-proxy] label{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)}`,
      `[data-provider-proxy] .actions{display:flex;gap:8px;justify-content:flex-end}`,
      `[data-provider-proxy] button{height:32px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);padding:0 14px;font-size:13px;cursor:pointer}`,
      `[data-provider-proxy] button.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none}`,
      `[data-provider-proxy] button.danger{color:var(--dsw-alias-state-error-primary)}`,
      `[data-provider-proxy] .saved{color:var(--dsw-alias-state-success-primary);font-size:12px}`,
      `[data-provider-proxy] .hint{color:var(--dsw-alias-label-tertiary);font-size:12px}`
    ].join("\n");

    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"provider-proxy/settings.css\"]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = name;
      tag.dataset.pluginCss = "provider-proxy/settings.css";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * Minimal settings-namespace scope talking straight to the host RPCs
     * (settings.describe / settings.mutate). Mirrors the shape consumed by the
     * section — status/value/base/user/revision/writable plus subscribe,
     * getSnapshot, load and set — but unlike ctx.settingsScope.bind it is NOT
     * gated on the page being loopback, so the page works from the HTTPS front
     * as well as from http://127.0.0.1:3080. A failed read keeps the current
     * status (callers retry via load()).
     */
    function createSettingsScope(api) {
      const listeners = new Set();
      let state = {
        status: "loading",
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: "host",
      };
      let readGeneration = 0;
      let disposed = false;

      const getSnapshot = () => state;
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const notify = () => {
        for (const listener of [...listeners]) {
          try { listener(); } catch { /* listener errors are isolated */ }
        }
      };

      function adopt(view, writable) {
        state = {
          status: "ready",
          value: view.value,
          base: view.base,
          user: view.user,
          revision: view.revision,
          writable: writable === undefined ? state.writable : writable,
          mode: "host",
        };
        notify();
      }

      async function read(generation) {
        let response;
        try {
          response = await api.settings.describe({});
        } catch {
          return; // transient failure: keep current status; retry via load()
        }
        if (!response.result.ok || disposed || generation !== readGeneration) return;
        const { namespaces, writable } = response.result.value;
        const view = namespaces.find((candidate) => candidate.ns === NS);
        if (view === undefined) {
          state = { ...state, status: "unavailable", writable };
          notify();
          return;
        }
        adopt(view, writable);
      }

      function load() {
        const generation = ++readGeneration;
        return read(generation);
      }

      async function write(ops) {
        readGeneration += 1;
        const revision = state.revision;
        let response;
        try {
          response = await api.settings.mutate({
            ns: NS,
            ops,
            ...(revision === undefined ? {} : { expectedRevision: revision }),
          });
        } catch {
          await load();
          return;
        }
        if (!response.result.ok) {
          await load();
          return;
        }
        const view = response.result.value;
        if (view && typeof view === "object" && view.ns === NS) adopt(view);
        await load();
      }

      return {
        subscribe,
        getSnapshot,
        load,
        set: (field, value) => write([{ op: "set", path: [field], value }]),
        unset: (field) => write([{ op: "unset", path: [field] }]),
      };
    }

    function ProviderProxySection(props) {
      const { scope } = props;
      // Bind the scope methods: they are class methods, and React invokes the
      // subscribe/getSnapshot callbacks without a receiver, so passing them
      // raw would throw `this.store is undefined` and crash the section.
      const snapshot = useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot()
      );
      const [draft, setDraft] = useState(null);
      const [saved, setSaved] = useState(false);
      const [retryTick, setRetryTick] = useState(0);

      // The scope's initial read is fire-and-forget: a single transient RPC
      // failure is swallowed inside the controller and leaves the snapshot at
      // "loading" forever (the dialog would show "Loading…" indefinitely).
      // Re-drive scope.load() on a timer while still loading so the section
      // self-heals instead of hanging.
      useEffect(() => {
        if (snapshot.status === "loading") {
          const timer = setTimeout(() => {
            scope.load();
            setRetryTick((tick) => tick + 1);
          }, 1200);
          return () => clearTimeout(timer);
        }
      }, [snapshot.status, scope, retryTick]);

      useEffect(() => {
        if (snapshot.status === "ready") {
          setDraft(JSON.parse(JSON.stringify(snapshot.value?.providers ?? {})));
          setSaved(false);
        }
      }, [snapshot.status, snapshot.value]);

      const update = useCallback((provider, patch) => {
        setDraft((current) => {
          const next = { ...current, [provider]: { ...(current[provider] ?? {}), ...patch } };
          return next;
        });
        setSaved(false);
      }, []);

      const remove = useCallback((provider) => {
        setDraft((current) => {
          const next = { ...current };
          delete next[provider];
          return next;
        });
        setSaved(false);
      }, []);

      const add = useCallback(() => {
        setDraft((current) => {
          const base = "new-provider";
          let key = base;
          let i = 1;
          while (current[key] !== undefined) key = `${base}-${i++}`;
          return { ...current, [key]: { enabled: false, proxyUrl: "", hosts: [] } };
        });
        setSaved(false);
      }, []);

      const save = useCallback(async () => {
        if (draft === null || !snapshot.writable) return;
        const providers = {};
        for (const [provider, rule] of Object.entries(draft)) {
          const key = provider.trim();
          if (key.length === 0) continue;
          providers[key] = {
            enabled: Boolean(rule.enabled),
            proxyUrl: (rule.proxyUrl ?? "").trim(),
            hosts: (rule.hosts ?? []).map((host) => host.trim()).filter((host) => host.length > 0),
          };
        }
        await scope.set("providers", providers);
        setSaved(true);
      }, [draft, scope, snapshot.writable]);

      if (snapshot.status === "unavailable") {
        return React.createElement("div", { "data-provider-proxy": "1" },
          React.createElement("h2", null, "Provider Proxy"),
          React.createElement("p", null, "Settings namespace is not available on this connection.")
        );
      }
      if (snapshot.status === "loading" || draft === null) {
        return React.createElement("div", { "data-provider-proxy": "1" },
          React.createElement("h2", null, "Provider Proxy"),
          React.createElement("p", null,
            retryTick > 0 ? "Loading… (settings sync is slow — retrying)" : "Loading…"
          )
        );
      }

      const rows = Object.entries(draft);
      return React.createElement("div", { "data-provider-proxy": "1" },
        React.createElement("h2", null, "Provider Proxy"),
        React.createElement("p", null,
          "Route only the selected provider hosts through an HTTP(S) proxy. ",
          "OpenAI official (api.openai.com) is included as a default rule; enable it and set your proxy URL."
        ),
        rows.length === 0 ? React.createElement("p", null, "No provider rules yet.") : null,
        rows.map(([provider, rule]) => {
          const hostsText = Array.isArray(rule.hosts) ? rule.hosts.join(", ") : "";
          return React.createElement("div", { className: "row", key: provider },
            React.createElement("div", { className: "row-head" },
              React.createElement("label", null,
                React.createElement("input", {
                  type: "checkbox",
                  checked: Boolean(rule.enabled),
                  onChange: (event) => update(provider, { enabled: event.target.checked }),
                }),
                "Enabled"
              ),
              React.createElement("button", {
                type: "button",
                className: "danger",
                onClick: () => remove(provider),
              }, "Remove")
            ),
            React.createElement("label", null, "Provider"),
            React.createElement("input", {
              type: "text",
              value: provider,
              onChange: (event) => {
                const nextKey = event.target.value;
                setDraft((current) => {
                  const next = { ...current };
                  const value = next[provider];
                  delete next[provider];
                  next[nextKey] = value;
                  return next;
                });
              },
            }),
            React.createElement("label", null, "Proxy URL (http:// or https://)"),
            React.createElement("input", {
              type: "text",
              value: rule.proxyUrl ?? "",
              placeholder: "http://127.0.0.1:7890",
              onChange: (event) => update(provider, { proxyUrl: event.target.value }),
            }),
            React.createElement("label", null, "Hosts (comma-separated)"),
            React.createElement("input", {
              type: "text",
              value: hostsText,
              placeholder: "api.openai.com, chatgpt.com",
              onChange: (event) => update(provider, {
                hosts: event.target.value.split(",").map((host) => host.trim()).filter((host) => host.length > 0),
              }),
            }),
            React.createElement("div", { className: "hint" },
              "Only requests to these hosts will use this proxy; all other providers keep using the original fetch."
            )
          );
        }),
        React.createElement("div", { className: "actions" },
          React.createElement("button", { type: "button", onClick: add }, "Add provider"),
          React.createElement("button", { type: "button", className: "primary", onClick: save, disabled: !snapshot.writable }, "Save"),
          saved ? React.createElement("span", { className: "saved" }, "Saved") : null
        )
      );
    }

    function apply(ctx) {
      const connection = ctx.get("connection");
      const scope = createSettingsScope(connection.api);
      const refresh = () => scope.load();
      ctx.effect(() => {
        const disposers = [];
        try {
          const remote = ctx.get("remote");
          disposers.push(remote.$on("settings/document-updated", (namespace) => {
            if (namespace === undefined || namespace === NS) refresh();
          }));
        } catch { /* remote events unavailable; reload on reconnect instead */ }
        disposers.push(ctx.on("connection/reset", refresh));
        refresh();
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, "provider-proxy: settings scope");
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "provider-proxy",
        order: 50,
        label: () => (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("zh") ? "代理设置" : "Provider Proxy"),
        inject: () => ({ scope }),
      }, ProviderProxySection));
    }

    return { name, inject, apply };
  },
});
