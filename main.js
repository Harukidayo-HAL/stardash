/*
 * main.js — Canvas のスケーリング、メインループ、描画順の組み立て
 * 実際の描画は render.js の関数だけを呼ぶ（無い関数は飛ばす）。
 */
(function () {
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = CONFIG.screen.width, H = CONFIG.screen.height;
  var view = { scale: 1, dpr: 1 };

  function R(name) {
    var f = window[name];
    if (typeof f !== 'function') return;
    f.apply(null, Array.prototype.slice.call(arguments, 1));
  }

  // 3章: 縦横比を保って最大化・中央配置、devicePixelRatio（上限2）
  function resize() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var scale = Math.min(vw / W, vh / H);
    var dpr = Math.min(window.devicePixelRatio || 1, CONFIG.screen.maxDevicePixelRatio);
    canvas.style.width = Math.floor(W * scale) + 'px';
    canvas.style.height = Math.floor(H * scale) + 'px';
    canvas.width = Math.floor(W * scale * dpr);
    canvas.height = Math.floor(H * scale * dpr);
    view.scale = scale; view.dpr = dpr;
    if (typeof Game !== 'undefined' && Game.setViewScale) Game.setViewScale(scale);
  }

  function renderFrame() {
    var s = Game.s;
    var k = view.scale * view.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);

    R('drawBackground', ctx, s.bgTime);
    if (s.mode === 'TITLE') { R('drawTitle', ctx, s); return; }

    ctx.save();
    if (s.shake > 0) ctx.translate(s.shakeX, s.shakeY);
    var i;
    for (i = 0; i < s.stars.length; i++) R('drawStar', ctx, s.stars[i]);
    for (i = 0; i < s.playerBullets.length; i++) R('drawPlayerBullet', ctx, s.playerBullets[i]);
    for (i = 0; i < s.enemies.length; i++) R('drawEnemy', ctx, s.enemies[i]);
    if (s.boss && s.boss.visible) R('drawBoss', ctx, s.boss);
    R('drawPlayer', ctx, s.player);
    for (i = 0; i < s.effects.length; i++) R('drawEffect', ctx, s.effects[i]);
    ctx.restore();

    R('drawHUD', ctx, s);
    if (s.banner && (s.mode === 'PLAYING' || s.mode === 'PAUSED')) R('drawBanner', ctx, s.banner.text, s.banner.t, s.banner.duration);

    // 敵弾は爆発・HUD・バナーより上（いちばん上）に描く。画面の揺れは弾にも同じだけかける（QA v1.1 P-1）
    ctx.save();
    if (s.shake > 0) ctx.translate(s.shakeX, s.shakeY);
    for (i = 0; i < s.enemyBullets.length; i++) R('drawEnemyBullet', ctx, s.enemyBullets[i]);
    if (s.debug) drawHitboxes(s);
    ctx.restore();

    // 一時停止・リザルトの覆いは弾より上
    if (s.mode === 'PAUSED') R('drawPause', ctx, s);
    else if (s.mode === 'GAMEOVER') R('drawGameOver', ctx, s);
    else if (s.mode === 'CLEAR') R('drawClear', ctx, s);
  }

  function drawHitboxes(s) {
    var i, T = CONFIG.enemy.types;
    if (!s.player.dead) R('drawDebugHitbox', ctx, s.player.x, s.player.y, CONFIG.player.hitRadius);
    for (i = 0; i < s.enemies.length; i++) R('drawDebugHitbox', ctx, s.enemies[i].x, s.enemies[i].y, T[s.enemies[i].type].hitRadius);
    for (i = 0; i < s.enemyBullets.length; i++) R('drawDebugHitbox', ctx, s.enemyBullets[i].x, s.enemyBullets[i].y, CONFIG.enemyBullet.hitRadius);
    for (i = 0; i < s.stars.length; i++) R('drawDebugHitbox', ctx, s.stars[i].x, s.stars[i].y, CONFIG.star.hitRadius);
    for (i = 0; i < s.playerBullets.length; i++) R('drawDebugHitbox', ctx, s.playerBullets[i].x, s.playerBullets[i].y, CONFIG.playerBullet.hitRadius);
    if (s.boss && s.boss.visible) R('drawDebugHitbox', ctx, s.boss.x, s.boss.y, CONFIG.boss.hitRadius);
  }

  var last = null;
  function frame(ts) {
    if (last === null) last = ts;
    var dt = Math.min(Math.max(0, (ts - last) / 1000), CONFIG.loop.maxDt);
    last = ts;
    Game.update(dt);
    renderFrame();
    window.requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { Game.onHidden(); Input.releaseAll(); if (typeof Sound !== 'undefined' && Sound.stopSfx) Sound.stopSfx(); }   // 効果音の余韻も止める（QA 19:40）
  });

  Input.init(canvas, Game.onAction);
  Game.init();
  resize();
  window.requestAnimationFrame(frame);
})();
