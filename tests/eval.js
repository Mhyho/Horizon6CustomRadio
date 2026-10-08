// 评测：node tests/eval.js synth <合成歌曲目录> [--analysis web/analysis.js] [--json out.json]
//       node tests/eval.js real  <Salsa 目录（tests/fetch_real_data.py 的输出）> [同上]
// 指标：速度准确率（acc1 / acc2）、节拍 F（70ms）、强拍 F、小节长度是否正确、副歌起点误差（小节）、循环接缝（dB，越小越好）。
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const mode = args[0], dir = args[1];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HR = require(path.resolve(opt('--analysis', path.join(__dirname, '../web/analysis.js'))))();

function readWav(p) {
  const b = fs.readFileSync(p);
  let off = 12, fmt, data;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  const n = data.length / 2 / fmt.ch, mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2);
    mono[i] = s / fmt.ch / 32768;
  }
  return { mono, sr: fmt.sr };
}

// ---- 指标
function fMeasure(est, ref, win) {
  if (!ref.length) return null;
  const used = new Set();
  let hit = 0;
  for (const r of ref) {
    let bi = -1, bd = win + 1;
    for (let i = 0; i < est.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(est[i] - r);
      if (d < bd) { bd = d; bi = i; }
      if (est[i] - r > win) break;
    }
    if (bi >= 0 && bd <= win) { used.add(bi); hit++; }
  }
  const p = est.length ? hit / est.length : 0, rc = hit / ref.length;
  return p + rc ? 2 * p * rc / (p + rc) : 0;
}
const tempoAcc1 = (e, t) => Math.abs(e / t - 1) <= 0.04;
const tempoAcc2 = (e, t) => [1, 2, 0.5, 3, 1 / 3, 1.5, 2 / 3].some((f) => Math.abs(e / (t * f) - 1) <= 0.04);

function chorusStarts(sections) {
  const out = [];
  let prev = false;
  for (const s of sections) {
    const c = s.label === 'chorus' || s.label === 'drop';
    if (c && !prev) out.push(s.start);
    prev = c;
  }
  return out;
}

/** 与分析器无关的接缝残差：跳转前 / 后各 N 个采样，(a-b) 能量相对两者平均能量，单位 dB（0 dB≈互不相关） */
function seamDb(x, start, end, N = 4800) {
  const calc = (a0, b0) => {
    let d = 0, ea = 0, eb = 0;
    for (let i = 0; i < N; i++) {
      const a = x[a0 + i] || 0, b = x[b0 + i] || 0;
      d += (a - b) * (a - b); ea += a * a; eb += b * b;
    }
    return d / (0.5 * (ea + eb) + 1e-12);
  };
  if (start - N < 0 || end - N < 0 || end + N > x.length) return null;
  const pre = calc(start - N, end - N), post = calc(start, end);
  return 10 * Math.log10(0.5 * (pre + post) + 1e-12);
}

/** 低通（滑动平均 ≈ 0.5kHz 以下，主要是鼓点 / 贝斯的相位）后的接缝残差 */
function lowpass(x, w = 96) {
  const out = new Float32Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) { acc += x[i]; if (i >= w) acc -= x[i - w]; out[i] = acc / w; }
  return out;
}

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }

const rows = [];
if (mode === 'synth') {
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
  for (const f of names) {
    const truth = JSON.parse(fs.readFileSync(path.join(dir, f + '.truth.json')));
    const { mono, sr } = readWav(path.join(dir, f));
    const t0 = Date.now();
    const r = HR.analyze(mono, sr);
    const ms = Date.now() - t0;
    const tb = truth.beats, win = 0.07 * sr;
    const barLen = (truth.downbeats[truth.downbeats.length - 1] - truth.downbeats[0]) / (truth.downbeats.length - 1);
    const row = {
      name: truth.name, ms, bpm: r.bpm, truthBpm: truth.bpm, bpb: r.beatsPerBar, truthBpb: truth.beatsPerBar,
      acc1: tempoAcc1(r.bpm, truth.bpm), acc2: tempoAcc2(r.bpm, truth.bpm),
      beatF: fMeasure(r.beats, tb, win), downF: fMeasure(r.downbeats, truth.downbeats, win),
      metre: Math.abs(r.beatsPerBar * (r.constantTempo && r.grid ? r.grid.period : 60 * sr / r.bpm) / (truth.beatsPerBar * 60 * sr / truth.bpm) - 1) < 0.05,
    };
    const dc = chorusStarts(r.sections);
    if (truth.choruses.length) {
      const tc = truth.choruses;
      const errBars = (d, t) => (d == null ? 16 : Math.min(16, Math.abs(d - t) / barLen));
      row.chorusFirst = errBars(dc[0], tc[0]);
      row.chorusLast = errBars(dc[dc.length - 1], tc[tc.length - 1]);
      row.dropErr = errBars(r.markers.TrackDrop, tc[0]);
      row.postErr = errBars(r.markers.PostDrop, tc[tc.length - 1]);
    }
    if (r.loopsTrack && r.loopsTrack.length) {
      const c = r.loopsTrack[0];
      row.seamDb = seamDb(mono, c.start, c.end);
      row.seamBars = c.bars;
      // 音乐上是否合理：起点、终点都落在真实小节线（±60ms）上，即循环长度是整数个真实小节
      const nearBar = (p) => truth.downbeats.some((d) => Math.abs(d - p) < 0.06 * sr);
      row.loopMusical = nearBar(c.start) && nearBar(c.end);
      row.seamClean = row.seamDb != null && row.seamDb < -20;
    }
    if (truth.loops.length) row.truthSeamDb = seamDb(mono, truth.loops[0].start, truth.loops[0].end);
    rows.push(row);
  }
  const f = (v, d = 2) => (v == null || Number.isNaN(v) ? '  -  ' : v.toFixed(d));
  console.log('case            bpm(est/true)   acc1 acc2 metre beatF downF  chorus1 chorusN drop  post  seamdB loop  ms');
  for (const r of rows) {
    console.log(`${r.name.padEnd(15)} ${(f(r.bpm, 1) + '/' + f(r.truthBpm, 1)).padEnd(13)}   ${r.acc1 ? 'Y' : '.'}    ${r.acc2 ? 'Y' : '.'}    ${r.metre ? 'Y' : '.'}     ${f(r.beatF)} ${f(r.downF)}  ${f(r.chorusFirst, 1).padStart(5)}  ${f(r.chorusLast, 1).padStart(5)}  ${f(r.dropErr, 1).padStart(5)} ${f(r.postErr, 1).padStart(5)} ${f(r.seamDb, 1).padStart(6)} ${r.loopMusical ? 'Y' : '.'}${r.seamClean ? 'c' : ' '}   ${r.ms}`);
  }
  const sel = (k) => rows.map((r) => r[k]).filter((v) => v != null);
  const summary = {
    tempoAcc1: mean(rows.map((r) => +r.acc1)), tempoAcc2: mean(rows.map((r) => +r.acc2)),
    beatF: mean(sel('beatF')), downbeatF: mean(sel('downF')), metreAcc: mean(rows.map((r) => +r.metre)),
    chorusFirstErrBars: mean(sel('chorusFirst')), chorusLastErrBars: mean(sel('chorusLast')),
    dropWithin0_5bar: mean(sel('dropErr').map((v) => +(v <= 0.5))), postWithin0_5bar: mean(sel('postErr').map((v) => +(v <= 0.5))),
    seamMedianDb: sel('seamDb').sort((a, b) => a - b)[Math.floor(sel('seamDb').length / 2)],
    seamClean: mean(rows.map((r) => +!!r.seamClean)), loopMusical: mean(rows.map((r) => +!!r.loopMusical)),
    maxMs: Math.max(...rows.map((r) => r.ms)),
  };
  console.log('SUMMARY', JSON.stringify(summary));
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ rows, summary }, null, 1));
} else if (mode === 'real') {
  const audioDir = fs.existsSync(path.join(dir, 'aud/audio_fragments')) ? path.join(dir, 'aud/audio_fragments') : dir;
  const annDir = path.join(dir, 'ann');
  const files = fs.readdirSync(audioDir).filter((f) => f.endsWith('.wav')).sort((a, b) => parseInt(a) - parseInt(b));
  for (const f of files) {
    const id = f.replace('.wav', '');
    const ann = fs.readFileSync(path.join(annDir, id + '.txt'), 'utf8').split(/\s+/).filter(Boolean).map(Number);
    const { mono, sr } = readWav(path.join(audioDir, f));
    const beatsRef = ann.map((ms) => ms / 1000 * sr);
    const ioi = beatsRef.slice(1).map((b, i) => b - beatsRef[i]).sort((a, b) => a - b);
    const per = ioi[ioi.length >> 1];
    const bpmRef = 60 * sr / per;
    // Salsa 的标注是整首歌的毫秒时间，而音频是其中某个 30 秒片段，片段起点没有给出。
    // 所以只能评「与相位无关的节拍 F」：取标注最开头 30 秒、再整体平移到最合适的位置。
    const slice = beatsRef.filter((b) => b - beatsRef[0] <= mono.length + per).map((b) => b - beatsRef[0]);
    let phaseFreeF = 0;
    const t0 = Date.now();
    const r = HR.analyze(mono, sr);
    const ms = Date.now() - t0;
    for (let d = 0; d < per; d += 0.01 * sr) {
      const ref = slice.map((b) => b + d - per).filter((b) => b >= 0 && b < mono.length);
      phaseFreeF = Math.max(phaseFreeF, fMeasure(r.beats, ref, 0.07 * sr) || 0);
    }
    rows.push({
      name: id, ms, bpm: r.bpm, truthBpm: bpmRef, acc1: tempoAcc1(r.bpm, bpmRef), acc2: tempoAcc2(r.bpm, bpmRef),
      beatF: phaseFreeF, constant: r.constant === undefined ? r.constantTempo : r.constantTempo,
      // 真实音乐没有「已知无缝循环」真值，只能看与分析器无关的波形残差（越低越好）；30 秒片段里用赛后循环候选（≥4 小节）
      seamDb: r.loopsPost && r.loopsPost.length ? seamDb(mono, r.loopsPost[0].start, r.loopsPost[0].end, 2400) : null,
      seamLowDb: r.loopsPost && r.loopsPost.length ? seamDb(lowpass(mono), r.loopsPost[0].start, r.loopsPost[0].end, 2400) : null,
    });
  }
  const summary = {
    n: rows.length, tempoAcc1: mean(rows.map((r) => +r.acc1)), tempoAcc2: mean(rows.map((r) => +r.acc2)),
    beatF: mean(rows.map((r) => r.beatF)), maxMs: Math.max(...rows.map((r) => r.ms)),
    loopTop1SeamMedianDb: (() => { const a = rows.map((r) => r.seamDb).filter((v) => v != null).sort((x, y) => x - y); return a[a.length >> 1]; })(),
    loopTop1SeamMeanDb: mean(rows.map((r) => r.seamDb).filter((v) => v != null)),
    loopTop1LowpassMedianDb: (() => { const a = rows.map((r) => r.seamLowDb).filter((v) => v != null).sort((x, y) => x - y); return a[a.length >> 1]; })(),
    loopTop1Below6dB: mean(rows.filter((r) => r.seamDb != null).map((r) => +(r.seamDb < -6))),
    loopClipsWithCandidate: rows.filter((r) => r.seamDb != null).length,
  };
  if (args.includes('--verbose')) for (const r of rows) console.log(r.name.padStart(4), r.bpm.toFixed(1).padStart(6), '/', r.truthBpm.toFixed(1).padStart(6), r.acc1 ? 'Y' : '.', r.acc2 ? 'Y' : '.', r.beatF.toFixed(2), r.constant ? 'const' : 'var');
  console.log('SUMMARY', JSON.stringify(summary));
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ rows, summary }, null, 1));
} else {
  console.error('用法: node tests/eval.js synth|real <目录> [--analysis analysis.js] [--json out.json] [--verbose]');
  process.exit(2);
}
