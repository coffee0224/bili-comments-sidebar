/* ============================================================
   Bili Comments Sidebar — fork v3.4 (content script)

   WHAT THIS DOES
   - Adds a tabbed column over B站's native right column:
     [简介] = B站原生右栏（相关视频等, 只是被推到标签行下方）
     [评论] = 本扩展的评论区（时间戳可点击跳转）
   - B站原生评论区（播放器下方）保持原样显示，与右栏互不干扰。

   ARCHITECTURE (hard-won constraints — read before touching)
   1. Our root node #bili-comments-sidebar lives on <body> FOREVER.
      ANY foreign node inside B站's #app subtree (.right-container
      or .video-container-v1) during their mount window crashes the
      bili-header fragment-anchor remount (site nav disappears) and
      inserting into the rc first-child slot permanently breaks the
      video-awesome-img lazy registry (grey thumbnails). Never move
      the node into their DOM; positionSidebar() only READS rects
      and writes our own inline style.
   2. positionSidebar() emulates an in-flow column: left/width lock
      to the native .right-container slot, top follows the slot rect
      every frame (rAF-throttled scroll listener) so page scrolling
      moves the panel exactly like in-flow content.
   3. Tab switching is pure CSS on <html> classes — zero mutation
      of B站 nodes. Comments mode: rc visibility:hidden (keeps its
      411px slot, page geometry unchanged). Intro mode: our comment
      machinery hidden, native rc content pushed down 52px below
      the persistent tab bar.
   4. The list is its own scroll container (overscroll-behavior:
      contain) so wheel-scrolling comments never drags the page.

   MODULES
   lib.js (loaded first, same isolated world) holds all pure helpers
   (BCSLib) and their unit tests (tests/, `node --test`).
   ============================================================ */
(() => {
  'use strict';

  const {
    bvidFromPath, videoInfoFromHtml, buildTree, timeAgo, esc,
    imgUrl, fmtMsg, fmtLike, linkifyTime, linkifyUrls, parseTimeSec, highlight,
    linkifyMentions, applyEmotes, renderPictures,
  } = BCSLib;

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
    expanded: {},       // rpid -> { replies:[], done:bool }
    tabMode: 'intro',   // current tab: 'intro' | 'comments'
    defaultTab: 'intro',// opening-a-video default (toggled by 💬 button)
    // assigned later: sb (root node), position, setTab
  };

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  /* ============================================================
     VIDEO INFO  (BV -> aid; DOM state first, view API fallback)
     ============================================================ */
  const _vcache = {};
  let _vErr = '';  // last view-API error, surfaced in UI messages

  const bvidFromUrl = () => bvidFromPath(location.pathname);

  function scriptsText() {
    let out = '';
    for (const sc of document.scripts) out += (sc.textContent || '') + '\n';
    return out;
  }

  async function getVideoInfo(bvid) {
    if (_vcache[bvid]) return _vcache[bvid];
    _vErr = '';

    // 1) Inline __INITIAL_STATE__ first: free, instant, immune to
    //    API risk control (hard loads only — see lib.js docstring)
    const dom = videoInfoFromHtml(scriptsText(), bvid,
      document.title.replace(/_哔哩哔哩_bilibili.*$/, ''));
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

  // One page of root comments
  async function apiRootComments(oid, page, sort) {
    const u = `https://api.bilibili.com/x/v2/reply?type=1&oid=${oid}&pn=${page}&sort=${sort}&nohot=0`;
    const r = await fetch(u, { credentials: 'include' });
    const j = await r.json();
    if (j.code !== 0) throw new Error(j.message || `code ${j.code}`);
    return j.data;
  }

  // ALL replies under a root comment (auto-paginate, cap 1000)
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
      if (pn > 50) break; // safety cap
    }
    return all;
  }

  /* ============================================================
     VIDEO SEEK  (timestamp click)
     ============================================================ */
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

  /* ============================================================
     SIDEBAR DOM + EVENTS
     ============================================================ */

  function createUI() {
    const sb = document.createElement('div');
    sb.id = 'bili-comments-sidebar';
    sb.className = ''; // light palette is the CSS default now
    sb.innerHTML = `
      <div class="bcs-header">
        <div class="bcs-header-row">
          <div class="bcs-tabs">
            <button class="bcs-tab on" id="J-tab-i" title="B站右栏原内容（相关视频等）">简介</button>
            <button class="bcs-tab" id="J-tab-c" title="视频评论">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
              评论 <span class="cnt" id="J-cnt">0</span>
            </button>
          </div>
          <div class="bcs-header-actions">
            <button class="bcs-dtab-btn" id="J-dtab" title="新视频默认打开评论：关">
              <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
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
        <span class="bcs-ver" title="Bili Comments Sidebar fork build">v3.4.1</span>
        <button class="bcs-footer-btn" id="J-jump">⬆ 回到顶部</button>
      </div>
    `;
    // Attach to <body> — and it STAYS there forever (see architecture
    // note at the top: entering B站's #app subtree crashes their
    // bili-header remount and lazy-image registry).
    document.body.appendChild(sb);
    S.sb = sb; // survive B站 rebuilds: re-find via reference, not just ID

    // ---- events ----
    // timestamp click -> seek
    sb.addEventListener('click', e => {
      const t = e.target.closest('.bcs-time');
      if (t && t.dataset.t) seekVideo(parseTimeSec(t.dataset.t));
    });

    // default-tab toggle (persisted via chrome.storage.local):
    // 💬 on = every newly opened video starts on the 评论 tab
    const syncDtabBtn = () => {
      const on = S.defaultTab === 'comments';
      const b = $('J-dtab');
      b.classList.toggle('on', on);
      b.title = `新视频默认打开评论：${on ? '开' : '关'}`;
    };
    $('J-dtab').onclick = () => {
      S.defaultTab = S.defaultTab === 'comments' ? 'intro' : 'comments';
      syncDtabBtn();
      try { chrome.storage.local.set({ _bcsDefaultTab: S.defaultTab }); } catch (e) {}
    };
    syncDtabBtn();

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

    // search (debounced)
    let _ft;
    $('J-search').oninput = e => {
      clearTimeout(_ft);
      _ft = setTimeout(() => { S.filter = e.target.value.trim(); render(); }, 200);
    };

    // refresh
    $('J-refresh').onclick = () => { S.expanded = {}; load(true); };

    // ---- tabs: 简介 (B站原生右栏) / 评论 ------------------------------
    // Pure CSS switching via <html> classes — see architecture note 3.
    const setTab = mode => {
      S.tabMode = mode;
      const intro = mode === 'intro';
      document.documentElement.classList.toggle('bcs-intro-page', intro);
      $('J-tab-c').classList.toggle('on', !intro);
      $('J-tab-i').classList.toggle('on', intro);
      // the fixed panel needs a fresh dock whenever it becomes visible
      if (!intro && S.position) S.position();
    };
    S.setTab = setTab;
    $('J-tab-c').onclick = () => setTab('comments');
    $('J-tab-i').onclick = () => setTab('intro');
    setTab(S.defaultTab); // establish the html class before first paint

    // jump: scroll list to top
    $('J-jump').onclick = () => {
      const sc = $('J-scroll');
      if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' });
    };

    // infinite scroll: the list is its own scroll container; observe
    // the sentinel against that container so pages load near bottom
    const scroller = sb.querySelector('#J-scroll');
    new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !S.loading && S.hasMore) load(false);
    }, { root: scroller, rootMargin: '600px 0px' }).observe(sb.querySelector('#J-sentinel'));
  }

  /* ============================================================
     PAGE LAYOUT
     ============================================================ */

  // The native right column has its first cards — B站's mount window
  // is over; reading rects / docking now is safe.
  function rightSettled(rc) {
    return !!(rc.querySelector('.video-page-card-small') ||
              rc.querySelector('.up-panel-container') ||
              rc.querySelector('.video-pod'));
  }

  function positionSidebar() {
    const sb = document.getElementById('bili-comments-sidebar') || S.sb;
    const rc = document.querySelector('.right-container');
    if (!sb || !rc || !rightSettled(rc)) return false;
    const r = rc.getBoundingClientRect();
    if (r.width < 50 || r.height < 100) {
      // theater/wide mode restructured the layout — get out of the way
      if (sb.style.display !== 'none') sb.style.display = 'none';
      return true;
    }
    if (sb.style.display === 'none') sb.style.display = '';
    // height is content-driven (list capped by CSS at 75vh); only the
    // slot-following top + left/width are geometry we own
    const left = Math.round(r.left), top = Math.round(r.top);
    const w = Math.round(r.width);
    if (Number(sb.dataset.l) === left && Number(sb.dataset.t) === top &&
        Number(sb.dataset.w) === w) return true;
    sb.dataset.l = left; sb.dataset.t = top; sb.dataset.w = w;
    sb.style.left = left + 'px';
    sb.style.top = top + 'px';
    sb.style.width = w + 'px';
    sb.style.height = ''; // auto
    return true;
  }
  S.position = positionSidebar;

  let driftTimer = null, scrollHooked = false;
  function startDriftWatch() {
    if (driftTimer) return;
    // page scroll moves the slot -> move the panel with it (in-flow
    // feel); runs in BOTH modes — the tab bar is visible in intro too
    if (!scrollHooked) {
      scrollHooked = true;
      let ticking = false;
      window.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => { ticking = false; positionSidebar(); });
      }, { passive: true });
    }
    // cheap 1s check catches resize / SPA / theater drift of left+width
    driftTimer = setInterval(positionSidebar, 1000);
    window.addEventListener('resize', positionSidebar);
  }

  function applyLayout() {
    // bcs-layout class drives the right-column mode CSS in
    // sidebar.css; B站's own comment section below the player is
    // intentionally NOT hidden (v3.2) — it coexists with the sidebar.
    document.documentElement.classList.add('bcs-layout');
    startDriftWatch();
    if (!positionSidebar()) {
      // video area not rendered yet — retry until it appears
      const t = setInterval(() => {
        if (positionSidebar()) clearInterval(t);
      }, 500);
      setTimeout(() => clearInterval(t), 30000);
    }
  }

  /* ============================================================
     LOAD ROOT COMMENTS
     ============================================================ */
  async function load(reset) {
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
          // merge置顶 first, dedup against the normal page-1 items
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
      // ---- collapsed: expand button ----
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
  const LIKE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>`;
  const REPLY_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;

  function mkCard(c, isRoot) {
    const m = c.member || {};
    const ct = c.content || {};
    const isUp = S.upMid && String(m.mid) === String(S.upMid);
    const lv = m.level_info?.current_level || 0;
    const likes = c.like || 0;
    const rcount = c.rcount || 0;

    let body = fmtMsg(ct.message);
    body = applyEmotes(body, ct.emote);
    body = linkifyMentions(body, ct.members);
    body = linkifyTime(body);
    body = linkifyUrls(body);
    if (S.filter) body = highlight(body, S.filter);
    body += renderPictures(ct.pictures);

    const card = document.createElement('div');
    card.className = 'bcs-c';

    // header
    const avatarSrc = imgUrl(m.avatar, '@48w_48h.webp');
    const avatarFull = imgUrl(m.avatar);
    // clickable avatar & username -> user space page (space.bilibili.com/{mid})
    const spaceUrl = m.mid ? `https://space.bilibili.com/${m.mid}` : '';
    const avAttrs = spaceUrl
      ? `class="bcs-av-link" href="${spaceUrl}" target="_blank" rel="noopener noreferrer" title="查看 ${esc(m.uname || '该用户')} 的主页"`
      : 'style="display:contents"';

    const head = document.createElement('div');
    head.className = 'bcs-c-head';
    head.innerHTML = `
      <a ${avAttrs}><img class="bcs-av" src="${avatarSrc}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${avatarFull}'"/></a>
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

  function mkBtn(text, handler) {
    const btn = document.createElement('button');
    btn.className = 'bcs-more-btn';
    btn.textContent = text;
    btn.onclick = handler;
    return btn;
  }

  // Re-render one root thread after expand/collapse/sort change
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
     SPA NAVIGATION  (B站 swaps videos without reloading)
     ============================================================ */
  function watchUrl() {
    let last = location.href;
    new MutationObserver(() => {
      // Re-dock if B站 rebuilt the right column (rect changed)
      positionSidebar();
      if (location.href !== last) {
        last = location.href;
        S.oid = null; S.upMid = null;
        S.comments = []; S.page = 1;
        S.hasMore = true; S.expanded = {};
        if (S.setTab) S.setTab(S.defaultTab); // new video → user's default tab
        setTimeout(() => { load(true); }, 800);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ============================================================
     INIT
     ============================================================ */
  function init() {
    // read the default-tab preference BEFORE building the UI so the
    // first paint and the 💬 button state are already correct
    try {
      chrome.storage.local.get('_bcsDefaultTab', (r) => {
        if (r._bcsDefaultTab) S.defaultTab = r._bcsDefaultTab;
        boot();
      });
    } catch (e) {
      boot();
    }
  }

  function boot() {
    createUI();
    applyLayout();
    watchUrl();
    load(true);
  }

  console.log('[BCS] v3.4.1 ready');
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else
    init();

})();
