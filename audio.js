/*
 * audio.js — 音の呼び出しはすべてここ（サウンド担当が差し替える場所）
 *
 * 公開インターフェース（仕様書12章）:
 *   Sound.play(id)       効果音  (se_shot, se_hit, se_explode, se_star, se_damage,
 *                                 se_warning, se_boss_explode, se_gameover, se_clear, se_select)
 *   Sound.playBgm(id)    BGM    (bgm_title, bgm_stage, bgm_boss) ループ再生。同じIDなら何もしない
 *   Sound.stopBgm()      BGM停止
 * 任意（ゲーム側は存在チェックしてから呼ぶ。無くても動く）:
 *   Sound.unlock()       ユーザー入力（keydown / mousedown / touchstart / touchend）ごとに呼ばれる（自動再生制限の解除）。
 *                        iOS Safari は touchend でないと解除できないため、何度呼ばれても安全に作ること
 *   Sound.stopSfx()      画面が隠れたときに呼ばれる。鳴っている効果音（余韻も）を止める
 *   Sound.setMuted(bool) ミュート反映（状態の保存はゲーム側が localStorage に行う）
 *
 * 音はすべて Web Audio API でその場で合成する（ネオン／シンセウェイブ調）。外部ファイル・サンプルは使わない。
 * どんな環境でも例外を投げない。
 *
 * 信号の流れ:
 *   細かい効果音(shot/hit/explode) → minorBus（被弾・星・WARNING の間だけ下げる）─┐
 *   大事な効果音 ───────────────────────────────→ sfxBus(seVolume×mix.sfx) ─┐
 *   BGM → loopBus → bgmBus(bgmVolume×mix.bgm) ──────────────────────────────┤→ limiter → trim → master(ミュート) → destination
 *   リミッターはふだんは効かない安全用（実測: 通常プレイ・ボス戦とも 1dB 以上の圧縮は 0.1% 以下）。
 *   音量の配分・間引きの数値の正本は config.js（CONFIG.audio.mix と CONFIG.audio.sfx）。audio.js の値は config に無いときの予備だけ
 *   （compressor などが作れない環境では、そのまま master へつなぐ）
 */
var Sound = (function () {
  var ctx = null;
  var master = null;
  var unlocked = false;
  var muted = false;
  var currentBgm = null;   // 鳴らしたいBGM ID（unlock前でも覚えておく）
  var bgmTimer = null;
  var bgmStep = 0;
  var pendingSfx = null;   // { id, at } 音の準備前に頼まれた効果音（1つだけ覚えておく）
  var justResumed = false; // 準備ができた直後の最初のBGMの出だしを少し遅らせる
  var debugLog = [];       // テスト用: 実際に予約したBGM（id）の記録

  // ---- 合成用の内部状態（サウンド担当） ----
  var sfxBus = null, bgmBus = null;
  var noiseBuf = null, noiseTried = false;
  var lastPlay = {};       // id -> 最後に鳴らした ctx.currentTime（連打の間引き）
  var voices = {};         // id -> 鳴っている音の終了時刻の配列（同時発音数の上限）
  var allVoices = [];      // 効果音全体の終了時刻
  var loop = null;         // 再生中のBGMの状態 { def, bus, send, nextTime }
  var sfxOut = null;       // 効果音バスの出力先（リミッター、なければ master）
  var minorBus = null;     // 連打される細かい音（se_shot / se_hit / se_explode）。大事な音の間だけ下げる
  // 音量の配分（実測で決めた値。CONFIG.audio.mix があればそちらを使う）
  function mix(k, d) { var c = cfg(); return num(c && c.mix && c.mix[k], d); }
  var LOOKAHEAD = 0.14;    // 秒。BGM は少し先まで予約してタイマーの揺れに強くする
  var TICK_MS = 25;
  var MINOR_IDS = { se_shot: 1, se_hit: 1, se_explode: 1 };
  // 調整する数値の正本は config.js の CONFIG.audio.mix と CONFIG.audio.sfx。ここの値は config に無いときの予備だけ
  var KEY_DUCK = { se_damage: 0.55, se_star: 0.35, se_warning: 1.5 };   // 予備: 大事な音が鳴る間、細かい音を下げておく秒数
  function sfxCfg(id) { var c = cfg(); return (c && c.sfx && c.sfx[id]) || {}; }
  var sfxLevel = 1;        // いま鳴らしている効果音の音量倍率（CONFIG.audio.sfx[id].level）。BGM では 1

  function cfg() { return (typeof CONFIG !== 'undefined' && CONFIG.audio) ? CONFIG.audio : null; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  function ensureCtx() {
    if (ctx) return ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
      buildBuses();
    } catch (e) { ctx = null; }
    return ctx;
  }

  // 効果音／BGM のバスと、音割れ防止のリミッター。作れないものがあっても止めない
  function buildBuses() {
    var c = cfg();
    var out = master;
    try {
      // 安全用のリミッター。ふだんはかからず、ボス撃破などの大きな音が重なったときだけ効く高さにする
      var lim = ctx.createDynamicsCompressor();
      lim.threshold.value = mix('limitThreshold', -3); lim.knee.value = 0; lim.ratio.value = 20;
      lim.attack.value = 0.001; lim.release.value = 0.1;
      var trim = ctx.createGain(); trim.gain.value = mix('outputTrim', 0.92);   // compressor の自動メイクアップ分を戻して True Peak を -1dBTP 未満に
      lim.connect(trim); trim.connect(master);
      out = lim;
    } catch (e) { out = master; }
    sfxOut = out;
    makeSfxBuses();
    try {
      bgmBus = ctx.createGain(); bgmBus.gain.value = num(c && c.bgmVolume, 0.5) * mix('bgm', 1.45); bgmBus.connect(out);
    } catch (e) { bgmBus = null; }
  }

  // 効果音のバス（sfxBus と minorBus）を作る。画面が隠れたときは古いバスごと消して作り直す
  function makeSfxBuses() {
    var c = cfg(), out = sfxOut || master;
    try {
      sfxBus = ctx.createGain(); sfxBus.gain.value = num(c && c.seVolume, 0.7) * mix('sfx', 1.0); sfxBus.connect(out);
    } catch (e) { sfxBus = null; }
    try {
      minorBus = ctx.createGain(); minorBus.gain.value = 1; minorBus.connect(sfxBus || out);
    } catch (e) { minorBus = null; }
  }

  // 鳴っている効果音の余韻をすぐ止める（画面が隠れたとき）。古いバスを短くフェードして切り離し、新しいバスに替える
  function cutSfx() {
    pendingSfx = null;
    if (!ctx) return;
    var old = sfxBus, oldMinor = minorBus, fade = num(cfg() && cfg().sfxCutFade, 0.03);
    if (!old && !oldMinor) return;
    try {
      var now = ctx.currentTime, g = (old || oldMinor).gain;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + fade);
    } catch (e) { /* 無視 */ }
    setTimeout(function () {
      try { if (oldMinor) oldMinor.disconnect(); } catch (e) { /* 無視 */ }
      try { if (old) old.disconnect(); } catch (e) { /* 無視 */ }
    }, fade * 1000 + 50);
    lastPlay = {}; voices = {}; allVoices = [];   // 切った音の分の間引き・同時発音数を数えないようにする
    makeSfxBuses();
  }

  function canSound() { return !!(ctx && unlocked && !muted && ctx.state === 'running'); }   // 解除前は予約しない（再開時にまとめて鳴るのを防ぐ）

  function getNoise() {
    if (noiseBuf || noiseTried) return noiseBuf;
    noiseTried = true;
    try {
      var sr = ctx.sampleRate || 44100, len = Math.floor(sr * 1.0);   // 1秒だけ（約190KB）。ループして使う
      var b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      noiseBuf = b;
    } catch (e) { noiseBuf = null; }
    return noiseBuf;
  }

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // ---- 音源の部品 ----
  // 発振器1つ: { type, f, f1, glide, t, dur, gain, a, dest, lp, lp1, q, detune, hold }
  function voice(o) {
    var t = o.t, dur = o.dur, a = num(o.a, 0.004);
    var osc = ctx.createOscillator();
    var g = ctx.createGain(); g.gain.value = 0;   // 最初の自動変化より前は無音（初期値1のままだと、書き出しで1サンプルのクリックが出た）
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f1 && o.f1 !== o.f) osc.frequency.exponentialRampToValueAtTime(o.f1, t + num(o.glide, dur));
    if (o.detune) { try { osc.detune.setValueAtTime(o.detune, t); } catch (e) { /* 無視 */ } }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.gain * sfxLevel, t + a);
    if (o.hold) g.gain.setValueAtTime(o.gain * sfxLevel, t + a + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var node = osc;
    if (o.lp) {
      try {
        var flt = ctx.createBiquadFilter();
        flt.type = o.ftype || 'lowpass';
        flt.Q.value = num(o.q, 0.7);
        flt.frequency.setValueAtTime(o.lp, t);
        if (o.lp1) flt.frequency.exponentialRampToValueAtTime(o.lp1, t + num(o.lpTime, dur));
        osc.connect(flt); node = flt;
      } catch (e) { node = osc; }
    }
    node.connect(g); g.connect(o.dest);
    if (o.send) { try { g.connect(o.send); } catch (e) { /* 無視 */ } }
    osc.start(t); osc.stop(t + dur + 0.05);
  }
  // ノイズ: { t, dur, gain, a, ftype, f, f1, q, dest }
  function noise(o) {
    var buf = getNoise(); if (!buf) return;
    var t = o.t, dur = o.dur;
    var src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    var g = ctx.createGain(); g.gain.value = 0;   // 同上（クリック対策）
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.gain * sfxLevel, t + num(o.a, 0.002));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var node = src;
    try {
      var flt = ctx.createBiquadFilter();
      flt.type = o.ftype || 'lowpass';
      flt.Q.value = num(o.q, 0.7);
      flt.frequency.setValueAtTime(o.f || 4000, t);
      if (o.f1) flt.frequency.exponentialRampToValueAtTime(o.f1, t + num(o.fTime, dur));
      src.connect(flt); node = flt;
    } catch (e) { node = src; }
    node.connect(g); g.connect(o.dest);
    src.start(t, Math.random() * 0.9); src.stop(t + dur + 0.05);
  }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  // ---- 効果音の定義 ----
  // gap: 同じIDの最短間隔(秒)、max: 同じIDの同時発音数、len: おおよその長さ（発音数の管理用）
  // gap と max は CONFIG.audio.sfx[id] にあればそちらを使う（ここの値は予備）。len は音の長さに合わせた内部の値
  var SFX = {
    // 射撃: とても短く静かな「ポッ」。三角波中心で高い倍音を抑え、2〜6kHz が耳に刺さらないように。毎回わずかに音程を揺らす
    se_shot: { gap: 0.05, max: 3, len: 0.06, fn: function (t, d) {
      var p = rnd(0.97, 1.03);
      voice({ type: 'triangle', f: 1250 * p, f1: 640 * p, t: t, dur: 0.05, gain: 0.14, a: 0.002, dest: d });
      voice({ type: 'square', f: 1250 * p, f1: 640 * p, t: t, dur: 0.035, gain: 0.024, a: 0.002, lp: 1800, dest: d });
    } },
    // 命中: 乾いた「チッ」。高域（6kHz〜）のノイズで、大事な音の帯域（1〜4kHz）をふさがない
    se_hit: { gap: 0.06, max: 2, len: 0.05, fn: function (t, d) {
      noise({ t: t, dur: 0.03, gain: 0.112, ftype: 'highpass', f: 6500, dest: d });
      voice({ type: 'triangle', f: 900, f1: 500, t: t, dur: 0.04, gain: 0.064, dest: d });
    } },
    // 敵撃破: こもったノイズの「ボフッ」＋低いドスン（中高域は控えめ）
    se_explode: { gap: 0.07, max: 3, len: 0.4, fn: function (t, d) {
      noise({ t: t, dur: 0.36, gain: 0.16, ftype: 'lowpass', f: 1800, f1: 150, q: 1.0, dest: d });
      voice({ type: 'sine', f: 180, f1: 42, t: t, dur: 0.28, gain: 0.32, a: 0.002, dest: d });
      voice({ type: 'square', f: 260, f1: 60, t: t, dur: 0.1, gain: 0.025, lp: 700, dest: d });
    } },
    // 星: キラッと上がる3音（E6→A6→E7）＋短い余韻。1〜4kHz にしっかり音がある
    se_star: { gap: 0.04, max: 3, len: 0.36, fn: function (t, d) {
      var n = [88, 93, 100];
      for (var i = 0; i < 3; i++) {
        var last = (i === 2);
        voice({ type: 'triangle', f: mtof(n[i]), t: t + i * 0.05, dur: last ? 0.3 : 0.14, gain: 0.375, a: 0.003, dest: d });
        voice({ type: 'square', f: mtof(n[i] - 12), t: t + i * 0.05, dur: last ? 0.22 : 0.1, gain: 0.05, a: 0.003, lp: 3500, dest: d });
      }
    } },
    // 被弾: ザラついた下降音＋1〜4kHz の濁ったブザー＋ノイズ。爆発や命中が重なっていても「やられた」とわかる
    se_damage: { gap: 0.15, max: 1, len: 0.6, fn: function (t, d) {
      voice({ type: 'sawtooth', f: 620, f1: 90, t: t, dur: 0.5, gain: 0.24, lp: 3500, lp1: 900, q: 4, dest: d });
      voice({ type: 'square', f: 1480, f1: 880, t: t, dur: 0.48, gain: 0.07, hold: 0.2, lp: 4000, dest: d });
      voice({ type: 'square', f: 1520, f1: 905, t: t, dur: 0.48, gain: 0.07, hold: 0.2, lp: 4000, dest: d });
      noise({ t: t, dur: 0.45, gain: 0.3, ftype: 'bandpass', f: 2600, f1: 1100, q: 0.9, dest: d });
      voice({ type: 'sine', f: 140, f1: 40, t: t, dur: 0.35, gain: 0.3, dest: d });
    } },
    // WARNING: うねる警報音を3回
    se_warning: { gap: 0.5, max: 1, len: 1.5, fn: function (t, d) {
      for (var i = 0; i < 3; i++) {
        var s = t + i * 0.5;
        voice({ type: 'sawtooth', f: 520, f1: 820, glide: 0.3, t: s, dur: 0.4, gain: 0.2, a: 0.02, hold: 0.22, lp: 2600, q: 3, dest: d });
        voice({ type: 'sawtooth', f: 523, f1: 826, glide: 0.3, t: s, dur: 0.4, gain: 0.15, a: 0.02, hold: 0.22, detune: -12, lp: 2000, dest: d });
        voice({ type: 'square', f: 130, f1: 205, glide: 0.3, t: s, dur: 0.4, gain: 0.125, a: 0.02, hold: 0.22, lp: 800, dest: d });
      }
    } },
    // ボス撃破: 連続する爆発＋長い低音と余韻
    se_boss_explode: { gap: 0.5, max: 1, len: 2.6, fn: function (t, d) {
      voice({ type: 'sine', f: 120, f1: 28, t: t, dur: 2.0, gain: 0.55, a: 0.005, dest: d });
      voice({ type: 'sawtooth', f: 90, f1: 30, t: t, dur: 1.4, gain: 0.12, lp: 600, lp1: 80, dest: d });
      noise({ t: t, dur: 2.4, gain: 0.4, ftype: 'lowpass', f: 3000, f1: 90, q: 0.8, dest: d });
      var at = [0, 0.18, 0.4, 0.62, 0.9];
      for (var i = 0; i < at.length; i++) {
        noise({ t: t + at[i], dur: 0.45, gain: 0.32, ftype: 'lowpass', f: 6000 - i * 700, f1: 200, q: 1.5, dest: d });
        voice({ type: 'sine', f: 170 - i * 15, f1: 40, t: t + at[i], dur: 0.3, gain: 0.3, dest: d });
      }
      // 最後にキラッとした余韻（A5 と E6）
      voice({ type: 'triangle', f: mtof(81), t: t + 1.0, dur: 1.4, gain: 0.05, a: 0.05, dest: d });
      voice({ type: 'triangle', f: mtof(88), t: t + 1.08, dur: 1.3, gain: 0.04, a: 0.05, dest: d });
    } },
    // ゲームオーバー: 下がっていく短調のアルペジオ（E5 C5 A4 → 低いA）
    se_gameover: { gap: 0.5, max: 1, len: 2.0, fn: function (t, d) {
      var n = [76, 72, 69, 64];
      for (var i = 0; i < n.length; i++) {
        var s = t + i * 0.22, last = (i === n.length - 1), dur = last ? 1.4 : 0.32;
        voice({ type: 'sawtooth', f: mtof(n[i]), f1: last ? mtof(n[i]) * 0.94 : 0, glide: dur, t: s, dur: dur, gain: 0.14, a: 0.01, lp: 2400, lp1: 400, dest: d });
        voice({ type: 'sawtooth', f: mtof(n[i]), t: s, dur: dur, gain: 0.1, a: 0.01, detune: 14, lp: 1800, lp1: 300, dest: d });
      }
      voice({ type: 'triangle', f: mtof(45), f1: mtof(45) * 0.94, t: t + 0.66, dur: 1.4, gain: 0.3, a: 0.02, dest: d });
    } },
    // クリア: 上がっていく長調のファンファーレ（A C# E A → A の和音）
    se_clear: { gap: 0.5, max: 1, len: 2.0, fn: function (t, d) {
      var n = [69, 73, 76, 81];
      for (var i = 0; i < n.length; i++) {
        voice({ type: 'square', f: mtof(n[i]), t: t + i * 0.11, dur: 0.18, gain: 0.08, lp: 3200, dest: d });
      }
      var chord = [69, 73, 76, 81, 85], s = t + 0.44;
      for (var j = 0; j < chord.length; j++) {
        voice({ type: 'sawtooth', f: mtof(chord[j]), t: s, dur: 1.5, gain: 0.06, a: 0.02, hold: 0.3, detune: -9, lp: 4000, lp1: 900, dest: d });
        voice({ type: 'sawtooth', f: mtof(chord[j]), t: s, dur: 1.5, gain: 0.06, a: 0.02, hold: 0.3, detune: 9, lp: 4000, lp1: 900, dest: d });
      }
      voice({ type: 'triangle', f: mtof(45), t: s, dur: 1.5, gain: 0.3, a: 0.01, hold: 0.3, dest: d });
      voice({ type: 'sine', f: mtof(93), t: s + 0.1, dur: 1.0, gain: 0.04, a: 0.02, dest: d });
    } },
    // 決定: 短い2音の「ピロッ」（A5→E6）
    se_select: { gap: 0.04, max: 2, len: 0.16, fn: function (t, d) {
      voice({ type: 'square', f: mtof(81), t: t, dur: 0.06, gain: 0.144, lp: 3500, dest: d });
      voice({ type: 'square', f: mtof(88), t: t + 0.05, dur: 0.1, gain: 0.144, lp: 3500, dest: d });
    } }
  };

  function pendingMs() { return (CONFIG.audio && CONFIG.audio.pendingSfxMs) || 300; }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  // 音の準備ができたら、直前に頼まれていた効果音（開始音など）を1回だけ鳴らし直す（QA v1.1 再レビュー）
  function flushPending() {
    try {
      if (!ctx || ctx.state !== 'running') return;
      var p = pendingSfx; pendingSfx = null;
      if (p && nowMs() - p.at <= pendingMs()) playSfx(p.id);
    } catch (e) { /* 無視 */ }
  }

  // 大事な音（被弾・星・WARNING）が鳴っている間、細かい音のバスを少し下げて聞き取りやすくする
  function duckMinor(now, dur) {
    if (!minorBus) return;
    try {
      var g = minorBus.gain, low = mix('duck', 0.4);
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(low, now + mix('duckAttack', 0.01));
      g.setValueAtTime(low, now + dur);
      g.linearRampToValueAtTime(1, now + dur + mix('duckRelease', 0.15));
    } catch (e) { /* 無視 */ }
  }

  function playSfx(id) {
    var def = SFX[id];
    if (!def) return;
    if (!canSound()) {
      // 解除済みで準備（resume）待ちのときだけ、最後の1つを短い間だけ覚えておく。まとめて鳴らすことはしない
      // 射撃音・命中音は細かく何度も鳴るので覚えない（開始音などの大事な音を上書きしないため。QA 再レビュー 18:5x）
      // 爆発音（se_explode）も同じく覚えない（QA 再レビュー 19:40。開始音を上書きできたため）
      if (MINOR_IDS[id]) return;
      if (ctx && unlocked && !muted && ctx.state !== 'running' && ctx.state !== 'closed') pendingSfx = { id: id, at: nowMs() };
      return;
    }
    var now = ctx.currentTime, sc = sfxCfg(id);
    var gap = num(sc.gap, def.gap), max = num(sc.max, def.max), duck = num(sc.duck, KEY_DUCK[id] || 0);
    if (lastPlay[id] !== undefined && now - lastPlay[id] < gap && now >= lastPlay[id]) return;   // 連打の間引き
    var list = voices[id] || (voices[id] = []);
    while (list.length && list[0] <= now) list.shift();
    while (allVoices.length && allVoices[0] <= now) allVoices.shift();
    if (list.length >= max) return;                                       // 同じ音の重なりすぎを防ぐ
    if (allVoices.length >= mix('maxSfxVoices', 24) && (id === 'se_shot' || id === 'se_hit')) return;   // 混んでいるときは細かい音から間引く
    lastPlay[id] = now;
    var end = now + def.len;
    list.push(end);
    allVoices.push(end); allVoices.sort(function (a, b) { return a - b; });
    if (duck > 0) duckMinor(now, duck);
    sfxLevel = num(sc.level, 1);
    try { def.fn(now + 0.005, (MINOR_IDS[id] && minorBus) || sfxBus || master); } finally { sfxLevel = 1; }
  }

  // ---- BGM の楽器 ----
  function kick(t, d, g) {
    voice({ type: 'sine', f: 150, f1: 42, glide: 0.12, t: t, dur: 0.3, gain: g, a: 0.002, dest: d });
  }
  function snare(t, d, g) {
    noise({ t: t, dur: 0.18, gain: g, ftype: 'bandpass', f: 1900, q: 0.7, dest: d });
    voice({ type: 'triangle', f: 230, f1: 160, t: t, dur: 0.08, gain: g * 0.5, dest: d });
  }
  function hat(t, d, g, len) {
    noise({ t: t, dur: len || 0.04, gain: g, ftype: 'highpass', f: 7500, dest: d });
  }
  function bass(t, d, m, len, g, cut) {
    voice({ type: 'sawtooth', f: mtof(m), t: t, dur: len, gain: g, a: 0.003, lp: cut, lp1: Math.max(120, cut * 0.25), lpTime: len * 0.8, q: 5, dest: d });
  }
  function pluck(t, d, s, m, len, g, type, cut) {
    voice({ type: type || 'square', f: mtof(m), t: t, dur: len, gain: g, a: 0.003, lp: cut || 3000, lp1: 600, lpTime: len, q: 2, dest: d, send: s });
  }
  function lead(t, d, s, m, len, g, cut) {
    voice({ type: 'sawtooth', f: mtof(m), t: t, dur: len, gain: g, a: 0.02, hold: len * 0.5, lp: cut || 2600, detune: -7, dest: d, send: s });
    voice({ type: 'sawtooth', f: mtof(m), t: t, dur: len, gain: g, a: 0.02, hold: len * 0.5, lp: cut || 2600, detune: 7, dest: d, send: s });
  }
  function pad(t, d, s, notes, len, g) {
    for (var i = 0; i < notes.length; i++) {
      voice({ type: 'sawtooth', f: mtof(notes[i]), t: t, dur: len, gain: g, a: len * 0.35, hold: len * 0.2, detune: -10, lp: 1100, dest: d, send: s });
      voice({ type: 'sawtooth', f: mtof(notes[i]), t: t, dur: len, gain: g, a: len * 0.35, hold: len * 0.2, detune: 10, lp: 1100, dest: d });
    }
  }

  // ---- BGM の譜面（16分音符 × 16ステップ × 4小節） ----
  // 和音は MIDI ノート番号（57 = A3 = 220Hz）
  var BGM = {
    // タイトル: ゆったり。Am9 - Fmaj7 - C - G のパッド、遠くで鳴る三角波のアルペジオ
    bgm_title: { bpm: 90, bars: 4, delay: 0.75, fb: 0.35, wet: 0.3,
      roots: [33, 29, 36, 31],
      chords: [[57, 60, 64, 71], [53, 57, 60, 64], [55, 60, 64, 67], [55, 59, 62, 66]],
      arp: [[69, 72, 76, 79], [65, 69, 72, 76], [67, 72, 76, 79], [67, 71, 74, 78]],
      fn: function (L, bar, st, t, d, s, sd) {
        var c = this;
        if (st === 0) { pad(t, d, s, c.chords[bar], sd * 20, 0.032); bass(t, d, c.roots[bar] + 12, sd * 14, 0.11, 500); }
        if (st === 8) bass(t, d, c.roots[bar] + 12, sd * 7, 0.07, 400);
        if (st % 2 === 0) { var a = c.arp[bar], k = [0, 1, 2, 3, 2, 1, 3, 1][st / 2]; pluck(t, d, s, a[k], sd * 2.5, 0.035, 'triangle', 2400); }
        if (st === 0 || st === 10) kick(t, d, 0.13);
        if (st === 4 || st === 12) hat(t, d, 0.03, 0.12);
      } },
    // 通常パート: 128BPM。16分の刻むベース、4つ打ち、16分のアルペジオ、サビっぽいリード
    bgm_stage: { bpm: 128, bars: 4, delay: 0.75, fb: 0.3, wet: 0.25,
      roots: [33, 29, 36, 31],
      arp: [[57, 60, 64, 69], [53, 57, 60, 65], [55, 60, 64, 67], [55, 59, 62, 67]],
      melody: [[0, 0, 76, 6], [0, 8, 74, 4], [0, 12, 72, 4], [1, 0, 77, 8], [1, 8, 76, 8], [2, 0, 79, 6], [2, 8, 76, 4], [2, 12, 72, 4], [3, 0, 74, 12], [3, 12, 71, 4]],
      fn: function (L, bar, st, t, d, s, sd) {
        var c = this, a = c.arp[bar];
        // 1小節目の1拍目のアルペジオは A3(220Hz) から始まる
        pluck(t, d, s, a[[0, 1, 2, 3, 1, 2, 3, 2][st % 8]], sd * 1.6, st % 4 === 0 ? 0.045 : 0.032, 'square', 2600);
        var r = c.roots[bar] + (st === 14 || st === 6 ? 12 : 0);
        bass(t, d, r, sd * 0.9, st % 2 === 0 ? 0.13 : 0.09, st % 4 === 0 ? 1400 : 900);
        if (st % 4 === 0) kick(t, d, 0.42);
        if (st === 4 || st === 12) snare(t, d, 0.2);
        hat(t, d, st % 4 === 2 ? 0.07 : 0.03, st % 4 === 2 ? 0.06 : 0.03);
        for (var i = 0; i < c.melody.length; i++) {
          var n = c.melody[i];
          if (n[0] === bar && n[1] === st) lead(t, d, s, n[2], sd * n[3], 0.03, 2400);
        }
      } },
    // ボス戦: 150BPM。A - B♭ - A - G# の半音の動きで緊張感。ベースはオクターブで跳ね、キックが多め
    bgm_boss: { bpm: 150, bars: 4, delay: 0.5, fb: 0.25, wet: 0.2,
      roots: [33, 34, 33, 32],
      arp: [[69, 72, 76, 81], [70, 74, 77, 82], [69, 72, 76, 81], [68, 71, 74, 80]],
      fn: function (L, bar, st, t, d, s, sd) {
        var c = this, a = c.arp[bar];
        pluck(t, d, s, a[[0, 2, 1, 3, 2, 0, 3, 1][st % 8]], sd * 1.2, 0.03, 'sawtooth', 3200);
        var r = c.roots[bar] + ([3, 7, 11, 15].indexOf(st) >= 0 ? 12 : 0);
        bass(t, d, r, sd * 0.85, st % 2 === 0 ? 0.14 : 0.1, st % 4 === 0 ? 1600 : 1000);
        if (st % 4 === 0 || st === 10 || st === 14) kick(t, d, 0.4);
        if (st === 4 || st === 12) snare(t, d, 0.22);
        hat(t, d, st % 2 === 0 ? 0.06 : 0.035, 0.03);
        // 警報のような半音のリード（E5→F5）
        if (st === 0 && (bar === 1 || bar === 3)) { lead(t, d, s, 76, sd * 6, 0.028, 2000); }
        if (st === 8 && (bar === 1 || bar === 3)) { lead(t, d, s, 77, sd * 8, 0.028, 2000); }
      } }
  };

  function makeLoopBus(def) {
    var bus = ctx.createGain(); bus.gain.value = 1; bus.connect(bgmBus || master);
    var send = null;
    try {   // 軽いフィードバックディレイ（シンセウェイブらしい広がり）。作れなければ無し
      var spb = 60 / def.bpm;
      var dl = ctx.createDelay(1.5); dl.delayTime.value = Math.min(1.4, spb * def.delay);
      var fb = ctx.createGain(); fb.gain.value = def.fb;
      var wet = ctx.createGain(); wet.gain.value = def.wet;
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500;
      send = ctx.createGain(); send.gain.value = 1;
      send.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(wet); wet.connect(bus);
    } catch (e) { send = null; }
    return { bus: bus, send: send };
  }

  function fadeOutLoop(l) {
    if (!l || !l.bus) return;
    try {
      var now = ctx.currentTime;
      l.bus.gain.cancelScheduledValues(now);
      l.bus.gain.setValueAtTime(l.bus.gain.value, now);
      l.bus.gain.linearRampToValueAtTime(0, now + 0.06);
    } catch (e) { /* 無視 */ }
    setTimeout(function () {
      try { l.bus.disconnect(); } catch (e) { /* 無視 */ }
      try { if (l.send) l.send.disconnect(); } catch (e) { /* 無視 */ }
    }, 400);
  }

  function startBgmLoop() {
    clearBgmLoop();
    if (!currentBgm || !ctx || !unlocked) return;
    var def = BGM[currentBgm];
    if (!def) return;
    bgmStep = 0;
    var sd = 60 / def.bpm / 4;   // 16分音符の長さ
    var nextTime = -1;
    var tick = function () {
      try {
        if (!loop || ctx.state !== 'running') { nextTime = -1; return; }   // 止まっている間は予約しない（再開時にまとめて鳴らさない）
        var now = ctx.currentTime;
        if (nextTime < 0 || nextTime < now - 0.05) {
          var d0 = 0.02;
          if (justResumed) { justResumed = false; d0 = Math.max(d0, (CONFIG.audio && CONFIG.audio.firstBgmDelay) || 0); }
          nextTime = now + d0;
          if (debugLog.length < 200) debugLog.push(currentBgm);
        }   // 初回・タイマーが大きく遅れたときは、まとめて鳴らさず今から
        while (nextTime < now + LOOKAHEAD) {
          var total = def.bars * 16, st = bgmStep % 16, bar = Math.floor((bgmStep % total) / 16);
          if (!muted) def.fn(def, bar, st, nextTime, loop.bus, loop.send, sd);   // ミュート中は譜面だけ進める
          bgmStep++;
          nextTime += sd;
        }
      } catch (e) { /* 無視 */ }
    };
    try { loop = makeLoopBus(def); } catch (e) { loop = null; return; }
    tick();
    bgmTimer = setInterval(tick, TICK_MS);
  }

  function clearBgmLoop() {
    if (bgmTimer !== null) { clearInterval(bgmTimer); bgmTimer = null; }
    if (loop) { var l = loop; loop = null; fadeOutLoop(l); }
  }

  return {
    unlock: function () {
      try {
        ensureCtx();
        if (!ctx) return;
        // 'suspended'（自動再生制限）も 'interrupted'（iOS で通知・通話に割り込まれた）も resume する
        if (ctx.state !== 'running' && ctx.state !== 'closed' && ctx.resume) {
          justResumed = true;
          var pr = ctx.resume();
          if (pr && pr.then) pr.then(flushPending, function () { /* 解除できなくても止めない */ });
        }
        // iOS 向け: ユーザー操作の中で無音を1回鳴らすと確実に解除される
        try {
          var buf = ctx.createBuffer(1, 1, ctx.sampleRate || CONFIG.audio.fallbackSampleRate);
          var src = ctx.createBufferSource();
          src.buffer = buf; src.connect(ctx.destination); src.start(0);
        } catch (e2) { /* 無視 */ }
        if (!ctx.__sdState) {
          ctx.__sdState = true;
          try { ctx.addEventListener('statechange', function () { if (ctx.state === 'running') flushPending(); }); } catch (e3) { /* 無視 */ }
        }
        if (!unlocked) {
          unlocked = true;
          // 待っていたBGMは次のタスクで開始する。最初の入力でそのままゲーム開始した場合に
          // タイトルBGMの1音目がステージBGMと重なるのを防ぐ（QA v1.1）
          setTimeout(function () { if (currentBgm && bgmTimer === null) startBgmLoop(); }, 0);
        }
      } catch (e) { /* 無視 */ }
    },
    play: function (id) {
      try {
        playSfx(id);
      } catch (e) { /* 無視 */ }
    },
    playBgm: function (id) {
      try {
        if (currentBgm === id && bgmTimer !== null) return;
        currentBgm = id;
        startBgmLoop();
      } catch (e) { /* 無視 */ }
    },
    stopBgm: function () {
      try { currentBgm = null; clearBgmLoop(); } catch (e) { /* 無視 */ }
    },
    stopSfx: function () {   // 任意: 画面が隠れたときに呼ばれる。鳴っている効果音の余韻を止める
      try { cutSfx(); } catch (e) { /* 無視 */ }
    },
    _debugBgmLog: function () { return debugLog.slice(); },   // テスト用（読み取りのみ）
    setMuted: function (m) {
      muted = !!m;
      try { if (master) master.gain.value = muted ? 0 : 1; } catch (e) { /* 無視 */ }
    }
  };
})();
