/* FH6 电台标记编辑器 —— 界面与交互 */
(() => {
  'use strict';

  const HR = HRAnalysisModule();
  const PROJECT_RATE = 48000; // FH6 电台统一使用 48kHz

  // ------------------------------------------------------------------ 定义
  const MARKERS = [
    { name: 'TrackStart', zh: '歌曲开始', short: 'Start', color: '#9aa4b2' },
    { name: 'TrackDrop', zh: '比赛切入点', short: 'Drop', color: '#ff5d5d', key: '1' },
    { name: 'TrackLoopStart', zh: '循环起点', short: 'Loop▸', color: '#3fb6ff', key: '2' },
    { name: 'TrackLoopEnd', zh: '循环终点', short: '◂Loop', color: '#3fb6ff', key: '3' },
    { name: 'PostDrop', zh: '赛后切入点', short: 'PostDrop', color: '#ffb347', key: '4' },
    { name: 'PostRaceLoopStart', zh: '赛后循环起点', short: 'Post▸', color: '#b48cff', key: '5' },
    { name: 'PostRaceLoopEnd', zh: '赛后循环终点', short: '◂Post', color: '#b48cff', key: '6' },
    { name: 'End', zh: '结束（最后一个采样点）', short: 'End', color: '#9aa4b2' },
    { name: 'DJDrop', zh: 'DJ 讲话后接入', short: 'DJDrop', color: '#5ad18a', adv: true },
    { name: 'DJSegment', zh: 'DJ 插入段', short: 'DJSeg', color: '#5ad18a', adv: true },
    { name: 'DJStart', zh: '结尾 DJ 可插入', short: 'DJStart', color: '#5ad18a', adv: true },
    { name: 'StingerStart', zh: '转场音效', short: 'Stinger', color: '#5ad18a', adv: true },
  ];
  const MDEF = Object.fromEntries(MARKERS.map((m) => [m.name, m]));
  const MAIN_SIX = ['TrackDrop', 'TrackLoopStart', 'TrackLoopEnd', 'PostDrop', 'PostRaceLoopStart', 'PostRaceLoopEnd'];
  const CSV_COLUMNS = ['MatchName', 'Filename', 'DisplayName', 'Artist', 'SampleRate', 'SampleLength', 'TrackStart', 'DJDrop', 'TrackDrop',
    'TrackLoopStart', 'TrackLoopEnd', 'PostDrop', 'PostRaceLoopStart', 'PostRaceLoopEnd', 'DJSegment', 'StingerStart', 'DJStart', 'End'];
  const XML_ORDER = ['TrackStart', 'DJDrop', 'TrackDrop', 'DJSegment', 'PostDrop', 'DJStart', 'StingerStart',
    'TrackLoopStart', 'TrackLoopEnd', 'PostRaceLoopStart', 'PostRaceLoopEnd', 'End'];

  const SECTION_TYPES = {
    other: { zh: '未标注', color: '#5b6372' },
    intro: { zh: '前奏', color: '#4f9d9a' },
    verse: { zh: '主歌', color: '#4a78c2' },
    build: { zh: '铺垫 / 预副歌', color: '#c29a3a' },
    chorus: { zh: '副歌 / 高潮', color: '#e0533d' },
    bridge: { zh: '桥段 / 间奏', color: '#8a62c9' },
    outro: { zh: '尾奏', color: '#3f8f5c' },
  };
  const SECTION_ALIASES = {
    drop: 'chorus', hook: 'chorus', refrain: 'chorus', pre: 'build', prechorus: 'build', 'pre-chorus': 'build', buildup: 'build',
    inst: 'bridge', solo: 'bridge', break: 'bridge', breakdown: 'bridge', interlude: 'bridge', start: 'intro', end: 'outro',
  };

  // 时间线布局
  const RULER_H = 30, SEC_H = 28, FLAG_H = 40, LOOPBAR_H = 5;
  const WAVE_TOP = RULER_H + SEC_H + FLAG_H;

  // ------------------------------------------------------------------ 状态
  const state = {
    songs: [],
    cur: null,
    view: { start: 0, spp: 1000 },
    playhead: 0,
    selMarker: null,
    selSection: -1,
    snap: 'beat',
    snapZero: true,
    follow: true,
    pendingRows: [],
    hover: null,
  };
  let needsDraw = true;
  let songSeq = 0;

  const $ = (id) => document.getElementById(id);
  const canvas = $('timeline'), ctx2d = canvas.getContext('2d');
  const ov = $('overview'), ovctx = ov.getContext('2d');

  // ------------------------------------------------------------------ 工具函数
  function fmtTime(samples, sr = PROJECT_RATE, ms = true) {
    if (samples == null || isNaN(samples)) return '';
    const neg = samples < 0;
    let t = Math.abs(samples) / sr;
    const m = Math.floor(t / 60);
    t -= m * 60;
    const s = ms ? t.toFixed(3).padStart(6, '0') : String(Math.floor(t)).padStart(2, '0');
    return (neg ? '-' : '') + String(m).padStart(2, '0') + ':' + s;
  }

  function parseTime(text, sr = PROJECT_RATE) {
    const t = String(text).trim();
    if (!t) return null;
    const parts = t.split(':').map((p) => p.trim());
    if (parts.some((p) => p === '' || isNaN(Number(p)))) return NaN;
    let sec = 0;
    for (const p of parts) sec = sec * 60 + Number(p);
    return Math.round(sec * sr);
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function nearestIndex(arr, v) {
    let lo = 0, hi = arr.length - 1;
    if (hi < 0) return -1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(arr[lo - 1] - v) <= Math.abs(arr[lo] - v)) return lo - 1;
    return lo;
  }

  function firstIndexAtOrAfter(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function toast(msg, ms = 2600) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, ms);
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function baseName(name) { return name.replace(/\.[^.]+$/, ''); }
  function normName(name) { return baseName(String(name || '')).trim().toLowerCase(); }
  function isAudioFile(f) { return /^audio\//.test(f.type) || /\.(wav|mp3|flac|ogg|m4a|aac|opus|wma)$/i.test(f.name); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // ------------------------------------------------------------------ 音频载入
  function parseWavHeader(ab) {
    const v = new DataView(ab);
    if (ab.byteLength < 44 || v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) return null;
    let off = 12, fmt = null;
    while (off + 8 <= ab.byteLength) {
      const id = v.getUint32(off, false), size = v.getUint32(off + 4, true);
      if (id === 0x666d7420) {
        fmt = { format: v.getUint16(off + 8, true), channels: v.getUint16(off + 10, true), sampleRate: v.getUint32(off + 12, true), bits: v.getUint16(off + 22, true) };
      } else if (id === 0x64617461 && fmt) {
        const bytesPerFrame = fmt.channels * fmt.bits / 8;
        const dataBytes = Math.min(size, ab.byteLength - off - 8);
        return { ...fmt, frames: Math.floor(dataBytes / bytesPerFrame) };
      }
      off += 8 + size + (size & 1);
    }
    return fmt;
  }

  async function decodeSong(song) {
    const ab = await song.file.arrayBuffer();
    const wav = parseWavHeader(ab);
    song.native = wav ? { sampleRate: wav.sampleRate, channels: wav.channels, bits: wav.bits, frames: wav.frames, wav: true } : { wav: false };
    const octx = new OfflineAudioContext(2, 1, PROJECT_RATE);
    const buffer = await octx.decodeAudioData(ab);
    song.buffer = buffer;
    song.sr = buffer.sampleRate;
    song.length = buffer.length;
    const n = buffer.length, chs = buffer.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < chs; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i];
    }
    if (chs > 1) for (let i = 0; i < n; i++) mono[i] /= chs;
    song.mono = mono;
    song.peaks = buildPeaks(mono);
  }

  function buildPeaks(mono) {
    const levels = [];
    let block = 256;
    let n = Math.ceil(mono.length / block);
    let min = new Float32Array(n), max = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let lo = 1, hi = -1;
      const e = Math.min(mono.length, (b + 1) * block);
      for (let i = b * block; i < e; i++) { const v = mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      min[b] = lo; max[b] = hi;
    }
    levels.push({ block, min, max });
    while (n > 2) {
      const n2 = Math.ceil(n / 2), mn = new Float32Array(n2), mx = new Float32Array(n2);
      for (let b = 0; b < n2; b++) {
        const a = 2 * b, c = Math.min(n - 1, a + 1);
        mn[b] = Math.min(min[a], min[c]); mx[b] = Math.max(max[a], max[c]);
      }
      block *= 2; n = n2; min = mn; max = mx;
      levels.push({ block, min, max });
    }
    return levels;
  }

  function releaseAudio(song) {
    song.buffer = null; song.mono = null; song.peaks = null;
  }

  function newSong(file) {
    return {
      id: ++songSeq, file, name: file.name, base: baseName(file.name),
      sr: PROJECT_RATE, length: 0, native: null, buffer: null, mono: null, peaks: null,
      markers: {}, sections: [], analysis: null, displayName: baseName(file.name), artist: '',
      undo: [], redo: [], loaded: false,
    };
  }

  function defaultMarkers(song) {
    const m = {};
    for (const d of MARKERS) m[d.name] = null;
    m.TrackStart = 0;
    m.End = song.length - 1;
    return m;
  }

  async function addFiles(files) {
    const audio = [...files].filter(isAudioFile);
    const data = [...files].filter((f) => /\.(csv|json)$/i.test(f.name));
    let first = null;
    for (const f of audio) {
      const exists = state.songs.find((s) => s.name === f.name && s.file.size === f.size);
      if (exists) { first = first || exists; continue; }
      const s = newSong(f);
      state.songs.push(s);
      first = first || s;
    }
    renderSongList();
    if (first) await selectSong(first);
    for (const f of data) await importFile(f);
  }

  async function selectSong(song) {
    if (state.cur === song && song.buffer) return;
    pause();
    if (state.cur && state.cur !== song) { saveSong(state.cur); releaseAudio(state.cur); }
    state.cur = song;
    state.selMarker = null; state.selSection = -1;
    renderSongList();
    setStatus(`正在解码 ${song.name} …`);
    try {
      await decodeSong(song);
    } catch (e) {
      console.error(e);
      toast(`无法解码 ${song.name}：浏览器不支持该格式或文件损坏`, 5000);
      setStatus('解码失败');
      return;
    }
    if (!song.loaded) {
      song.markers = defaultMarkers(song);
      song.sections = [{ start: 0, end: song.length, label: 'other' }];
      song.loaded = true;
      if (restoreSong(song)) toast('已恢复该歌曲上次的标记（本地自动保存）');
      applyPendingRows(song);
    }
    state.playhead = clamp(state.playhead, 0, song.length);
    if (state.playhead >= song.length) state.playhead = 0;
    zoomFit();
    renderAll();
    setStatus(`${song.name} 已载入：${song.length.toLocaleString()} 采样点 @ ${song.sr} Hz`);
  }

  // ------------------------------------------------------------------ 本地自动保存
  const storeKey = (s) => `fh6ms:${s.base}:${s.length}`;
  function serializeAnalysis(a) {
    if (!a) return null;
    const r = (v) => Math.round(v * 1000) / 1000;
    return {
      bpm: a.bpm, beatsPerBar: a.beatsPerBar, grid: a.grid, constantTempo: a.constantTempo,
      beats: a.beats, downbeats: a.downbeats,
      featBars: a.featBars, barFeats: a.barFeats ? a.barFeats.map((f) => f.map(r)) : null,
    };
  }
  function saveSong(song) {
    if (!song || !song.loaded) return;
    try {
      localStorage.setItem(storeKey(song), JSON.stringify({
        markers: song.markers, sections: song.sections, displayName: song.displayName, artist: song.artist,
        analysis: serializeAnalysis(song.analysis), t: Date.now(),
      }));
    } catch (e) { /* 存储满或被禁用时忽略 */ }
  }
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    const s = state.cur;
    saveTimer = setTimeout(() => saveSong(s), 400);
  }
  function restoreSong(song) {
    try {
      const raw = localStorage.getItem(storeKey(song));
      if (!raw) return false;
      const d = JSON.parse(raw);
      Object.assign(song.markers, d.markers || {});
      if (Array.isArray(d.sections) && d.sections.length) song.sections = d.sections;
      if (d.displayName) song.displayName = d.displayName;
      if (d.artist) song.artist = d.artist;
      if (d.analysis) song.analysis = d.analysis;
      return true;
    } catch (e) { return false; }
  }

  // ------------------------------------------------------------------ 撤销
  function snapshot(song) { return JSON.stringify({ markers: song.markers, sections: song.sections }); }
  function pushUndo() {
    const s = state.cur;
    if (!s) return;
    s.undo.push(snapshot(s));
    if (s.undo.length > 200) s.undo.shift();
    s.redo.length = 0;
  }
  function restoreSnap(s, snap) {
    const d = JSON.parse(snap);
    s.markers = d.markers; s.sections = d.sections;
  }
  function undo() {
    const s = state.cur;
    if (!s || !s.undo.length) return;
    s.redo.push(snapshot(s));
    restoreSnap(s, s.undo.pop());
    changed();
    toast('已撤销', 1000);
  }
  function redo() {
    const s = state.cur;
    if (!s || !s.redo.length) return;
    s.undo.push(snapshot(s));
    restoreSnap(s, s.redo.pop());
    changed();
    toast('已重做', 1000);
  }

  /** 数据改动后统一刷新 */
  function changed(opts = {}) {
    needsDraw = true;
    updateMarkerValues();
    renderValidation();
    if (!opts.keepSections) renderSectionList();
    renderSongList();
    scheduleSave();
  }

  // ------------------------------------------------------------------ 吸附
  function snapPositions(kind) {
    const a = state.cur && state.cur.analysis;
    if (!a) return null;
    if (kind === 'bar') return a.downbeats && a.downbeats.length ? a.downbeats : null;
    return a.beats && a.beats.length ? a.beats : null;
  }

  function zeroCross(s) {
    const song = state.cur, m = song.mono;
    const maxD = Math.round(song.sr * 0.002);
    const i0 = Math.round(s);
    for (let d = 0; d <= maxD; d++) {
      for (const i of [i0 - d, i0 + d]) {
        if (i <= 0 || i >= m.length) continue;
        if ((m[i - 1] <= 0 && m[i] > 0) || (m[i - 1] >= 0 && m[i] < 0)) return Math.abs(m[i]) < Math.abs(m[i - 1]) ? i : i - 1;
      }
    }
    return i0;
  }

  function snapSample(s, noSnap) {
    const song = state.cur;
    let out = s;
    if (!noSnap && state.snap !== 'off') {
      const arr = snapPositions(state.snap);
      if (arr) {
        const k = nearestIndex(arr, s);
        if (k >= 0 && Math.abs(arr[k] - s) / state.view.spp <= 10) out = arr[k];
      }
    }
    if (!noSnap && state.snapZero && song.mono) out = zeroCross(out);
    return clamp(Math.round(out), 0, song.length - 1);
  }

  // ------------------------------------------------------------------ 视图
  function canvasW() { return canvas.clientWidth || 1; }
  function canvasH() { return canvas.clientHeight || 1; }
  function xToS(x) { return state.view.start + x * state.view.spp; }
  function sToX(s) { return (s - state.view.start) / state.view.spp; }
  function maxSpp() { return state.cur ? Math.max(1, state.cur.length / canvasW()) : 1000; }

  function clampView() {
    const v = state.view, song = state.cur;
    v.spp = clamp(v.spp, 0.05, maxSpp() * 1.0001);
    if (!song) return;
    const visible = canvasW() * v.spp;
    v.start = clamp(v.start, 0, Math.max(0, song.length - visible));
  }

  function zoomAt(factor, x) {
    const s = xToS(x);
    state.view.spp *= factor;
    clampView();
    state.view.start = s - x * state.view.spp;
    clampView();
    needsDraw = true;
  }

  function zoomFit() {
    state.view.spp = maxSpp();
    state.view.start = 0;
    clampView();
    needsDraw = true;
  }

  function centerOn(s) {
    state.view.start = s - canvasW() * state.view.spp / 2;
    clampView();
    needsDraw = true;
  }

  function ensureVisible(s) {
    const x = sToX(s);
    if (x < 0 || x > canvasW()) centerOn(s);
  }

  // ------------------------------------------------------------------ 播放
  const player = { ctx: null, src: null, t0: 0, pos0: 0, loop: null, playing: false };

  function audioCtx() {
    if (!player.ctx) player.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (player.ctx.state === 'suspended') player.ctx.resume();
    return player.ctx;
  }

  function curPos() {
    if (!player.playing || !player.ctx) return state.playhead;
    const song = state.cur;
    let p = player.pos0 + Math.max(0, player.ctx.currentTime - player.t0) * song.sr;
    const L = player.loop;
    if (L && p >= L.end) p = L.start + ((p - L.end) % (L.end - L.start));
    return Math.min(p, song.length);
  }

  function stopSource() {
    if (player.src) {
      const s = player.src;
      player.src = null;
      try { s.onended = null; s.stop(); } catch (e) { /* 已停止 */ }
      s.disconnect();
    }
    player.playing = false;
  }

  function play(from, opts = {}) {
    const song = state.cur;
    if (!song || !song.buffer) return;
    stopSource();
    const ac = audioCtx();
    const src = ac.createBufferSource();
    src.buffer = song.buffer;
    src.connect(ac.destination);
    from = clamp(from, 0, song.length - 1);
    if (opts.loop) {
      src.loop = true;
      src.loopStart = opts.loop.start / song.sr;
      src.loopEnd = opts.loop.end / song.sr;
    }
    const when = ac.currentTime + 0.03;
    src.start(when, from / song.sr);
    if (opts.duration) src.stop(when + opts.duration);
    src.onended = () => {
      if (player.src !== src) return;
      state.playhead = curPos();
      player.src = null; player.playing = false;
      updatePlayButton();
      needsDraw = true;
    };
    Object.assign(player, { src, t0: when, pos0: from, loop: opts.loop || null, playing: true });
    updatePlayButton();
    ensureVisible(from);
  }

  function pause() {
    if (!player.playing) return;
    state.playhead = curPos();
    stopSource();
    updatePlayButton();
    needsDraw = true;
  }

  function togglePlay() {
    if (!state.cur) return;
    if (player.playing) pause();
    else play(state.playhead >= state.cur.length - 1 ? 0 : state.playhead);
  }

  function seek(s) {
    if (!state.cur) return;
    state.playhead = clamp(Math.round(s), 0, state.cur.length);
    if (player.playing) play(state.playhead);
    needsDraw = true;
    updateTimecode();
  }

  function updatePlayButton() { $('btnPlay').textContent = player.playing ? '❚❚' : '▶'; }

  function preview(kind) {
    const song = state.cur;
    if (!song) return;
    const m = song.markers;
    if (kind === 'TrackLoop' || kind === 'PostRaceLoop') {
      const a = m[kind + 'Start'], b = m[kind + 'End'];
      if (!isNum(a) || !isNum(b) || b <= a) { toast('请先设置有效的循环起点和终点'); return; }
      previewLoop(a, b);
    } else {
      const p = m[kind];
      if (!isNum(p)) { toast(`请先设置 ${kind}`); return; }
      play(p);
      toast(`从 ${kind} 播放（${fmtTime(p)}）`, 1500);
    }
  }

  function previewLoop(a, b) {
    const song = state.cur;
    const pre = 4 * song.sr;
    const from = Math.max(a, b - pre);
    play(from, { loop: { start: a, end: b }, duration: (b - from) / song.sr + 4 });
    toast(`试听衔接：${fmtTime(b)} → ${fmtTime(a)}`, 2000);
  }

  // ------------------------------------------------------------------ 标记操作
  function setMarker(name, value, opts = {}) {
    const song = state.cur;
    if (!song) return;
    if (!opts.noUndo) pushUndo();
    if (value === null || value === 'DISABLE') song.markers[name] = value;
    else song.markers[name] = clamp(Math.round(value), 0, song.length - 1);
    if (name === 'TrackStart' && value === null) song.markers.TrackStart = 0;
    if (name === 'End' && value === null) song.markers.End = song.length - 1;
    changed({ keepSections: true });
  }

  function markerList(song, includeAdv = true) {
    return MARKERS.filter((d) => (includeAdv || !d.adv) && isNum(song.markers[d.name]));
  }

  // ------------------------------------------------------------------ 段落操作
  function sectionAt(s) {
    const secs = state.cur.sections;
    for (let i = 0; i < secs.length; i++) if (s >= secs[i].start && s < secs[i].end) return i;
    return secs.length - 1;
  }

  function splitAt(s) {
    const song = state.cur;
    if (!song) return;
    const arr = snapPositions('bar');
    let p = s;
    if (state.snap !== 'off' && arr) {
      const k = nearestIndex(arr, s);
      if (k >= 0 && Math.abs(arr[k] - s) / state.view.spp <= 12) p = arr[k];
    }
    p = Math.round(p);
    const i = sectionAt(p);
    const sec = song.sections[i];
    const minLen = song.sr * 0.25;
    if (p - sec.start < minLen || sec.end - p < minLen) { toast('距离已有分界太近'); return; }
    pushUndo();
    song.sections.splice(i + 1, 0, { start: p, end: sec.end, label: sec.label });
    sec.end = p;
    state.selSection = i + 1;
    changed();
  }

  function removeBoundary(k) {
    const secs = state.cur.sections;
    if (k <= 0 || k >= secs.length) return;
    pushUndo();
    secs[k - 1].end = secs[k].end;
    secs.splice(k, 1);
    state.selSection = k - 1;
    changed();
  }

  function setSectionLabel(i, label) {
    const sec = state.cur.sections[i];
    if (!sec || sec.label === label) return;
    pushUndo();
    sec.label = label;
    changed();
  }

  function normalizeSections(list, length) {
    const out = list
      .filter((s) => isNum(s.start) && isNum(s.end) && s.end > s.start)
      .map((s) => ({ start: Math.round(s.start), end: Math.round(s.end), label: normLabel(s.label) }))
      .sort((a, b) => a.start - b.start);
    if (!out.length) return [{ start: 0, end: length, label: 'other' }];
    out[0].start = 0;
    for (let i = 1; i < out.length; i++) out[i].start = out[i - 1].end = Math.max(out[i - 1].start + 1, out[i].start);
    out[out.length - 1].end = length;
    return out;
  }

  function normLabel(l) {
    const k = String(l || '').toLowerCase().replace(/[\s_]+/g, '').replace(/\d+$/, '');
    if (SECTION_TYPES[k]) return k;
    if (SECTION_ALIASES[k]) return SECTION_ALIASES[k];
    return 'other';
  }

  function deriveFromSections() {
    const song = state.cur;
    if (!song) return;
    const labeled = song.sections.some((s) => s.label === 'chorus');
    if (!labeled) { toast('请先把至少一个段落标为「副歌 / 高潮」（或运行自动识别）', 3500); return; }
    const bars = song.analysis && song.analysis.downbeats;
    const mk = HR.deriveMarkers(song.sections, song.length, bars);
    pushUndo();
    applyMarkerSet(song, mk);
    changed();
    toast('已根据段落生成 TrackDrop / Loop / PostDrop 标记');
  }

  function snapZeroOnly(s) { return state.snapZero && state.cur.mono ? zeroCross(s) : Math.round(s); }

  // 循环起止点成对吸附到过零点：整体平移，保持循环长度不变（分别吸附会把波形级微调出来的精确长度破坏掉）
  function snapLoopPair(start, end) {
    const song = state.cur;
    const s0 = Math.round(start), len = Math.round(end) - s0;
    if (!state.snapZero || !song.mono) return [s0, s0 + len];
    const m = song.mono, maxD = Math.round(song.sr * 0.002);
    let best = 0, bc = Infinity;
    for (let d = -maxD; d <= maxD; d++) {
      const a = s0 + d, b = a + len;
      if (a <= 0 || b >= m.length) continue;
      // 起点、终点处的采样值都接近零，且斜率方向一致
      const cost = Math.abs(m[a]) + Math.abs(m[b]) + (Math.sign(m[a] - m[a - 1]) === Math.sign(m[b] - m[b - 1]) ? 0 : 0.01) + 1e-5 * Math.abs(d);
      if (cost < bc) { bc = cost; best = d; }
    }
    return [s0 + best, s0 + best + len];
  }

  /** 把一组推导出的 Marker 写进当前歌曲；两对循环点用成对吸附 */
  function applyMarkerSet(song, mk) {
    for (const k of MAIN_SIX) if (isNum(mk[k])) song.markers[k] = snapZeroOnly(mk[k]);
    for (const kind of ['TrackLoop', 'PostRaceLoop']) {
      const a = kind + 'Start', b = kind + 'End';
      if (isNum(mk[a]) && isNum(mk[b]) && mk[b] > mk[a]) {
        [song.markers[a], song.markers[b]] = snapLoopPair(mk[a], mk[b]);
        // Drop 和对应的循环起点本来是同一个位置，吸附后也保持一致
        const drop = kind === 'TrackLoop' ? 'TrackDrop' : 'PostDrop';
        if (mk[drop] === mk[a]) song.markers[drop] = song.markers[a];
      }
    }
  }

  // ------------------------------------------------------------------ 绘制
  function resizeCanvas(c, ctx) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function niceStep(pxPerSec) {
    const steps = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    for (const s of steps) if (s * pxPerSec >= 90) return s;
    return 600;
  }

  function fmtRuler(sec, step) {
    const m = Math.floor(sec / 60), s = sec - m * 60;
    const dec = step < 0.01 ? 4 : step < 0.1 ? 3 : step < 1 ? 1 : 0;
    return `${m}:${s.toFixed(dec).padStart(dec ? dec + 3 : 2, '0')}`;
  }

  function draw() {
    resizeCanvas(canvas, ctx2d);
    const W = canvasW(), H = canvasH(), g = ctx2d;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#121419';
    g.fillRect(0, 0, W, H);
    const song = state.cur;
    if (!song || !song.peaks) {
      g.fillStyle = '#5c6577';
      g.font = '15px sans-serif';
      g.textAlign = 'center';
      g.fillText(song ? '正在载入…' : '把音频文件拖到这里开始', W / 2, H / 2);
      g.textAlign = 'left';
      drawOverview();
      return;
    }
    const v = state.view, sr = song.sr;
    const s0 = v.start, s1 = v.start + W * v.spp;
    const waveH = H - WAVE_TOP;
    const mid = WAVE_TOP + waveH / 2;

    // 段落底色
    for (let i = 0; i < song.sections.length; i++) {
      const sec = song.sections[i];
      if (sec.end < s0 || sec.start > s1) continue;
      const x0 = Math.max(0, sToX(sec.start)), x1 = Math.min(W, sToX(sec.end));
      g.fillStyle = SECTION_TYPES[sec.label].color + '14';
      g.fillRect(x0, WAVE_TOP, x1 - x0, waveH);
    }

    // 循环区间底色
    const m = song.markers;
    const loops = [
      { a: m.TrackLoopStart, b: m.TrackLoopEnd, color: '#3fb6ff', y: WAVE_TOP + 1 },
      { a: m.PostRaceLoopStart, b: m.PostRaceLoopEnd, color: '#b48cff', y: H - LOOPBAR_H - 1 },
    ];
    for (const L of loops) {
      if (!isNum(L.a) || !isNum(L.b) || L.b <= L.a) continue;
      const x0 = clamp(sToX(L.a), -1, W + 1), x1 = clamp(sToX(L.b), -1, W + 1);
      g.fillStyle = L.color + '12';
      g.fillRect(x0, WAVE_TOP, x1 - x0, waveH);
      g.fillStyle = L.color + 'aa';
      g.fillRect(x0, L.y, x1 - x0, LOOPBAR_H);
    }

    // 节拍网格
    const a = song.analysis;
    if (a && a.beats && a.beats.length) {
      const beatPx = (a.beats.length > 1 ? (a.beats[1] - a.beats[0]) : sr) / v.spp;
      const dbs = new Set(a.downbeats || []);
      if (beatPx >= 5) {
        g.fillStyle = 'rgba(255,255,255,0.06)';
        for (let i = firstIndexAtOrAfter(a.beats, s0); i < a.beats.length && a.beats[i] <= s1; i++) {
          if (!dbs.has(a.beats[i])) g.fillRect(Math.round(sToX(a.beats[i])), WAVE_TOP, 1, waveH);
        }
      }
      if (a.downbeats && beatPx * (a.beatsPerBar || 4) >= 4) {
        g.fillStyle = 'rgba(255,255,255,0.14)';
        for (let i = firstIndexAtOrAfter(a.downbeats, s0); i < a.downbeats.length && a.downbeats[i] <= s1; i++) {
          g.fillRect(Math.round(sToX(a.downbeats[i])), WAVE_TOP, 1, waveH);
        }
      }
    }

    // 中线 + 波形
    g.fillStyle = '#2a2f3a';
    g.fillRect(0, Math.round(mid), W, 1);
    drawWave(g, song, W, mid, waveH / 2 - 8);

    // 标尺
    drawRuler(g, song, W);

    // 段落轨道
    drawSections(g, song, W);

    // 标记
    drawMarkers(g, song, W, H);

    // 播放头
    const px = sToX(curPos());
    if (px >= -1 && px <= W + 1) {
      g.fillStyle = '#ff7a3d';
      g.fillRect(Math.round(px), 0, 1.5, H);
      g.beginPath();
      g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 9); g.closePath();
      g.fill();
    }

    // 悬停竖线
    if (state.hover && state.hover.x != null && !drag) {
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(Math.round(state.hover.x), WAVE_TOP, 1, waveH);
    }
    drawOverview();
  }

  function drawWave(g, song, W, mid, amp) {
    const v = state.view, mono = song.mono;
    g.fillStyle = '#7f93b8';
    if (v.spp >= 256) {
      const levels = song.peaks;
      let L = levels[0];
      for (const l of levels) { if (l.block <= v.spp) L = l; else break; }
      for (let x = 0; x < W; x++) {
        const a = xToS(x), b = xToS(x + 1);
        let i0 = Math.floor(a / L.block), i1 = Math.max(i0 + 1, Math.ceil(b / L.block));
        i0 = Math.max(0, i0); i1 = Math.min(L.min.length, i1);
        if (i1 <= i0) continue;
        let lo = 1, hi = -1;
        for (let i = i0; i < i1; i++) { if (L.min[i] < lo) lo = L.min[i]; if (L.max[i] > hi) hi = L.max[i]; }
        const y0 = mid - hi * amp, y1 = mid - lo * amp;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    } else if (v.spp >= 1) {
      for (let x = 0; x < W; x++) {
        let i0 = Math.max(0, Math.floor(xToS(x))), i1 = Math.min(mono.length, Math.floor(xToS(x + 1)) + 1);
        if (i1 <= i0) continue;
        let lo = 1, hi = -1;
        for (let i = i0; i < i1; i++) { const s = mono[i]; if (s < lo) lo = s; if (s > hi) hi = s; }
        const y0 = mid - hi * amp, y1 = mid - lo * amp;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    } else {
      // 采样级：折线 + 采样点
      const i0 = Math.max(0, Math.floor(v.start) - 1), i1 = Math.min(mono.length - 1, Math.ceil(xToS(W)) + 1);
      g.strokeStyle = '#9fb2d6';
      g.lineWidth = 1.2;
      g.beginPath();
      for (let i = i0; i <= i1; i++) {
        const x = sToX(i), y = mid - mono[i] * amp;
        if (i === i0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      if (1 / v.spp >= 6) {
        g.fillStyle = '#cfe0ff';
        for (let i = i0; i <= i1; i++) g.fillRect(sToX(i) - 1.5, mid - mono[i] * amp - 1.5, 3, 3);
      }
    }
  }

  function drawRuler(g, song, W) {
    const v = state.view, sr = song.sr;
    g.fillStyle = '#1a1d24';
    g.fillRect(0, 0, W, RULER_H);
    g.fillStyle = '#313744';
    g.fillRect(0, RULER_H - 1, W, 1);
    const pxPerSec = sr / v.spp;
    const step = niceStep(pxPerSec);
    const t0 = Math.floor(v.start / sr / step) * step;
    g.font = '11px "Cascadia Mono", Consolas, monospace';
    g.textBaseline = 'top';
    for (let t = t0; ; t += step) {
      const x = sToX(t * sr);
      if (x > W) break;
      if (x < -60) continue;
      g.fillStyle = '#4a5366';
      g.fillRect(Math.round(x), 2, 1, 12);
      g.fillStyle = '#9aa4b2';
      g.fillText(fmtRuler(t + 1e-9, step), x + 3, 3);
      for (let k = 1; k < 5; k++) {
        const xx = sToX((t + step * k / 5) * sr);
        g.fillStyle = '#353b48';
        g.fillRect(Math.round(xx), 9, 1, 5);
      }
    }
    // 小节号
    const a = song.analysis;
    if (a && a.downbeats && a.downbeats.length > 1) {
      const barPx = (a.downbeats[1] - a.downbeats[0]) / v.spp;
      let every = 1;
      while (barPx * every < 26) every *= 2;
      g.fillStyle = '#ffb38a';
      for (let i = firstIndexAtOrAfter(a.downbeats, v.start); i < a.downbeats.length; i++) {
        const x = sToX(a.downbeats[i]);
        if (x > W) break;
        if (i % every) continue;
        g.fillRect(Math.round(x), RULER_H - 9, 1, 8);
        g.fillText(String(i + 1), x + 3, RULER_H - 12);
      }
    }
    g.textBaseline = 'alphabetic';
  }

  function drawSections(g, song, W) {
    const y = RULER_H, h = SEC_H;
    g.fillStyle = '#16181e';
    g.fillRect(0, y, W, h);
    g.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
    g.textBaseline = 'middle';
    for (let i = 0; i < song.sections.length; i++) {
      const sec = song.sections[i];
      const x0 = sToX(sec.start), x1 = sToX(sec.end);
      if (x1 < 0 || x0 > W) continue;
      const t = SECTION_TYPES[sec.label];
      const sel = i === state.selSection;
      g.fillStyle = t.color + (sel ? 'ee' : 'a8');
      const cx0 = Math.max(0, x0) + 1, cx1 = Math.min(W, x1) - 1;
      g.fillRect(cx0, y + 3, Math.max(0, cx1 - cx0), h - 6);
      if (sel) { g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(cx0 + 0.5, y + 3.5, Math.max(0, cx1 - cx0 - 1), h - 7); }
      if (cx1 - cx0 > 24) {
        g.save();
        g.beginPath(); g.rect(cx0, y, cx1 - cx0, h); g.clip();
        g.fillStyle = '#fff';
        const bars = barsBetween(song, sec.start, sec.end);
        const label = t.zh + (bars ? ` · ${bars} 小节` : '');
        g.fillText(label, Math.max(cx0 + 6, Math.min(cx0 + 6, cx1 - 6)), y + h / 2 + 0.5);
        g.restore();
      }
    }
    // 分界手柄
    for (let i = 1; i < song.sections.length; i++) {
      const x = sToX(song.sections[i].start);
      if (x < -2 || x > W + 2) continue;
      g.fillStyle = '#e8ecf3';
      g.fillRect(Math.round(x) - 1, y + 1, 2, h - 2);
    }
    g.textBaseline = 'alphabetic';
  }

  function barsBetween(song, a, b) {
    const d = song.analysis && song.analysis.downbeats;
    if (!d || d.length < 2) return 0;
    const bar = (d[d.length - 1] - d[0]) / (d.length - 1);
    const n = (b - a) / bar;
    return Math.abs(n - Math.round(n)) < 0.15 ? Math.round(n) : Math.round(n * 10) / 10;
  }

  let flagRects = [];
  function drawMarkers(g, song, W, H) {
    const y = RULER_H + SEC_H;
    g.fillStyle = '#14161b';
    g.fillRect(0, y, W, FLAG_H);
    g.fillStyle = '#2a2f3a';
    g.fillRect(0, y + FLAG_H - 1, W, 1);
    g.font = '11px "Segoe UI", sans-serif';
    g.textBaseline = 'middle';
    const list = markerList(song).map((d) => ({ d, s: song.markers[d.name], x: sToX(song.markers[d.name]) }))
      .sort((p, q) => p.x - q.x || MARKERS.indexOf(p.d) - MARKERS.indexOf(q.d));
    const rowRight = [-Infinity, -Infinity];
    flagRects = [];
    for (const it of list) {
      if (it.x < -80 || it.x > W + 80) continue;
      const sel = state.selMarker === it.d.name;
      // 竖线
      g.fillStyle = it.d.color + (sel ? 'ff' : 'cc');
      g.fillRect(Math.round(it.x) - (sel ? 1 : 0), y, sel ? 2 : 1, H - y);
      // 旗标
      const tw = g.measureText(it.d.short).width + 10;
      let row = rowRight[0] < it.x - 2 ? 0 : rowRight[1] < it.x - 2 ? 1 : 0;
      const ry = y + 2 + row * 19;
      rowRight[row] = it.x + tw;
      g.fillStyle = it.d.color + (sel ? 'ff' : 'dd');
      g.fillRect(it.x, ry, tw, 17);
      if (sel) { g.strokeStyle = '#fff'; g.strokeRect(it.x + 0.5, ry + 0.5, tw - 1, 16); }
      g.fillStyle = '#0d0f13';
      g.fillText(it.d.short, it.x + 5, ry + 9);
      flagRects.push({ name: it.d.name, x0: it.x, x1: it.x + tw, y0: ry, y1: ry + 17 });
    }
    g.textBaseline = 'alphabetic';
  }

  function drawOverview() {
    resizeCanvas(ov, ovctx);
    const W = ov.clientWidth, H = ov.clientHeight, g = ovctx;
    g.fillStyle = '#101216';
    g.fillRect(0, 0, W, H);
    const song = state.cur;
    if (!song || !song.peaks) return;
    const L = song.peaks[0];
    const per = L.min.length / W;
    g.fillStyle = '#4c5a75';
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor(x * per), i1 = Math.max(i0 + 1, Math.floor((x + 1) * per));
      let lo = 1, hi = -1;
      for (let i = i0; i < i1 && i < L.min.length; i++) { if (L.min[i] < lo) lo = L.min[i]; if (L.max[i] > hi) hi = L.max[i]; }
      g.fillRect(x, H / 2 - hi * (H / 2 - 6), 1, Math.max(1, (hi - lo) * (H / 2 - 6)));
    }
    for (const sec of song.sections) {
      g.fillStyle = SECTION_TYPES[sec.label].color;
      g.fillRect(sec.start / song.length * W, H - 4, (sec.end - sec.start) / song.length * W, 4);
    }
    for (const d of markerList(song, false)) {
      g.fillStyle = d.color;
      g.fillRect(Math.round(song.markers[d.name] / song.length * W), 0, 1, H - 4);
    }
    const vx = state.view.start / song.length * W, vw = canvasW() * state.view.spp / song.length * W;
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(vx, 0, Math.max(2, vw), H);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.strokeRect(vx + 0.5, 0.5, Math.max(2, vw) - 1, H - 1);
    g.fillStyle = '#ff7a3d';
    g.fillRect(Math.round(curPos() / song.length * W), 0, 1, H);
  }

  // ------------------------------------------------------------------ 主循环
  let lastTc = -1;
  function frame() {
    if (player.playing) {
      const p = curPos();
      if (state.follow && state.cur) {
        const W = canvasW(), x = sToX(p);
        if (x > W * 0.92 || x < 0) { state.view.start = p - W * state.view.spp * 0.08; clampView(); }
      }
      needsDraw = true;
    }
    if (needsDraw) { needsDraw = false; draw(); }
    const p = Math.round(curPos());
    if (p !== lastTc) { lastTc = p; updateTimecode(); }
    requestAnimationFrame(frame);
  }

  function updateTimecode() {
    const p = Math.round(curPos());
    const sr = state.cur ? state.cur.sr : PROJECT_RATE;
    $('tcTime').textContent = fmtTime(p, sr);
    $('tcSamples').textContent = `${p.toLocaleString()} smp`;
  }

  // ------------------------------------------------------------------ 时间线交互
  let drag = null;

  function hitTest(x, y) {
    const song = state.cur;
    if (!song || !song.peaks) return { type: 'none' };
    if (y < RULER_H) return { type: 'ruler' };
    if (y < RULER_H + SEC_H) {
      for (let i = 1; i < song.sections.length; i++) {
        if (Math.abs(sToX(song.sections[i].start) - x) <= 5) return { type: 'boundary', index: i };
      }
      return { type: 'section', index: sectionAt(xToS(x)) };
    }
    if (y < WAVE_TOP) {
      for (let i = flagRects.length - 1; i >= 0; i--) {
        const r = flagRects[i];
        if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return { type: 'marker', name: r.name };
      }
    }
    // 竖线附近，优先选中的
    let best = null, bd = 6;
    for (const d of markerList(song)) {
      const dist = Math.abs(sToX(song.markers[d.name]) - x);
      const adj = d.name === state.selMarker ? dist - 2 : dist;
      if (adj < bd) { bd = adj; best = d.name; }
    }
    if (best) return { type: 'marker', name: best };
    return { type: y < WAVE_TOP ? 'flags' : 'wave' };
  }

  function canvasPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('mousedown', (e) => {
    hideCtxMenu();
    const song = state.cur;
    if (!song || !song.peaks) return;
    const { x, y } = canvasPos(e);
    if (e.button === 1) { drag = { type: 'pan', x0: x, start0: state.view.start }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    const h = hitTest(x, y);
    if (h.type === 'marker') {
      selectMarker(h.name);
      drag = { type: 'marker', name: h.name, moved: false, before: snapshot(song), x0: x };
    } else if (h.type === 'boundary') {
      state.selSection = h.index;
      drag = { type: 'boundary', index: h.index, moved: false, before: snapshot(song), x0: x };
    } else if (h.type === 'section') {
      state.selSection = h.index;
      state.selMarker = null;
      renderSectionList();
      updateMarkerSelection();
      seek(snapSeek(xToS(x), e.altKey));
      drag = { type: 'scrub' };
    } else {
      state.selMarker = null;
      updateMarkerSelection();
      seek(snapSeek(xToS(x), e.altKey));
      drag = { type: 'scrub' };
    }
    needsDraw = true;
  });

  function snapSeek(s, alt) {
    if (alt || state.snap === 'off') return s;
    const arr = snapPositions(state.snap);
    if (!arr) return s;
    const k = nearestIndex(arr, s);
    return k >= 0 && Math.abs(arr[k] - s) / state.view.spp <= 6 ? arr[k] : s;
  }

  window.addEventListener('mousemove', (e) => {
    const song = state.cur;
    if (!song || !song.peaks) return;
    const { x, y } = canvasPos(e);
    if (drag) {
      if (drag.type === 'pan') {
        state.view.start = drag.start0 - (x - drag.x0) * state.view.spp;
        clampView();
      } else if (drag.type === 'marker') {
        if (!drag.moved && Math.abs(x - drag.x0) < 2) return;
        if (!drag.moved) { drag.moved = true; song.undo.push(drag.before); song.redo.length = 0; }
        const s = snapSample(xToS(clamp(x, 0, canvasW())), e.altKey);
        song.markers[drag.name] = s;
        updateMarkerValues();
        showTooltip(x, y, `${drag.name}  ${fmtTime(s, song.sr)}  ·  ${s.toLocaleString()} smp`);
      } else if (drag.type === 'boundary') {
        if (!drag.moved && Math.abs(x - drag.x0) < 2) return;
        if (!drag.moved) { drag.moved = true; song.undo.push(drag.before); song.redo.length = 0; }
        const secs = song.sections, k = drag.index;
        let s = xToS(clamp(x, 0, canvasW()));
        const arr = snapPositions('bar');
        if (!e.altKey && state.snap !== 'off' && arr) {
          const i = nearestIndex(arr, s);
          if (i >= 0 && Math.abs(arr[i] - s) / state.view.spp <= 10) s = arr[i];
        }
        const minLen = song.sr * 0.25;
        s = clamp(Math.round(s), secs[k - 1].start + minLen, secs[k].end - minLen);
        secs[k - 1].end = secs[k].start = s;
        showTooltip(x, y, `段落分界  ${fmtTime(s, song.sr)}`);
      } else if (drag.type === 'scrub') {
        seek(snapSeek(xToS(clamp(x, 0, canvasW())), e.altKey));
      }
      needsDraw = true;
      return;
    }
    // 悬停
    const inside = x >= 0 && y >= 0 && x <= canvasW() && y <= canvasH();
    state.hover = inside ? { x, y } : null;
    if (inside) {
      const h = hitTest(x, y);
      canvas.style.cursor = h.type === 'marker' || h.type === 'boundary' ? 'ew-resize' : h.type === 'ruler' ? 'text' : 'default';
      if (h.type === 'marker') {
        const v = song.markers[h.name];
        showTooltip(x, y, `${h.name}（${MDEF[h.name].zh}）  ${fmtTime(v, song.sr)}  ·  ${v.toLocaleString()} smp`);
      } else if (y >= WAVE_TOP || y < RULER_H) {
        const s = Math.round(xToS(x));
        showTooltip(x, y, `${fmtTime(s, song.sr)}  ·  ${s.toLocaleString()} smp`);
      } else hideTooltip();
    } else hideTooltip();
    needsDraw = true;
  });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    hideTooltip();
    if ((d.type === 'marker' || d.type === 'boundary') && d.moved) changed();
    else if (d.type === 'boundary') renderSectionList();
    needsDraw = true;
  });

  canvas.addEventListener('mouseleave', () => { state.hover = null; if (!drag) hideTooltip(); needsDraw = true; });

  canvas.addEventListener('wheel', (e) => {
    if (!state.cur || !state.cur.peaks) return;
    e.preventDefault();
    const { x } = canvasPos(e);
    if (e.ctrlKey || e.metaKey) {
      zoomAt(Math.exp(e.deltaY * 0.0018), x);
    } else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      state.view.start += d * state.view.spp * (e.deltaMode === 1 ? 30 : 1);
      clampView();
      needsDraw = true;
    }
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = canvasPos(e);
    const h = hitTest(x, y);
    if (h.type === 'section') { state.selSection = h.index; showSectionMenu(e.clientX, e.clientY, h.index, xToS(x)); }
    else if (h.type === 'marker') {
      switchTab('markers');
      const inp = document.querySelector(`.mrow[data-name="${h.name}"] input.smp`);
      if (inp) { inp.focus(); inp.select(); }
    }
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const song = state.cur;
    if (!song || !song.peaks) return;
    const { x, y } = canvasPos(e);
    const h = hitTest(x, y);
    if (h.type === 'section') { state.selSection = h.index; needsDraw = true; renderSectionList(); showSectionMenu(e.clientX, e.clientY, h.index, xToS(x)); }
    else if (h.type === 'boundary') showBoundaryMenu(e.clientX, e.clientY, h.index);
    else if (h.type === 'marker') showMarkerMenu(e.clientX, e.clientY, h.name);
    else showPlaceMenu(e.clientX, e.clientY, xToS(x));
  });

  function showTooltip(x, y, text) {
    const t = $('tooltip');
    t.textContent = text;
    t.hidden = false;
    const W = canvasW();
    const tw = t.offsetWidth;
    t.style.left = Math.min(W - tw - 4, x + 12) + 'px';
    t.style.top = Math.max(2, y - 28) + 'px';
  }
  function hideTooltip() { $('tooltip').hidden = true; }

  // 概览条
  let ovDrag = false;
  function ovSeekView(e) {
    const song = state.cur;
    if (!song || !song.peaks) return;
    const r = ov.getBoundingClientRect();
    const s = (e.clientX - r.left) / r.width * song.length;
    centerOn(s);
  }
  ov.addEventListener('mousedown', (e) => { ovDrag = true; ovSeekView(e); });
  window.addEventListener('mousemove', (e) => { if (ovDrag) ovSeekView(e); });
  window.addEventListener('mouseup', () => { ovDrag = false; });

  // ------------------------------------------------------------------ 右键菜单
  function showMenu(cx, cy, items) {
    const m = $('ctxMenu');
    m.innerHTML = '';
    for (const it of items) {
      if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
      const b = document.createElement('button');
      if (it.color) { const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = it.color; b.appendChild(sw); }
      b.appendChild(document.createTextNode(it.label));
      b.onclick = () => { hideCtxMenu(); it.action(); };
      m.appendChild(b);
    }
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(cx, window.innerWidth - r.width - 6) + 'px';
    m.style.top = Math.min(cy, window.innerHeight - r.height - 6) + 'px';
  }
  function hideCtxMenu() { $('ctxMenu').hidden = true; }
  document.addEventListener('mousedown', (e) => { if (!$('ctxMenu').contains(e.target)) hideCtxMenu(); });

  function showSectionMenu(cx, cy, i, s) {
    const items = Object.entries(SECTION_TYPES).map(([k, t]) => ({ label: t.zh, color: t.color, action: () => setSectionLabel(i, k) }));
    items.push('-');
    items.push({ label: '在此处切分', action: () => splitAt(s) });
    if (i > 0) items.push({ label: '与前一段合并', action: () => removeBoundary(i) });
    if (i < state.cur.sections.length - 1) items.push({ label: '与后一段合并', action: () => removeBoundary(i + 1) });
    items.push({ label: '试听本段', action: () => play(state.cur.sections[i].start) });
    showMenu(cx, cy, items);
  }

  function showBoundaryMenu(cx, cy, k) {
    showMenu(cx, cy, [
      { label: '删除这个分界', action: () => removeBoundary(k) },
      { label: '从这里播放', action: () => play(state.cur.sections[k].start) },
    ]);
  }

  function showMarkerMenu(cx, cy, name) {
    const song = state.cur;
    const items = [
      { label: `从 ${name} 播放`, action: () => play(song.markers[name]) },
      { label: '移到播放头', action: () => setMarker(name, curPos()) },
    ];
    if (!['TrackStart', 'End'].includes(name)) items.push({ label: '清除（留空 = 自动）', action: () => setMarker(name, null) });
    showMenu(cx, cy, items);
  }

  function showPlaceMenu(cx, cy, s) {
    const p = snapSample(s, false);
    showMenu(cx, cy, MARKERS.filter((d) => !['TrackStart', 'End'].includes(d.name)).map((d) => ({
      label: `在此放置 ${d.name}`, color: d.color, action: () => { setMarker(d.name, p); selectMarker(d.name); },
    })));
  }

  // ------------------------------------------------------------------ 侧边栏：歌曲列表
  function songStatus(s) {
    if (!s.loaded) return '';
    const n = MAIN_SIX.filter((k) => isNum(s.markers[k])).length;
    return n === 6 ? 'ok' : n ? 'partial' : '';
  }

  function renderSongList() {
    const ul = $('songList');
    ul.innerHTML = '';
    $('songListEmpty').hidden = state.songs.length > 0;
    for (const s of state.songs) {
      const li = document.createElement('li');
      if (s === state.cur) li.className = 'active';
      li.innerHTML = `<span class="name"></span><span class="info"><span class="dot ${songStatus(s)}"></span><span class="dur"></span><span class="rm" title="从列表移除">✕</span></span>`;
      li.querySelector('.name').textContent = s.name;
      li.querySelector('.name').title = s.name;
      li.querySelector('.dur').textContent = s.length ? fmtTime(s.length, s.sr, false) : '未载入';
      li.onclick = (e) => {
        if (e.target.classList.contains('rm')) { removeSong(s); return; }
        selectSong(s);
      };
      ul.appendChild(li);
    }
    renderMeta();
  }

  function removeSong(s) {
    saveSong(s);
    const i = state.songs.indexOf(s);
    state.songs.splice(i, 1);
    if (state.cur === s) {
      pause();
      releaseAudio(s);
      state.cur = null;
      const next = state.songs[Math.min(i, state.songs.length - 1)];
      if (next) selectSong(next);
      else renderAll();
    }
    renderSongList();
  }

  function renderMeta() {
    const s = state.cur;
    $('songMeta').hidden = !s || !s.loaded;
    if (!s || !s.loaded) return;
    if (document.activeElement !== $('metaDisplayName')) $('metaDisplayName').value = s.displayName || '';
    if (document.activeElement !== $('metaArtist')) $('metaArtist').value = s.artist || '';
    const n = s.native || {};
    let info = `${s.length.toLocaleString()} 采样点 · ${fmtTime(s.length, s.sr)}<br>`;
    if (n.wav) {
      info += `源文件：WAV ${n.sampleRate} Hz / ${n.bits} bit / ${n.channels} ch`;
      if (n.sampleRate !== PROJECT_RATE) info += `<br><span class="warn">⚠ 非 48kHz，已重采样到 48kHz 计算位置</span>`;
      else if (n.frames && Math.abs(n.frames - s.length) > 1) info += `<br><span class="warn">⚠ 解码长度与文件头不一致（${n.frames}）</span>`;
    } else {
      info += `<span class="warn">⚠ 压缩格式，已解码为 48kHz；位置可能与最终 WAV 相差几毫秒</span>`;
    }
    $('metaInfo').innerHTML = info;
  }

  $('metaDisplayName').addEventListener('input', (e) => { if (state.cur) { state.cur.displayName = e.target.value; scheduleSave(); } });
  $('metaArtist').addEventListener('input', (e) => { if (state.cur) { state.cur.artist = e.target.value; scheduleSave(); } });

  // ------------------------------------------------------------------ 标记面板
  function renderMarkerTable() {
    const main = $('markerTable'), adv = $('markerTableAdv');
    main.innerHTML = ''; adv.innerHTML = '';
    for (const d of MARKERS) {
      const row = document.createElement('div');
      row.className = 'mrow';
      row.dataset.name = d.name;
      const fixed = d.name === 'TrackStart' || d.name === 'End';
      row.innerHTML = `
        <span class="sw" style="background:${d.color}"></span>
        <span class="nm">${d.name}<small>${d.zh}${d.key ? ` · 键 ${d.key}` : ''}</small></span>
        <span class="btns">
          <button data-act="goto" title="定位并从这里播放">▶</button>
          <button data-act="here" title="设为播放头位置">⤓</button>
          ${d.adv ? '<button data-act="disable" title="切换 自动 / 禁用（DISABLE）">⊘</button>' : ''}
          ${fixed ? '' : '<button data-act="clear" title="清除（留空 = 导入时自动）">✕</button>'}
        </span>
        <span class="vals">
          <input class="smp" type="text" inputmode="numeric" placeholder="${d.adv ? '自动' : '未设置'}" title="采样点">
          <input class="tm" type="text" placeholder="mm:ss.mmm" title="时间">
        </span>`;
      row.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') { selectMarker(d.name, false); return; }
        const act = e.target.dataset && e.target.dataset.act;
        const song = state.cur;
        if (!song || !song.loaded) return;
        if (act === 'goto') {
          const v = song.markers[d.name];
          if (isNum(v)) { selectMarker(d.name); centerOn(v); play(v); }
        } else if (act === 'here') {
          setMarker(d.name, snapZeroOnly(curPos())); selectMarker(d.name);
        } else if (act === 'clear') {
          setMarker(d.name, null);
        } else if (act === 'disable') {
          setMarker(d.name, song.markers[d.name] === 'DISABLE' ? null : 'DISABLE');
        } else {
          selectMarker(d.name);
          const v = song.markers[d.name];
          if (isNum(v)) ensureVisible(v);
        }
      });
      const smp = row.querySelector('.smp'), tm = row.querySelector('.tm');
      const commit = (inp, parse) => {
        const song = state.cur;
        if (!song || !song.loaded) return;
        const raw = inp.value.trim();
        if (raw === '') { setMarker(d.name, null); return; }
        if (d.adv && /^(disable|disabled|off)$/i.test(raw)) { setMarker(d.name, 'DISABLE'); return; }
        const v = parse(raw);
        if (!isNum(v)) { toast('无法识别的数值'); updateMarkerValues(); return; }
        if (v < 0 || v > song.length - 1) toast('超出歌曲范围，已限制到有效区间');
        setMarker(d.name, v);
      };
      smp.addEventListener('change', () => commit(smp, (t) => Number(t.replace(/[,_\s]/g, ''))));
      tm.addEventListener('change', () => commit(tm, (t) => parseTime(t, state.cur.sr)));
      for (const inp of [smp, tm]) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
      (d.adv ? adv : main).appendChild(row);
    }
    updateMarkerValues();
  }

  function updateMarkerValues() {
    const song = state.cur;
    for (const row of document.querySelectorAll('.mrow')) {
      const name = row.dataset.name;
      const v = song && song.loaded ? song.markers[name] : null;
      const smp = row.querySelector('.smp'), tm = row.querySelector('.tm');
      if (document.activeElement !== smp) smp.value = isNum(v) ? String(v) : v === 'DISABLE' ? 'DISABLE' : '';
      if (document.activeElement !== tm) tm.value = isNum(v) ? fmtTime(v, song.sr) : '';
      tm.disabled = v === 'DISABLE';
    }
    updateMarkerSelection();
  }

  function selectMarker(name, scroll = true) {
    state.selMarker = name;
    updateMarkerSelection(scroll);
    needsDraw = true;
  }

  function updateMarkerSelection(scroll) {
    for (const row of document.querySelectorAll('.mrow')) {
      const sel = row.dataset.name === state.selMarker;
      row.classList.toggle('selected', sel);
      if (sel && scroll) {
        if (MDEF[row.dataset.name].adv) row.closest('details').open = true;
        row.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  // ------------------------------------------------------------------ 校验
  function validate(song) {
    const out = [];
    const m = song.markers, L = song.length, sr = song.sr;
    for (const d of MARKERS) {
      const v = m[d.name];
      if (isNum(v) && (v < 0 || v > L - 1)) out.push(['err', `${d.name} 超出范围（0 ~ ${L - 1}）`]);
    }
    const unset = MAIN_SIX.filter((k) => !isNum(m[k]));
    if (unset.length) out.push(['warn', `未设置：${unset.join('、')}。导出时留空，导入工具会自动处理。`]);
    const loopCheck = (a, b, label) => {
      if (!isNum(m[a]) || !isNum(m[b])) return;
      if (m[b] <= m[a]) { out.push(['err', `${label}：终点必须在起点之后`]); return; }
      const len = m[b] - m[a];
      const sm = song.mono ? HR.seamScore(song.mono, sr, m[a], m[b]) : null;
      const seamTxt = sm ? `，接缝 ${sm.db.toFixed(0)}dB` : '';
      if (len < sr * 4) out.push(['warn', `${label}只有 ${(len / sr).toFixed(1)} 秒，太短会显得很重复`]);
      const db = song.analysis && song.analysis.downbeats;
      if (db && db.length > 2) {
        const bar = (db[db.length - 1] - db[0]) / (db.length - 1);
        const bars = len / bar;
        const off = Math.abs(bars - Math.round(bars)) * bar / sr * 1000;
        // 终点按波形微调过时长度会略偏离整小节；接缝好就不再提示
        if (off > 15 && !(sm && sm.score >= 0.7)) out.push(['warn', `${label}长度为 ${bars.toFixed(2)} 小节，不是整小节，跳转时可能会掉拍（偏差 ${off.toFixed(0)}ms）`]);
        else out.push(['ok', `${label}：${fmtTime(len, sr)}，${Math.round(bars)} 小节${seamTxt}`]);
      } else out.push(['ok', `${label}：${fmtTime(len, sr)}${seamTxt}`]);
      if (sm && sm.score < 0.35) out.push(['warn', `${label}接缝波形 / 响度差异大（${sm.db.toFixed(0)}dB），跳转处可能听到咔哒声或电平突变，可试试「循环点候选」`]);
    };
    loopCheck('TrackLoopStart', 'TrackLoopEnd', 'TrackLoop');
    loopCheck('PostRaceLoopStart', 'PostRaceLoopEnd', '赛后循环');
    if (isNum(m.TrackDrop) && isNum(m.TrackLoopEnd) && m.TrackDrop >= m.TrackLoopEnd) out.push(['err', 'TrackDrop 必须在 TrackLoopEnd 之前']);
    if (isNum(m.PostDrop) && isNum(m.PostRaceLoopEnd) && m.PostDrop >= m.PostRaceLoopEnd) out.push(['err', 'PostDrop 必须在 PostRaceLoopEnd 之前']);
    if (isNum(m.TrackDrop) && isNum(m.TrackLoopStart) && m.TrackDrop > m.TrackLoopEnd) out.push(['warn', 'TrackDrop 在循环区间之后']);
    return out;
  }

  function renderValidation() {
    const box = $('validation');
    box.innerHTML = '';
    const song = state.cur;
    if (!song || !song.loaded) return;
    for (const [k, msg] of validate(song)) {
      const d = document.createElement('div');
      d.className = 'item ' + k;
      d.textContent = (k === 'err' ? '✖ ' : k === 'warn' ? '⚠ ' : '✔ ') + msg;
      box.appendChild(d);
    }
  }

  // ------------------------------------------------------------------ 段落面板
  function renderSectionList() {
    const box = $('sectionList');
    box.innerHTML = '';
    const song = state.cur;
    if (!song || !song.loaded) return;
    song.sections.forEach((sec, i) => {
      const row = document.createElement('div');
      row.className = 'srow' + (i === state.selSection ? ' selected' : '');
      const opts = Object.entries(SECTION_TYPES).map(([k, t]) => `<option value="${k}"${k === sec.label ? ' selected' : ''}>${t.zh}</option>`).join('');
      const bars = barsBetween(song, sec.start, sec.end);
      row.innerHTML = `<span class="bar" style="background:${SECTION_TYPES[sec.label].color}"></span>
        <select>${opts}</select>
        <span class="tm">${fmtTime(sec.start, song.sr)} · ${((sec.end - sec.start) / song.sr).toFixed(1)}s${bars ? ` · ${bars} 小节` : ''}</span>
        <button class="btn small" title="从本段开始播放">▶</button>`;
      row.querySelector('select').addEventListener('change', (e) => setSectionLabel(i, e.target.value));
      row.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); play(sec.start); });
      row.addEventListener('click', (e) => {
        if (e.target.tagName === 'SELECT') return;
        state.selSection = i;
        ensureVisible(sec.start);
        seek(sec.start);
        renderSectionList();
      });
      box.appendChild(row);
    });
  }

  // ------------------------------------------------------------------ 自动识别
  let worker = null, workerFailed = false, jobSeq = 0;
  function getWorker() {
    if (worker || workerFailed) return worker;
    try {
      const src = `const M=(${HRAnalysisModule.toString()})();
onmessage=(e)=>{const d=e.data;try{const r=M.analyze(d.mono,d.sr,d.opts,(p,msg)=>postMessage({id:d.id,progress:p,msg}));postMessage({id:d.id,result:r});}catch(err){postMessage({id:d.id,error:String(err&&err.stack||err)});}};`;
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } catch (e) {
      workerFailed = true;
      worker = null;
    }
    return worker;
  }

  function runAnalysis(song, opts) {
    return new Promise((resolve, reject) => {
      const onProgress = (p, msg) => setProgress(p, msg);
      const w = getWorker();
      if (!w) {
        setTimeout(() => {
          try { resolve(HR.analyze(song.mono, song.sr, opts, onProgress)); } catch (e) { reject(e); }
        }, 30);
        return;
      }
      const id = ++jobSeq;
      const handler = (e) => {
        const d = e.data;
        if (d.id !== id) return;
        if (d.progress != null) onProgress(d.progress, d.msg);
        else {
          w.removeEventListener('message', handler);
          w.removeEventListener('error', errHandler);
          if (d.error) reject(new Error(d.error)); else resolve(d.result);
        }
      };
      const errHandler = (e) => {
        // Worker 不可用（某些浏览器的 file:// 限制）时回退到主线程
        w.removeEventListener('message', handler);
        w.removeEventListener('error', errHandler);
        workerFailed = true; worker = null;
        e.preventDefault && e.preventDefault();
        setTimeout(() => {
          try { resolve(HR.analyze(song.mono, song.sr, opts, onProgress)); } catch (err) { reject(err); }
        }, 30);
      };
      w.addEventListener('message', handler);
      w.addEventListener('error', errHandler);
      w.postMessage({ id, mono: song.mono.slice(), sr: song.sr, opts });
    });
  }

  function setProgress(p, msg) {
    const box = $('analysisProgress');
    box.hidden = p == null;
    if (p == null) return;
    box.querySelector('.bar').style.width = Math.round(p * 100) + '%';
    box.querySelector('span').textContent = `${msg || ''} ${Math.round(p * 100)}%`;
  }

  async function analyzeCurrent() {
    const song = state.cur;
    if (!song || !song.mono) { toast('请先打开一首歌'); return; }
    const btn = $('btnAnalyze');
    btn.disabled = true;
    setProgress(0, '开始');
    try {
      const r = await runAnalysis(song, {});
      applyAnalysis(song, r, { replaceSections: $('optReplaceSections').checked, applyMarkers: $('optApplyMarkers').checked });
      toast(`识别完成：${r.bpm.toFixed(2)} BPM，${r.sections.length} 个段落`);
    } catch (e) {
      console.error(e);
      toast('识别失败：' + e.message, 5000);
    } finally {
      btn.disabled = false;
      setProgress(null);
    }
  }

  function applyAnalysis(song, r, opts) {
    pushUndo();
    song.analysis = {
      bpm: r.bpm, beatsPerBar: r.beatsPerBar || 4, grid: r.grid || null, constantTempo: !!r.constantTempo,
      beats: r.beats || [], downbeats: r.downbeats || [],
      featBars: r.bars || null, barFeats: r.barFeats || null,
      loopsTrack: r.loopsTrack || [], loopsPost: r.loopsPost || [],
    };
    if (opts.replaceSections && r.sections && r.sections.length) song.sections = normalizeSections(r.sections, song.length);
    if (opts.applyMarkers) {
      const mk = r.markers && Object.keys(r.markers).length ? r.markers : HR.deriveMarkers(song.sections, song.length, song.analysis.downbeats);
      applyMarkerSet(song, mk);
    }
    renderAnalysisResult();
    renderLoopCandidates(song.analysis.loopsTrack, 'TrackLoop');
    changed();
  }

  function renderAnalysisResult() {
    const song = state.cur, box = $('analysisResult');
    const a = song && song.analysis;
    $('bpmInput').value = a && a.bpm ? a.bpm.toFixed(2) : '';
    if (!a) { box.innerHTML = ''; return; }
    const counts = {};
    for (const s of song.sections) counts[s.label] = (counts[s.label] || 0) + 1;
    box.innerHTML = `速度 <b>${a.bpm.toFixed(2)} BPM</b>${a.constantTempo ? '（恒定速度网格）' : '（变速，逐拍跟踪）'}<br>
      ${a.beats.length} 拍 / ${a.downbeats.length} 小节（每小节 ${a.beatsPerBar || 4} 拍，自动检测）<br>
      段落：${Object.entries(counts).map(([k, n]) => `${SECTION_TYPES[k].zh}×${n}`).join('、')}`;
  }

  function findLoops(kind) {
    const song = state.cur;
    const a = song && song.analysis;
    if (!a || !a.barFeats || !a.featBars) { toast('请先运行一次「自动识别」'); return; }
    const m = song.markers;
    const pre = kind === 'TrackLoop'
      ? { start: m.TrackLoopStart, end: m.TrackLoopEnd }
      : { start: m.PostRaceLoopStart, end: m.PostRaceLoopEnd };
    const list = HR.findLoopCandidates(a.barFeats, a.featBars, song.length,
      { start: isNum(pre.start) ? pre.start : null, end: isNum(pre.end) ? pre.end : null },
      { minBars: kind === 'TrackLoop' ? 8 : 4, count: 8, audio: song.mono, sr: song.sr });
    renderLoopCandidates(list, kind);
  }

  function renderLoopCandidates(list, kind) {
    const box = $('loopCandidates');
    box.innerHTML = '';
    const song = state.cur;
    if (!list || !list.length) { if (song && song.analysis) box.innerHTML = '<div class="hint">没有找到候选</div>'; return; }
    const title = document.createElement('div');
    title.className = 'hint';
    title.textContent = kind === 'TrackLoop' ? '应用到 TrackLoopStart / End：' : '应用到 PostRaceLoopStart / End：';
    box.appendChild(title);
    for (const c of list) {
      const it = document.createElement('div');
      it.className = 'loop-item';
      it.innerHTML = `<span class="tm">${fmtTime(c.start, song.sr)} → ${fmtTime(c.end, song.sr)}</span>
        <span class="sc" title="${c.seam != null ? '接缝评分 ' + Math.round(c.seam * 100) + '/100；终点已按波形微调 ' + (c.shift || 0) + ' 采样点' : ''}">${c.bars} 小节${c.seamDb != null ? ' · 接缝 ' + c.seamDb.toFixed(0) + 'dB' : ''}</span>
        <button class="btn small" data-a="try" title="试听跳转衔接">▶</button>
        <button class="btn small" data-a="use">应用</button>`;
      it.querySelector('[data-a=try]').onclick = () => previewLoop(c.start, c.end);
      it.querySelector('[data-a=use]').onclick = () => {
        pushUndo();
        [song.markers[kind + 'Start'], song.markers[kind + 'End']] = snapLoopPair(c.start, c.end);
        changed({ keepSections: true });
        toast(`已应用 ${kind}`);
      };
      box.appendChild(it);
    }
  }

  function setGridFromPlayhead() {
    const song = state.cur;
    if (!song || !song.loaded) return;
    const bpm = Number($('bpmInput').value);
    if (!(bpm >= 40 && bpm <= 260)) { toast('请先在 BPM 框中输入 40–260 之间的速度'); return; }
    const period = song.sr * 60 / bpm;
    const t0 = Math.round(curPos());
    const beats = HR.gridBeats(t0, period, song.length);
    const k0 = Math.round((beats[0] - t0) / period); // 第一拍相对 t0 的拍号（≤0）
    const downbeats = beats.filter((_, i) => (((i + k0) % 4) + 4) % 4 === 0);
    const prev = song.analysis || {};
    song.analysis = { ...prev, bpm, beatsPerBar: 4, grid: { t0, period }, constantTempo: true, beats, downbeats };
    renderAnalysisResult();
    changed({ keepSections: false });
    toast(`已用 ${bpm} BPM 以播放头为第一拍重建网格`);
  }

  // ------------------------------------------------------------------ 导入
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((f) => f !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
  }

  function matchSong(names) {
    const keys = names.filter(Boolean).map(normName);
    return state.songs.find((s) => keys.includes(normName(s.name)) || keys.includes(normName(s.displayName)));
  }

  function applyCsvRow(song, row) {
    const srcLen = Number(row.SampleLength) || 0;
    const scale = srcLen > 0 && song.length && Math.abs(srcLen - song.length) > 1 ? (song.length - 1) / (srcLen - 1) : 1;
    pushUndo();
    for (const d of MARKERS) {
      if (!(d.name in row)) continue;
      const raw = row[d.name];
      if (raw === '' || /^auto$/i.test(raw)) { if (!['TrackStart', 'End'].includes(d.name)) song.markers[d.name] = null; continue; }
      if (/^(disable|disabled|off|<disable>)$/i.test(raw)) { if (d.adv) song.markers[d.name] = 'DISABLE'; continue; }
      const v = Number(raw);
      if (!isFinite(v)) continue;
      if (v < 0) { if (d.adv) song.markers[d.name] = 'DISABLE'; continue; }
      song.markers[d.name] = clamp(Math.round(v * scale), 0, song.length - 1);
    }
    if (row.DisplayName) song.displayName = row.DisplayName;
    if (row.Artist) song.artist = row.Artist;
    return scale;
  }

  function applyPendingRows(song) {
    const idx = state.pendingRows.findIndex((r) => matchSong([r.MatchName, r.Filename, r.DisplayName]) === song);
    if (idx < 0) return;
    const [row] = state.pendingRows.splice(idx, 1);
    if (row.__project) applyProjectSong(song, row.__project);
    else applyCsvRow(song, row);
    toast(`已应用之前导入的标记：${song.name}`);
  }

  async function importFile(file) {
    const text = await file.text();
    try {
      if (/\.csv$/i.test(file.name)) importCsv(text);
      else importJson(JSON.parse(text), file.name);
    } catch (e) {
      console.error(e);
      toast(`导入 ${file.name} 失败：${e.message}`, 5000);
    }
  }

  function importCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) { toast('CSV 中没有数据'); return; }
    let applied = 0, pending = 0, scaled = 0;
    for (const row of rows) {
      const song = matchSong([row.MatchName, row.Filename, row.DisplayName, row.name, row.title]);
      if (song && song.loaded) {
        if (applyCsvRow(song, row) !== 1) scaled++;
        applied++;
      } else {
        state.pendingRows.push(row);
        pending++;
      }
    }
    changed();
    let msg = `CSV：已应用 ${applied} 首`;
    if (pending) msg += `，${pending} 首将在打开对应音频后自动应用`;
    if (scaled) msg += `（${scaled} 首的 SampleLength 不同，已按比例换算）`;
    toast(msg, 4500);
  }

  function applyProjectSong(song, ps) {
    const scale = ps.length && song.length && Math.abs(ps.length - song.length) > 1 ? song.length / ps.length : 1;
    const sc = (v) => (isNum(v) ? Math.round(v * scale) : v);
    pushUndo();
    if (ps.markers) for (const d of MARKERS) if (d.name in ps.markers) {
      const v = ps.markers[d.name];
      song.markers[d.name] = isNum(v) ? clamp(sc(v), 0, song.length - 1) : v === 'DISABLE' ? 'DISABLE' : (['TrackStart', 'End'].includes(d.name) ? song.markers[d.name] : null);
    }
    if (ps.sections) song.sections = normalizeSections(ps.sections.map((s) => ({ ...s, start: sc(s.start), end: sc(s.end) })), song.length);
    if (ps.displayName) song.displayName = ps.displayName;
    if (ps.artist) song.artist = ps.artist;
    if (ps.analysis) {
      const a = ps.analysis;
      song.analysis = {
        ...a,
        beats: (a.beats || []).map(sc), downbeats: (a.downbeats || []).map(sc),
        featBars: a.featBars ? a.featBars.map(sc) : null,
      };
    }
  }

  function importJson(obj, fileName) {
    // 1) 本工具导出的项目
    if (obj && Array.isArray(obj.songs)) {
      let applied = 0, pending = 0;
      for (const ps of obj.songs) {
        const song = matchSong([ps.name, ps.base, ps.displayName]);
        if (song && song.loaded) { applyProjectSong(song, ps); applied++; }
        else { state.pendingRows.push({ MatchName: ps.base || ps.name, Filename: ps.name, __project: ps }); pending++; }
      }
      changed();
      renderAnalysisResult();
      toast(`项目：已应用 ${applied} 首${pending ? `，${pending} 首待打开音频后应用` : ''}`, 4000);
      return;
    }
    // 2) 分析脚本输出（单首）
    if (obj && (obj.sections || obj.beats)) {
      let song = obj.file ? matchSong([obj.file]) : null;
      song = song || state.cur;
      if (!song || !song.loaded) { toast('请先打开对应的音频，再导入分析结果'); return; }
      const srcRate = obj.sampleRate || song.sr;
      const k = song.sr / srcRate;
      const conv = (v) => Math.round(v * k);
      const r = {
        bpm: obj.bpm || 0, beatsPerBar: obj.beatsPerBar || 4,
        beats: (obj.beats || []).map(conv), downbeats: (obj.downbeats || []).map(conv),
        sections: (obj.sections || []).map((s) => ({ start: conv(s.start), end: conv(s.end), label: s.label })),
        markers: null, constantTempo: false,
      };
      if (!r.downbeats.length && r.beats.length) r.downbeats = r.beats.filter((_, i) => i % 4 === 0);
      if (!r.bpm && r.beats.length > 1) r.bpm = 60 * song.sr / ((r.beats[r.beats.length - 1] - r.beats[0]) / (r.beats.length - 1));
      if (song !== state.cur) { toast(`分析结果属于 ${song.name}，请先切换到该歌曲`); return; }
      applyAnalysis(song, r, { replaceSections: r.sections.length > 0, applyMarkers: $('optApplyMarkers').checked });
      toast(`已导入分析结果 ${fileName}`);
      return;
    }
    toast('无法识别的 JSON 格式');
  }

  // ------------------------------------------------------------------ 导出
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(songs) {
    const lines = [CSV_COLUMNS.join(',')];
    for (const s of songs) {
      const row = {
        MatchName: s.base, Filename: s.name, DisplayName: s.displayName || s.base, Artist: s.artist || '',
        SampleRate: s.sr, SampleLength: s.length,
      };
      for (const d of MARKERS) {
        const v = s.markers[d.name];
        row[d.name] = isNum(v) ? v : v === 'DISABLE' ? 'DISABLE' : '';
      }
      lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function exportCsv() {
    const songs = state.songs.filter((s) => s.loaded);
    if (!songs.length) { toast('没有可导出的歌曲'); return; }
    const errs = songs.flatMap((s) => validate(s).filter(([k]) => k === 'err').map(([, m]) => `${s.name}: ${m}`));
    download('fh6_markers.csv', buildCsv(songs), 'text/csv');
    toast(errs.length ? `已导出（注意：有 ${errs.length} 个错误，见右侧校验）` : `已导出 ${songs.length} 首歌的标记`, 3500);
  }

  function exportProject() {
    const songs = state.songs.filter((s) => s.loaded);
    if (!songs.length) { toast('没有可导出的歌曲'); return; }
    const data = {
      app: 'fh6-marker-studio', version: 1, sampleRate: PROJECT_RATE,
      songs: songs.map((s) => ({
        name: s.name, base: s.base, length: s.length, sampleRate: s.sr, displayName: s.displayName, artist: s.artist,
        markers: s.markers, sections: s.sections, analysis: serializeAnalysis(s.analysis),
      })),
    };
    download('fh6_marker_project.json', JSON.stringify(data, null, 1), 'application/json');
  }

  function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function showXml() {
    const s = state.cur;
    if (!s || !s.loaded) { toast('请先打开一首歌'); return; }
    const lines = [`<!-- ${xmlEscape(s.name)} : SampleLength="${s.length}" SampleRate="${s.sr}" -->`];
    for (const name of XML_ORDER) {
      const v = s.markers[name];
      if (isNum(v)) lines.push(`<Marker Name="${name}" Position="${v}" />`);
      else if (v === 'DISABLE') lines.push(`<Marker Name="${name}" Position="-1" />`);
      else lines.push(`<!-- ${name}: 未设置（保留原 XML 值或由工具自动推导） -->`);
    }
    const text = lines.join('\n');
    const body = $('modalBody');
    body.innerHTML = '<p>可以粘贴到 RadioInfo XML 对应 &lt;Sample&gt; 节点中，替换原有的 Marker（同时记得更新 SampleLength）。</p><textarea readonly></textarea><div class="row-btns"><button class="btn primary" id="copyXmlBtn">复制</button></div>';
    body.querySelector('textarea').value = text;
    body.querySelector('#copyXmlBtn').onclick = async () => {
      const ta = body.querySelector('textarea');
      try { await navigator.clipboard.writeText(text); } catch (e) { ta.select(); document.execCommand('copy'); }
      toast('已复制');
    };
    openModal('RadioInfo XML Marker 片段');
  }

  function openModal(title) { $('modalTitle').textContent = title; $('modal').hidden = false; }
  $('modalClose').onclick = () => { $('modal').hidden = true; };
  $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });

  // ------------------------------------------------------------------ 绑定
  function switchTab(name) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of document.querySelectorAll('.tabpane')) p.classList.toggle('active', p.id === 'tab-' + name);
  }
  for (const t of document.querySelectorAll('.tab')) t.onclick = () => switchTab(t.dataset.tab);

  $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('importInput').addEventListener('change', async (e) => { for (const f of e.target.files) await importFile(f); e.target.value = ''; });
  $('btnExportCsv').onclick = exportCsv;
  $('btnExportJson').onclick = exportProject;
  $('btnCopyXml').onclick = showXml;
  $('btnHelp').onclick = () => { $('modalBody').innerHTML = ''; $('modalBody').appendChild($('helpTpl').content.cloneNode(true)); openModal('帮助'); };
  $('btnPlay').onclick = togglePlay;
  $('btnToStart').onclick = () => { seek(0); ensureVisible(0); };
  $('btnZoomIn').onclick = () => zoomAt(1 / 1.6, sToX(curPos()) >= 0 && sToX(curPos()) <= canvasW() ? sToX(curPos()) : canvasW() / 2);
  $('btnZoomOut').onclick = () => zoomAt(1.6, canvasW() / 2);
  $('btnZoomFit').onclick = zoomFit;
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;
  $('snapMode').onchange = (e) => { state.snap = e.target.value; };
  $('snapZero').onchange = (e) => { state.snapZero = e.target.checked; };
  $('followPlay').onchange = (e) => { state.follow = e.target.checked; };
  $('btnSetDownbeat').onclick = setGridFromPlayhead;
  $('btnSplit').onclick = () => splitAt(curPos());
  $('btnDeriveMarkers').onclick = deriveFromSections;
  $('btnAnalyze').onclick = analyzeCurrent;
  $('btnFindLoopsTrack').onclick = () => findLoops('TrackLoop');
  $('btnFindLoopsPost').onclick = () => findLoops('PostRaceLoop');
  for (const b of document.querySelectorAll('[data-preview]')) b.onclick = () => preview(b.dataset.preview);

  // 拖放
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').classList.add('show'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.remove('show'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').classList.remove('show');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // 键盘
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (!$('modal').hidden) { if (e.key === 'Escape') $('modal').hidden = true; return; }
    const song = state.cur;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    if (!song || !song.loaded) return;
    const beatLen = song.analysis && song.analysis.beats && song.analysis.beats.length > 1
      ? (song.analysis.beats[song.analysis.beats.length - 1] - song.analysis.beats[0]) / (song.analysis.beats.length - 1) : null;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); togglePlay(); }
    else if (k === 'Home') { seek(0); ensureVisible(0); }
    else if (k === 'End') { seek(song.length - 1); ensureVisible(song.length - 1); }
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const dir = k === 'ArrowLeft' ? -1 : 1;
      const p = curPos();
      let target;
      const arr = snapPositions(e.shiftKey ? 'bar' : 'beat');
      if (arr) {
        const i = firstIndexAtOrAfter(arr, p + (dir > 0 ? 1 : 0));
        target = dir > 0 ? (arr[i] != null && arr[i] > p + 1 ? arr[i] : arr[i + 1]) : arr[Math.max(0, i - 1)];
        if (target == null) target = dir > 0 ? song.length - 1 : 0;
      } else target = p + dir * song.sr * (e.shiftKey ? 2 : 0.5);
      seek(target);
      ensureVisible(state.playhead);
    } else if (/^[1-6]$/.test(k)) {
      const d = MARKERS.find((m) => m.key === k);
      setMarker(d.name, snapZeroOnly(curPos()));
      selectMarker(d.name);
      toast(`${d.name} → ${fmtTime(song.markers[d.name])}`, 1200);
    } else if (k === '[' || k === ']') {
      const name = state.selMarker;
      if (!name || !isNum(song.markers[name])) return;
      const dir = k === '[' ? -1 : 1;
      const step = e.altKey ? 10 : (beatLen || song.sr * 0.1);
      let v = song.markers[name] + dir * step;
      if (!e.altKey) v = snapSample(v, false);
      setMarker(name, v);
      ensureVisible(song.markers[name]);
    } else if (k === 'Delete' || k === 'Backspace') {
      if (state.selMarker && !['TrackStart', 'End'].includes(state.selMarker)) setMarker(state.selMarker, null);
      else if (state.selSection > 0) removeBoundary(state.selSection);
    } else if (k === 's' || k === 'S') splitAt(curPos());
    else if (k === 'l' || k === 'L') preview('TrackLoop');
    else if (k === '+' || k === '=') zoomAt(1 / 1.6, sToX(curPos()) >= 0 && sToX(curPos()) <= canvasW() ? sToX(curPos()) : canvasW() / 2);
    else if (k === '-' || k === '_') zoomAt(1.6, canvasW() / 2);
    else if (k === '0') zoomFit();
    else if (k === 'Escape') { state.selMarker = null; state.selSection = -1; updateMarkerSelection(); renderSectionList(); needsDraw = true; }
  });

  new ResizeObserver(() => { clampView(); needsDraw = true; }).observe($('timelineWrap'));
  window.addEventListener('beforeunload', () => { if (state.cur) saveSong(state.cur); });

  function setStatus(msg) { $('statusbar').textContent = msg; }

  function renderAll() {
    renderSongList();
    updateMarkerValues();
    renderValidation();
    renderSectionList();
    renderAnalysisResult();
    const a = state.cur && state.cur.analysis;
    renderLoopCandidates(a ? a.loopsTrack : null, 'TrackLoop');
    needsDraw = true;
  }

  renderMarkerTable();
  renderAll();
  requestAnimationFrame(frame);

  // 供自动化测试使用
  window.__fh6 = { state, addFiles, analyzeCurrent, buildCsv: () => buildCsv(state.songs.filter((s) => s.loaded)), importCsv, setMarker, validate };
})();
