// The only network request this extension makes: the page's state to the Lyric Viewer on this PC. If you changed `port` in the
// viewer's config.json, change it here and in manifest.json too.
const VIEWER = "http://127.0.0.1:3838";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.state) return false;
  fetch(`${VIEWER}/ytm/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message.state),
  })
    .then((res) => (res.ok ? res.json() : { cmds: [] }))
    .then((body) => sendResponse({ cmds: Array.isArray(body?.cmds) ? body.cmds : [] }))
    .catch(() => sendResponse({ cmds: [] }));
  return true;
});
