/*
 * game.js — 状態管理、更新、当たり判定、出現テーブル
 * 描画は render.js、音は audio.js の関数だけを呼ぶ（存在しなくても止まらないようにチェック付き）。
 * 数値はすべて CONFIG（config.js）から読む。
 */
var Game = (function () {
  var C = CONFIG;
  var DEG = Math.PI / 180;
  var TAU = Math.PI * 2;

  // ---------- 音・保存のラッパー（差し替え／空関数でも壊れない） ----------
  function snd(id) {
    try { if (typeof Sound !== 'undefined' && Sound && typeof Sound.play === 'function') Sound.play(id); } catch (e) { /* 無視 */ }
  }
  function bgm(id) {
    try { if (typeof Sound !== 'undefined' && Sound && typeof Sound.playBgm === 'function') Sound.playBgm(id); } catch (e) { /* 無視 */ }
  }
  function stopBgm() {
    try { if (typeof Sound !== 'undefined' && Sound && typeof Sound.stopBgm === 'function') Sound.stopBgm(); } catch (e) { /* 無視 */ }
  }
  function applyMute(m) {
    try { if (typeof Sound !== 'undefined' && Sound && typeof Sound.setMuted === 'function') Sound.setMuted(m); } catch (e) { /* 無視 */ }
  }
  function loadInt(key) {
    try { var v = parseInt(window.localStorage.getItem(key), 10); return isNaN(v) ? 0 : v; } catch (e) { return 0; }
  }
  function saveInt(key, v) {
    try { window.localStorage.setItem(key, String(Math.floor(v))); } catch (e) { /* 無視 */ }
  }
  function readDebugFlag() {
    try { return new URLSearchParams(window.location.search).get(C.debug.queryKey) === '1'; } catch (e) { return false; }
  }

  // ---------- 状態 ----------
  var s = {
    mode: 'TITLE',          // TITLE | PLAYING | PAUSED | GAMEOVER | CLEAR
    titleTime: 0,
    bgTime: 0,
    elapsed: 0,
    score: 0,
    hiScore: 0,
    lives: 0,
    hitOnce: false,
    player: null,
    playerBullets: [],
    enemies: [],
    enemyBullets: [],
    stars: [],
    effects: [],
    banner: null,           // { text, t, duration }
    phaseIndex: 0,
    spawnAcc: {},
    starAcc: 0,             // 定期的な星を出した数
    bossStage: 'none',      // none | warning | fight
    warningTimer: 0,
    boss: null,
    shake: 0,
    shakeX: 0,
    shakeY: 0,
    resultTime: 0,
    newRecord: false,
    result: null,
    muted: false,
    debug: false,
    debugInvincible: false
  };

  function rand(a, b) { return a + Math.random() * (b - a); }
  function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
  // 線分(ax,ay)-(bx,by) と円(cx,cy,r) の交差（高速弾のすり抜け防止）
  function segCircle(ax, ay, bx, by, cx, cy, r) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return dist2(ax + dx * t, ay + dy * t, cx, cy) <= r * r;
  }

  function newPlayer() {
    var P = C.player;
    return { x: P.startX, y: P.startY, invincible: 0, dead: false, deathTimer: 0, cooldown: 0, shotCount: 0 };
  }

  function resetRun() {
    s.elapsed = 0;
    s.score = 0;
    s.lives = C.player.lives;
    s.hitOnce = false;
    s.player = newPlayer();
    s.playerBullets = [];
    s.enemies = [];
    s.enemyBullets = [];
    s.stars = [];
    s.effects = [];
    s.banner = null;
    s.phaseIndex = 0;
    s.spawnAcc = {};
    s.starAcc = 0;
    s.bossStage = 'none';
    s.warningTimer = 0;
    s.boss = null;
    s.shake = 0; s.shakeX = 0; s.shakeY = 0;
    s.resultTime = 0;
    s.newRecord = false;
    s.result = null;
  }

  // ---------- 画面遷移 ----------
  function startGame() {
    resetRun();
    s.mode = 'PLAYING';
    snd('se_select');
    bgm('bgm_stage');
    if (typeof Input !== 'undefined') Input.consumeDrag();
  }
  function toTitle() {
    s.mode = 'TITLE';
    s.titleTime = 0;
    bgm('bgm_title');
  }
  function currentBgmId() { return s.bossStage === 'none' ? 'bgm_stage' : 'bgm_boss'; }
  function pause() {
    if (s.mode !== 'PLAYING') return;
    s.mode = 'PAUSED';
    stopBgm();
    snd('se_select');
  }
  function resume() {
    if (s.mode !== 'PAUSED') return;
    s.mode = 'PLAYING';
    snd('se_select');
    bgm(currentBgmId());
    if (typeof Input !== 'undefined') Input.consumeDrag();
  }
  function updateHighScore(finalScore) {
    s.newRecord = finalScore > s.hiScore;
    if (s.newRecord) { s.hiScore = finalScore; saveInt(C.score.highScoreKey, finalScore); }
  }
  function gameOver() {
    s.mode = 'GAMEOVER';
    s.resultTime = 0;
    updateHighScore(s.score);
    stopBgm();
    snd('se_gameover');
  }
  function stageClear() {
    var lifeBonus = s.lives * C.score.lifeBonus;
    var noMissBonus = s.hitOnce ? 0 : C.score.noMissBonus;
    var base = s.score;
    s.result = { baseScore: base, lives: s.lives, lifeBonus: lifeBonus, noMissBonus: noMissBonus, total: base + lifeBonus + noMissBonus };
    s.score = s.result.total;
    s.mode = 'CLEAR';
    s.resultTime = 0;
    s.enemyBullets = [];
    updateHighScore(s.score);
    stopBgm();
    snd('se_clear');
  }

  // ---------- 入力 ----------
  function inRect(p, b) {
    return !!p && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  }
  // 一時停止ボタンの当たり判定: 見た目(40×40)はそのまま、判定だけ広げる（QA v1.1）。
  // 一辺 = max(見た目 + 2×pauseHitPad, minTouchTargetCss ÷ 表示倍率)。中心は見た目と同じで、画面からはみ出す分は内側へずらす。
  var viewScale = 1;   // 論理px 1 あたりの CSS px（main.js が resize 時に設定）
  function pauseHitRect() {
    var b = C.ui.pauseButton, U = C.ui, W = C.screen.width, H = C.screen.height;
    var minLogical = U.minTouchTargetCss / (viewScale > 0 ? viewScale : 1);
    var w = Math.min(W, Math.max(b.w + U.pauseHitPad * 2, minLogical));
    var h = Math.min(H, Math.max(b.h + U.pauseHitPad * 2, minLogical));
    var x = b.x + b.w / 2 - w / 2, y = b.y + b.h / 2 - h / 2;
    x = Math.max(0, Math.min(W - w, x));
    y = Math.max(0, Math.min(H - h, y));
    return { x: x, y: y, w: w, h: h };
  }
  function inPauseButton(p) { return inRect(p, pauseHitRect()); }
  function inTitleButton(p) { return inRect(p, C.ui.titleButton); }
  function onAction(action, data) {
    if (action === 'mute') {
      s.muted = !s.muted;
      saveInt(C.audio.mutedKey, s.muted ? 1 : 0);
      applyMute(s.muted);
      return;
    }
    switch (s.mode) {
      case 'TITLE':
        if (action === 'confirm' || action === 'tap') startGame();
        break;
      case 'PLAYING':
        if (action === 'pause' || (action === 'tap' && inPauseButton(data))) pause();
        else if (s.debug && action === 'debugSkip') debugSkip();
        else if (s.debug && action === 'debugInvincible') s.debugInvincible = !s.debugInvincible;
        break;
      case 'PAUSED':
        if (action === 'pause' || action === 'tap') resume();
        break;
      case 'GAMEOVER':
      case 'CLEAR':
        if (s.resultTime < C.ui.resultInputLock) break;
        // 4.4 v1.1: TITLE ボタンのタップ/クリック → タイトル、それ以外の場所 → リトライ
        if (action === 'escape' || (action === 'tap' && inTitleButton(data))) toTitle();
        else if (action === 'confirm' || action === 'tap') startGame();
        break;
    }
  }
  function debugSkip() {
    var ph = C.stage.phases;
    for (var i = 0; i < ph.length; i++) {
      if (ph[i].end > s.elapsed) {
        s.elapsed = ph[i].end;
        s.starAcc = Math.floor(s.elapsed / C.star.periodicInterval);   // 飛ばした分の星をまとめて出さない
        return;
      }
    }
  }

  // ---------- 生成 ----------
  function fireEnemyBullet(x, y, angle, speed) {
    if (s.enemyBullets.length >= C.enemyBullet.maxCount) return;
    s.enemyBullets.push({ x: x, y: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed });
  }
  function fireSpread(x, y, center, ways, stepDeg, speed) {
    for (var i = 0; i < ways; i++) fireEnemyBullet(x, y, center + (i - (ways - 1) / 2) * stepDeg * DEG, speed);
  }
  function aimAngle(x, y) {
    if (!s.player || s.player.dead) return Math.PI / 2;
    return Math.atan2(s.player.y - y, s.player.x - x);
  }
  function spawnEnemy(type, speedMul) {
    var T = C.enemy.types[type];
    var margin = C.stage.spawnMarginX + (T.keepSwayOnScreen ? T.swayAmplitude : 0);
    var x = rand(margin, C.screen.width - margin);
    var e = { type: type, x: x, y: C.stage.spawnY, baseX: x, hp: T.hp, speedMul: speedMul, age: 0, flash: 0, fireTimer: T.firstFireDelay || 0, mode: 'enter', stopT: 0 };
    s.enemies.push(e);
  }
  function spawnStar(x, y) {
    s.stars.push({ x: x, y: y, magnet: false });
  }
  function addEffect(type, x, y, size, duration) {
    s.effects.push({ type: type, x: x, y: y, size: size, t: 0, duration: duration });
  }
  function spawnBoss() {
    var B = C.boss;
    s.boss = {
      x: B.startX, y: B.startY, hp: B.hp, maxHp: B.hp, active: true,
      entering: true, entryT: 0, dir: 1, half: false,
      aimTimer: B.phase1.aimInterval, radialTimer: B.phase1.radialInterval, radialAngle: 0,
      flash: 0, dying: false, deathT: 0, smallAcc: 0, bigDone: false, visible: true
    };
  }

  // ---------- 被弾・撃破 ----------
  function playerVulnerable() {
    var p = s.player;
    return !p.dead && p.invincible <= 0 && !s.debugInvincible && !(s.boss && s.boss.dying);
  }
  function damagePlayer() {
    s.lives--;
    s.hitOnce = true;
    s.enemyBullets = [];
    snd('se_damage');
    if (s.lives <= 0) {
      s.lives = 0;
      s.player.dead = true;
      s.player.deathTimer = 0;
      addEffect('player_explosion', s.player.x, s.player.y, C.player.width * 2, C.player.deathTime);
    } else {
      s.player.invincible = C.player.invincibleTime;
    }
  }
  function killEnemy(e) {
    var T = C.enemy.types[e.type];
    s.score += T.score;
    addEffect('explosion', e.x, e.y, T.width, C.enemy.explosionTime);
    snd('se_explode');
    if (Math.random() < T.dropChance) {
      for (var i = 0; i < T.dropCount; i++) {
        var sc = T.dropCount > 1 ? C.star.scatter : 0;
        spawnStar(e.x + rand(-sc, sc), e.y + rand(-sc, sc));
      }
    }
  }
  function damageBoss(dmg) {
    var b = s.boss, B = C.boss;
    b.hp -= dmg;
    b.flash = C.enemy.hitFlashTime;
    if (b.hp <= 0) {
      b.hp = 0;
      b.dying = true;
      b.deathT = 0;
      s.score += B.score;
      s.enemyBullets = [];
      snd('se_boss_explode');
      return;
    }
    snd('se_hit');
    if (!b.half && b.hp <= b.maxHp * B.halfHpRatio) {
      b.half = true;
      s.shake = B.shakeTime;
      s.enemyBullets = [];
      b.aimTimer = B.phase2.aimInterval;
      b.radialTimer = B.phase2.radialInterval;
    }
  }

  // ---------- 更新 ----------
  function update(dt) {
    if (s.mode === 'PAUSED') return;
    s.bgTime += dt;
    if (s.mode === 'TITLE') { s.titleTime += dt; return; }
    if (s.mode === 'GAMEOVER' || s.mode === 'CLEAR') { s.resultTime += dt; return; }
    if (s.mode === 'PLAYING') updatePlaying(dt);
  }

  function phaseAt(t) {
    var ph = C.stage.phases;
    for (var i = 0; i < ph.length; i++) if (t >= ph[i].start && t < ph[i].end) return i;
    return -1;
  }

  function updatePlaying(dt) {
    s.elapsed += dt;

    // フェーズ進行
    var idx = phaseAt(s.elapsed);
    if (idx >= 0 && idx !== s.phaseIndex) {
      s.phaseIndex = idx;
      s.spawnAcc = {};
      s.banner = { text: C.stage.phases[idx].name, t: 0, duration: C.stage.phaseBannerTime };
    }
    if (s.bossStage === 'none' && s.elapsed >= C.stage.bossTime) {
      s.bossStage = 'warning';
      s.warningTimer = 0;
      s.banner = { text: 'WARNING', t: 0, duration: C.stage.warningTime };
      snd('se_warning');
      bgm('bgm_boss');
    }
    if (s.bossStage === 'warning') {
      s.warningTimer += dt;
      if (s.warningTimer >= C.stage.warningTime) { s.bossStage = 'fight'; spawnBoss(); }
    }

    // 雑魚出現
    if (s.bossStage === 'none' && idx >= 0 && s.elapsed >= C.stage.readyTime) {
      var phase = C.stage.phases[idx];
      // 7.1 v1.1: 各フェーズの初回はフェーズ開始（フェーズ1は準備時間明け）と同時、以後は表の間隔。
      // 出現時刻 = 開始 + k×間隔 を直接計算する（浮動小数の誤差で境界に二重出現しない／fps非依存）。
      var phaseStart = Math.max(phase.start, C.stage.readyTime);
      var eps = C.stage.timeEpsilon;
      for (var type in phase.intervals) {
        var iv = phase.intervals[type];
        var k = s.spawnAcc[type] || 0;          // このフェーズで出した数
        while (phaseStart + k * iv <= s.elapsed + eps && phaseStart + k * iv < phase.end - eps) {
          k++;
          spawnEnemy(type, phase.speedMul);
        }
        s.spawnAcc[type] = k;
      }
    }
    // 定期的な星（ボス戦中も継続）
    // 出現時刻 = k×間隔（k=1,2,...）を回数で数える（dt の足し算の誤差で1個抜けるのを防ぐ）
    while ((s.starAcc + 1) * C.star.periodicInterval <= s.elapsed + C.stage.timeEpsilon) {
      s.starAcc++;
      spawnStar(rand(C.star.spawnMarginX, C.screen.width - C.star.spawnMarginX), C.star.spawnY);
    }

    updatePlayer(dt);
    updatePlayerBullets(dt);
    updateEnemies(dt);
    updateBoss(dt);
    updateEnemyBullets(dt);
    updateStars(dt);
    updateEffects(dt);

    if (s.banner) { s.banner.t += dt; if (s.banner.t >= s.banner.duration) s.banner = null; }
    if (s.shake > 0) {
      s.shake = Math.max(0, s.shake - dt);
      var a = s.shake > 0 ? C.boss.shakeAmplitude : 0;
      s.shakeX = rand(-a, a); s.shakeY = rand(-a, a);
    }

    if (s.player.dead) {
      s.player.deathTimer += dt;
      if (s.player.deathTimer >= C.player.deathTime) gameOver();
    }
  }

  function updatePlayer(dt) {
    var p = s.player, P = C.player, PB = C.playerBullet;
    var drag = (typeof Input !== 'undefined') ? Input.consumeDrag() : { x: 0, y: 0 };
    if (p.dead) return;
    var held = (typeof Input !== 'undefined') ? Input.held : {};
    var dx = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    var dy = (held.down ? 1 : 0) - (held.up ? 1 : 0);
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) { p.x += dx / len * P.speed * dt; p.y += dy / len * P.speed * dt; }
    p.x += drag.x; p.y += drag.y;
    p.x = Math.max(P.edgeMargin, Math.min(C.screen.width - P.edgeMargin, p.x));
    p.y = Math.max(P.edgeMargin, Math.min(C.screen.height - P.edgeMargin, p.y));
    if (p.invincible > 0) p.invincible = Math.max(0, p.invincible - dt);

    var firing = (typeof Input !== 'undefined') && (Input.touchMode || held.fire);
    p.cooldown -= dt;
    if (firing) {
      while (p.cooldown <= 0) {
        p.cooldown += P.shotInterval;
        s.playerBullets.push({ x: p.x - PB.offsetX, y: p.y + PB.offsetY, prevY: p.y + PB.offsetY });
        s.playerBullets.push({ x: p.x + PB.offsetX, y: p.y + PB.offsetY, prevY: p.y + PB.offsetY });
        if (p.shotCount % C.audio.shotSoundEvery === 0) snd('se_shot');
        p.shotCount++;
      }
    } else if (p.cooldown < 0) {
      p.cooldown = 0;
    }
  }

  function updatePlayerBullets(dt) {
    var PB = C.playerBullet;
    var out = [];
    for (var i = 0; i < s.playerBullets.length; i++) {
      var b = s.playerBullets[i];
      b.prevY = b.y;
      b.y -= PB.speed * dt;
      if (b.y < -PB.offscreenMargin) continue;
      if (hitByPlayerBullet(b)) continue;
      out.push(b);
    }
    s.playerBullets = out;
  }

  function hitByPlayerBullet(b) {
    var PB = C.playerBullet;
    for (var i = 0; i < s.enemies.length; i++) {
      var e = s.enemies[i];
      if (e.hp <= 0) continue;
      var T = C.enemy.types[e.type];
      if (segCircle(b.x, b.prevY, b.x, b.y, e.x, e.y, T.hitRadius + PB.hitRadius)) {
        e.hp -= PB.damage;
        e.flash = C.enemy.hitFlashTime;
        addEffect('hit', e.x, e.y, T.hitRadius, C.enemy.hitFlashTime);
        if (e.hp <= 0) killEnemy(e); else snd('se_hit');
        return true;
      }
    }
    var bo = s.boss;
    if (bo && !bo.entering && !bo.dying && segCircle(b.x, b.prevY, b.x, b.y, bo.x, bo.y, C.boss.hitRadius + PB.hitRadius)) {
      damageBoss(PB.damage);
      return true;
    }
    return false;
  }

  function updateEnemies(dt) {
    var E = C.enemy, W = C.screen.width, H = C.screen.height;
    var out = [];
    for (var i = 0; i < s.enemies.length; i++) {
      var e = s.enemies[i], T = E.types[e.type];
      if (e.hp <= 0) continue;
      e.age += dt;
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt);
      var v = T.speed * e.speedMul;
      if (e.type === 'A') {
        e.y += v * dt;
      } else if (e.type === 'B') {
        e.y += v * dt;
        e.x = e.baseX + T.swayAmplitude * Math.sin(TAU * e.age / T.swayPeriod);
        e.fireTimer -= dt;
        while (e.fireTimer <= 0) {
          e.fireTimer += T.fireInterval;
          if (e.y <= s.player.y - T.fireMinAbovePlayer) fireEnemyBullet(e.x, e.y, aimAngle(e.x, e.y), T.bulletSpeed * e.speedMul);
        }
      } else if (e.type === 'C') {
        if (e.mode === 'enter') {
          e.y += v * dt;
          if (e.y >= T.stopY) { e.y = T.stopY; e.mode = 'stop'; e.stopT = 0; e.shots = 0; }
        } else if (e.mode === 'stop') {
          e.stopT += dt;
        } else {
          e.y += v * dt;
        }
        if (e.mode === 'stop') {
          // 15章: 停止した瞬間から撃つ。発射時刻 = firstFireDelay + k×間隔（停止時間未満のみ）→ 3.0秒で計3回
          var eps = C.stage.timeEpsilon;
          while (T.firstFireDelay + e.shots * T.fireInterval <= e.stopT + eps &&
                 T.firstFireDelay + e.shots * T.fireInterval < T.stopTime - eps) {
            e.shots++;
            fireSpread(e.x, e.y, Math.PI / 2, T.fanWays, T.fanStepDeg, T.bulletSpeed * e.speedMul);
          }
          if (e.stopT >= T.stopTime - eps) e.mode = 'leave';
        }
      }
      // 体当たり
      if (playerVulnerable() && dist2(e.x, e.y, s.player.x, s.player.y) <= Math.pow(T.hitRadius + C.player.hitRadius, 2)) {
        damagePlayer();
        addEffect('explosion', e.x, e.y, T.width, E.explosionTime);
        continue;
      }
      if (e.y > H + E.offscreenBottomMargin || e.x < -E.offscreenSideMargin || e.x > W + E.offscreenSideMargin) continue;
      out.push(e);
    }
    s.enemies = out;
  }

  function updateBoss(dt) {
    var b = s.boss, B = C.boss;
    if (!b) return;
    if (b.flash > 0) b.flash = Math.max(0, b.flash - dt);
    if (b.dying) {
      b.deathT += dt;
      s.enemyBullets = [];
      if (b.deathT < B.deathSmallUntil) {
        b.smallAcc += dt;
        while (b.smallAcc >= B.deathSmallInterval) {
          b.smallAcc -= B.deathSmallInterval;
          addEffect('boss_explosion_small', b.x + rand(-B.deathSmallScatter, B.deathSmallScatter), b.y + rand(-B.deathSmallScatter, B.deathSmallScatter) / 2, B.height / 2, C.enemy.explosionTime);
        }
      } else if (!b.bigDone) {
        b.bigDone = true;
        b.visible = false;
        addEffect('boss_explosion_big', b.x, b.y, B.width, B.deathBigTime);
      }
      if (b.deathT >= B.deathTime) { b.active = false; stageClear(); }
      return;
    }
    if (b.entering) {
      b.entryT += dt;
      var k = Math.min(1, b.entryT / B.entryTime);
      b.y = B.startY + (B.stopY - B.startY) * k;
      if (k >= 1) b.entering = false;
    } else {
      var P = b.half ? B.phase2 : B.phase1;
      b.x += b.dir * P.moveSpeed * dt;
      if (b.x >= B.maxX) { b.x = B.maxX; b.dir = -1; }
      if (b.x <= B.minX) { b.x = B.minX; b.dir = 1; }
      b.aimTimer -= dt;
      while (b.aimTimer <= 0) {
        b.aimTimer += P.aimInterval;
        fireSpread(b.x, b.y, aimAngle(b.x, b.y), P.aimWays, P.aimStepDeg, P.aimSpeed);
      }
      b.radialTimer -= dt;
      while (b.radialTimer <= 0) {
        b.radialTimer += P.radialInterval;
        for (var i = 0; i < P.radialWays; i++) fireEnemyBullet(b.x, b.y, b.radialAngle + i * TAU / P.radialWays, P.radialSpeed);
        b.radialAngle += P.radialRotateDeg * DEG;
      }
    }
    if (playerVulnerable() && dist2(b.x, b.y, s.player.x, s.player.y) <= Math.pow(B.hitRadius + C.player.hitRadius, 2)) {
      damagePlayer();
    }
  }

  function updateEnemyBullets(dt) {
    var EB = C.enemyBullet, W = C.screen.width, H = C.screen.height, m = EB.offscreenMargin;
    var p = s.player, r = EB.hitRadius + C.player.hitRadius;
    var out = [];
    for (var i = 0; i < s.enemyBullets.length; i++) {
      var b = s.enemyBullets[i];
      var px = b.x, py = b.y;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < -m || b.x > W + m || b.y < -m || b.y > H + m) continue;
      if (playerVulnerable() && segCircle(px, py, b.x, b.y, p.x, p.y, r)) {
        damagePlayer();          // 敵弾はここで全消去される
        return;
      }
      out.push(b);
    }
    s.enemyBullets = out;
  }

  function updateStars(dt) {
    var ST = C.star, p = s.player, H = C.screen.height;
    var out = [];
    for (var i = 0; i < s.stars.length; i++) {
      var st = s.stars[i];
      var alive = !p.dead;
      if (alive && dist2(st.x, st.y, p.x, p.y) <= ST.magnetRange * ST.magnetRange) st.magnet = true;
      if (alive && st.magnet) {
        var dx = p.x - st.x, dy = p.y - st.y, d = Math.sqrt(dx * dx + dy * dy);
        var step = ST.magnetSpeed * dt;
        if (d <= step) { st.x = p.x; st.y = p.y; } else { st.x += dx / d * step; st.y += dy / d * step; }
      } else {
        st.y += ST.fallSpeed * dt;
      }
      if (alive && dist2(st.x, st.y, p.x, p.y) <= Math.pow(ST.hitRadius + C.player.hitRadius, 2)) {
        s.score += ST.score;
        snd('se_star');
        continue;
      }
      if (st.y > H + ST.offscreenMargin) continue;
      out.push(st);
    }
    s.stars = out;
  }

  function updateEffects(dt) {
    var out = [];
    for (var i = 0; i < s.effects.length; i++) {
      var e = s.effects[i];
      e.t += dt;
      if (e.t < e.duration) out.push(e);
    }
    s.effects = out;
  }

  // ---------- 公開 ----------
  return {
    s: s,
    init: function () {
      s.hiScore = loadInt(C.score.highScoreKey);
      s.muted = loadInt(C.audio.mutedKey) === 1;
      s.debug = readDebugFlag();
      applyMute(s.muted);
      resetRun();
      toTitle();
    },
    update: update,
    onAction: onAction,
    onHidden: function () { pause(); },
    setViewScale: function (k) { viewScale = k; },
    pauseHitRect: pauseHitRect,
    // テスト用
    _startGame: startGame,
    _debugSkip: debugSkip
  };
})();
