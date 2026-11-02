const statusEl = document.getElementById('status');

async function refresh() {
  const { connected, port } = await chrome.runtime.sendMessage({ type: 'status' });
  statusEl.textContent = connected ? `Connected to Claude (port ${port})` : `Not connected (port ${port})`;
  statusEl.className = connected ? 'on' : 'off';
}

document.getElementById('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(refresh, 800);
});

refresh();
