/** welcome.js - first-run guide. Polls the state every 1.5 s and lets you control the bridge. */
const $ = (selector) => document.querySelector(selector);
let busy = false;
let latest = null;

/** The OS decides which install steps and commands are shown (Windows vs Linux/macOS). */
const OS = /windows/i.test(navigator.userAgentData?.platform ?? '') || /Windows/.test(navigator.userAgent) ? 'win'
  : /mac/i.test(navigator.userAgentData?.platform ?? '') || /Macintosh|Mac OS X/.test(navigator.userAgent) ? 'mac'
  : 'linux';

function personalize() {
  document.body.dataset.os = OS;
  for (const el of document.querySelectorAll('.os-win')) el.hidden = OS !== 'win';
  for (const el of document.querySelectorAll('.os-unix')) el.hidden = OS === 'win';
  $('#cmd-text').textContent = OS === 'win' ? 'python server\\install_service.py' : 'python3 server/install_service.py';
}
personalize();

async function send(type) {
  try { return (await chrome.runtime.sendMessage({ type })) ?? { ok: false, error: 'No response from the extension.' }; }
  catch (err) { return { ok: false, error: err.message }; }
}

function showMessage(text) {
  const el = $('#bridge-msg');
  el.hidden = !text;
  el.textContent = text ?? '';
}

function render(state) {
  const b = state.bridge ?? {};
  const servers = state.servers ?? [];
  const launcher = Boolean(b.launcherOnline);

  $('#step-launcher').dataset.state = launcher ? 'done' : 'current';
  $('#launcher-status').textContent = launcher ? 'Launcher active \u2713' : 'Not detected yet';
  $('#launcher-help').hidden = launcher;

  $('#step-bridge').dataset.state = !launcher ? 'pending' : (b.online ? 'done' : 'current');
  $('#bridge-status').textContent = !b.checked ? 'Checking\u2026' : (b.online ? 'Bridge connected \u2713' : (b.paused ? 'Off on purpose' : 'Off'));
  $('#btn-start').disabled = busy || !launcher || Boolean(b.online);
  $('#btn-restart').disabled = busy || !launcher || !b.online;
  $('#btn-stop').disabled = busy || !launcher || !b.online;

  const list = $('#server-list');
  list.replaceChildren(...servers.map((s) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = s.name;
    const tag = document.createElement('span');
    tag.className = 'tag' + (s.status === 'connected' ? ' on' : '');
    tag.textContent = s.status === 'connected' ? 'connected' : (s.enabled ? 'active' : 'disabled');
    li.append(name, tag);
    return li;
  }));
  const hasServers = b.online && servers.length > 0;
  $('#step-servers').dataset.state = !b.online ? 'pending' : (hasServers ? 'done' : 'current');
  $('#servers-status').textContent = !b.online ? '' : (hasServers ? `${servers.length} detected \u2713` : 'None yet');
  $('#btn-config').disabled = !b.online;
  $('#step-ready').dataset.state = hasServers ? 'current' : 'pending';
}

async function refresh() {
  const state = await send('GET_STATE');
  if (state?.ok === false) return;
  await send('PROBE_BRIDGE'); // also refreshes the launcher state
  latest = await send('GET_STATE');
  render(latest);
}

async function run(type, okText) {
  if (busy) return;
  busy = true;
  showMessage('One moment\u2026');
  if (latest) render(latest);
  const res = await send(type);
  busy = false;
  showMessage(res.ok ? okText : (res.error ?? 'The action could not be completed.'));
  await refresh();
}

$('#btn-start').addEventListener('click', () => run('START_BRIDGE', 'Bridge started.'));
$('#btn-restart').addEventListener('click', () => run('RESTART_BRIDGE', 'Bridge restarted.'));
$('#btn-stop').addEventListener('click', () => run('STOP_BRIDGE', 'Bridge stopped.'));
$('#btn-config').addEventListener('click', async () => {
  const res = await send('OPEN_CONFIG');
  showMessage(res.ok ? 'Opening servers.json\u2026 save the file and the bridge reloads it on its own.' : (res.error ?? 'The file could not be opened.'));
});
$('#copy-cmd').addEventListener('click', async (event) => {
  try { await navigator.clipboard.writeText($('#cmd-text').textContent); event.currentTarget.textContent = 'Copied ✓'; }
  catch { event.currentTarget.textContent = 'Select it and copy it manually'; }
});

// ───────────── Step 4: the installable rules, shown and copyable right here ─────────────
// The text is the ONE generated source (instructions/instructions.txt, from `npm run instructions`): the
// page ships it and reads it, so what the user copies can never drift from what the extension expects.
let instructionsText = '';

async function loadInstructions() {
  const pre = $('#instructions-text');
  const copy = $('#copy-instructions');
  try {
    const res = await fetch(chrome.runtime.getURL('instructions/instructions.txt'));
    if (!res.ok) throw new Error(res.status);
    instructionsText = await res.text();
    pre.textContent = instructionsText;
    copy.disabled = false;
  } catch {
    pre.textContent = 'The instructions file could not be read here. Find it in the project folder: instructions/instructions.txt';
    copy.hidden = true;
  }
}

$('#copy-instructions').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(instructionsText);
    button.textContent = 'Copied ✓';
  } catch {
    // The clipboard API can be blocked: select the whole text so a manual Ctrl+C is one keystroke away.
    const range = document.createRange();
    range.selectNodeContents($('#instructions-text'));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    button.textContent = 'Selected — press Ctrl+C';
  }
  setTimeout(() => { button.textContent = 'Copy the instructions'; }, 2400);
});

loadInstructions();
refresh();
setInterval(refresh, 1500);