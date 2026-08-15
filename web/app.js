/* dsh-gal frontend: visual-novel presentation of a dsh session.
 * Talks to the plugin server: GET /manifest.json, GET /events (SSE), POST /send.
 */
(() => {
  const qs = new URLSearchParams(location.search);
  const token = qs.get('token') ?? '';
  const withToken = (path) => token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path;

  const $ = (id) => document.getElementById(id);
  const layerA = $('layer-a'), layerB = $('layer-b'), layerImg = $('layer-img');
  const dialogueText = $('dialogue-text');
  const advance = $('advance');
  const ticker = $('ticker'), tickerText = $('ticker-text');
  const historyEl = $('history'), historyList = $('history-list');
  const input = $('input'), btnSend = $('btn-send');
  const emotionTag = $('emotion-tag');

  let manifest = { characterName: 'Cetus', defaultEmotion: 'neutral', emotions: {} };
  let currentEmotion = '';
  let activeLayer = null; // which video layer is showing
  let busy = false;
  let autoMode = false;

  // ---------- character emotion layers ----------
  function setEmotion(name) {
    const emo = manifest.emotions[name] ? name : manifest.defaultEmotion;
    if (emo === currentEmotion) return;
    currentEmotion = emo;
    emotionTag.textContent = emo;
    const asset = manifest.emotions[emo];
    if (!asset) return;
    if (asset.video) {
      const next = activeLayer === layerA ? layerB : layerA;
      next.src = withToken(asset.video);
      next.play().catch(() => {});
      next.classList.add('visible');
      if (activeLayer) activeLayer.classList.remove('visible');
      layerImg.classList.remove('visible');
      activeLayer = next;
    } else if (asset.image) {
      layerImg.src = withToken(asset.image);
      layerImg.classList.add('visible');
      if (activeLayer) { activeLayer.classList.remove('visible'); activeLayer = null; }
    }
  }

  // ---------- typewriter with galgame paging ----------
  const msgQueue = [];   // pending assistant messages
  let typing = false;    // currently animating a page
  let pageRest = '';     // text not yet shown (later pages)
  let waitingAdvance = false;
  let typeTimer = null;
  let autoTimer = null;

  function overflowing() {
    const win = $('text-window');
    return win.scrollHeight > win.clientHeight + 2;
  }

  function beginMessage(text) {
    pageRest = text;
    nextPage();
  }

  function nextPage() {
    waitingAdvance = false;
    advance.classList.add('hidden');
    dialogueText.textContent = '';
    typePage();
  }

  function typePage() {
    typing = true;
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    const step = () => {
      if (!typing) return;
      if (pageRest.length === 0) { finishPage(cursor, false); return; }
      const ch = pageRest[0];
      dialogueText.textContent += ch;
      pageRest = pageRest.slice(1);
      dialogueText.appendChild(cursor);
      if (overflowing()) {
        // took one character too many for this page — give it back and hold
        dialogueText.removeChild(cursor);
        dialogueText.textContent = dialogueText.textContent.slice(0, -1);
        pageRest = ch + pageRest;
        finishPage(cursor, true);
        return;
      }
      typeTimer = setTimeout(step, ch === '\n' ? 90 : 18);
    };
    step();
  }

  function finishPage(cursor, more) {
    typing = false;
    clearTimeout(typeTimer);
    cursor.remove();
    if (more || msgQueue.length > 0) {
      waitingAdvance = true;
      advance.classList.remove('hidden');
      if (autoMode) autoTimer = setTimeout(advanceNow, 2400);
    }
  }

  function revealRestOfPage() {
    // fast-forward: fill until the window is full (or text ends)
    clearTimeout(typeTimer);
    while (pageRest.length > 0) {
      const ch = pageRest[0];
      dialogueText.textContent += ch;
      pageRest = pageRest.slice(1);
      if (overflowing()) {
        dialogueText.textContent = dialogueText.textContent.slice(0, -1);
        pageRest = ch + pageRest;
        break;
      }
    }
    typing = false;
    finishPage(document.createElement('span'), pageRest.length > 0);
  }

  function advanceNow() {
    clearTimeout(autoTimer);
    if (typing) { revealRestOfPage(); return; }
    if (!waitingAdvance) return;
    if (pageRest.length > 0) { nextPage(); return; }
    waitingAdvance = false;
    advance.classList.add('hidden');
    playNext();
  }

  function playNext() {
    if (typing || waitingAdvance) return;
    const next = msgQueue.shift();
    if (next === undefined) return;
    if (next.emotion) setEmotion(next.emotion);
    beginMessage(next.text);
  }

  $('text-window').addEventListener('click', advanceNow);
  document.addEventListener('keydown', (ev) => {
    if (ev.target === input) return;
    if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); advanceNow(); }
    if (ev.key === 'l' || ev.key === 'L') toggleHistory();
    if (ev.key === 'a' || ev.key === 'A') toggleAuto();
  });

  // ---------- history ----------
  const history = []; // {role, text}
  function pushHistory(role, text) {
    history.push({ role, text });
    const entry = document.createElement('div');
    entry.className = `h-entry ${role}`;
    const roleEl = document.createElement('div');
    roleEl.className = 'h-role';
    roleEl.textContent = role === 'user' ? 'You' : role === 'assistant' ? manifest.characterName : 'Action';
    const textEl = document.createElement('div');
    textEl.className = 'h-text';
    textEl.textContent = text;
    entry.append(roleEl, textEl);
    historyList.appendChild(entry);
  }
  function toggleHistory() {
    historyEl.classList.toggle('hidden');
    if (!historyEl.classList.contains('hidden')) historyList.scrollTop = historyList.scrollHeight;
  }
  $('btn-history').addEventListener('click', toggleHistory);
  $('btn-close-history').addEventListener('click', toggleHistory);

  function toggleAuto() {
    autoMode = !autoMode;
    $('btn-auto').classList.toggle('active', autoMode);
    if (autoMode && waitingAdvance) autoTimer = setTimeout(advanceNow, 1200);
  }
  $('btn-auto').addEventListener('click', toggleAuto);

  // ---------- busy / ticker ----------
  function setBusy(value) {
    busy = value;
    btnSend.disabled = value;
    if (value) {
      setEmotion('thinking');
      ticker.classList.remove('hidden');
      if (tickerText.textContent === '') tickerText.textContent = 'thinking…';
    } else {
      ticker.classList.add('hidden');
      tickerText.textContent = '';
    }
  }

  // ---------- input ----------
  $('input-row').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (text === '' || busy) return;
    input.value = '';
    try {
      const res = await fetch(withToken('/send'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      msgQueue.push({ text: `(failed to send: ${err.message})`, emotion: 'sad' });
      playNext();
    }
  });

  // ---------- event stream ----------
  function handleEvent(ev) {
    switch (ev.type) {
      case 'user':
        pushHistory('user', ev.text);
        $('last-user').classList.remove('hidden');
        $('last-user-text').textContent = ev.text;
        setBusy(true);
        break;
      case 'status':
        tickerText.textContent = ev.text;
        ticker.classList.remove('hidden');
        break;
      case 'assistant':
        pushHistory('assistant', ev.text);
        setBusy(false);
        // live conversation favors freshness: unshown backlog yields to the
        // newest reply (everything stays readable in History)
        msgQueue.length = 0;
        msgQueue.push({ text: ev.text, emotion: ev.emotion });
        if (waitingAdvance && pageRest.length === 0) advanceNow();
        else playNext();
        break;
      case 'busy':
        setBusy(ev.value);
        break;
      case 'emotion':
        setEmotion(ev.emotion);
        break;
      case 'snapshot':
        for (const entry of ev.entries) pushHistory(entry.role, entry.text);
        if (ev.entries.length > 0) {
          const last = ev.entries[ev.entries.length - 1];
          if (last.role === 'assistant') { msgQueue.push({ text: last.text, emotion: ev.emotion }); playNext(); }
        }
        break;
    }
  }

  function connect() {
    const source = new EventSource(withToken('/events'));
    source.onopen = () => $('conn-dot').classList.add('on');
    source.onerror = () => $('conn-dot').classList.remove('on');
    source.onmessage = (msg) => {
      try { handleEvent(JSON.parse(msg.data)); } catch { /* ignore malformed frames */ }
    };
  }

  // ---------- boot ----------
  fetch(withToken('/manifest.json'))
    .then((res) => res.json())
    .then((m) => {
      manifest = m;
      $('char-name').textContent = m.characterName;
      setEmotion(m.defaultEmotion);
      connect();
      const greeting = m.greeting ?? 'Hello! I am listening — say something below.';
      msgQueue.push({ text: greeting, emotion: m.defaultEmotion });
      playNext();
    })
    .catch(() => {
      dialogueText.textContent = 'Failed to load manifest — is the dsh-gal plugin running?';
    });
})();
