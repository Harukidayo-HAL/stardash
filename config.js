/*
 * スターダッシュ 設定値（仕様書 v1.1 準拠）
 * ゲームの数値はすべてここに集約する。調整はこのファイルだけで行う。
 * 単位: 座標/サイズ = 論理px（360×640）, 速度 = px/秒, 時間 = 秒, 角度 = 度
 */
var CONFIG = {
  // ---- 3章 画面 ----
  screen: {
    width: 360,
    height: 640,
    maxDevicePixelRatio: 2,
    letterboxColor: '#000'
  },

  // ---- 2章 ループ ----
  loop: {
    maxDt: 0.05            // 1フレームの dt 上限（タブ復帰時のワープ防止）
  },

  // ---- 3章 背景（流れる星3層） ----
  background: {
    colorTop: '#000',
    colorBottom: '#0a0f2a',
    layers: [
      { speed: 30,  count: 20, size: 1,   alpha: 0.4 },
      { speed: 60,  count: 15, size: 1.5, alpha: 0.7 },
      { speed: 120, count: 10, size: 2,   alpha: 1.0 }
    ]
  },

  // ---- 5章 自機 ----
  player: {
    startX: 180,
    startY: 560,
    width: 24,
    height: 24,
    hitRadius: 5,
    speed: 240,
    edgeMargin: 12,          // 中心が端から12px以上内側
    lives: 3,
    invincibleTime: 2.0,
    blinkInterval: 0.1,
    shotInterval: 0.15,
    deathTime: 1.0,          // 4.4 自機爆発演出 → GAME OVER 表示まで
    color: '#4ff'
  },

  playerBullet: {
    offsetX: 6,              // 自機中心から左右 ±6px
    offsetY: -12,            // 発射位置（自機中心からの y オフセット）
    speed: 600,
    width: 4,
    height: 12,
    hitRadius: 3,            // 判定（見た目と独立）
    damage: 1,
    color: '#ff4',
    offscreenMargin: 20
  },

  // ---- 6章 入力 ----
  input: {
    dragRatio: 1.0           // 相対ドラッグの倍率
  },

  // ---- 7章 進行 ----
  stage: {
    readyTime: 2.0,          // 最初の2.0秒は敵を出さない
    bossTime: 120,           // 120秒でボス戦
    warningTime: 2.0,        // WARNING 表示時間
    phaseBannerTime: 1.0,    // PHASE 2/3 表示時間
    spawnY: -30,
    spawnMarginX: 24,
    timeEpsilon: 1e-6,       // 出現時刻の比較誤差（浮動小数対策）
    phases: [
      { name: 'PHASE 1', start: 0,  end: 40,  speedMul: 1.0,  intervals: { A: 1.0 } },
      { name: 'PHASE 2', start: 40, end: 80,  speedMul: 1.15, intervals: { A: 0.8, B: 2.5 } },
      { name: 'PHASE 3', start: 80, end: 120, speedMul: 1.3,  intervals: { A: 0.6, B: 1.8, C: 6.0 } }
    ]
  },

  // ---- 7.2 星 ----
  star: {
    periodicInterval: 3.0,
    spawnY: -20,
    spawnMarginX: 24,
    fallSpeed: 100,
    hitRadius: 10,
    magnetRange: 80,
    magnetSpeed: 300,
    score: 50,
    scatter: 16,             // 複数ドロップ時の散らばり（±px）
    offscreenMargin: 20,
    size: 20,                // 見た目の直径（px）。判定 hitRadius 10 と一致（直径20）
    color: '#ffd84a'
  },

  // ---- 8章 敵 ----
  enemy: {
    offscreenBottomMargin: 40,  // 下端 +40 より下で消える
    offscreenSideMargin: 0,     // 中心が左右の画面外に出たら消える
    hitFlashTime: 0.05,
    explosionTime: 0.3,
    types: {
      A: {
        width: 20, height: 20, hitRadius: 10, hp: 1, speed: 120,
        score: 100, dropChance: 0.3, dropCount: 1, color: '#f55'
      },
      B: {
        width: 24, height: 24, hitRadius: 12, hp: 3, speed: 90,
        swayAmplitude: 60, swayPeriod: 2.0,
        keepSwayOnScreen: true,   // 7.1: 出現xは「端から24px + 揺れ幅60」内側 = x=84〜276
        fireMinAbovePlayer: 40,   // 8章 v1.1: 自機より40px以上上にいる間だけ撃つ
        fireInterval: 2.0, firstFireDelay: 1.0, bulletSpeed: 180,
        score: 300, dropChance: 1.0, dropCount: 1, color: '#c5f'
      },
      C: {
        width: 40, height: 40, hitRadius: 20, hp: 12, speed: 60,
        stopY: 130, stopTime: 3.0,
        fireInterval: 1.0, firstFireDelay: 0.0, bulletSpeed: 150,
        fanWays: 5, fanStepDeg: 15,           // ±30° を 15°刻み = 5方向
        score: 1000, dropChance: 1.0, dropCount: 3, color: '#fa3'
      }
    }
  },

  enemyBullet: {
    hitRadius: 4,
    diameter: 8,
    maxCount: 200,
    offscreenMargin: 20,
    color: '#f8c',
    edgeColor: '#fff'
  },

  // ---- 9章 ボス ----
  boss: {
    width: 120,
    height: 60,
    hitRadius: 36,
    hp: 120,                 // v1.1: 240 → 120
    startX: 180,
    startY: -60,
    stopY: 110,
    entryTime: 3.0,
    minX: 70,
    maxX: 290,
    score: 10000,
    halfHpRatio: 0.5,        // HP 50%以下（= 60）で後半
    shakeTime: 0.5,
    shakeAmplitude: 6,
    deathTime: 2.0,
    deathSmallInterval: 0.12,   // 小爆発の連続間隔
    deathSmallUntil: 1.4,       // ここまで小爆発 → 大爆発
    deathSmallScatter: 50,
    deathBigTime: 0.6,
    color: '#f3a',
    coreColor: '#fff',
    phase1: {
      moveSpeed: 80,
      aimInterval: 1.2, aimWays: 3, aimStepDeg: 15, aimSpeed: 200,
      radialInterval: 4.0, radialWays: 12, radialSpeed: 140, radialRotateDeg: 0
    },
    phase2: {
      moveSpeed: 120,
      aimInterval: 0.8, aimWays: 5, aimStepDeg: 15, aimSpeed: 220,
      radialInterval: 3.0, radialWays: 16, radialSpeed: 150, radialRotateDeg: 11.25
    }
  },

  // ---- 10章 スコア ----
  score: {
    lifeBonus: 3000,
    noMissBonus: 5000,
    highScoreKey: 'stardash_highscore'
  },

  // ---- 4章 画面遷移 ----
  ui: {
    resultInputLock: 0.8,     // GAME OVER/CLEAR 表示から入力を受け付けない時間
    titleBlinkPeriod: 1.0,
    pauseButton: { x: 314, y: 6, w: 40, h: 40 },  // 右上 40×40（見た目）
    pauseHitPad: 8,           // 一時停止ボタンの判定を見た目より各辺この論理pxだけ広げる（→56×56）
    minTouchTargetCss: 44,    // 判定の最小サイズ（CSS px。Apple 推奨 44pt）。小さい画面では自動で広げる
    titleButton: { x: 120, y: 570, w: 120, h: 40 }, // 4.4 v1.1: リザルト画面下部の TITLE ボタン 120×40
    hudMargin: 10,
    hudFontSize: 16,
    lifeIconSize: 14,
    lifeIconGap: 6,
    lifeIconFadeAlpha: 0.4,   // 自機がライフのアイコンに重なる（近づく）ときのアイコンの不透明度
    lifeIconFadeMargin: 10,   // 自機の見た目（24×24）がアイコンの範囲からこのpx以内に来たら薄くする
    lifeIconFadeExitMargin: 16, // 薄くなったあと、元に戻すのはこのpxより外に出たとき（境目でのチラつき防止。Margin 以上にする）
    lifeIconFadeTime: 0.15,   // 薄くする／戻すのにかける秒数（0 ですぐ切り替え）
    bossBar: { x: 30, y: 52, w: 300, h: 6 },
    pauseOverlayAlpha: 0.6,
    resultOverlayAlpha: 0.6,
    titleFontSize: 44,
    bannerFontSize: 32,
    textFontSize: 16,
    smallFontSize: 12,
    lineHeight: 28,
    resultSideMargin: 30,     // クリア内訳の左右余白
    font: 'monospace'
  },

  // ---- 11章 デバッグ ----
  debug: {
    queryKey: 'debug',
    hitboxColor: 'rgba(0,255,0,0.8)'
  },

  // ---- 12章 音 ----
  audio: {
    bgmVolume: 0.5,
    seVolume: 0.7,
    mutedKey: 'stardash_muted',
    shotSoundEvery: 2,        // 2回に1回だけ se_shot
    pendingSfxMs: 300,        // 音の準備前（resume待ち）に頼まれた効果音を、準備できたら鳴らし直す猶予（ミリ秒）
    firstBgmDelay: 0.12,      // 音の準備ができた直後のBGMは、この秒数だけ遅らせて始める（出だしの欠け対策）
    // 仮音（WebAudio ビープ）の定義。サウンド担当が audio.js を差し替えたら不要
    // type: 波形, freq: 開始Hz, freqEnd: 終了Hz, dur: 秒, gain: 相対音量
    beeps: {
      se_shot:         { type: 'square',   freq: 880,  freqEnd: 660, dur: 0.04, gain: 0.15 },
      se_hit:          { type: 'square',   freq: 300,  freqEnd: 250, dur: 0.03, gain: 0.2 },
      se_explode:      { type: 'sawtooth', freq: 200,  freqEnd: 40,  dur: 0.25, gain: 0.4 },
      se_star:         { type: 'sine',     freq: 1200, freqEnd: 1800, dur: 0.08, gain: 0.4 },
      se_damage:       { type: 'sawtooth', freq: 400,  freqEnd: 60,  dur: 0.4,  gain: 0.6 },
      se_warning:      { type: 'square',   freq: 440,  freqEnd: 440, dur: 0.6,  gain: 0.4 },
      se_boss_explode: { type: 'sawtooth', freq: 150,  freqEnd: 20,  dur: 1.5,  gain: 0.7 },
      se_gameover:     { type: 'triangle', freq: 440,  freqEnd: 110, dur: 1.0,  gain: 0.6 },
      se_clear:        { type: 'triangle', freq: 523,  freqEnd: 1046, dur: 0.8, gain: 0.6 },
      se_select:       { type: 'square',   freq: 660,  freqEnd: 990, dur: 0.08, gain: 0.3 }
    },
    // 仮BGM: 音階(Hz)を順に鳴らすだけのループ
    bgm: {
      bgm_title: { type: 'triangle', step: 0.3,  notes: [262, 330, 392, 330, 294, 349, 440, 349], gain: 0.15 },
      bgm_stage: { type: 'square',   step: 0.15, notes: [220, 0, 262, 0, 330, 262, 220, 196], gain: 0.06 },
      bgm_boss:  { type: 'sawtooth', step: 0.12, notes: [110, 110, 131, 110, 147, 110, 131, 104], gain: 0.06 }
    },
    noteLength: 0.9,          // 1ステップに対する音の長さの割合
    fallbackSampleRate: 44100 // 無音バッファ（iOS の解除用）のサンプルレート。ctx.sampleRate が取れないときだけ使う
  }
};
