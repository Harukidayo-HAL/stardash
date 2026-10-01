/*
 * render.js — 描画はすべてここ（デザイナーが差し替える場所）
 * 仕様書11章の関数名。オブジェクトは x, y を中心座標で持つ。
 * ctx は論理座標（360×640）に変換済みの状態で渡される。
 * 各関数は ctx の状態を save/restore で元に戻すこと。
 * 当たり判定は CONFIG の hitRadius で決まるので、絵の大きさを変えても判定は変わらない。
 *
 * v2 ネオン調（デザイナー / 2026-10-01、ディレクター承認済み。元ドラフト: assets/neon-draft/render-neon.js）
 * - ゲーム内の絵（背景・自機・弾・敵・ボス・星・エフェクト・バナー）はネオン版
 * - HUD / タイトル / ポーズ / リザルト（drawHUD, drawTitle, drawPause, drawGameOver, drawClear,
 *   drawTitleButtonShape など）は v1.1 のまま（読みやすさ優先で変更なし）
 * - 性能: shadowBlur は初回にオフスクリーン canvas へ焼き込むだけ。毎フレームは drawImage のみ
 */

/* ===== 共通ヘルパー（HUD・リザルト用。v1.1 から変更なし） ===== */
function _text(ctx, str, x, y, size, color, align) {
  ctx.fillStyle = color || '#fff';
  ctx.font = 'bold ' + size + 'px ' + CONFIG.ui.font;
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
}

function _poly(ctx, cx, cy, rx, ry, sides, rotation) {
  ctx.beginPath();
  for (var i = 0; i < sides; i++) {
    var a = rotation + i * Math.PI * 2 / sides;
    var px = cx + Math.cos(a) * rx, py = cy + Math.sin(a) * ry;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/* ===== ネオン調のゲーム内描画 ===== */
/* ===== 調整値（色はCONFIGの系統を維持し、ネオン用の補助色だけここに置く） ===== */
var NEON = {
  spriteScale: (typeof window !== 'undefined' && window.NEON_SPRITE_SCALE) || 3, // 焼き込み解像度（論理pxの何倍か）
  lineWidth: 2,
  glowBlur: 6,           // グローのぼかし量（論理px）。控えめ
  glowAlpha: 0.55,       // グローの濃さ（白飛び防止）
  bodyFillAlpha: 0.18,   // 敵・自機の内側の塗り（暗いガラス感）
  bg: { gridColor: 'rgba(60,90,160,0.10)', gridSize: 40, starTint: [150, 170, 210], starAlphaMul: 0.45 },
  enemyBullet: { ring: 'rgba(8,0,14,0.95)', ringWidth: 2, glowColor: '#f8c', glowAlpha: 0.35, core: '#fff' },
  // 爆発色。ボス系は敵弾ピンク（#f8c）と色相が被らない金/橙にする（テスターレビュー 2026-10-01）
  explosion: { enemy: '#fc6', player: '#4ff', boss: '#ffb347', bossBig: '#fff0b8' },
  // 敵Bの線色：CONFIG の #c5f は他の敵より暗く見えるので描画側で一段明るく（ディレクター指示）
  enemyColor: { B: '#d68cff' },
  // ボス：外枠はCONFIGのマゼンタのまま、中は暗く塗り、コアは白でもピンクでもない琥珀色
  boss: { bodyFill: 'rgba(28,4,24,0.88)', coreRing: '#ffb020', coreDark: '#2a1200', corePupil: '#ffc84a' },
  // 星アイテム：自機弾（#ff4 黄緑寄り）と区別するため、暖かい金〜橙のグラデで塗りつぶす
  star: { edge: '#ffb23a', fillInner: '#fff1a8', fillOuter: '#ffa526', pulseHz: 0.8 }
};
var _neonTime = 0;   // drawBackground の t を保存（一時停止中は止まる）。星の明滅に使う

/* ===== スプライトキャッシュ ===== */
var _neonCache = {};
function _neonSprite(key, w, h, pad, drawFn) {
  var s = _neonCache[key];
  if (s) return s;
  var S = NEON.spriteScale;
  var cw = w + pad * 2, ch = h + pad * 2;
  var c = document.createElement('canvas');
  c.width = Math.ceil(cw * S); c.height = Math.ceil(ch * S);
  var g = c.getContext('2d');
  g.scale(S, S);
  g.translate(cw / 2, ch / 2);          // 原点 = スプライト中心
  drawFn(g, S);
  s = { canvas: c, w: cw, h: ch };
  _neonCache[key] = s;
  return s;
}
function _neonBlit(ctx, spr, x, y) {
  ctx.drawImage(spr.canvas, x - spr.w / 2, y - spr.h / 2, spr.w, spr.h);
}

function _neonPath(g, pts) {
  g.beginPath();
  for (var i = 0; i < pts.length; i++) { if (i === 0) g.moveTo(pts[i][0], pts[i][1]); else g.lineTo(pts[i][0], pts[i][1]); }
  g.closePath();
}
function _neonPoly(rx, ry, sides, rot) {
  var p = [];
  for (var i = 0; i < sides; i++) { var a = rot + i * Math.PI * 2 / sides; p.push([Math.cos(a) * rx, Math.sin(a) * ry]); }
  return p;
}
function _rgba(hex, a) {
  var h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var n = parseInt(h, 16);
  return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
}

/* ネオン線：①ぼかしたグロー（1回だけ焼く）②くっきりした本線 ③細い白っぽい芯 */
function _neonStroke(g, S, pathFn, color, lw, opt) {
  opt = opt || {};
  lw = lw || NEON.lineWidth;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  if (opt.fill) { pathFn(); g.fillStyle = opt.fill; g.fill(); }
  // ① グロー
  g.shadowColor = _rgba(color, opt.glowAlpha != null ? opt.glowAlpha : NEON.glowAlpha);
  g.shadowBlur = (opt.blur != null ? opt.blur : NEON.glowBlur) * S;
  g.strokeStyle = _rgba(color, 0.6);
  g.lineWidth = lw;
  pathFn(); g.stroke();
  g.shadowBlur = 0; g.shadowColor = 'transparent';
  // ② 本線
  g.strokeStyle = color; g.lineWidth = lw;
  pathFn(); g.stroke();
  // ③ 芯（明るさの“抜け”。白にはしない）
  if (opt.core !== false) {
    g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = Math.max(0.6, lw * 0.35);
    pathFn(); g.stroke();
  }
  g.restore();
}

/* ===== 背景 ===== */
var _neonBgStars = null;
function _neonInitBg() {
  var W = CONFIG.screen.width, H = CONFIG.screen.height;
  var seed = 12345;
  function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  _neonBgStars = CONFIG.background.layers.map(function (layer) {
    var arr = [];
    for (var i = 0; i < layer.count; i++) arr.push({ x: rnd() * W, y: rnd() * H, tw: rnd() });
    return arr;
  });
}
function drawBackground(ctx, t) {
  var W = CONFIG.screen.width, H = CONFIG.screen.height, B = CONFIG.background, nb = NEON.bg;
  if (!_neonBgStars) _neonInitBg();
  _neonTime = t;
  ctx.save();
  var grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, B.colorTop);
  grad.addColorStop(1, B.colorBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // ごく薄いグリッド（ゆっくり流れる）。1回の stroke にまとめる
  var gs = nb.gridSize, off = (t * 20) % gs;
  ctx.strokeStyle = nb.gridColor; ctx.lineWidth = 1;
  ctx.beginPath();
  for (var x = gs / 2; x < W; x += gs) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (var y = off - gs; y < H; y += gs) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  // 流れる星：くすんだ青灰色・低い不透明度（弾と見間違えないように）
  var c = nb.starTint;
  B.layers.forEach(function (layer, li) {
    ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (layer.alpha * nb.starAlphaMul) + ')';
    var stars = _neonBgStars[li], sz = layer.size;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var yy = (s.y + layer.speed * t) % H;
      ctx.fillRect(s.x, yy, sz, sz * (li === 2 ? 2 : 1)); // 一番手前の層だけ少し縦に伸ばして“流れ”を出す
    }
  });
  ctx.restore();
}

/* ===== 自機 ===== */
function _neonPlayerSprite() {
  var P = CONFIG.player, w = P.width, h = P.height;
  return _neonSprite('player', w, h, 10, function (g, S) {
    var pts = [[0, -h / 2], [w / 2, h / 2], [0, h / 2 - 6], [-w / 2, h / 2]]; // 矢じり型（三角形の下に切れ込み）
    _neonStroke(g, S, function () { _neonPath(g, pts); }, P.color, 2, { fill: _rgba(P.color, NEON.bodyFillAlpha) });
    // 中心の小さな白点 = 当たり判定の位置の目安（半径は判定より小さい）
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.arc(0, 0, 2, 0, Math.PI * 2); g.fill();
  });
}
function drawPlayer(ctx, player) {
  var P = CONFIG.player;
  if (player.dead) return;
  ctx.save();
  // 無敵中の点滅：消すのではなく薄くする（チカチカを抑える）
  if (player.invincible > 0 && Math.floor(player.invincible / P.blinkInterval) % 2 === 1) ctx.globalAlpha = 0.3;
  _neonBlit(ctx, _neonPlayerSprite(), player.x, player.y);
  ctx.restore();
}

/* ===== 自機弾：黄色の細長いカプセル ===== */
function drawPlayerBullet(ctx, b) {
  var C = CONFIG.playerBullet, w = C.width, h = C.height;
  var spr = _neonSprite('pbullet', w, h, 4, function (g, S) {
    function cap() { var r = w / 2; g.beginPath(); g.moveTo(-r, -h / 2 + r); g.arc(0, -h / 2 + r, r, Math.PI, 0); g.lineTo(r, h / 2 - r); g.arc(0, h / 2 - r, r, 0, Math.PI); g.closePath(); }
    g.save();
    g.shadowColor = _rgba(C.color, 0.45); g.shadowBlur = 3 * S;
    g.fillStyle = C.color; cap(); g.fill();
    g.restore();
    g.fillStyle = 'rgba(255,255,230,0.9)';
    g.fillRect(-0.6, -h / 2 + 2, 1.2, h - 4);   // 芯
  });
  ctx.save();
  ctx.globalAlpha = 0.85;  // 敵弾より一段控えめ
  _neonBlit(ctx, spr, b.x, b.y);
  ctx.restore();
}

/* ===== 敵弾：最優先で目立たせる ===== */
function drawEnemyBullet(ctx, b) {
  var C = CONFIG.enemyBullet, N = NEON.enemyBullet, r = C.diameter / 2;
  var spr = _neonSprite('ebullet', C.diameter, C.diameter, 6, function (g, S) {
    // 外側：ピンクのにじみ（薄く）
    var rg = g.createRadialGradient(0, 0, r, 0, 0, r + 5);
    rg.addColorStop(0, _rgba(N.glowColor, N.glowAlpha)); rg.addColorStop(1, _rgba(N.glowColor, 0));
    g.fillStyle = rg; g.beginPath(); g.arc(0, 0, r + 5, 0, Math.PI * 2); g.fill();
    // 暗い縁取りリング（どんな背景・敵・エフェクトの上でも輪郭が切れる）
    g.strokeStyle = N.ring; g.lineWidth = N.ringWidth;
    g.beginPath(); g.arc(0, 0, r + N.ringWidth / 2, 0, Math.PI * 2); g.stroke();
    // 本体：明るいピンク
    g.fillStyle = C.color; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    // 白い芯
    var cg = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.7);
    cg.addColorStop(0, N.core); cg.addColorStop(0.6, N.core); cg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = cg; g.beginPath(); g.arc(0, 0, r * 0.7, 0, Math.PI * 2); g.fill();
  });
  _neonBlit(ctx, spr, b.x, b.y);
}

/* ===== 敵 ===== */
function _neonEnemySprite(type, flash) {
  var T = CONFIG.enemy.types[type], w = T.width, h = T.height;
  var base = NEON.enemyColor[type] || T.color;
  var col = flash ? '#fff' : base;
  var fill = flash ? 'rgba(255,255,255,0.25)' : _rgba(base, type === 'B' ? 0.26 : NEON.bodyFillAlpha);
  return _neonSprite('enemy' + type + (flash ? 'F' : ''), w, h, 10, function (g, S) {
    var o = { fill: fill, glowAlpha: flash ? 0.5 : NEON.glowAlpha };
    if (type === 'A') {
      // 角を少し落とした四角＋内側の小さな菱形
      var k = 2.5, a = w / 2 - 1, bb = h / 2 - 1;
      var pts = [[-a + k, -bb], [a - k, -bb], [a, -bb + k], [a, bb - k], [a - k, bb], [-a + k, bb], [-a, bb - k], [-a, -bb + k]];
      _neonStroke(g, S, function () { _neonPath(g, pts); }, col, 2, o);
      _neonStroke(g, S, function () { _neonPath(g, _neonPoly(3.5, 3.5, 4, 0)); }, col, 1.2, { blur: 2, core: false });
    } else if (type === 'B') {
      // 菱形＋内側の菱形（目）
      o.glowAlpha = flash ? 0.5 : 0.7;   // 紫は暗く見えやすいので少しだけグロー強め
      _neonStroke(g, S, function () { _neonPath(g, _neonPoly(w / 2 - 1, h / 2 - 1, 4, -Math.PI / 2)); }, col, 2.4, o);
      _neonStroke(g, S, function () { _neonPath(g, _neonPoly(4.5, 4.5, 4, -Math.PI / 2)); }, col, 1.5, { blur: 2 });
    } else {
      // 六角形の砲台：外枠＋内側の円＋下向きの砲身
      _neonStroke(g, S, function () { _neonPath(g, _neonPoly(w / 2 - 1, h / 2 - 1, 6, 0)); }, col, 2.2, o);
      _neonStroke(g, S, function () { g.beginPath(); g.arc(0, 0, 9, 0, Math.PI * 2); }, col, 1.6, { blur: 3 });
      _neonStroke(g, S, function () { g.beginPath(); g.moveTo(-3, 6); g.lineTo(-3, 15); g.lineTo(3, 15); g.lineTo(3, 6); }, col, 1.4, { blur: 2, core: false });
    }
  });
}
function drawEnemy(ctx, enemy) {
  if (!CONFIG.enemy.types[enemy.type]) return;
  _neonBlit(ctx, _neonEnemySprite(enemy.type, enemy.flash > 0), enemy.x, enemy.y);
}

/* ===== ボス ===== */
function _neonBossSprite(flash) {
  var B = CONFIG.boss, w = B.width, h = B.height;
  var col = flash ? '#fff' : B.color;
  return _neonSprite('boss' + (flash ? 'F' : ''), w, h, 14, function (g, S) {
    var hw = w / 2 - 1, hh = h / 2 - 1, k = 22;
    var outer = [[-hw, 0], [-hw + k, -hh], [hw - k, -hh], [hw, 0], [hw - k, hh], [-hw + k, hh]];
    // 本体は暗く塗る（敵弾のピンク本体と暗いリングが上で読めるように）
    _neonStroke(g, S, function () { _neonPath(g, outer); }, col, 2.5, { fill: flash ? 'rgba(90,60,80,0.9)' : NEON.boss.bodyFill, glowAlpha: 0.45 });
    // 内側の装甲ライン
    var ihw = hw - 12, ihh = hh - 9, ik = 14;
    _neonStroke(g, S, function () { _neonPath(g, [[-ihw, 0], [-ihw + ik, -ihh], [ihw - ik, -ihh], [ihw, 0], [ihw - ik, ihh], [-ihw + ik, ihh]]); }, col, 1.2, { blur: 2, core: false, glowAlpha: 0.35 });
    // 左右の砲口
    [-1, 1].forEach(function (sd) {
      _neonStroke(g, S, function () { g.beginPath(); g.arc(sd * 38, 6, 4, 0, Math.PI * 2); }, col, 1.4, { blur: 2, core: false });
    });
    // コア：白やピンクにしない（白芯・ピンクの敵弾が上に重なっても消えないように）。
    // 暗い中心＋琥珀色のリング＋小さな琥珀の瞳。CONFIG.boss.coreColor(#fff) は使わない
    var cr = h / 4, NB = NEON.boss, ccol = flash ? '#fff' : NB.coreRing;
    g.fillStyle = NB.coreDark; g.beginPath(); g.arc(0, 0, cr, 0, Math.PI * 2); g.fill();
    _neonStroke(g, S, function () { g.beginPath(); g.arc(0, 0, cr - 1.5, 0, Math.PI * 2); }, ccol, 2.4, { blur: 4, glowAlpha: 0.5 });
    g.fillStyle = flash ? '#fff' : NB.corePupil;
    g.beginPath(); g.arc(0, 0, cr * 0.28, 0, Math.PI * 2); g.fill();
  });
}
function drawBoss(ctx, boss) {
  _neonBlit(ctx, _neonBossSprite(boss.flash > 0), boss.x, boss.y);
}

/* ===== 星（スコアアイテム）：塗りつぶした金の五芒星 =====
 * CONFIG.star.size は「見た目の直径」（20px = 判定半径10と一致）。外側の頂点までの半径 = size/2
 * 自機弾（黄緑寄りの #ff4）と区別するため、暖かい金〜橙のグラデで塗る。ゆっくり明るさが脈動（約0.8Hz、明滅ではない） */
function _neonStarPts(R, r) {
  var pts = [];
  for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R; pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
  return pts;
}
function drawStar(ctx, star) {
  var C = CONFIG.star, N = NEON.star;
  var R = C.size / 2 - 1, r = R * 0.48;   // 線の太さ分だけ内側に（外形 ≒ 直径20）
  var spr = _neonSprite('star', C.size, C.size, 6, function (g, S) {
    var pts = _neonStarPts(R, r);
    var fg = g.createRadialGradient(0, -1, 0, 0, 0, R);
    fg.addColorStop(0, N.fillInner); fg.addColorStop(0.45, C.color); fg.addColorStop(1, N.fillOuter);
    _neonStroke(g, S, function () { _neonPath(g, pts); }, N.edge, 2, { fill: fg, blur: 4, glowAlpha: 0.45, core: false });
    g.fillStyle = fg; _neonPath(g, _neonStarPts(R - 1.2, r - 0.6)); g.fill();
  });
  var halo = _neonSprite('starHalo', C.size, C.size, 8, function (g, S) {
    var hg = g.createRadialGradient(0, 0, 2, 0, 0, C.size / 2 + 7);
    hg.addColorStop(0, _rgba(N.fillOuter, 0.55)); hg.addColorStop(1, _rgba(N.fillOuter, 0));
    g.fillStyle = hg; g.beginPath(); g.arc(0, 0, C.size / 2 + 7, 0, Math.PI * 2); g.fill();
  });
  var pulse = 0.5 + 0.5 * Math.sin(_neonTime * Math.PI * 2 * N.pulseHz + star.x * 0.05);
  ctx.save();
  ctx.translate(star.x, star.y);
  ctx.globalAlpha = 0.25 + 0.35 * pulse;       // にじみだけを 0.25〜0.6 でゆっくり脈動
  _neonBlit(ctx, halo, 0, 0);
  ctx.globalAlpha = 1;
  ctx.rotate(Math.sin(star.y * 0.03) * 0.35);  // 落下に合わせてゆらゆら
  _neonBlit(ctx, spr, 0, 0);
  ctx.restore();
}

/* ===== エフェクト：輪と線の破片だけ。塗りつぶしの白い円は使わない ===== */
function _neonExplosionColor(type) {
  var E = NEON.explosion;
  if (type === 'player_explosion') return E.player;
  if (type === 'boss_explosion_small') return E.boss;
  if (type === 'boss_explosion_big') return E.bossBig;
  return E.enemy;
}
function drawEffect(ctx, e) {
  var k = Math.min(1, e.t / e.duration);
  var fade = 1 - k;
  ctx.save();
  ctx.lineCap = 'round';
  if (e.type === 'hit') {
    // 被弾フラッシュ：細い白リングが一瞬広がって消える
    ctx.globalAlpha = 0.6 * fade;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(e.x, e.y, e.size * (0.7 + 0.5 * k), 0, Math.PI * 2); ctx.stroke();
  } else {
    var col = _neonExplosionColor(e.type);
    var ease = 1 - (1 - k) * (1 - k);
    var R = e.size * (0.35 + 0.9 * ease);
    // 外側のリング（太め→細め）
    ctx.globalAlpha = 0.75 * fade;
    ctx.strokeStyle = col; ctx.lineWidth = 2.5 * fade + 0.5;
    ctx.beginPath(); ctx.arc(e.x, e.y, R, 0, Math.PI * 2); ctx.stroke();
    // 破片（座標からシードを作って毎回同じ形）
    var n = e.type === 'boss_explosion_big' ? 16 : 10;
    var seed = Math.floor(e.x * 7 + e.y * 13) % 360;
    ctx.globalAlpha = 0.85 * fade;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + (seed + i * 37 % 11) * 0.02;
      var d0 = R * (0.5 + 0.25 * ((i * 53 + seed) % 7) / 7), d1 = d0 + e.size * 0.35 * fade;
      ctx.moveTo(e.x + Math.cos(a) * d0, e.y + Math.sin(a) * d0);
      ctx.lineTo(e.x + Math.cos(a) * d1, e.y + Math.sin(a) * d1);
    }
    ctx.stroke();
    // 中心のごく薄いにじみ（序盤のみ、低い不透明度）
    if (k < 0.4) {
      ctx.globalAlpha = 0.18 * (1 - k / 0.4);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(e.x, e.y, R * 0.45, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

/* ===== バナー（PHASE 2 / PHASE 3 / WARNING） =====
 * 点滅はオン/オフではなく、ゆるやかな明るさの脈動（チカチカ防止）。文字のグローは文字列ごとに1回だけ焼く */
function _neonBannerSprite(text) {
  var U = CONFIG.ui, warn = text === 'WARNING';
  var col = warn ? '#f45' : '#4ff';
  var fs = U.bannerFontSize + 4, w = CONFIG.screen.width, h = fs * 2.2;
  return _neonSprite('banner_' + text, w, h, 0, function (g, S) {
    g.font = 'bold ' + fs + 'px ' + U.font;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (warn) {
      // 上下の細いライン＋斜線の帯
      g.fillStyle = 'rgba(255,40,80,0.125)'; g.fillRect(-w / 2, -h / 2 + 4, w, h - 8); // 帯は元の0.25の半分（敵弾は main.js で最前面に描かれる）
      _neonStroke(g, S, function () { g.beginPath(); g.moveTo(-w / 2, -h / 2 + 4); g.lineTo(w / 2, -h / 2 + 4); g.moveTo(-w / 2, h / 2 - 4); g.lineTo(w / 2, h / 2 - 4); }, col, 1.5, { blur: 4, core: false });
      g.save(); g.beginPath(); g.rect(-w / 2, -h / 2 + 6, w, 6); g.rect(-w / 2, h / 2 - 12, w, 6); g.clip();
      g.strokeStyle = 'rgba(255,70,100,0.25)'; g.lineWidth = 2;
      for (var x = -w / 2 - 20; x < w / 2 + 20; x += 10) { g.beginPath(); g.moveTo(x, h / 2); g.lineTo(x + 20, -h / 2); g.stroke(); }
      g.restore();
    }
    g.save();
    g.shadowColor = _rgba(col, 0.7); g.shadowBlur = 8 * S;
    g.lineWidth = 2.5; g.strokeStyle = col; g.strokeText(text, 0, 0);
    g.restore();
    // 文字は塗らずに中抜き（輪郭だけ）。WARNING/PHASE 表示中も文字の後ろの敵弾が見えるように
    g.lineWidth = 1; g.strokeStyle = warn ? 'rgba(255,225,230,0.95)' : 'rgba(225,255,255,0.95)';
    g.strokeText(text, 0, 0);
  });
}
function drawBanner(ctx, text, t, duration) {
  var S = CONFIG.screen, warn = text === 'WARNING';
  var a;
  if (warn) a = 0.65 + 0.25 * Math.cos(t * Math.PI * 2 * 1.5);          // 1.5Hz のゆるい脈動 0.4〜0.9
  else {
    var d = duration || CONFIG.stage.phaseBannerTime;
    a = Math.min(1, t / 0.15, Math.max(0, (d - t) / 0.25));        // フェードイン/アウト
  }
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  _neonBlit(ctx, _neonBannerSprite(text), S.width / 2, S.height / 2);
  ctx.restore();
}

/* ===== HUD・タイトル・ポーズ・リザルト（v1.1 のまま） ===== */
function drawHUD(ctx, state) {
  var U = CONFIG.ui, S = CONFIG.screen, P = CONFIG.player;
  ctx.save();
  _text(ctx, String(state.score), U.hudMargin, U.hudMargin + U.hudFontSize / 2, U.hudFontSize, '#fff', 'left');
  _text(ctx, 'HI ' + Math.max(state.hiScore, state.score), S.width / 2, U.hudMargin + U.hudFontSize / 2, U.hudFontSize, '#ccc', 'center');
  // ライフ（左下）
  ctx.fillStyle = P.color;
  for (var i = 0; i < state.lives; i++) {
    var cx = U.hudMargin + U.lifeIconSize / 2 + i * (U.lifeIconSize + U.lifeIconGap);
    var cy = S.height - U.hudMargin - U.lifeIconSize / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - U.lifeIconSize / 2);
    ctx.lineTo(cx + U.lifeIconSize / 2, cy + U.lifeIconSize / 2);
    ctx.lineTo(cx - U.lifeIconSize / 2, cy + U.lifeIconSize / 2);
    ctx.closePath(); ctx.fill();
  }
  // 一時停止ボタン（右上）
  var pb = U.pauseButton;
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2;
  ctx.strokeRect(pb.x, pb.y, pb.w, pb.h);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(pb.x + pb.w * 0.3, pb.y + pb.h * 0.25, pb.w * 0.13, pb.h * 0.5);
  ctx.fillRect(pb.x + pb.w * 0.57, pb.y + pb.h * 0.25, pb.w * 0.13, pb.h * 0.5);
  // ボスHPバー
  if (state.boss && state.boss.active) {
    var bb = U.bossBar;
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(bb.x, bb.y, bb.w, bb.h);
    ctx.fillStyle = CONFIG.boss.color;
    ctx.fillRect(bb.x, bb.y, bb.w * Math.max(0, state.boss.hp) / state.boss.maxHp, bb.h);
  }
  if (state.muted) _text(ctx, 'MUTE', S.width - U.hudMargin, S.height - U.hudMargin - U.smallFontSize / 2, U.smallFontSize, '#888', 'right');
  ctx.restore();
}

function drawTitle(ctx, state) {
  var U = CONFIG.ui, S = CONFIG.screen;
  ctx.save();
  _text(ctx, 'STAR DASH', S.width / 2, S.height * 0.3, U.titleFontSize, '#4ff');
  _text(ctx, 'HI ' + state.hiScore, S.width / 2, S.height * 0.42, U.textFontSize, '#fff');
  if ((state.titleTime % U.titleBlinkPeriod) < U.titleBlinkPeriod / 2) {
    _text(ctx, 'PRESS SPACE / TAP TO START', S.width / 2, S.height * 0.6, U.textFontSize, '#ff4');
  }
  _text(ctx, '移動: 矢印/WASD・ドラッグ', S.width / 2, S.height * 0.75, U.smallFontSize, '#ccc');
  _text(ctx, '射撃: SPACE（スマホは自動）', S.width / 2, S.height * 0.75 + U.lineHeight * 0.7, U.smallFontSize, '#ccc');
  _text(ctx, '一時停止: P　ミュート: M', S.width / 2, S.height * 0.75 + U.lineHeight * 1.4, U.smallFontSize, '#ccc');
  if (state.muted) _text(ctx, 'MUTE', S.width - U.hudMargin, S.height - U.hudMargin, U.smallFontSize, '#888', 'right');
  ctx.restore();
}

function drawPause(ctx, state) {
  var U = CONFIG.ui, S = CONFIG.screen;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,' + U.pauseOverlayAlpha + ')';
  ctx.fillRect(0, 0, S.width, S.height);
  _text(ctx, 'PAUSED', S.width / 2, S.height * 0.45, U.bannerFontSize, '#fff');
  _text(ctx, 'P / TAP TO RESUME', S.width / 2, S.height * 0.55, U.textFontSize, '#ccc');
  ctx.restore();
}

function _resultCommon(ctx, state, y) {
  var U = CONFIG.ui, S = CONFIG.screen;
  if (state.newRecord) _text(ctx, 'NEW RECORD!', S.width / 2, y, U.textFontSize, '#ff4');
  if (state.resultTime >= U.resultInputLock) {
    _text(ctx, 'SPACE / TAP: RETRY', S.width / 2, y + U.lineHeight * 1.5, U.textFontSize, '#fff');
    _text(ctx, 'ESC: TITLE', S.width / 2, y + U.lineHeight * 2.5, U.textFontSize, '#ccc');
    drawTitleButtonShape(ctx, U.titleButton);
  }
}

/* 4.4 v1.1: リザルト画面下部の TITLE ボタン（位置・大きさ＝判定は CONFIG.ui.titleButton）。
   drawGameOver / drawClear の中から呼ぶ。差し替え時もこの矩形に描くこと */
function drawTitleButtonShape(ctx, b) {
  var U = CONFIG.ui;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  _text(ctx, 'TITLE', b.x + b.w / 2, b.y + b.h / 2, U.textFontSize, '#fff');
  ctx.restore();
}

function drawGameOver(ctx, state) {
  var U = CONFIG.ui, S = CONFIG.screen;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,' + U.resultOverlayAlpha + ')';
  ctx.fillRect(0, 0, S.width, S.height);
  _text(ctx, 'GAME OVER', S.width / 2, S.height * 0.3, U.bannerFontSize, '#f55');
  _text(ctx, 'SCORE ' + state.score, S.width / 2, S.height * 0.42, U.textFontSize, '#fff');
  _text(ctx, 'HI ' + state.hiScore, S.width / 2, S.height * 0.42 + U.lineHeight, U.textFontSize, '#ccc');
  _resultCommon(ctx, state, S.height * 0.42 + U.lineHeight * 2.5);
  ctx.restore();
}

function _row(ctx, label, value, y, color) {
  var U = CONFIG.ui, S = CONFIG.screen, m = U.resultSideMargin;
  _text(ctx, label, m, y, U.textFontSize, color, 'left');
  _text(ctx, value, S.width - m, y, U.textFontSize, color, 'right');
}

function drawClear(ctx, state) {
  var U = CONFIG.ui, S = CONFIG.screen, r = state.result;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,' + U.resultOverlayAlpha + ')';
  ctx.fillRect(0, 0, S.width, S.height);
  _text(ctx, 'STAGE CLEAR', S.width / 2, S.height * 0.2, U.bannerFontSize, '#4ff');
  var y = S.height * 0.31, L = U.lineHeight;
  _row(ctx, 'プレイスコア（撃破＋星）', String(r.baseScore), y, '#fff');
  _row(ctx, 'ライフボーナス ×' + r.lives, '+' + r.lifeBonus, y + L, '#fff');
  _row(ctx, 'ノーミスボーナス', '+' + r.noMissBonus, y + L * 2, r.noMissBonus > 0 ? '#ff4' : '#888');
  _row(ctx, '合計', String(r.total), y + L * 3.2, '#4ff');
  _text(ctx, 'HI ' + state.hiScore, S.width / 2, y + L * 4.4, U.textFontSize, '#ccc');
  _resultCommon(ctx, state, y + L * 5.4);
  ctx.restore();
}

/* デバッグ（?debug=1）用：既存 render.js と同じ関数名・同じ見た目 */
function drawDebugHitbox(ctx, x, y, r) {
  ctx.save();
  ctx.strokeStyle = CONFIG.debug.hitboxColor;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}
