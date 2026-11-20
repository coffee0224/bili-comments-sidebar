/* ============================================================
   BCSLib — pure helpers for Bili Comments Sidebar (fork v3.0)

   Zero DOM access, zero chrome API: every function here is a pure
   string/data transform, unit-tested by tests/lib.test.js via
   `node --test`. In the extension this file is listed BEFORE
   content.js in manifest content_scripts.js — classic scripts share
   one isolated world, so content.js reads the top-level `BCSLib`
   binding directly. In Node the module guard makes it require()-able.
   ============================================================ */
const BCSLib = (() => {
  'use strict';

  /* ============================================================
     VIDEO IDENTITY
     ============================================================ */

  // '/video/BV1GJ411x7h7/?p=1' -> 'BV1GJ411x7h7'; anything else -> null
  function bvidFromPath(pathname) {
    const m = String(pathname).match(/\/video\/(BV[\w]+)/);
    return m ? m[1] : null;
  }

  /* Extract video info from the page's inline __INITIAL_STATE__ JSON.
     Content scripts live in an isolated world and cannot read
     window.__INITIAL_STATE__, but the inline <script> TAG is shared
     DOM — its textContent carries the same JSON. This survives
     view-API risk control (-404/-352/-403) on every hard page load.
     (On SPA navigation document.scripts still belongs to the first
     page, so callers fall back to the API path then.)
     `html` = concatenated <script> text, `bvid` = expected BV id,
     `fallbackTitle` = used when the title key is missing/empty. */
  function videoInfoFromHtml(html, bvid, fallbackTitle) {
    try {
      const s = String(html);
      const anchor = new RegExp('"aid"\\s*:\\s*(\\d+)\\s*,\\s*"bvid"\\s*:\\s*"' + bvid + '"');
      const m = s.match(anchor);
      if (!m) return null;
      const aid = m[1];
      const i = s.indexOf(m[0]);
      const seg = s.slice(i, i + 16000);

      const grab = (re) => { const mm = seg.match(re); return mm ? mm[1] : ''; };
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
      const stat = {
        view: num('view'), danmaku: num('danmaku'), reply: num('reply'),
        like: num('like'), coin: num('coin'), favorite: num('favorite'), share: num('share'),
      };

      return {
        aid,
        upMid: oMid || null,
        title: title || fallbackTitle || '',
        desc,
        pubdate,
        owner: oMid ? { mid: oMid, name: oName, face: oFace } : null,
        stat,
      };
    } catch (e) {
      return null;
    }
  }

  /* ============================================================
     COMMENT TREE
     Bilibili replies are max 2 levels; each reply carries `root`
     (root comment rpid) and `parent` (rpid it replies to). We build
     a nested tree from the flat list.
     ============================================================ */

  function buildTree(flatReplies, rootRpid, sortMode) {
    if (!flatReplies || flatReplies.length === 0) return [];

    const sorted = [...flatReplies];
    if (sortMode === 'hot') {
      sorted.sort((a, b) => (b.like || 0) - (a.like || 0));
    } else {
      sorted.sort((a, b) => (a.ctime || 0) - (b.ctime || 0));
    }

    const map = new Map();
    for (const r of sorted) {
      map.set(String(r.rpid), { ...r, _children: [] });
    }

    const roots = [];
    for (const r of sorted) {
      const node = map.get(String(r.rpid));
      const pid = String(r.parent);
      if (pid === String(rootRpid) || !map.has(pid)) {
        roots.push(node); // top-level reply (or orphan: parent not in page)
      } else {
        map.get(pid)._children.push(node);
      }
    }
    return roots;
  }

  /* ============================================================
     TEXT / HTML HELPERS
     ============================================================ */

  function timeAgo(ts, nowMs) {
    const d = (nowMs === undefined ? Date.now() : nowMs) / 1000 - ts;
    if (d < 60) return '刚刚';
    if (d < 3600) return (d / 60 | 0) + '分钟前';
    if (d < 86400) return (d / 3600 | 0) + '小时前';
    if (d < 2592000) return (d / 86400 | 0) + '天前';
    const o = new Date(ts * 1000);
    return `${o.getFullYear()}-${String(o.getMonth() + 1).padStart(2, '0')}-${String(o.getDate()).padStart(2, '0')}`;
  }

  // HTML-escape user text (&, <, > — same coverage the old DOM trick gave)
  function esc(t) {
    return String(t)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Bilibili CDN @Nw.webp suffix = resized WebP; strip any existing
  // suffix before adding the requested one
  function imgUrl(url, suffix) {
    if (!url) return '';
    url = url.replace(/^http:\/\//, 'https://');
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

  function fmtLike(n) { return n > 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }

  /* ============================================================
     TIMESTAMP LINKIFY
     mm:ss or h:mm:ss inside comment text becomes a clickable span.
     Only text runs are touched (mapTextRuns), never generated tags.
     ============================================================ */

  /* Scan every text run of an HTML fragment, INCLUDING the leading and
     trailing runs that have no surrounding tags (a comment whose whole
     text is one URL or one timestamp). Wrapping in '>...<' lets those
     edge runs match the tag-delimiter regex; wrapper is stripped after. */
  function mapTextRuns(html, fn) {
    return ('>' + html + '<')
      .replace(/>([^<]+)</g, (_, t) => '>' + fn(t) + '<')
      .slice(1, -1);
  }

  const TIME_RE = /\b(\d{1,3}:[0-5]\d(?::[0-5]\d)?)\b/g;

  function linkifyTime(html) {
    return mapTextRuns(html, t =>
      t.replace(TIME_RE, '<span class="bcs-time" data-t="$1">$1</span>'));
  }

  function parseTimeSec(t) {
    const p = t.split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  }

  // Wrap `kw` occurrences in <span class="bcs-hl">; regex metachars
  // in kw are escaped; only text runs are touched
  function highlight(html, kw) {
    if (!kw) return html;
    const r = new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return mapTextRuns(html, t => t.replace(r, '<span class="bcs-hl">$1</span>'));
  }

  /* ============================================================
     @MENTION LINKIFY
     B站 API 在 reply.content.members[] 里给出被 @ 用户的
     {mid, uname}。"@uname" 变成可点击 anchor 跳 space.bilibili.com。
     无 members 数据时退化为纯高亮（无链接）。
     输入是已转义 HTML：用 esc(uname) 做 split/join 匹配，
     不走正则，uname 中的正则元字符安全；只动文本段。
     ============================================================ */

  function mentionAnchor(mb) {
    const escd = esc(mb.uname);
    return `<a class="bcs-at" href="https://space.bilibili.com/${mb.mid}" ` +
      `target="_blank" rel="noopener noreferrer nofollow" title="查看 ${escd} 的主页">@${escd}</a>`;
  }

  function linkifyMentions(html, members) {
    const valid = (members || []).filter(m => m && m.mid && m.uname);
    if (valid.length === 0) return highlightAt(html);
    // Renamed users: message keeps the OLD handle ("@old_name") while
    // members[].uname is the new one — exact match fails. Members appear
    // in message order, so leftover @runs are zipped with leftover
    // members in order (shared across text runs via this pool).
    const pool = [];
    let poolIdx = 0;
    return mapTextRuns(html, (t) => {
      if (!t.includes('@')) return t;
      let out = t;
      const used = new Set();
      for (const mb of valid) {
        const target = '@' + esc(mb.uname);
        if (out.includes(target)) {
          out = out.split(target).join(mentionAnchor(mb));
          used.add(mb);
        }
      }
      const left = valid.filter(mb => !used.has(mb));
      if (left.length && pool.length === 0) pool.push(...left);
      out = out.replace(/(^|\s)@([^\s@，。,.；;]{1,30})/g, (m0, pre, name) => {
        const mb = pool[poolIdx++];
        return mb ? pre + `<a class="bcs-at" href="https://space.bilibili.com/${mb.mid}" ` +
          `target="_blank" rel="noopener noreferrer nofollow" title="查看 ${esc(mb.uname)} 的主页">@${name}</a>` : m0;
      });
      return out;
    });
  }

  // Fallback highlight when members[] is absent: an @name without a link.
  // @ must be at run start or after whitespace — emails (a@b.com) stay plain.
  const AT_NAME_RE = /(^|\s)@([\w\-.·\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]{1,30})/g;

  function highlightAt(html) {
    return mapTextRuns(html, t =>
      t.replace(AT_NAME_RE, '$1<span class="bcs-at">@$2</span>'));
  }

  /* ============================================================
     URL LINKIFY
     Raw http(s) URLs in comment text become clickable anchors
     (target=_blank, so B站's tab is left alone). Only text runs are
     touched (mapTextRuns) — tag attributes (img src etc.) are never
     modified. Trailing ASCII + 中文 punctuation is kept OUT of the link.
     Input is ALREADY HTML-escaped text: entities like &amp; inside
     a URL stay entities, which is valid in both href and display.
     ============================================================ */

  // ASCII-only URL chars: excludes quotes/brackets/angles (injection
  // safety) AND all non-ASCII (\u0080-\uffff), so 中文标号 like ，。）
  // naturally terminate the URL — comments never pad them with
  // spaces. Trailing ASCII punctuation (. , ; : ) ! ?) is legal in
  // URLs; URL_TAIL_RE moves it out of the link.
  const URL_RE = /(https?:\/\/[^\s"'<>\[\]\u0080-\uffff]+)/g;
  const URL_TAIL_RE = /[),.;:!?，。；：！？）】》」』"']+$/;

  function linkifyUrls(html) {
    return mapTextRuns(html, (t) => {
      if (!t.includes('://')) return t;
      return t.replace(URL_RE, (m) => {
        const url = m.replace(URL_TAIL_RE, '');
        const tail = m.slice(url.length);
        const a = `<a class="bcs-link" href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`;
        return tail ? a + tail : a;
      });
    });
  }

  /* ============================================================
     COMMENT CONTENT RICH RENDERING (string -> HTML)
     ============================================================ */

  // Replace [emote text] with CDN stickers (content.emote map)
  function applyEmotes(html, emote, escFn) {
    if (!emote) return html;
    const e = escFn || esc;
    for (const [k, v] of Object.entries(emote)) {
      const ek = e(k);
      const src = imgUrl(v.url, '@100w.webp');
      html = html.replaceAll(ek,
        `<img class="bcs-emote" src="${src}" alt="${ek}" title="${ek}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${imgUrl(v.url)}'"/>`
      );
    }
    return html;
  }

  // Thumbnails for user-uploaded pictures (content.pictures)
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

  return {
    bvidFromPath,
    videoInfoFromHtml,
    buildTree,
    timeAgo,
    esc,
    imgUrl,
    fmtMsg,
    fmtLike,
    TIME_RE,
    linkifyTime,
    linkifyUrls,
    linkifyMentions,
    highlightAt,
    parseTimeSec,
    highlight,
    applyEmotes,
    renderPictures,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BCSLib;
