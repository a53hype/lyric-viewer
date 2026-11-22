// Carries the page's state to the extension's background worker, and the viewer's commands back to the page.
const SOURCE = "lyric-viewer-ytm";
window.addEventListener("message", (event) => {
  const d = event.data;
  if (event.source !== window || d?.source !== SOURCE || d.type !== "state") return;
  try {
    chrome.runtime.sendMessage({ state: d.state }, (reply) => {
      void chrome.runtime.lastError;
      for (const cmd of reply?.cmds ?? []) window.postMessage({ source: SOURCE, type: "cmd", action: cmd.action, arg: cmd.arg }, location.origin);
    });
  } catch {
    // The extension was reloaded: this page's copy of the script is orphaned until the tab is refreshed.
  }
});
