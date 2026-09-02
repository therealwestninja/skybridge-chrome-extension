// Backend that wraps the Rook extension's `rook-model` Port as a generate() call. `connect` is
// injectable (defaults to chrome.runtime.connect) so this is unit-testable outside the extension.
export function makeWorkerPortBackend({ connect, portName = "rook-model", timeoutMs = 30000 } = {}) {
  const doConnect = connect ||
    ((typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.connect)
      ? () => chrome.runtime.connect({ name: portName })
      : null);
  return {
    name: "worker-port",
    generate({ system, messages, options } = {}) {
      if (!doConnect) return Promise.reject(new Error("worker-port: chrome.runtime unavailable"));
      const port = doConnect();
      const msgs = [...(system ? [{ role: "system", content: system }] : []), ...(messages || [])];
      const onToken = options && options.onToken;
      return new Promise((resolve, reject) => {
        let text = "";
        let done = false;
        const timer = timeoutMs ? setTimeout(() => finish(() => reject(new Error("worker-port: timeout"))), timeoutMs) : null;
        function finish(act) { if (done) return; done = true; if (timer) clearTimeout(timer); try { port.disconnect(); } catch (e) {} act(); }
        port.onMessage.addListener((m) => {
          if (!m || done) return;
          if (m.type === "token") { text += (m.t || ""); if (onToken) onToken(m.t || ""); }
          else if (m.type === "done") { finish(() => resolve(m.text != null ? m.text : text)); }
          else if (m.type === "error") { finish(() => reject(new Error(m.error || "worker-port error"))); }
        });
        if (port.onDisconnect && port.onDisconnect.addListener) {
          port.onDisconnect.addListener(() => finish(() => reject(new Error("worker-port: disconnected"))));
        }
        port.postMessage({ type: "chat", messages: msgs, stream: !!onToken });
      });
    },
  };
}
