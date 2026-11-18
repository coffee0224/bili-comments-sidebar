(() => {
  'use strict';

  /* ============================================================
     DIAGNOSTIC MODE  (temporary — bisects the grey-images bug)
     localStorage.bcsMode on the bilibili origin gates features:
       full     everything on (default, current behaviour)
       off      script does NOTHING at all
       nostyle  skip style injection + html.bcs-layout class
       nomount  skip inserting into .right-container (sb stays at body end)
       nofetch  skip our API fetches (comments show 加载中 forever)
       norescue skip the window capture listeners
     ============================================================ */
  const BCS_MODE = (() => {
    try { return localStorage.getItem('bcsMode') || 'full'; } catch (e) { return 'full'; }
  })();
  // boot pacing: 'fast' (default, v2.7) ends the boot window as soon as
  // we're mounted — setTab('简介')'s wake() promotes data-src/eager and
  // dispatches scroll so bilibili's lazy loader recovers on un-collapse.
  // 'safe' restores the old "wait until native imgs complete" pacing.
  const BCS_BOOT = (() => {
    try { return localStorage.getItem('bcsBoot') === 'safe' ? 'safe' : 'fast'; } catch (e) { return 'fast'; }
  })();
  const MODE = {
    style:  !['off', 'nostyle'].includes(BCS_MODE),
    mount:  !['off', 'nomount'].includes(BCS_MODE),
    fetch:  !['off', 'nofetch'].includes(BCS_MODE),
    rescue: !['off', 'norescue'].includes(BCS_MODE),
  };

  /* ============================================================
     STATE
     ============================================================ */
  const S = {
    comments: [],       // root comments loaded so far
    sort: 2,            // 0 = newest, 2 = hottest  (bilibili API param)
    replySort: 'hot',   // 'hot' | 'time'  (client-side)
    filter: '',
    page: 1,
    total: 0,
    loading: false,
    hasMore: true,
    oid: null,
    upMid: null,
    // rpid -> { replies:[], done:bool }
    expanded: {},
    theme: 'light',  // 'light' matches B站 native page; toggle to 'dark' via header button
    tabMode: 'comments', // 'comments' | 'intro'
    bootDone: false,     // boot window finished → safe to collapse native blocks
  };

  /* ============================================================
     VIDEO INFO  (BV -> aid via API)
     ============================================================ */
  const _vcache = {};
  let _vErr = '';  // last view-API error, surfaced in UI messages

  function bvidFromUrl() {
    const m = location.pathname.match(/\/video\/(BV[\w]+)/);
    return m ? m[1] : null;
  }

  /* Extract video info from the page's inline __INITIAL_STATE__ script.
     Content scripts live in an isolated world and cannot read
     window.__INITIAL_STATE__, but the inline <script> TAG is shared DOM —
     its textContent carries the same JSON. This survives view-API
     risk control (-404/-352/-403) and works on every hard page load.
     (On SPA navigation document.scripts still belongs to the first page,
     so callers fall back to the API path then.) */
  function videoInfoFromDom(bvid) {
    try {
      const anchor = new RegExp('"aid"\\s*:\\s*(\\d+)\\s*,\\s*"bvid"\\s*:\\s*"' + bvid + '"');
      let aid = '', seg = '';
      for (const sc of document.scripts) {
        const t = sc.textContent || '';
        const m = t.match(anchor);
        if (m) { aid = m[1]; seg = t.slice(t.indexOf(m[0]), t.indexOf(m[0]) + 16000); break; }
      }
      if (!aid) return null;

      const grab = (re) => { const m = seg.match(re); return m ? m[1] : ''; };
      const jstr = (raw) => { try { return JSON.parse('"' + raw + '"'); } catch (e) { return raw; } };
      const title = jstr(grab(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/));
      const desc = jstr(grab(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/));
      const pubdate = parseInt(grab(/"pubdate"\s*:\s*(\d+)/), 10) || 0;
      const oMid = grab(/"owner"\s*:\s*\{\s*"mid"\s*:\s*(\d+)/);
      const oName = jstr(grab(/"owner"\s*:\s*\{\s*"mid"\s*:\s*\d+\s*,\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"/));
      const oFace = jstr(grab(/"owner"\s*:\s*\{\s*"mid"\s*:\s*\d+\s*,\s*"name"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"face"\s*:\s*"((?:[^"\\]|\\.)*)"/));
      const statIdx = seg.search(/"stat"\s*:\s*\{/);
      const statSeg = statIdx >= 0 ? seg.slice(statIdx, statIdx + 700) : '';
      const num = (k) => parseInt((statSeg.match(new RegExp('"' + k + '"\\s*:\\s*(\\d+)')) || [0, 0])[1], 10) || 0;
      const stat = { view: num('view'), danmaku: num('danmaku'), reply: num('reply'), like: num('like'), coin: num('coin'), favorite: num('favorite'), share: num('share') };

      return {
        aid,
        upMid: oMid || null,
        title: title || document.title.replace(/_哔哩哔哩_bilibili.*$/, ''),
        desc,
        pubdate,
        owner: oMid ? { mid: oMid, name: oName, face: oFace } : null,
        stat,
      };
    } catch (e) { return null; }
  }

  async function getVideoInfo(bvid) {
    if (_vcache[bvid]) return _vcache[bvid];
    _vErr = '';

    // 1) DOM state first: free, instant, immune to API risk control
    const dom = videoInfoFromDom(bvid);
    if (dom && dom.aid) { _vcache[bvid] = dom; return dom; }

    // 2) API fallback (only source of truth on SPA navigation)
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { credentials: 'include' });
    const j = await r.json().catch(() => ({ code: -1, message: '响应不是 JSON' }));
    if (j.code !== 0 || !j.data) {
      _vErr = `view API code ${j.code}: ${j.message || ''}`;
      return null;
    }
    const d = j.data;
    const info = {
      aid: String(d.aid),
      upMid: d.owner?.mid ? String(d.owner.mid) : null,
      title: d.title || '',
      desc: d.desc || '',
      pubdate: d.pubdate || 0,
      owner: d.owner ? { name: d.owner.name, face: d.owner.face, mid: d.owner.mid } : null,
      stat: d.stat ? {
        view: d.stat.view, danmaku: d.stat.danmaku, reply: d.stat.reply,
        like: d.stat.like, coin: d.stat.coin, favorite: d.stat.favorite, share: d.stat.share,
      } : null,
    };
    _vcache[bvid] = info;
    return info;
  }

  async function ensureOid() {
    if (S.oid) return true;
    const bv = bvidFromUrl();
    if (!bv) throw new Error('URL 中没有 BV 号');
    const info = await getVideoInfo(bv);
    if (!info || !info.aid) throw new Error(`无法获取视频信息（${_vErr || '页面数据不可用'}）`);
    S.oid = info.aid;
    S.upMid = info.upMid;
    return true;
  }

  /* ============================================================
     BILIBILI COMMENT API
     ============================================================ */

  // Fetch one page of root comments
  async function apiRootComments(oid, page, sort) {
    const u = `https://api.bilibili.com/x/v2/reply?type=1&oid=${oid}&pn=${page}&sort=${sort}&nohot=0`;
    const r = await fetch(u, { credentials: 'include' });
    const j = await r.json();
    if (j.code !== 0) throw new Error(j.message || `code ${j.code}`);
    return j.data;
  }

  // Fetch ALL replies under a root comment (auto-paginate)
  async function apiAllReplies(oid, rootRpid) {
    const all = [];
    let pn = 1;
    const ps = 20;
    while (true) {
      const u = `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${oid}&root=${rootRpid}&pn=${pn}&ps=${ps}`;
      const r = await fetch(u, { credentials: 'include' });
      const j = await r.json();
      if (j.code !== 0) {
        // first page failing = real error: surface it instead of
        // silently rendering "no replies"
        if (pn === 1) throw new Error(j.message || `code ${j.code}`);
        break;
      }
      const replies = j.data?.replies;
      if (!replies || replies.length === 0) break;
      all.push(...replies);
      const total = j.data?.page?.count ?? 0;
      if (all.length >= total) break;
      pn++;
      if (pn > 50) break; // safety cap 1000 replies
    }
    return all;
  }

  /* ============================================================
     TREE BUILDER
     Bilibili reply system is max 2 levels, but each reply has
     `root` (the root comment rpid) and `parent` (the rpid it
     replies to).  We build a nested tree from the flat list.
     ============================================================ */

  function buildTree(flatReplies, rootRpid, sortMode) {
    if (!flatReplies || flatReplies.length === 0) return [];

    const sorted = [...flatReplies];
    if (sortMode === 'hot') {
      sorted.sort((a, b) => (b.like || 0) - (a.like || 0));
    } else {
      sorted.sort((a, b) => (a.ctime || 0) - (b.ctime || 0));
    }

    // Build map
    const map = new Map();
    for (const r of sorted) {
      map.set(String(r.rpid), { ...r, _children: [] });
    }

    const roots = [];
    for (const r of sorted) {
      const node = map.get(String(r.rpid));
      const pid = String(r.parent);
      if (pid === String(rootRpid) || !map.has(pid)) {
        // Top-level reply to root
        roots.push(node);
      } else {
        map.get(pid)._children.push(node);
      }
    }
    return roots;
  }

  /* ============================================================
     HELPERS
     ============================================================ */

  function timeAgo(ts) {
    const d = Date.now() / 1000 - ts;
    if (d < 60) return '刚刚';
    if (d < 3600) return (d / 60 | 0) + '分钟前';
    if (d < 86400) return (d / 3600 | 0) + '小时前';
    if (d < 2592000) return (d / 86400 | 0) + '天前';
    const o = new Date(ts * 1000);
    return `${o.getFullYear()}-${String(o.getMonth() + 1).padStart(2, '0')}-${String(o.getDate()).padStart(2, '0')}`;
  }

  const _e = document.createElement('div');
  function esc(t) { _e.textContent = t; return _e.innerHTML; }

  // ---- Image URL optimization ----
  // Bilibili CDN supports @Nw.webp suffix for fast resized images
  // and sometimes blocks hotlinking without proper referrer handling
  function imgUrl(url, suffix) {
    if (!url) return '';
    // Ensure https
    url = url.replace(/^http:\/\//, 'https://');
    // Remove existing @ suffix if any
    if (suffix) {
      url = url.replace(/@[^/]+$/, '');
      url += suffix;
    }
    return url;
  }

  function fmtMsg(msg) {
    if (!msg) return '';
    return esc(msg).replace(/\n/g, '<br>');
  }

  /* ============================================================
     TIMESTAMP LINKIFY + VIDEO SEEK
     ============================================================ */
  const TIME_RE = /\b(\d{1,3}:[0-5]\d(?::[0-5]\d)?)\b/g;

  function linkifyTime(html) {
    // Only touch text nodes (between tags) so we never break HTML
    return html.replace(/>([^<]+)</g, (_, t) =>
      '>' + t.replace(TIME_RE, '<span class="bcs-time" data-t="$1">$1</span>') + '<'
    );
  }

  function parseTimeSec(t) {
    const p = t.split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  }

  function seekVideo(sec) {
    try {
      if (window.player && typeof window.player.seek === 'function') {
        window.player.seek(sec, true);
        if (typeof window.player.play === 'function') window.player.play();
        return;
      }
    } catch (e) {}
    const v = document.querySelector('video');
    if (v) {
      try { v.currentTime = sec; const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
    }
  }

  function applyEmotes(html, emote) {
    if (!emote) return html;
    for (const [k, v] of Object.entries(emote)) {
      const ek = esc(k);
      const src = imgUrl(v.url, '@100w.webp');
      html = html.replaceAll(ek,
        `<img class="bcs-emote" src="${src}" alt="${ek}" title="${ek}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${imgUrl(v.url)}'"/>`
      );
    }
    return html;
  }

  // Render user-uploaded pictures in comments (content.pictures)
  function renderPictures(pictures) {
    if (!pictures || pictures.length === 0) return '';
    const imgs = pictures.map(p => {
      const src = imgUrl(p.img_src, '@360w.webp');
      const full = imgUrl(p.img_src);
      return `<a class="bcs-pic-link" href="${full}" target="_blank" title="点击查看大图">` +
        `<img class="bcs-pic" src="${src}" loading="lazy" referrerpolicy="no-referrer" ` +
        `onerror="this.onerror=null;this.src='${imgUrl(p.img_src)}'"/>` +
        `</a>`;
    }).join('');
    return `<div class="bcs-pics">${imgs}</div>`;
  }

  function highlight(html, kw) {
    if (!kw) return html;
    const r = new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
    return html.replace(/>([^<]+)</g, (_, t) => '>' + t.replace(r, '<span class="bcs-hl">$1</span>') + '<');
  }

  function fmtLike(n) { return n > 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }

  const LIKE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>`;
  const REPLY_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;

  /* ============================================================
     CREATE SIDEBAR DOM
     ============================================================ */

  function createUI() {
    const sb = document.createElement('div');
    sb.id = 'bili-comments-sidebar';
    sb.innerHTML = `
      <div class="bcs-header">
        <div class="bcs-header-row">
          <div class="bcs-tabs">
            <button class="bcs-tab on" id="J-tab-c" title="视频评论">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
              评论 <span class="cnt" id="J-cnt">0</span>
            </button>
            <button class="bcs-tab" id="J-tab-i" title="B站右栏原内容（相关视频等）">简介</button>
          </div>
          <div class="bcs-header-actions">
            <button class="bcs-theme-btn" id="J-theme" title="切换明亮/暗黑模式">
              <svg id="J-theme-icon" viewBox="0 0 24 24"><path d="M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707.707M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"/></svg>
            </button>
          </div>
        </div>
        <div class="bcs-toolbar">
          <div class="bcs-pill-group" id="J-csort">
            <button class="bcs-pill on" data-v="2">🔥 热门</button>
            <button class="bcs-pill" data-v="0">🕐 最新</button>
          </div>
          <div class="bcs-pill-group" id="J-rsort">
            <button class="bcs-pill on-pink" data-v="hot">回复·热度</button>
            <button class="bcs-pill" data-v="time">回复·时间</button>
          </div>
          <input class="bcs-search" id="J-search" placeholder="搜索评论…"/>
          <button class="bcs-icon-btn" id="J-refresh" title="刷新">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
        </div>
      </div>
      <div class="bcs-list" id="J-scroll"><div id="J-list"></div><div class="bcs-sentinel" id="J-sentinel"></div></div>
      <div class="bcs-footer">
        <span id="J-info"></span>
        <span class="bcs-ver" title="Bili Comments Sidebar fork build">v2.7</span>
        <button class="bcs-footer-btn" id="J-jump">⬆ 回到顶部</button>
      </div>
    `;
    // Attach to document first so getElementById works below;
    // applyLayout() will MOVE this node into .right-container
    // (moving preserves listeners).
    document.body.appendChild(sb);
    S.sb = sb; // survive B站 rebuilds: re-mount via reference, not just ID

    // ---- events ----
    // timestamp click -> seek
    sb.addEventListener('click', e => {
      const t = e.target.closest('.bcs-time');
      if (t && t.dataset.t) seekVideo(parseTimeSec(t.dataset.t));
    });

    // theme toggle
    $('J-theme').onclick = () => {
      S.theme = S.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      try { chrome.storage.local.set({ _bcsTheme: S.theme }); } catch (e) {}
    };

    function applyTheme() {
      const sb = $('bili-comments-sidebar');
      const icon = $('J-theme-icon');
      if (S.theme === 'light') {
        sb.classList.add('light');
        // Moon icon for "switch to dark"
        icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/>';
      } else {
        sb.classList.remove('light');
        // Sun icon for "switch to light"
        icon.innerHTML = '<path d="M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707.707M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"/>';
      }
    }

    // Load saved theme
    applyTheme();
    try {
      chrome.storage.local.get('_bcsTheme', (r) => {
        if (r._bcsTheme) { S.theme = r._bcsTheme; applyTheme(); }
      });
    } catch (e) {}

    // comment sort
    $$('#J-csort .bcs-pill').forEach(b => b.onclick = () => {
      const v = Number(b.dataset.v);
      if (v === S.sort) return;
      S.sort = v;
      $$('#J-csort .bcs-pill').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      S.expanded = {};
      load(true);
    });

    // reply sort
    $$('#J-rsort .bcs-pill').forEach(b => b.onclick = () => {
      const v = b.dataset.v;
      if (v === S.replySort) return;
      S.replySort = v;
      $$('#J-rsort .bcs-pill').forEach(x => x.classList.remove('on-pink'));
      b.classList.add('on-pink');
      refreshAllExpanded();
    });

    // search
    let _ft;
    $('J-search').oninput = e => {
      clearTimeout(_ft);
      _ft = setTimeout(() => { S.filter = e.target.value.trim(); render(); }, 200);
    };

    // refresh
    $('J-refresh').onclick = () => { S.expanded = {}; load(true); };

    // ---- tabs: 评论 / 简介(B站右栏原内容) ------------------------------
    // Exclusive switching: comments mode collapses the native right-column
    // blocks via .bcs-native-hide (setNativeCollapsed), intro mode hides
    // our comment-specific blocks. The header row with the two tabs stays
    // visible in both modes.
    const setTab = mode => {
      S.tabMode = mode;
      const intro = mode === 'intro';
      sb.classList.toggle('bcs-intro-mode', intro);
      $('J-tab-c').classList.toggle('on', !intro);
      $('J-tab-i').classList.toggle('on', intro);
      if (intro) {
        setNativeCollapsed(false);
        // The native right column lazy-loads its images (data-src → src on
        // scroll-into-view). While our comments tab collapsed the native
        // blocks, that loader never fired — and because comments scroll
        // INSIDE #J-scroll, no window scroll event ever happens to wake it
        // up. Force it: promote data-src ourselves and dispatch
        // scroll/resize so bilibili's own listeners re-evaluate.
        const wake = () => {
          const parent = sb.parentElement;
          if (parent) {
            parent.querySelectorAll('img').forEach(img => {
              img.loading = 'eager'; // native loading=lazy: force fetch now
              const ds = img.dataset.src || img.dataset.original;
              const s = img.getAttribute('src') || '';
              if (ds && (!s || s.startsWith('data:'))) img.src = ds;
            });
          }
          window.dispatchEvent(new Event('scroll'));
          window.dispatchEvent(new Event('resize'));
        };
        requestAnimationFrame(wake);
        // second shot + a REAL 1px scroll round-trip: loaders that ignore
        // synthetic events still react to actual scrollY movement
        setTimeout(() => { wake(); window.scrollBy(0, 1); window.scrollBy(0, -1); }, 350);
      } else if (S.bootDone) {
        setNativeCollapsed(true);
      }
    };
    S.setTab = setTab;
    $('J-tab-c').onclick = () => setTab('comments');
    $('J-tab-i').onclick = () => setTab('intro');

    // render-then-collapse, v2.3 "boot" strategy: during a short boot
    // window we hide OUR comment blocks (.bcs-boot), so the native
    // content occupies the right column unimpeded — images mount with
    // the registry intact (v2.3: we are appended LAST and only after
    // the native cards settled). Poll the native blocks' <img>s until
    // complete (hard cap 6s), then drop the boot class and collapse
    // the native column (unless the user is on the 简介 tab). Re-armed
    // on SPA navigation where the right column is rebuilt.
    let bootPoll = 0;
    const scheduleCollapse = () => {
      clearInterval(bootPoll);
      S.bootDone = false;
      setNativeCollapsed(false); // rebuilt native blocks start visible
      sb.classList.add('bcs-boot'); // hide ours → native in viewport
      let t0 = Date.now();
      const abs0 = Date.now(); // absolute cap independent of mount delay
      bootPoll = setInterval(() => {
        // while sb still awaits mounting (end of <body>), DON'T run the
        // boot clock — the poll would read page-wide imgs and the finish
        // branch would fire before we're even in the right column.
        const rc = sb.parentElement;
        const mounted = rc && rc.classList.contains('right-container');
        if (!mounted) { t0 = Date.now(); return; }
        window.dispatchEvent(new Event('scroll')); // nudge scroll-driven mounts
        const imgs = [...rc.querySelectorAll('img')];
        const ready = imgs.length > 0 && imgs.every(i => i.complete);
        const t = Date.now() - t0;
        // fast: natives are settled (rightSettled gated the mount) and we
        // appended LAST, so the registry formed unimpeded — remaining lazy
        // loads recover via setTab('简介')'s wake(). Finish on first tick.
        // safe: old pacing — wait for every img complete (floor 1.5s).
        const done = BCS_BOOT === 'fast'
          ? t >= 250
          : (ready && t >= 1500) || t >= 6000 || Date.now() - abs0 > 10000;
        if (done) {
          clearInterval(bootPoll);
          S.bootDone = true;
          sb.classList.remove('bcs-boot');
          mountSidebar(); // reposition sb LAST→FIRST child now that boot is over
          if (S.tabMode !== 'intro') setNativeCollapsed(true);
          console.log('[BCS] boot 完成', { boot: BCS_BOOT, mounted: true, t, ready, imgs: imgs.length });
        }
      }, 250);
    };
    S.scheduleCollapse = scheduleCollapse;
    scheduleCollapse();

    // jump: scroll list to top
    $('J-jump').onclick = () => {
      const sc = $('J-scroll');
      if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' });
    };

    // infinite scroll: the list is its own scroll container; observe the
    // sentinel against that container so pages load near its bottom
    const scroller = sb.querySelector('#J-scroll');
    new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !S.loading && S.hasMore) load(false);
    }, { root: scroller, rootMargin: '600px 0px' }).observe(sb.querySelector('#J-sentinel'));

    // ---- event rescue v2 ----------------------------------------------
    // (gated by MODE.rescue for the grey-images bisect)
    const INTERACTIVE = '.bcs-pill,.bcs-more-btn,.bcs-time,.bcs-jump,.bcs-theme-btn,' +
                        '.bcs-icon-btn,.bcs-footer-btn,.bcs-load-btn,.bcs-collapse,' +
                        'button,a,input';
    if (MODE.rescue) {
    // hit-test that works even when pointer-events:none makes elementsFromPoint
    // skip our subtree: geometric rect containment over our interactive nodes.
    const hitMine = (s, x, y) => {
      const byStack = document.elementsFromPoint(x, y)
        .find(el => s.contains(el) && el.closest(INTERACTIVE));
      if (byStack) return byStack;
      for (const el of s.querySelectorAll(INTERACTIVE)) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
          return el;
      }
      return null;
    };
    window.addEventListener('click', e => {
      const s = $('bili-comments-sidebar');
      if (!s || s.contains(e.target)) return;
      const r = s.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right ||
          e.clientY < r.top || e.clientY > r.bottom) return;
      const mine = hitMine(s, e.clientX, e.clientY);
      if (mine) { e.preventDefault(); e.stopPropagation(); mine.click(); }
    }, true);
    window.addEventListener('pointerdown', e => {
      // overlays can eat focus before click: focus our input directly
      const s = $('bili-comments-sidebar');
      if (!s || s.contains(e.target)) return;
      const r = s.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right ||
          e.clientY < r.top || e.clientY > r.bottom) return;
      const mine = hitMine(s, e.clientX, e.clientY);
      if (mine && mine.tagName === 'INPUT') { e.preventDefault(); mine.focus(); }
    }, true);
    window.addEventListener('wheel', e => {
      const s = $('bili-comments-sidebar');
      if (!s || s.contains(e.target)) return;
      const sc = $('J-scroll');
      if (!sc) return;
      const r = sc.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right ||
          e.clientY < r.top || e.clientY > r.bottom) return;
      const atTop = sc.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1 && e.deltaY > 0;
      if (atTop || atBottom) return; // let overscroll chain to the page
      e.preventDefault(); e.stopPropagation();
      sc.scrollTop += e.deltaY;
    }, { capture: true, passive: false });
    } // MODE.rescue
  }

  function $(id) { return document.getElementById(id); }
  function $$(sel) { return document.querySelectorAll(sel); }

  /* ============================================================
     (intro section removed v1.5 — comments-only sidebar)
     ============================================================ */
  /* ============================================================
     PAGE LAYOUT: comments become the first block of B站's
     native right column (.right-container), fully in-flow.
     Left column keeps video + title + actions as-is; only the
     original (duplicate) comment section below the player is
     hidden.
     ============================================================ */
  function injectLayoutStyle() {
    if (document.getElementById('bcs-layout-style')) return;
    const st = document.createElement('style');
    st.id = 'bcs-layout-style';
    st.textContent = `
      html.bcs-layout #commentapp,
      html.bcs-layout .comment-container,
      html.bcs-layout .bili-comment-container,
      html.bcs-layout #comment {
        display: none !important;
      }
    `;
    document.documentElement.appendChild(st);
  }

  // Insert (or re-insert after SPA rebuilds) the sidebar — as the LAST
  // child of B站's right column, and only AFTER its content settled.
  // v2.3 bisect verdict: inserting as FIRST child (or mid-mount)
  // permanently breaks bilibili's video-awesome-img lazy registry —
  // every .video-awesome-img anchor stays EMPTY (grey covers, 0 <img>
  // in the whole right column) for the page's lifetime. Appending last
  // after the native cards exist leaves that registry intact.
  function rightSettled(rc) {
    return !!(rc.querySelector('.video-page-card-small') ||
              rc.querySelector('.up-panel-container') ||
              rc.querySelector('.video-pod'));
  }
  function mountSidebar() {
    // getElementById returns null once B站's rebuild WIPES us from the
    // document — but the node object (with all listeners) lives on in
    // S.sb. Fall back to the stored reference and re-append it.
    let sb = document.getElementById('bili-comments-sidebar') || S.sb;
    const rc = document.querySelector('.right-container');
    if (!sb || !rc || !rightSettled(rc)) return false;
    // Position: LAST child while the boot window is open (any foreign
    // first-child presence during B站's mount permanently breaks the
    // video-awesome-img registry — grey images). Once boot is done we
    // reposition to FIRST child so the tab bar sits at the top of the
    // right column in BOTH tabs (with sb last, expanding 简介 pushed
    // the tabs 3000px below the fold — unreachable).
    if (S.bootDone) {
      if (rc.firstElementChild !== sb) rc.insertBefore(sb, rc.firstChild);
    } else {
      if (rc.lastElementChild !== sb) rc.appendChild(sb);
    }
    // re-assert the desired state after a rebuild replaced the native
    // blocks (fresh nodes have no .bcs-native-hide)
    if (S.bootDone && S.tabMode !== 'intro') setNativeCollapsed(true);
    return true;
  }
  // Collapse/expand the native right-column blocks via a class on those
  // nodes themselves (sb is now the LAST child, so CSS sibling
  // combinators can no longer reach them).
  function setNativeCollapsed(collapsed) {
    const sb = document.getElementById('bili-comments-sidebar');
    const rc = sb && sb.parentElement;
    // NEVER operate outside .right-container (during the pre-mount phase
    // sb hangs at the end of <body>; touching body children would nuke
    // the whole page).
    if (!rc || !rc.classList.contains('right-container')) return;
    [...rc.children].forEach(el => {
      if (el !== sb) el.classList.toggle('bcs-native-hide', collapsed);
    });
  }

  function applyLayout() {
    if (MODE.style) {
      injectLayoutStyle();
      document.documentElement.classList.add('bcs-layout');
    }
    if (!MODE.mount) return;
    if (!mountSidebar()) {
      // right column not rendered yet — retry until it appears
      const t = setInterval(() => {
        if (mountSidebar()) clearInterval(t);
      }, 500);
      setTimeout(() => clearInterval(t), 30000);
    }
  }

  /* ============================================================
     LOAD ROOT COMMENTS
     ============================================================ */
  async function load(reset) {
    if (!MODE.fetch) { // diagnostic: our API calls suspended
      const l = $('J-list');
      if (l) l.innerHTML = '<div class="bcs-state">诊断模式 nofetch：评论请求已禁用</div>';
      return;
    }
    if (S.loading) return;
    const list = $('J-list');
    const rb = $('J-refresh');

    if (reset) {
      S.page = 1; S.comments = []; S.hasMore = true;
      S.oid = null; S.upMid = null;
    }

    S.loading = true;
    rb.classList.add('spin');
    if (S.comments.length === 0)
      list.innerHTML = '<div class="bcs-state"><div class="bcs-spinner"></div>加载中…</div>';

    try {
      await ensureOid();

      const data = await apiRootComments(S.oid, S.page, S.sort);
      S.total = data.page?.count || 0;
      $('J-cnt').textContent = S.total.toLocaleString();

      const items = data.replies || [];
      if (items.length === 0) { S.hasMore = false; }
      else {
        if (S.page === 1 && data.top_replies && data.top_replies.length) {
          const topIds = new Set(data.top_replies.map(r => String(r.rpid)));
          const deduped = items.filter(r => !topIds.has(String(r.rpid)));
          S.comments = [...data.top_replies.map(r => ({ ...r, _top: true })), ...deduped];
        } else {
          S.comments.push(...items);
        }
        S.page++;
      }

      render();

    } catch (err) {
      console.error('[BiliSidebar]', err);
      if (S.comments.length === 0) {
        list.innerHTML = `<div class="bcs-state">加载失败: ${esc(err.message)}</div>`;
      }
    } finally {
      S.loading = false;
      rb.classList.remove('spin');
      $('J-info').textContent = `${S.comments.length} / ${S.total}`;
    }
  }

  /* ============================================================
     RENDER
     ============================================================ */
  function render() {
    const list = $('J-list');
    let data = S.comments;

    if (S.filter) {
      const kw = S.filter.toLowerCase();
      data = data.filter(c =>
        (c.content?.message || '').toLowerCase().includes(kw) ||
        (c.member?.uname || '').toLowerCase().includes(kw)
      );
    }

    if (data.length === 0 && !S.loading) {
      list.innerHTML = `<div class="bcs-state">${S.filter ? '没有匹配' : '暂无评论'}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const c of data) frag.appendChild(mkRoot(c));
    list.innerHTML = '';
    list.appendChild(frag);
  }

  /* ============================================================
     BUILD DOM — ROOT COMMENT
     ============================================================ */
  function mkRoot(c) {
    const root = document.createElement('div');
    root.className = 'bcs-root';
    root.dataset.rpid = c.rpid;
    root.appendChild(mkCard(c, true));

    const rpid = String(c.rpid);
    const rcount = c.rcount || 0;
    const exp = S.expanded[rpid];

    if (exp && exp.done) {
      // ---- fully expanded ----
      const tree = buildTree(exp.replies, rpid, S.replySort);
      if (tree.length > 0) {
        // Wrapper with sticky collapse button at bottom
        const expWrap = document.createElement('div');
        expWrap.className = 'bcs-expanded-wrap';

        expWrap.appendChild(mkRepliesWrap(tree, 1));

        // Sticky collapse button pinned at bottom
        const stickyBar = document.createElement('div');
        stickyBar.className = 'bcs-sticky-collapse';
        const collapseBtn = mkBtn(`▴ 收起 ${rcount} 条回复`, () => {
          delete S.expanded[rpid];
          rerenderRoot(rpid);
        });
        stickyBar.appendChild(collapseBtn);
        expWrap.appendChild(stickyBar);

        root.appendChild(expWrap);
      }
    } else if (rcount > 0) {
      // ---- collapsed: no preview, just the expand button ----
      const btn = mkBtn(`▾ 展开全部 ${rcount} 条回复`, async function handler() {
        btn.classList.add('busy');
        btn.textContent = '加载中…';
        try {
          if (!S.oid) await ensureOid();
          const replies = await apiAllReplies(S.oid, rpid);
          S.expanded[rpid] = { replies, done: true };
          rerenderRoot(rpid);
        } catch (e) {
          btn.classList.remove('busy');
          btn.textContent = '加载失败，点击重试';
        }
      });
      root.appendChild(btn);
    }

    return root;
  }

  /* ============================================================
     BUILD DOM — NESTED REPLIES (Reddit thread lines)
     ============================================================ */
  function mkRepliesWrap(treeNodes, depth) {
    const wrap = document.createElement('div');
    wrap.className = `bcs-replies-wrap d${Math.min(depth, 3)}`;

    // Thread line (clickable to collapse)
    const line = document.createElement('div');
    line.className = 'bcs-thread-line';
    line.title = '点击折叠';
    line.onclick = () => { wrap.style.display = 'none'; };
    wrap.appendChild(line);

    const inner = document.createElement('div');
    inner.className = 'bcs-replies-inner';

    for (const node of treeNodes) {
      inner.appendChild(mkCard(node, false));
      // Recurse children
      if (node._children && node._children.length > 0) {
        inner.appendChild(mkRepliesWrap(node._children, depth + 1));
      }
    }

    wrap.appendChild(inner);
    return wrap;
  }

  /* ============================================================
     BUILD DOM — SINGLE COMMENT CARD
     ============================================================ */
  function mkCard(c, isRoot) {
    const m = c.member || {};
    const ct = c.content || {};
    const isUp = S.upMid && String(m.mid) === String(S.upMid);
    const lv = m.level_info?.current_level || 0;
    const likes = c.like || 0;
    const rcount = c.rcount || 0;

    let body = fmtMsg(ct.message);
    body = applyEmotes(body, ct.emote);
    body = linkifyTime(body);
    if (S.filter) body = highlight(body, S.filter);
    // Append user-uploaded pictures
    body += renderPictures(ct.pictures);

    const card = document.createElement('div');
    card.className = 'bcs-c';

    // header
    const avatarSrc = imgUrl(m.avatar, '@48w_48h.webp');
    const avatarFull = imgUrl(m.avatar);
    const head = document.createElement('div');
    head.className = 'bcs-c-head';
    head.innerHTML = `
      <img class="bcs-av" src="${avatarSrc}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${avatarFull}'"/>
      <span class="bcs-un${isUp ? ' up' : ''}">${esc(m.uname || '匿名')}</span>
      ${isUp ? '<span class="bcs-tag up-tag">UP主</span>' : ''}
      ${c._top ? '<span class="bcs-tag top-tag">置顶</span>' : ''}
      ${isRoot ? `<span class="bcs-lv l${lv}">Lv${lv}</span>` : ''}
      <span class="bcs-dot">·</span>
      <span class="bcs-ts">${timeAgo(c.ctime)}</span>
    `;
    card.appendChild(head);

    // body
    const bd = document.createElement('div');
    bd.className = 'bcs-c-body';
    bd.innerHTML = body;
    card.appendChild(bd);

    // actions
    const acts = document.createElement('div');
    acts.className = 'bcs-c-acts';
    acts.innerHTML = `
      <span class="bcs-act${likes > 100 ? ' hot' : ''}">${LIKE_SVG} ${fmtLike(likes)}</span>
      ${isRoot && rcount > 0 ? `<span class="bcs-act">${REPLY_SVG} ${rcount}</span>` : ''}
    `;
    card.appendChild(acts);

    return card;
  }

  /* ============================================================
     UTILITY: BUTTON
     ============================================================ */
  function mkBtn(text, handler) {
    const btn = document.createElement('button');
    btn.className = 'bcs-more-btn';
    btn.textContent = text;
    btn.onclick = handler;
    return btn;
  }

  /* ============================================================
     RE-RENDER A SINGLE ROOT THREAD (after expand/collapse/sort)
     ============================================================ */
  function rerenderRoot(rpid) {
    const old = document.querySelector(`.bcs-root[data-rpid="${rpid}"]`);
    if (!old) return;
    const c = S.comments.find(x => String(x.rpid) === String(rpid));
    if (!c) return;
    old.replaceWith(mkRoot(c));
  }

  function refreshAllExpanded() {
    for (const rpid of Object.keys(S.expanded)) {
      if (S.expanded[rpid].done) rerenderRoot(rpid);
    }
  }

  /* ============================================================
     SPA NAVIGATION
     ============================================================ */
  function watchUrl() {
    let last = location.href;
    new MutationObserver(() => {
      // Re-mount if B站 rebuilt the right column without our block
      if (MODE.mount) mountSidebar();
      if (location.href !== last) {
        last = location.href;
        S.oid = null; S.upMid = null;
        S.comments = []; S.page = 1;
        S.hasMore = true; S.expanded = {};
        if (S.setTab) S.setTab('comments'); // new video → reset to comments tab
        if (S.scheduleCollapse) S.scheduleCollapse(); // rebuilt right column → render-then-collapse again
        setTimeout(() => { load(true); }, 800);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ============================================================
     INIT
     ============================================================ */
  function init() {
    createUI();
    applyLayout();
    watchUrl();
    load(true);
  }

  console.log('[BCS] v2.7 mode=' + BCS_MODE + ' boot=' + BCS_BOOT +
    ' style:' + MODE.style + ' mount:' + MODE.mount +
    ' fetch:' + MODE.fetch + ' rescue:' + MODE.rescue);
  if (BCS_MODE !== 'off') {
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', init);
    else
      init();
  }

})();
