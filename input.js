/*
 * input.js — キーボード／タッチ／マウス入力
 * 押しっぱなしの状態は Input.held、単発の操作は handler(action, data) へ通知する。
 *   action: 'confirm'(Space/Enter) | 'pause'(P) | 'escape'(Esc) | 'mute'(M) | 'tap'({x,y} 論理座標)
 *           | 'debugSkip'(N, ?debug=1 時) | 'debugInvincible'(I, ?debug=1 時)
 */
var Input = (function () {
  var KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    Space: 'fire'
  };
  var ACTIONMAP = {
    Space: 'confirm', Enter: 'confirm', NumpadEnter: 'confirm',
    KeyP: 'pause', Escape: 'escape', KeyM: 'mute',
    KeyN: 'debugSkip', KeyI: 'debugInvincible'
  };

  var self = {
    held: { left: false, right: false, up: false, down: false, fire: false },
    touchMode: false,   // タッチを検知したら true（自動射撃）
    dragDX: 0,
    dragDY: 0,
    handler: null
  };
  var canvas = null;
  var dragId = null, lastX = 0, lastY = 0;

  function unlockAudio() {
    try { if (typeof Sound !== 'undefined' && Sound.unlock) Sound.unlock(); } catch (e) { /* 無視 */ }
  }
  function emit(action, data) {
    if (self.handler) self.handler(action, data);
  }
  function scale() {
    var r = canvas.getBoundingClientRect();
    return { r: r, sx: CONFIG.screen.width / (r.width || 1), sy: CONFIG.screen.height / (r.height || 1) };
  }
  function toLogical(clientX, clientY) {
    var s = scale();
    return { x: (clientX - s.r.left) * s.sx, y: (clientY - s.r.top) * s.sy };
  }

  function onKeyDown(e) {
    var code = e.code;
    if (KEYMAP[code] || ACTIONMAP[code]) e.preventDefault();
    unlockAudio();
    if (KEYMAP[code]) self.held[KEYMAP[code]] = true;
    if (ACTIONMAP[code] && !e.repeat) emit(ACTIONMAP[code]);
  }
  function onKeyUp(e) {
    var code = e.code;
    if (KEYMAP[code]) { self.held[KEYMAP[code]] = false; e.preventDefault(); }
  }

  function onTouchStart(e) {
    e.preventDefault();
    unlockAudio();
    self.touchMode = true;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (dragId === null) { dragId = t.identifier; lastX = t.clientX; lastY = t.clientY; }
      emit('tap', toLogical(t.clientX, t.clientY));
    }
  }
  function onTouchMove(e) {
    e.preventDefault();
    var s = scale();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (t.identifier !== dragId) continue;
      self.dragDX += (t.clientX - lastX) * s.sx * CONFIG.input.dragRatio;
      self.dragDY += (t.clientY - lastY) * s.sy * CONFIG.input.dragRatio;
      lastX = t.clientX; lastY = t.clientY;
    }
  }
  function onTouchEnd(e) {
    e.preventDefault();
    unlockAudio();   // iOS Safari は touchstart ではなく touchend をユーザー操作として音を解除する（QA v1.1）
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === dragId) dragId = null;
    }
  }
  function onMouseDown(e) {
    unlockAudio();
    emit('tap', toLogical(e.clientX, e.clientY));
  }

  self.init = function (cv, handler) {
    canvas = cv;
    self.handler = handler;
    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp, { passive: false });
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    // 画面全体でスクロール・拡大・長押しメニューを無効化
    document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('blur', self.releaseAll);
  };
  self.consumeDrag = function () {
    var d = { x: self.dragDX, y: self.dragDY };
    self.dragDX = 0; self.dragDY = 0;
    return d;
  };
  self.releaseAll = function () {
    for (var k in self.held) self.held[k] = false;
    self.dragDX = 0; self.dragDY = 0;
  };
  return self;
})();
