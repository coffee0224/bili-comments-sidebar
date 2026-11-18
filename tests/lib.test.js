'use strict';
/* Unit tests for lib.js (pure helpers). Run: npm test  (node >= 18) */
const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../lib.js');

/* ---------- parseTimeSec ---------- */

test('parseTimeSec: mm:ss', () => {
  assert.strictEqual(L.parseTimeSec('12:34'), 12 * 60 + 34);
  assert.strictEqual(L.parseTimeSec('0:00'), 0);
  assert.strictEqual(L.parseTimeSec('99:59'), 99 * 60 + 59);
});

test('parseTimeSec: h:mm:ss', () => {
  assert.strictEqual(L.parseTimeSec('1:02:03'), 3600 + 2 * 60 + 3);
  assert.strictEqual(L.parseTimeSec('0:00:00'), 0);
});

/* ---------- fmtLike ---------- */

test('fmtLike boundaries (n > 10000, strict)', () => {
  assert.strictEqual(L.fmtLike(0), '0');
  assert.strictEqual(L.fmtLike(9999), '9999');
  assert.strictEqual(L.fmtLike(10000), '10000'); // strictly greater only
  assert.strictEqual(L.fmtLike(10001), '1.0万');
  assert.strictEqual(L.fmtLike(123456), '12.3万');
});

/* ---------- timeAgo ---------- */

test('timeAgo buckets with injected now', () => {
  const NOW = 1700000000000; // ms
  const ago = (sec) => L.timeAgo(NOW / 1000 - sec, NOW);
  assert.strictEqual(ago(30), '刚刚');
  assert.strictEqual(ago(61), '1分钟前');
  assert.strictEqual(ago(3600 + 10), '1小时前');
  assert.strictEqual(ago(86400 + 10), '1天前');
  assert.strictEqual(ago(29 * 86400), '29天前');
  // >= 30 days falls back to YYYY-MM-DD
  assert.match(ago(31 * 86400), /^\d{4}-\d{2}-\d{2}$/);
});

/* ---------- esc / fmtMsg ---------- */

test('esc escapes & < > only (same coverage as the old DOM trick)', () => {
  assert.strictEqual(L.esc('<script>&x</script>'), '&lt;script&gt;&amp;x&lt;/script&gt;');
});

test('fmtMsg escapes then converts newlines', () => {
  assert.strictEqual(L.fmtMsg('a\nb<c'), 'a<br>b&lt;c');
  assert.strictEqual(L.fmtMsg(''), '');
});

/* ---------- imgUrl ---------- */

test('imgUrl: http upgraded, suffix swapped', () => {
  assert.strictEqual(L.imgUrl('http://i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.strictEqual(L.imgUrl('http://i0.hdslb.com/a.jpg@100w.webp', '@48w'), 'https://i0.hdslb.com/a.jpg@48w');
  assert.strictEqual(L.imgUrl('https://i0.hdslb.com/a.jpg', '@48w_48h.webp'), 'https://i0.hdslb.com/a.jpg@48w_48h.webp');
  assert.strictEqual(L.imgUrl(''), '');
});

/* ---------- timestamp linkify ---------- */

test('linkifyTime wraps mm:ss and h:mm:ss, only between tags', () => {
  const out = L.linkifyTime('<p>看 12:34 很有意思</p>');
  assert.ok(out.includes('data-t="12:34"'));
  assert.ok(out.includes('bcs-time'));
  const h = L.linkifyTime('<p>1:02:03</p>');
  assert.ok(h.includes('data-t="1:02:03"'));
});

test('linkifyTime leaves plain digits and non-timestamps alone', () => {
  const out = L.linkifyTime('<p>12345 和 99:99</p>');
  assert.ok(!out.includes('bcs-time'), '12345 must not linkify; 99:99 has invalid minutes');
});

/* ---------- highlight ---------- */

test('highlight escapes regex metachars in the keyword', () => {
  const out = L.highlight('<p>a.c abc</p>', 'a.c');
  assert.ok(out.includes('<span class="bcs-hl">a.c</span>'));
  assert.ok(!out.includes('bcs-hl">abc'), 'dot must not act as wildcard');
});

/* ---------- buildTree ---------- */

const R0 = 100;
const mk = (rpid, parent, like, ctime) => ({ rpid, parent, root: R0, like, ctime });

test('buildTree: hot sort orders roots by like desc', () => {
  const tree = L.buildTree([mk(1, R0, 1, 300), mk(2, R0, 50, 100), mk(3, R0, 9, 200)], R0, 'hot');
  assert.deepStrictEqual(tree.map(n => n.rpid), [2, 3, 1]);
});

test('buildTree: time sort orders roots by ctime asc', () => {
  const tree = L.buildTree([mk(1, R0, 1, 300), mk(2, R0, 50, 100), mk(3, R0, 9, 200)], R0, 'time');
  assert.deepStrictEqual(tree.map(n => n.rpid), [2, 3, 1]);
});

test('buildTree: nests children under their parent', () => {
  const tree = L.buildTree([mk(1, R0, 5, 10), mk(2, 1, 1, 20), mk(3, 2, 1, 30)], R0, 'time');
  assert.strictEqual(tree.length, 1);
  assert.strictEqual(tree[0].rpid, 1);
  assert.strictEqual(tree[0]._children.length, 1);
  assert.strictEqual(tree[0]._children[0].rpid, 2);
  assert.strictEqual(tree[0]._children[0]._children[0].rpid, 3);
});

test('buildTree: orphan (parent not in list) becomes a root', () => {
  const tree = L.buildTree([mk(9, 888, 1, 1)], R0, 'hot');
  assert.strictEqual(tree.length, 1);
  assert.strictEqual(tree[0].rpid, 9);
});

test('buildTree: empty input', () => {
  assert.deepStrictEqual(L.buildTree([], R0, 'hot'), []);
  assert.deepStrictEqual(L.buildTree(null, R0, 'hot'), []);
});

/* ---------- bvidFromPath ---------- */

test('bvidFromPath', () => {
  assert.strictEqual(L.bvidFromPath('/video/BV1GJ411x7h7/'), 'BV1GJ411x7h7');
  assert.strictEqual(L.bvidFromPath('/video/BV1GJ411x7h7/?p=1'), 'BV1GJ411x7h7');
  assert.strictEqual(L.bvidFromPath('/video/av12345'), null);
  assert.strictEqual(L.bvidFromPath('/'), null);
});

/* ---------- videoInfoFromHtml ---------- */

// Realistic __INITIAL_STATE__ slice (structure mirrors bilibili's
// video page; \uXXXX escapes appear exactly as in the real payload)
const FIXTURE = `<script>window.__INITIAL_STATE__={"aid":80433022,"bvid":"BV1GJ411x7h7",` +
  `"videoData":{"aid":80433022,"bvid":"BV1GJ411x7h7","title":"\\u3010\\u5b98\\u65b9 MV\\u3011Never Gonna Give You Up",` +
  `"desc":"line1\\nline2","pubdate":1577779200,` +
  `"owner":{"mid":486906719,"name":"\\u7d22\\u5c3c\\u97f3\\u4e50\\u4e2d\\u56fd","face":"http://i0.hdslb.com/bfs/face/a.jpg"},` +
  `"stat":{"aid":80433022,"view":108656388,"danmaku":152231,"reply":241347,"like":2982887,"coin":1296141,"favorite":1569881,"share":508407}}};</script>`;

test('videoInfoFromHtml extracts aid/owner/stat from __INITIAL_STATE__', () => {
  const info = L.videoInfoFromHtml(FIXTURE, 'BV1GJ411x7h7', 'fallback');
  assert.ok(info);
  assert.strictEqual(info.aid, '80433022');
  assert.strictEqual(info.upMid, '486906719');
  assert.strictEqual(info.title, '【官方 MV】Never Gonna Give You Up');
  assert.strictEqual(info.owner.name, '索尼音乐中国');
  assert.strictEqual(info.desc, 'line1\nline2');
  assert.strictEqual(info.pubdate, 1577779200);
  assert.strictEqual(info.stat.view, 108656388);
  assert.strictEqual(info.stat.reply, 241347);
  assert.strictEqual(info.stat.share, 508407);
});

test('videoInfoFromHtml: no match -> null; missing title -> fallback', () => {
  assert.strictEqual(L.videoInfoFromHtml('<html>nothing</html>', 'BV1x', 'fb'), null);
  const minimal = `{"aid":7,"bvid":"BV7","pubdate":1}`;
  const info = L.videoInfoFromHtml(minimal, 'BV7', 'FALLBACK TITLE');
  assert.ok(info);
  assert.strictEqual(info.aid, '7');
  assert.strictEqual(info.title, 'FALLBACK TITLE');
  assert.strictEqual(info.owner, null);
});

/* ---------- applyEmotes / renderPictures ---------- */

test('applyEmotes replaces escaped emote keys with <img>', () => {
  const emote = { '[doge]': { url: 'http://i0.hdslb.com/bfs/emote/d.png' } };
  const out = L.applyEmotes('<p>[doge]</p>', emote);
  assert.ok(out.includes('bcs-emote'));
  assert.ok(out.includes('https://i0.hdslb.com/bfs/emote/d.png@100w.webp'));
  assert.ok(!out.includes('[doge]</p>'), 'raw key should be consumed');
  assert.strictEqual(L.applyEmotes('<p>x</p>', null), '<p>x</p>');
});

test('renderPictures builds thumbnail links', () => {
  assert.strictEqual(L.renderPictures([]), '');
  assert.strictEqual(L.renderPictures(null), '');
  const out = L.renderPictures([{ img_src: 'http://i0.hdslb.com/bfs/p1.jpg' }]);
  assert.ok(out.includes('bcs-pic-link'));
  assert.ok(out.includes('@360w.webp'));
});

/* ---------- linkifyUrls ---------- */

test('linkifyUrls wraps raw http(s) URLs between tags', () => {
  const out = L.linkifyUrls('>看这个 https://a.com/x 很好<');
  assert.ok(out.includes('<a class="bcs-link" href="https://a.com/x" target="_blank"'));
  assert.ok(out.includes('>https://a.com/x</a>'));
  assert.ok(!out.includes('href="看这个'));
});

test('linkifyUrls keeps trailing punctuation out of the link', () => {
  const out = L.linkifyUrls('>https://a.com/p1，下句<');
  assert.ok(out.includes('href="https://a.com/p1"'));
  assert.ok(out.endsWith('，下句<'));
  const out2 = L.linkifyUrls('>见 https://b.com。<');
  assert.ok(out2.includes('href="https://b.com"'));
  assert.ok(out2.includes('</a>。<'));
});

test('linkifyUrls never touches tag attributes or non-URL text', () => {
  const html = '<img src="https://cdn.example/e.png" alt="e">官网 www.a.com 逛逛<';
  const out = L.linkifyUrls(html);
  assert.ok(out.startsWith('<img src="https://cdn.example/e.png" alt="e">'),
    'attribute must stay untouched');
  assert.ok(!out.includes('href="www.a.com"'), 'no scheme -> no link');
  assert.ok(!out.includes('href="https://cdn.example'), 'tag URL must not be linkified');
});

test('linkifyUrls handles query strings with escaped entities', () => {
  // input is already HTML-escaped: & became &amp;
  const out = L.linkifyUrls('>https://a.com/s?x=1&amp;y=2 end<');
  assert.ok(out.includes('href="https://a.com/s?x=1&amp;y=2"'));
});

test('linkifyUrls leaves text without :// alone', () => {
  const html = '<p>plain 12:34 text</p>';
  assert.strictEqual(L.linkifyUrls(html), html);
});

/* ---------- bare/whole-string inputs (mapTextRuns edge) ---------- */

test('linkifyUrls linkifies a comment that is ONLY a URL (b23.tv case)', () => {
  const out = L.linkifyUrls('https://b23.tv/mall-XFTMs-2tGzn');
  assert.ok(out.startsWith('<a class="bcs-link" href="https://b23.tv/mall-XFTMs-2tGzn"'));
  assert.ok(out.endsWith('</a>'));
});

test('linkifyTime linkifies a whole-string timestamp (no surrounding tags)', () => {
  const out = L.linkifyTime('12:34');
  assert.strictEqual(out, '<span class="bcs-time" data-t="12:34">12:34</span>');
});

test('mapTextRuns edge: empty string and tag-only fragments survive', () => {
  assert.strictEqual(L.linkifyUrls(''), '');
  assert.strictEqual(L.linkifyUrls('<br>'), '<br>');
  assert.strictEqual(L.linkifyTime('<br><br>'), '<br><br>');
});

test('highlight matches when keyword spans the whole string', () => {
  const out = L.highlight('bili', 'bili');
  assert.strictEqual(out, '<span class="bcs-hl">bili</span>');
});
