<script>
/* ── DOWNLOAD GAMES ──
   Talks to /api/games/* (netlify/functions/games.mts). Reuses the page's own
   globals: E (session token), C (is admin), Y (toast). Everything else is
   prefixed gm* so it can't clash with the main script. */
(function () {
  'use strict';
  var MAX_BYTES = 45 * 1024 * 1024;
  var EXT = ['rbxl', 'rbxlx', 'rbxm', 'rbxmx', 'zip', 'rar', '7z'];
  var $ = function (id) { return document.getElementById(id); };
  var baseTitle = document.title;
  var st = { q: '', searchSeq: 0, sugSeq: 0, sugTimer: null, sug: [], active: -1, detail: null, detailId: null, agoTimer: null, busy: false, mode: 'catalog' };

  var ICON_SEARCH = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  var ICON_DL = '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 20h16"/></svg>';

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) {
    n = +n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function bytes(n) { n = +n || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function isAdmin() { try { return C === true; } catch (e) { return false; } }
  function token() { try { return E || ''; } catch (e) { return ''; } }
  function toast(msg, isErr) { try { if (typeof Y === 'function') Y(msg, !!isErr); } catch (e) {} }
  function ago(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return (m <= 1 ? 'a minute' : m + ' minutes') + ' ago';
    var h = Math.floor(m / 60); if (h < 24) return (h === 1 ? 'an hour' : h + ' hours') + ' ago';
    var d = Math.floor(h / 24); if (d < 30) return (d === 1 ? 'yesterday' : d + ' days ago');
    var mo = Math.floor(d / 30); if (mo < 12) return (mo === 1 ? 'a month' : mo + ' months') + ' ago';
    var y = Math.floor(d / 365); return (y <= 1 ? 'a year' : y + ' years') + ' ago';
  }
  function dateStr(ts) { try { return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return new Date(ts).toDateString(); } }

  function api(path, opts) {
    opts = opts || {};
    var h = {};
    if (opts.body) h['Content-Type'] = 'application/json';
    if (opts.auth && token()) h.Authorization = 'Bearer ' + token();
    return fetch('/api/games' + path, { method: opts.method || 'GET', headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) { var er = new Error(d.error || 'Something went wrong'); er.status = r.status; throw er; }
          return d;
        });
      });
  }

  /* ---------- routing (#games, #game/<id>) ---------- */
  function onRoute() {
    var h = location.hash || '';
    var m = h.match(/^#game\/(\d+)/);
    if (m) { openView(); showDetail(m[1]); }
    else if (h === '#games') { openView(); showList(); }
    else { hideView(); }
  }
  function openView() {
    if (!document.body.classList.contains('gm-open')) { document.body.classList.add('gm-open'); window.scrollTo(0, 0); }
  }
  function hideView() {
    document.body.classList.remove('gm-open');
    document.title = baseTitle; stopAgo(); closeSug();
  }
  window.openGames = function () { if (location.hash === '#games') onRoute(); else location.hash = '#games'; };
  window.closeGames = function () {
    if (location.hash) { try { history.pushState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; } }
    hideView(); window.scrollTo(0, 0);
  };
  function goGame(id) { location.hash = '#game/' + id; }
  function goList() { location.hash = '#games'; }

  /* ---------- list / search ---------- */
  function showList() {
    $('gmList').hidden = false; $('gmDetail').hidden = true; $('gmBackHome').hidden = false; stopAgo();
    document.title = baseTitle;
    if (!$('gmResults').children.length) { if (st.q) runSearch(st.q); else loadCatalog(); }
  }

  function skeleton(n) { var s = ''; for (var i = 0; i < n; i++) s += '<div class="gm-skel"></div>'; return s; }

  function cardHtml(g) {
    var has = g.hasFile;
    return '<button type="button" class="gm-card" data-id="' + esc(g.universeId) + '">' +
      (g.icon ? '<img class="gm-card-img" loading="lazy" alt="" src="' + esc(g.icon) + '">' : '<div class="gm-card-img"></div>') +
      '<span class="gm-badge' + (has ? '' : ' off') + '">' + (has ? 'File' : 'No file') + '</span>' +
      '<div class="gm-card-body"><div class="gm-card-name">' + esc(g.name) + '</div>' +
      (g.creator ? '<div class="gm-card-by">by ' + esc(g.creator) + '</div>' : '') +
      '<div class="gm-card-meta">' + (has && g.updatedAt ? 'Updated ' + esc(ago(g.updatedAt)) : (g.playing ? num(g.playing) + ' playing' : '&nbsp;')) + '</div></div></button>';
  }

  function loadCatalog() {
    st.mode = 'catalog'; st.q = '';
    $('gmHint').innerHTML = '';
    $('gmListTitle').textContent = 'Games with files';
    $('gmResults').innerHTML = skeleton(6);
    var seq = ++st.searchSeq;
    api('/catalog').then(function (d) {
      if (seq !== st.searchSeq) return;
      var items = d.items || [];
      $('gmResults').innerHTML = items.length ? items.map(cardHtml).join('') :
        '<div class="gm-empty"><b>No game files yet</b>Use the search above to look up any Roblox game.<br>Games we publish files for will show up here.</div>';
    }).catch(function () {
      if (seq !== st.searchSeq) return;
      $('gmResults').innerHTML = '<div class="gm-empty"><b>Couldn’t load games</b>Check your connection and try again.</div>';
    });
  }

  function runSearch(q) {
    q = (q || '').trim(); st.q = q; closeSug();
    if (!q) { loadCatalog(); return; }
    st.mode = 'search';
    var seq = ++st.searchSeq;
    $('gmHint').innerHTML = '';
    $('gmListTitle').textContent = 'Searching…';
    $('gmResults').innerHTML = skeleton(8);
    api('/search?q=' + encodeURIComponent(q)).then(function (d) {
      if (seq !== st.searchSeq) return;
      renderResults(d, q);
    }).catch(function (e) {
      if (seq !== st.searchSeq) return;
      $('gmListTitle').textContent = '';
      $('gmResults').innerHTML = '<div class="gm-empty"><b>Search failed</b>' + esc(e.message || 'Please try again.') + '</div>';
    });
  }

  function renderResults(d, q) {
    var res = d.results || [];
    $('gmListTitle').textContent = res.length ? res.length + (res.length === 1 ? ' result' : ' results') + ' for “' + q + '”' : '';
    var hint = '';
    if (d.didYouMean) hint += '<span>Did you mean <button type="button" class="gm-link" data-q="' + esc(d.didYouMean) + '">' + esc(d.didYouMean) + '</button>?</span>';
    if (d.suggestions && d.suggestions.length) {
      hint += '<span>Related:</span>' + d.suggestions.map(function (s) { return '<button type="button" class="gm-chip" data-q="' + esc(s) + '">' + esc(s) + '</button>'; }).join('');
    }
    $('gmHint').innerHTML = hint;
    $('gmResults').innerHTML = res.length ? res.map(cardHtml).join('') :
      '<div class="gm-empty"><b>No games found</b>Nothing matched “' + esc(q) + '”.<br>Check the spelling, or paste a Roblox game link / ID.</div>';
  }

  /* ---------- live suggestions ---------- */
  function closeSug() { var b = $('gmSuggest'); if (b) b.classList.remove('open'); var i = $('gmInput'); if (i) i.setAttribute('aria-expanded', 'false'); st.active = -1; }
  function renderSug(d) {
    var items = [];
    (d.queries || []).forEach(function (q) { items.push({ type: 'q', q: q }); });
    (d.games || []).forEach(function (g) { items.push({ type: 'g', g: g }); });
    st.sug = items;
    if (!items.length) { closeSug(); return; }
    var html = '', gi = 0;
    var hasQ = (d.queries || []).length, hasG = (d.games || []).length;
    if (hasQ) html += '<div class="gm-sg-label">Suggestions</div>';
    items.forEach(function (it, i) {
      if (it.type === 'g' && !gi++ && hasG) html += '<div class="gm-sg-label">Games</div>';
      if (it.type === 'q') html += '<button type="button" class="gm-sg-item" role="option" data-i="' + i + '">' + ICON_SEARCH + '<span class="gm-sg-main"><span class="gm-sg-name">' + esc(it.q) + '</span></span></button>';
      else html += '<button type="button" class="gm-sg-item" role="option" data-i="' + i + '">' +
        (it.g.icon ? '<img alt="" src="' + esc(it.g.icon) + '">' : '<span class="gm-sg-ph"></span>') +
        '<span class="gm-sg-main"><span class="gm-sg-name">' + esc(it.g.name) + '</span>' + (it.g.creator ? '<span class="gm-sg-sub">by ' + esc(it.g.creator) + '</span>' : '') + '</span>' +
        (it.g.hasFile ? '<span class="gm-tag">File</span>' : '') + '</button>';
    });
    var box = $('gmSuggest'); box.innerHTML = html; box.classList.add('open');
    $('gmInput').setAttribute('aria-expanded', 'true'); st.active = -1;
  }
  function fetchSug(q) {
    var seq = ++st.sugSeq;
    api('/suggest?q=' + encodeURIComponent(q)).then(function (d) {
      if (seq !== st.sugSeq || $('gmInput').value.trim() !== q) return;
      renderSug(d);
    }).catch(function () { if (seq === st.sugSeq) closeSug(); });
  }
  function pick(i) {
    var it = st.sug[i]; if (!it) return;
    closeSug();
    if (it.type === 'q') { $('gmInput').value = it.q; syncClear(); runSearch(it.q); }
    else goGame(it.g.universeId);
  }
  function moveActive(dir) {
    var nodes = $('gmSuggest').querySelectorAll('.gm-sg-item'); if (!nodes.length) return;
    st.active = (st.active + dir + nodes.length) % nodes.length;
    nodes.forEach(function (n, i) { n.classList.toggle('active', i === st.active); });
    nodes[st.active].scrollIntoView({ block: 'nearest' });
  }
  function syncClear() { $('gmSearch').classList.toggle('has-text', !!$('gmInput').value); }

  /* ---------- game page ---------- */
  function showDetail(id) {
    $('gmList').hidden = true; var box = $('gmDetail'); box.hidden = false; $('gmBackHome').hidden = true; stopAgo();
    st.detailId = id; st.detail = null;
    box.innerHTML = '<button type="button" class="gm-back" onclick="gmBackToList()">‹ Back to games</button><div class="gm-skel" style="aspect-ratio:16/6;margin-bottom:22px"></div><div class="gm-skel" style="aspect-ratio:16/4"></div>';
    window.scrollTo(0, 0);
    api('/' + id).then(function (d) {
      if (st.detailId !== id) return;
      st.detail = d; renderDetail();
    }).catch(function (e) {
      if (st.detailId !== id) return;
      box.innerHTML = '<button type="button" class="gm-back" onclick="gmBackToList()">‹ Back to games</button><div class="gm-empty"><b>' + (e.status === 404 ? 'Game not found' : 'Couldn’t load this game') + '</b>' + esc(e.message || '') + '</div>';
    });
  }
  window.gmBackToList = function () { goList(); };

  function renderDetail() {
    var d = st.detail; if (!d) return;
    var g = d.game, f = d.file, admin = isAdmin();
    var total = (g.up || 0) + (g.down || 0);
    var like = total ? Math.round((g.up / total) * 100) + '%' : '—';
    var rbxUrl = 'https://www.roblox.com/games/' + esc(g.rootPlaceId || g.universeId);
    var stats = '';
    stats += '<div class="gm-stat">Playing<b>' + num(g.playing) + '</b></div>';
    stats += '<div class="gm-stat">Visits<b>' + num(g.visits) + '</b></div>';
    stats += '<div class="gm-stat">Likes<b>' + like + '</b></div>';
    if (g.maxPlayers) stats += '<div class="gm-stat">Max players<b>' + g.maxPlayers + '</b></div>';
    if (g.genre) stats += '<div class="gm-stat">Genre<b>' + esc(g.genre) + '</b></div>';

    var dl = '<button type="button" class="gm-dl-btn" id="gmDl"' + (f ? '' : ' disabled aria-disabled="true"') + '>' + ICON_DL + 'Download</button>';
    if (f) {
      dl += '<div class="gm-updated"><span class="gm-updated-label">Last Updated</span><span class="gm-updated-val" title="' + esc(new Date(f.ts).toLocaleString()) + '">' + esc(dateStr(f.ts)) + '</span><span class="gm-ago" data-ts="' + f.ts + '">· ' + esc(ago(f.ts)) + '</span></div>' +
        '<div class="gm-fileinfo">' + esc(f.origName) + ' · ' + esc(bytes(f.size)) + '</div>';
    } else {
      dl += '<div class="gm-nofile">We do not have this game file</div>';
    }
    if (admin) {
      dl += '<div class="gm-admin-row"><button type="button" class="gm-pub-btn" id="gmPubOpen">Publish file</button>' +
        (f ? '<button type="button" class="gm-rm-btn" id="gmRm">Remove file</button>' : '') + '</div>';
    }

    var long = (g.description || '').length > 260;
    $('gmDetail').innerHTML =
      '<button type="button" class="gm-back" onclick="gmBackToList()">‹ Back to games</button>' +
      (g.banner ? '<img class="gm-banner" alt="" src="' + esc(g.banner) + '">' : '') +
      '<div class="gm-head">' + (g.icon ? '<img class="gm-icon" alt="" src="' + esc(g.icon) + '">' : '') +
      '<div><div class="gm-name">' + esc(g.name) + '</div>' + (g.creator ? '<div class="gm-by">by <b style="color:#ccc">' + esc(g.creator) + '</b>' + (g.creatorVerified ? ' ✓' : '') + '</div>' : '') + '</div></div>' +
      '<div class="gm-chips">' + stats + '</div>' +
      (g.description ? '<div class="gm-desc" id="gmDesc">' + esc(g.description) + '</div>' + (long ? '<button type="button" class="gm-link gm-more" id="gmMore">Show more</button>' : '') : '') +
      '<a class="gm-rbx" href="' + rbxUrl + '" target="_blank" rel="noopener noreferrer">View on Roblox ↗</a>' +
      '<div class="gm-dl-panel">' + dl + '</div>';
    document.title = g.name + ' — Fayple Studios';
    startAgo();
  }

  function startAgo() {
    stopAgo();
    st.agoTimer = setInterval(function () {
      document.querySelectorAll('.gm-ago[data-ts]').forEach(function (el) { el.textContent = '· ' + ago(+el.getAttribute('data-ts')); });
    }, 30000);
  }
  function stopAgo() { if (st.agoTimer) { clearInterval(st.agoTimer); st.agoTimer = null; } }

  function download() {
    var f = st.detail && st.detail.file; if (!f) return;
    var a = document.createElement('a');
    a.href = f.publicUrl; a.download = f.origName; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Download started');
  }

  /* ---------- admin: publish / remove ---------- */
  window.gmOpenPublish = function () {
    if (!isAdmin() || !st.detail) return;
    $('gmPubGame').textContent = st.detail.game.name;
    $('gmFile').value = ''; $('gmPubErr').textContent = '';
    $('gmProg').style.display = 'none'; $('gmProgBar').style.width = '0';
    $('gmPubBtn').disabled = false; $('gmPubBtn').textContent = 'Publish';
    $('gmPublishModal').classList.add('open');
  };

  function putFile(signedUrl, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData();
      fd.append('cacheControl', '3600');
      fd.append('', file);
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', signedUrl);
      try { if (typeof e === 'string' && e && !/^YOUR_/.test(e)) xhr.setRequestHeader('apikey', e); } catch (x) {}
      xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        var msg = 'Upload failed (' + xhr.status + ')';
        try { var j = JSON.parse(xhr.responseText); if (j.message || j.error) msg = (j.message || j.error); } catch (x) {}
        reject(new Error(msg));
      };
      xhr.onerror = function () { reject(new Error('Upload failed — check your connection')); };
      xhr.send(fd);
    });
  }

  window.gmPublish = function () {
    if (st.busy || !isAdmin() || !st.detail) return;
    var file = $('gmFile').files[0], err = $('gmPubErr'); err.textContent = '';
    if (!file) { err.textContent = 'Choose a file first.'; return; }
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (EXT.indexOf(ext) < 0) { err.textContent = 'Unsupported file type. Allowed: .' + EXT.join(', .'); return; }
    if (file.size > MAX_BYTES) { err.textContent = 'File is too large (max 45 MB).'; return; }

    var id = st.detail.game.universeId, btn = $('gmPubBtn'), bar = $('gmProgBar');
    st.busy = true; btn.disabled = true; btn.textContent = 'Uploading…';
    $('gmProg').style.display = 'block'; bar.style.width = '0';

    api('/' + id + '/upload-url', { method: 'POST', auth: true, body: { filename: file.name, size: file.size } })
      .then(function (slot) {
        return putFile(slot.signedUrl, file, function (p) { bar.style.width = Math.round(p * 100) + '%'; }).then(function () { return slot; });
      })
      .then(function (slot) {
        btn.textContent = 'Publishing…'; bar.style.width = '100%';
        return api('/' + id + '/publish', { method: 'POST', auth: true, body: { path: slot.path, origName: file.name } });
      })
      .then(function (res) {
        if (st.detail && st.detail.game.universeId === id) { st.detail.file = res.file; renderDetail(); }
        $('gmResults').innerHTML = ''; // refresh catalog/search next time the list opens
        closeModalSafe(); toast('File published');
      })
      .catch(function (e) {
        err.textContent = e.message || 'Something went wrong';
        btn.disabled = false; btn.textContent = 'Publish'; $('gmProg').style.display = 'none';
      })
      .then(function () { st.busy = false; });
  };
  function closeModalSafe() { $('gmPublishModal').classList.remove('open'); }

  function removeFile() {
    if (!isAdmin() || !st.detail || !st.detail.file) return;
    if (!confirm('Remove the published file for “' + st.detail.game.name + '”?')) return;
    var id = st.detail.game.universeId;
    api('/' + id + '/file', { method: 'DELETE', auth: true }).then(function () {
      if (st.detail && st.detail.game.universeId === id) { st.detail.file = null; renderDetail(); }
      $('gmResults').innerHTML = ''; toast('File removed');
    }).catch(function (e) { toast(e.message || 'Could not remove the file', true); });
  }

  /* ---------- wiring ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    var input = $('gmInput'); if (!input) return;

    input.addEventListener('input', function () {
      syncClear();
      clearTimeout(st.sugTimer);
      var q = input.value.trim();
      if (q.length < 2) { st.sugSeq++; closeSug(); return; }
      st.sugTimer = setTimeout(function () { fetchSug(q); }, 220);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); moveActive(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveActive(-1); }
      else if (ev.key === 'Escape') { closeSug(); }
      else if (ev.key === 'Enter') {
        ev.preventDefault(); clearTimeout(st.sugTimer); st.sugSeq++;
        if (st.active >= 0) pick(+$('gmSuggest').querySelectorAll('.gm-sg-item')[st.active].getAttribute('data-i'));
        else runSearch(input.value);
      }
    });
    input.addEventListener('focus', function () { if (st.sug.length && input.value.trim().length >= 2) $('gmSuggest').classList.add('open'); });
    $('gmGo').addEventListener('click', function () { clearTimeout(st.sugTimer); st.sugSeq++; runSearch(input.value); });
    $('gmClear').addEventListener('click', function () { input.value = ''; syncClear(); st.sug = []; closeSug(); runSearch(''); input.focus(); });
    $('gmSuggest').addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    $('gmSuggest').addEventListener('click', function (ev) {
      var it = ev.target.closest('.gm-sg-item'); if (it) pick(+it.getAttribute('data-i'));
    });
    document.addEventListener('click', function (ev) { if (!ev.target.closest('#gmSearch')) closeSug(); });

    $('gmResults').addEventListener('click', function (ev) {
      var c = ev.target.closest('.gm-card'); if (c) goGame(c.getAttribute('data-id'));
    });
    $('gmHint').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-q]'); if (!b) return;
      input.value = b.getAttribute('data-q'); syncClear(); runSearch(input.value);
    });
    $('gmDetail').addEventListener('click', function (ev) {
      var t = ev.target;
      if (t.closest('#gmDl')) download();
      else if (t.closest('#gmPubOpen')) window.gmOpenPublish();
      else if (t.closest('#gmRm')) removeFile();
      else if (t.closest('#gmMore')) {
        var d = $('gmDesc'), full = d.classList.toggle('full'); t.closest('#gmMore').textContent = full ? 'Show less' : 'Show more';
      }
    });

    window.addEventListener('hashchange', onRoute);
    onRoute();
  });

  // Re-draw admin controls when the main script finishes sign-in / sign-out,
  // and leave the games section when a normal tab is clicked.
  window.addEventListener('load', function () {
    try {
      if (typeof F === 'function') { var _F = F; window.F = function () { var r = _F.apply(this, arguments); try { if (st.detail && !$('gmDetail').hidden) renderDetail(); } catch (x) {} return r; }; }
      if (typeof showTab === 'function') { var _s = showTab; window.showTab = function () { if (document.body.classList.contains('gm-open')) window.closeGames(); return _s.apply(this, arguments); }; }
    } catch (x) {}
  });
})();
</script>
