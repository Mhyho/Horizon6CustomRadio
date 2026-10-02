/*
 * 自动分析模块：节拍网格 / 小节 / 段落识别 / 段落标签 / Marker 推导 / 循环点搜索。
 *
 * 整个模块写在一个函数里，既可以在页面里直接调用 HRAnalysisModule()，
 * 也可以把函数源码 toString() 后塞进 Blob Worker 里后台运行（file:// 下也能用）。
 * 所有对外返回的位置均为「采样点」（基于传入的采样率）。
 */
function HRAnalysisModule() {
  'use strict';

  // ---------------------------------------------------------------- 基础工具
  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  function mean(a, s = 0, e = a.length) {
    if (e <= s) return 0;
    let t = 0;
    for (let i = s; i < e; i++) t += a[i];
    return t / (e - s);
  }

  function std(a) {
    const m = mean(a);
    let t = 0;
    for (let i = 0; i < a.length; i++) t += (a[i] - m) * (a[i] - m);
    return Math.sqrt(t / Math.max(1, a.length));
  }

  function median(arr) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function cosine(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
  }

  function movingAverage(x, radius) {
    const n = x.length, out = new Float32Array(n);
    let acc = 0, cnt = 0, lo = 0, hi = -1;
    for (let i = 0; i < n; i++) {
      const wantLo = Math.max(0, i - radius), wantHi = Math.min(n - 1, i + radius);
      while (hi < wantHi) { hi++; acc += x[hi]; cnt++; }
      while (lo < wantLo) { acc -= x[lo]; lo++; cnt--; }
      out[i] = acc / cnt;
    }
    return out;
  }

  // ---------------------------------------------------------------- 帧特征
  /**
   * 把 48k 左右的单声道信号降采样后做 STFT，得到：
   * onset（谱通量）、lowOnset（低频通量，鼓点）、rms（dB）、chroma(12)、bands(24 个对数频带 dB)
   */
  function computeFrameFeatures(x, sr, progress) {
    const decim = sr > 32000 ? 2 : 1;
    const fsr = sr / decim;
    const n = Math.floor(x.length / decim);
    const y = new Float32Array(n);
    if (decim === 1) y.set(x.subarray(0, n));
    else for (let i = 0; i < n; i++) y[i] = 0.5 * (x[2 * i] + x[2 * i + 1]);

    const nfft = 2048, hop = 512, nb = nfft / 2 + 1;
    const nFrames = Math.max(1, Math.floor((n - nfft) / hop) + 1);
    const win = new Float32Array(nfft);
    for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / nfft);

    // 频带：24 个对数间隔频带 40Hz..min(11k, nyquist)
    const NB = 24, fLo = 40, fHi = Math.min(11000, fsr / 2 - 1);
    const bandEdges = [];
    for (let b = 0; b <= NB; b++) bandEdges.push(fLo * Math.pow(fHi / fLo, b / NB));
    const binBand = new Int16Array(nb).fill(-1);
    const binChroma = new Int8Array(nb).fill(-1);
    let lowBandCount = 0;
    for (let k = 1; k < nb; k++) {
      const f = k * fsr / nfft;
      for (let b = 0; b < NB; b++) if (f >= bandEdges[b] && f < bandEdges[b + 1]) { binBand[k] = b; break; }
      if (f >= 55 && f <= 4200) binChroma[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
    }
    for (let b = 0; b < NB; b++) if (bandEdges[b + 1] <= 160) lowBandCount = b + 1;
    lowBandCount = Math.max(2, lowBandCount);

    const onset = new Float32Array(nFrames);
    const lowOnset = new Float32Array(nFrames);
    const rms = new Float32Array(nFrames);
    const chroma = new Float32Array(nFrames * 12);
    const bands = new Float32Array(nFrames * NB);

    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    const bandE = new Float64Array(NB);
    let prev = new Float32Array(NB), cur = new Float32Array(NB);
    for (let t = 0; t < nFrames; t++) {
      const off = t * hop;
      let e = 0;
      for (let i = 0; i < nfft; i++) {
        const v = y[off + i];
        e += v * v;
        re[i] = v * win[i]; im[i] = 0;
      }
      rms[t] = 10 * Math.log10(e / nfft + 1e-10);
      fftInPlace(re, im);
      bandE.fill(0);
      const cbase = t * 12;
      for (let k = 1; k < nb; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        const b = binBand[k];
        if (b >= 0) bandE[b] += p;
        const c = binChroma[k];
        if (c >= 0) chroma[cbase + c] += Math.sqrt(p);
      }
      for (let b = 0; b < NB; b++) {
        cur[b] = 10 * Math.log10(bandE[b] + 1e-9);
        bands[t * NB + b] = cur[b];
      }
      if (t > 0) {
        let fl = 0, lf = 0;
        for (let b = 0; b < NB; b++) {
          const d = cur[b] - prev[b];
          if (d > 0) { fl += d; if (b < lowBandCount) lf += d; }
        }
        onset[t] = fl / NB;
        lowOnset[t] = lf / lowBandCount;
      }
      const sw = prev; prev = cur; cur = sw;
      if (progress && (t & 1023) === 0) progress(0.05 + 0.45 * t / nFrames, '计算频谱特征');
    }

    // 去趋势 + 归一化
    const norm = (env) => {
      const ma = movingAverage(env, Math.round(fsr / hop * 0.4));
      for (let i = 0; i < env.length; i++) env[i] = Math.max(0, env[i] - ma[i]);
      const s = std(env) || 1;
      for (let i = 0; i < env.length; i++) env[i] /= s;
    };
    norm(onset); norm(lowOnset);

    // 帧 t 的谱通量峰值大约对应「帧中心 - 半个 hop」处的起音
    const frameToSample = (t) => Math.round((t * hop + nfft / 2 - hop / 2) * decim);
    return { onset, lowOnset, rms, chroma, bands, NB, nFrames, fps: fsr / hop, frameToSample, decim, hop, nfft };
  }

  /** 高时间分辨率的起音包络（用于把节拍网格对齐到采样级），约 2.7ms 一帧 */
  function fineOnsetEnvelope(x, sr, hopSec = 0.00266) {
    const hop = Math.max(16, Math.round(sr * hopSec)), win = hop * 4;
    const n = Math.max(1, Math.floor((x.length - win) / hop) + 1);
    const env = new Float32Array(n);
    // 一阶高通（去掉直流），对数能量差分
    let prevE = -100;
    for (let t = 0; t < n; t++) {
      let e = 0;
      const off = t * hop;
      for (let i = 1; i < win; i++) { const d = x[off + i] - 0.95 * x[off + i - 1]; e += d * d; }
      const le = 10 * Math.log10(e / win + 1e-10);
      env[t] = Math.max(0, le - prevE);
      prevE = le;
    }
    // 能量跳变最大的帧，是起音刚进入窗口尾部的那一帧
    return { env, hop, win, toSample: (t) => t * hop + win - hop / 2 };
  }

  // ---------------------------------------------------------------- 速度 / 节拍
  function estimateTempo(onset, fps) {
    const minLag = Math.floor(fps * 60 / 220), maxLag = Math.ceil(fps * 60 / 55);
    const n = onset.length;
    const ac = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += onset[i] * onset[i - lag];
      ac[lag] = s / (n - lag);
    }
    let best = -1, bestLag = minLag;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = 60 * fps / lag;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      // 同时考虑二倍 lag（半速）的支持，减少八度错误
      const support = lag * 2 <= maxLag ? 0.5 * ac[lag * 2] : 0;
      const s = (ac[lag] + support) * w;
      if (s > best) { best = s; bestLag = lag; }
    }
    const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? 0.5 * (a - c) / denom : 0;
    const lag = bestLag + Math.max(-0.5, Math.min(0.5, delta));
    return 60 * fps / lag;
  }

  /** Ellis 动态规划节拍跟踪 */
  function trackBeats(onset, fps, bpm) {
    const n = onset.length;
    const period = fps * 60 / bpm;
    // 高斯平滑的局部得分
    const sigma = Math.max(1, period / 32), rad = Math.ceil(sigma * 3);
    const local = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -rad; k <= rad; k++) {
        const j = i + k;
        if (j >= 0 && j < n) s += onset[j] * Math.exp(-0.5 * (k / sigma) * (k / sigma));
      }
      local[i] = s;
    }
    const cum = new Float32Array(n), back = new Int32Array(n).fill(-1);
    const tight = 100;
    const lo = Math.round(period / 2), hi = Math.round(period * 2);
    for (let t = 0; t < n; t++) {
      let best = -Infinity, bi = -1;
      for (let p = t - hi; p <= t - lo; p++) {
        if (p < 0) continue;
        const r = Math.log((t - p) / period);
        const s = cum[p] - tight * r * r;
        if (s > best) { best = s; bi = p; }
      }
      cum[t] = local[t] + (bi >= 0 ? Math.max(0, best) : 0);
      back[t] = bi >= 0 && best > 0 ? bi : -1;
    }
    let end = n - 1, bestEnd = -Infinity;
    for (let t = Math.max(0, n - Math.round(period * 1.5)); t < n; t++) if (cum[t] > bestEnd) { bestEnd = cum[t]; end = t; }
    const beats = [];
    for (let t = end; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
    beats.reverse();
    // 修剪首尾弱拍
    const thr = 0.3 * mean(Array.from(beats, (b) => local[b]));
    while (beats.length && local[beats[0]] < thr) beats.shift();
    while (beats.length && local[beats[beats.length - 1]] < thr) beats.pop();
    return { beats, period };
  }

  /** 线性回归拟合恒定速度网格，返回 {t0, period, residualStd} （单位：采样点） */
  function fitConstantGrid(beatSamples) {
    let idx = beatSamples.map((_, i) => i);
    let pts = beatSamples.slice();
    let fit = null;
    for (let pass = 0; pass < 3; pass++) {
      const m = pts.length;
      if (m < 8) return null;
      const mi = mean(idx), mt = mean(pts);
      let sxx = 0, sxy = 0;
      for (let i = 0; i < m; i++) { sxx += (idx[i] - mi) ** 2; sxy += (idx[i] - mi) * (pts[i] - mt); }
      const period = sxy / sxx, t0 = mt - period * mi;
      const res = pts.map((p, i) => p - (t0 + period * idx[i]));
      const rs = std(res);
      fit = { t0, period, residualStd: rs };
      const keepI = [], keepP = [];
      for (let i = 0; i < m; i++) if (Math.abs(res[i]) < Math.max(2.5 * rs, period * 0.04)) { keepI.push(idx[i]); keepP.push(pts[i]); }
      if (keepI.length === m) break;
      idx = keepI; pts = keepP;
    }
    return fit;
  }

  /** 在 ±maxShift 范围内整体平移恒定网格，使其与高精度起音包络最吻合 */
  function refineGridPhase(grid, fine, length) {
    const maxShift = grid.period * 0.12;
    const step = fine.hop / 2;
    let best = -1, bestShift = 0;
    for (let sh = -maxShift; sh <= maxShift; sh += step) {
      let s = 0;
      for (let b = grid.t0 + sh; b < length; b += grid.period) {
        if (b < 0) continue;
        const f = Math.round((b - fine.win + fine.hop / 2) / fine.hop);
        // 取 ±1 帧最大值，容忍少量误差
        let v = 0;
        for (let k = -1; k <= 1; k++) { const j = f + k; if (j >= 0 && j < fine.env.length) v = Math.max(v, fine.env[j]); }
        s += v;
      }
      if (s > best) { best = s; bestShift = sh; }
    }
    return { ...grid, t0: grid.t0 + bestShift };
  }

  function gridBeats(t0, period, length) {
    const out = [];
    let start = t0 - Math.floor(t0 / period) * period;
    for (let b = start; b < length; b += period) out.push(Math.round(b));
    return out;
  }

  function refineBeatsToOnsets(beats, fine, maxDev) {
    return beats.map((b) => {
      const f0 = Math.round((b - fine.win + fine.hop / 2) / fine.hop);
      const r = Math.ceil(maxDev / fine.hop);
      let best = -1, bf = f0;
      for (let f = f0 - r; f <= f0 + r; f++) {
        if (f < 0 || f >= fine.env.length) continue;
        if (fine.env[f] > best) { best = fine.env[f]; bf = f; }
      }
      return best > 0 ? Math.round(fine.toSample(bf)) : b;
    });
  }

  // ---------------------------------------------------------------- 小节 / 特征聚合
  function frameOfSample(F, s) {
    return Math.max(0, Math.min(F.nFrames - 1, Math.round((s / F.decim - F.nfft / 2 + F.hop / 2) / F.hop)));
  }

  function chooseDownbeatPhase(F, beats, beatsPerBar) {
    const nb = beats.length;
    if (nb < beatsPerBar * 4) return 0;
    // 每拍的低频起音强度 + 和声变化
    const low = new Float32Array(nb), chg = new Float32Array(nb);
    const chromaOf = (a, b) => {
      const v = new Float32Array(12);
      const fa = frameOfSample(F, a), fb = Math.max(fa + 1, frameOfSample(F, b));
      for (let f = fa; f < fb; f++) for (let c = 0; c < 12; c++) v[c] += F.chroma[f * 12 + c];
      return v;
    };
    let prevC = null;
    for (let i = 0; i < nb; i++) {
      const f = frameOfSample(F, beats[i]);
      let m = 0;
      for (let k = -1; k <= 1; k++) { const j = f + k; if (j >= 0 && j < F.nFrames) m = Math.max(m, F.lowOnset[j]); }
      low[i] = m;
      const c = chromaOf(beats[i], i + 1 < nb ? beats[i + 1] : beats[i] + (beats[i] - beats[i - 1]));
      chg[i] = prevC ? 1 - cosine(prevC, c) : 0;
      prevC = c;
    }
    const z = (a) => { const m = mean(a), s = std(a) || 1; return Array.from(a, (v) => (v - m) / s); };
    const zl = z(low), zc = z(chg);
    let best = -Infinity, phase = 0;
    for (let p = 0; p < beatsPerBar; p++) {
      let s = 0, c = 0;
      for (let i = p; i < nb; i += beatsPerBar) { s += zl[i] + zc[i]; c++; }
      s /= Math.max(1, c);
      if (s > best) { best = s; phase = p; }
    }
    return phase;
  }

  /** 每小节的特征向量：12 维 chroma + 12 维音色（对数频带 DCT）+ 响度 */
  function barFeatures(F, bars, length) {
    const NB = F.NB, feats = [], energy = [];
    for (let i = 0; i < bars.length; i++) {
      const a = bars[i], b = i + 1 < bars.length ? bars[i + 1] : length;
      const fa = frameOfSample(F, a), fb = Math.max(fa + 1, frameOfSample(F, b));
      const chroma = new Float64Array(12), band = new Float64Array(NB);
      let e = 0;
      for (let f = fa; f < fb; f++) {
        for (let c = 0; c < 12; c++) chroma[c] += F.chroma[f * 12 + c];
        for (let k = 0; k < NB; k++) band[k] += F.bands[f * NB + k];
        e += Math.pow(10, F.rms[f] / 10);
      }
      const cnt = fb - fa;
      let cn = 0;
      for (let c = 0; c < 12; c++) cn += chroma[c] * chroma[c];
      cn = Math.sqrt(cn) || 1;
      for (let k = 0; k < NB; k++) band[k] /= cnt;
      const mfcc = [];
      for (let q = 1; q <= 12; q++) {
        let s = 0;
        for (let k = 0; k < NB; k++) s += band[k] * Math.cos(Math.PI * q * (k + 0.5) / NB);
        mfcc.push(s / NB);
      }
      feats.push([...Array.from(chroma, (v) => v / cn), ...mfcc]);
      energy.push(10 * Math.log10(e / cnt + 1e-10));
    }
    // 维度标准化
    const D = feats.length ? feats[0].length : 0;
    for (let d = 0; d < D; d++) {
      const col = feats.map((f) => f[d]);
      const m = mean(col), s = std(col) || 1;
      for (const f of feats) f[d] = (f[d] - m) / s;
    }
    return { feats, energy };
  }

  // ---------------------------------------------------------------- 段落分割
  function segmentBars(feats, energy, opts) {
    const n = feats.length;
    if (n < 8) return [0];
    const S = [];
    for (let i = 0; i < n; i++) {
      S.push(new Float32Array(n));
      for (let j = 0; j < n; j++) S[i][j] = cosine(feats[i], feats[j]);
    }
    const K = 4;
    const nov = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      let s = 0, w = 0;
      for (let a = -K; a < K; a++) {
        for (let b = -K; b < K; b++) {
          const ia = i + a, ib = i + b;
          if (ia < 0 || ib < 0 || ia >= n || ib >= n) continue;
          const g = Math.exp(-0.5 * ((a + 0.5) ** 2 + (b + 0.5) ** 2) / (K * K * 0.5));
          const sign = (a < 0) === (b < 0) ? 1 : -1;
          s += sign * g * S[ia][ib];
          w += g;
        }
      }
      nov[i] = w ? s / w : 0;
    }
    const enov = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      enov[i] = Math.abs(mean(energy, i, Math.min(n, i + 4)) - mean(energy, Math.max(0, i - 4), i));
    }
    const zn = (a) => { const m = mean(a), s = std(a) || 1; return Array.from(a, (v) => (v - m) / s); };
    const z1 = zn(nov), z2 = zn(enov);
    const score = z1.map((v, i) => v + 0.6 * z2[i]);
    const phase = opts.phraseOffset || 0;
    const cand = [];
    for (let i = 2; i < n - 1; i++) {
      let isMax = true;
      for (let k = -2; k <= 2; k++) if (k && i + k >= 0 && i + k < n && score[i + k] > score[i]) isMax = false;
      if (!isMax) continue;
      let s = score[i];
      if (((i - phase) % 4 + 4) % 4 === 0) s += 0.5;
      if (((i - phase) % 8 + 8) % 8 === 0) s += 0.25;
      if (s > 0.6) cand.push({ i, s });
    }
    cand.sort((a, b) => b.s - a.s);
    const chosen = [0];
    const maxSeg = Math.max(2, Math.ceil(n / 6));
    for (const c of cand) {
      if (chosen.length >= maxSeg) break;
      if (chosen.every((j) => Math.abs(j - c.i) >= 4)) chosen.push(c.i);
    }
    chosen.sort((a, b) => a - b);
    return chosen;
  }

  // ---------------------------------------------------------------- 段落标签
  function labelSegments(segBars, feats, energy) {
    const n = feats.length;
    const segs = segBars.map((s, k) => ({ a: s, b: k + 1 < segBars.length ? segBars[k + 1] : n }));
    for (const sg of segs) {
      const D = feats[0].length, v = new Float64Array(D);
      for (let i = sg.a; i < sg.b; i++) for (let d = 0; d < D; d++) v[d] += feats[i][d];
      sg.vec = Array.from(v, (x) => x / (sg.b - sg.a));
      // 用线性能量平均再转 dB
      let e = 0;
      for (let i = sg.a; i < sg.b; i++) e += Math.pow(10, energy[i] / 10);
      sg.energy = 10 * Math.log10(e / (sg.b - sg.a));
      sg.label = 'verse';
    }
    const m = segs.length;
    if (m === 1) { segs[0].label = 'chorus'; return segs; }

    // 相似段落聚类（简单并查集）
    const parent = segs.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
      if (cosine(segs[i].vec, segs[j].vec) > 0.55) parent[find(i)] = find(j);
    }
    const clusters = new Map();
    segs.forEach((s, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(i); });

    const energies = segs.map((s) => s.energy);
    const maxE = Math.max(...energies), minE = Math.min(...energies);
    const medE = median(energies);
    const rel = (e) => (maxE - minE > 0.1 ? (e - minE) / (maxE - minE) : 1);

    let bestC = null, bestScore = -Infinity;
    for (const [, members] of clusters) {
      const ce = mean(members.map((i) => rel(segs[i].energy)));
      const bars = members.reduce((t, i) => t + segs[i].b - segs[i].a, 0);
      const score = ce * 1.6 + (members.length >= 2 ? 0.35 : 0) + Math.min(0.3, 0.05 * members.length) + Math.min(0.2, bars / n);
      if (score > bestScore) { bestScore = score; bestC = members; }
    }
    const chorusE = mean(bestC.map((i) => segs[i].energy));
    for (const i of bestC) segs[i].label = 'chorus';
    for (const s of segs) if (s.label !== 'chorus' && s.energy >= chorusE - 0.8 && s.energy >= medE) s.label = 'chorus';

    const first = segs[0], last = segs[m - 1];
    if (first.label !== 'chorus' && (first.energy < medE - 1 || first.b - first.a <= 8)) first.label = 'intro';
    if (last.label !== 'chorus' && m > 2 && (last.energy < segs[m - 2].energy - 1.5 || last.energy < medE - 2)) last.label = 'outro';

    const firstChorus = segs.findIndex((s) => s.label === 'chorus');
    for (let i = 1; i < m - 1; i++) {
      const s = segs[i];
      if (s.label !== 'verse') continue;
      // 铺垫段：紧挨副歌之前、较短、且能量在段内上升
      const half = Math.max(1, (s.b - s.a) >> 1);
      const rise = mean(energy, s.a + half, s.b) - mean(energy, s.a, s.a + half);
      const quiet = s.energy < medE - 2.5;
      if (segs[i + 1].label === 'chorus' && s.b - s.a <= 8 && (rise > 1 || !quiet)) s.label = 'build';
      else if (firstChorus >= 0 && i > firstChorus && quiet) s.label = 'bridge';
    }

    // 合并相邻同标签段
    const merged = [];
    for (const s of segs) {
      const p = merged[merged.length - 1];
      if (p && p.label === s.label) {
        const la = p.b - p.a, lb = s.b - s.a;
        p.energy = 10 * Math.log10((la * Math.pow(10, p.energy / 10) + lb * Math.pow(10, s.energy / 10)) / (la + lb));
        p.b = s.b;
      } else merged.push({ a: s.a, b: s.b, label: s.label, energy: s.energy });
    }
    return merged;
  }

  // ---------------------------------------------------------------- Marker 推导
  /**
   * 根据段落推导 FH Marker。
   * sections: [{start, end, label}]（采样点）；bars: 小节起点数组（可空）
   */
  function deriveMarkers(sections, length, bars) {
    const out = {};
    if (!sections || !sections.length || !length) return out;
    const hi = sections.filter((s) => s.label === 'chorus' || s.label === 'drop');
    let pool = hi;
    if (!pool.length) {
      // 没有标副歌：取除前奏/尾奏外最长的段
      const mid = sections.filter((s) => s.label !== 'intro' && s.label !== 'outro');
      pool = (mid.length ? mid : sections).slice().sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 1);
    }
    const firstHi = pool[0], lastHi = pool[pool.length - 1];
    out.TrackStart = 0;
    out.End = length - 1;
    out.TrackDrop = firstHi.start;
    out.TrackLoopStart = firstHi.start;
    out.TrackLoopEnd = Math.min(length - 1, lastHi.end);
    if (out.TrackLoopEnd - out.TrackLoopStart < 0.2 * length && sections.length) {
      // 循环过短：一直延伸到尾奏前
      const outro = sections.find((s) => s.label === 'outro');
      out.TrackLoopEnd = Math.min(length - 1, outro ? outro.start : lastHi.end);
    }
    out.PostDrop = lastHi.start;
    out.PostRaceLoopStart = lastHi.start;
    out.PostRaceLoopEnd = Math.min(length - 1, lastHi.end);
    if (pool.length >= 2 && out.PostRaceLoopEnd - out.PostRaceLoopStart < 0.04 * length) {
      out.PostDrop = out.PostRaceLoopStart = pool[pool.length - 2].start;
    }
    // 让循环长度为整小节
    if (bars && bars.length > 2) {
      out.TrackLoopEnd = alignLoopEndToBars(out.TrackLoopStart, out.TrackLoopEnd, bars, length);
      out.PostRaceLoopEnd = alignLoopEndToBars(out.PostRaceLoopStart, out.PostRaceLoopEnd, bars, length);
    }
    return out;
  }

  function alignLoopEndToBars(start, end, bars, length) {
    let best = end, bd = Infinity;
    for (const b of bars) {
      if (b <= start || b >= length) continue;
      const d = Math.abs(b - end);
      if (d < bd) { bd = d; best = b; }
    }
    return Math.min(length - 1, best);
  }

  // ---------------------------------------------------------------- 循环候选
  /**
   * 在小节起点上搜索「无缝」循环：跳转前后的内容与原位置相似。
   * prefer: {start, end} 期望位置（采样点），用于偏好；minBars：最短循环小节数
   */
  function findLoopCandidates(barFeats, bars, length, prefer, opts = {}) {
    const n = barFeats.length;
    const minBars = opts.minBars || 8;
    const w = opts.window || 2;
    const out = [];
    if (n < minBars + 2 * w) return out;
    const barLen = (bars[bars.length - 1] - bars[0]) / Math.max(1, bars.length - 1);
    const nearest = (s) => {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < bars.length; i++) { const d = Math.abs(bars[i] - s); if (d < bd) { bd = d; bi = i; } }
      return bi;
    };
    const ps = prefer && prefer.start != null ? nearest(prefer.start) : null;
    const pe = prefer && prefer.end != null ? nearest(prefer.end) : null;
    const winSim = (i, j, before) => {
      let s = 0, c = 0;
      for (let k = 0; k < w; k++) {
        const a = before ? i - 1 - k : i + k, b = before ? j - 1 - k : j + k;
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        s += cosine(barFeats[a], barFeats[b]); c++;
      }
      return c ? s / c : 0;
    };
    for (let i = w; i < n; i++) {
      for (let j = i + minBars; j <= n - 1; j++) {
        if (bars[j] >= length) break;
        let s = 0.5 * winSim(i, j, true) + 0.5 * winSim(i, j, false);
        const len = j - i;
        if (len % 8 === 0) s += 0.06; else if (len % 4 === 0) s += 0.03;
        if (ps != null) s -= 0.012 * Math.abs(i - ps);
        if (pe != null) s -= 0.012 * Math.abs(j - pe);
        s += 0.002 * Math.min(len, 64);
        out.push({ i, j, score: s });
      }
    }
    out.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of out) {
      if (picked.length >= (opts.count || 6)) break;
      if (picked.some((p) => Math.abs(p.i - c.i) < 2 && Math.abs(p.j - c.j) < 2)) continue;
      picked.push(c);
    }
    return picked.map((c) => ({
      start: bars[c.i], end: Math.min(length - 1, bars[c.j]), bars: c.j - c.i,
      score: c.score, seconds: (bars[c.j] - bars[c.i]) / (barLen || 1),
    }));
  }

  // ---------------------------------------------------------------- 主流程
  /**
   * @param {Float32Array} mono 单声道 PCM
   * @param {number} sr 采样率
   * @param {object} opts {beatsPerBar=4, bpmHint}
   */
  function analyze(mono, sr, opts = {}, progress = null) {
    const length = mono.length;
    const beatsPerBar = opts.beatsPerBar || 4;
    progress && progress(0.02, '准备');
    const F = computeFrameFeatures(mono, sr, progress);
    progress && progress(0.52, '估计速度');
    let bpm = opts.bpmHint || estimateTempo(F.onset, F.fps);
    const tb = trackBeats(F.onset, F.fps, bpm);
    progress && progress(0.62, '节拍对齐');
    const rawBeats = tb.beats.map((f) => F.frameToSample(f));
    const fine = fineOnsetEnvelope(mono, sr);
    let beats, grid = null, constantTempo = false;
    const fit = fitConstantGrid(rawBeats);
    if (fit && fit.residualStd < fit.period * 0.06) {
      grid = refineGridPhase(fit, fine, length);
      // 采样级精修：用 ~0.7ms 分辨率的包络找到每拍真实起音，再对强拍做一次回归
      const fine2 = fineOnsetEnvelope(mono, sr, 0.0007);
      const g0 = gridBeats(grid.t0, grid.period, length);
      const ref = refineBeatsToOnsets(g0, fine2, sr * 0.004);
      const idx0 = Math.round((g0[0] - grid.t0) / grid.period);
      const devs = ref.map((r, i) => r - g0[i]).filter((d) => Math.abs(d) < sr * 0.004);
      if (devs.length > 16) {
        const pts = [], ids = [];
        ref.forEach((r, i) => { if (Math.abs(r - g0[i]) < sr * 0.004) { pts.push(r); ids.push(i + idx0); } });
        const mi = mean(ids), mt = mean(pts);
        let sxx = 0, sxy = 0;
        for (let i = 0; i < pts.length; i++) { sxx += (ids[i] - mi) ** 2; sxy += (ids[i] - mi) * (pts[i] - mt); }
        const period = sxy / sxx;
        if (Math.abs(period / grid.period - 1) < 0.002) grid = { ...grid, period, t0: mt - period * mi };
      }
      beats = gridBeats(grid.t0, grid.period, length);
      constantTempo = true;
      bpm = 60 * sr / grid.period;
    } else {
      beats = refineBeatsToOnsets(rawBeats, fine, sr * 0.015);
      if (beats.length > 1) bpm = 60 * sr / median(beats.slice(1).map((b, i) => b - beats[i]));
    }
    progress && progress(0.7, '识别小节');
    const phase = chooseDownbeatPhase(F, beats, beatsPerBar);
    const downbeats = [];
    for (let i = phase; i < beats.length; i += beatsPerBar) downbeats.push(beats[i]);
    // 小节序列：从 0 开始（补一个 0 号伪小节以覆盖前奏前的空白）
    const bars = downbeats.slice();
    if (!bars.length || bars[0] > sr * 0.5) bars.unshift(0);
    progress && progress(0.78, '段落分割');
    const bf = barFeatures(F, bars, length);
    const segBars = segmentBars(bf.feats, bf.energy, { phraseOffset: bars[0] === 0 && downbeats[0] !== 0 ? 1 : 0 });
    progress && progress(0.9, '段落标注');
    const labeled = labelSegments(segBars, bf.feats, bf.energy);
    const sections = labeled.map((s) => ({
      start: s.a === 0 ? 0 : bars[s.a],
      end: s.b >= bars.length ? length : bars[s.b],
      label: s.label,
      energy: s.energy,
    }));
    const markers = deriveMarkers(sections, length, bars);
    const loopsTrack = findLoopCandidates(bf.feats, bars, length, { start: markers.TrackLoopStart, end: markers.TrackLoopEnd });
    const loopsPost = findLoopCandidates(bf.feats, bars, length, { start: markers.PostRaceLoopStart, end: markers.PostRaceLoopEnd }, { minBars: 4 });
    progress && progress(1, '完成');
    return {
      sampleRate: sr, length, bpm, constantTempo,
      grid: grid ? { t0: grid.t0, period: grid.period } : null,
      beats, downbeats, beatsPerBar, bars,
      barFeats: bf.feats, barEnergy: bf.energy,
      sections, markers, loopsTrack, loopsPost,
    };
  }

  return {
    analyze, deriveMarkers, findLoopCandidates, alignLoopEndToBars, gridBeats,
    _internal: { fftInPlace, estimateTempo, trackBeats, fitConstantGrid, segmentBars, labelSegments },
  };
}

if (typeof module !== 'undefined') module.exports = HRAnalysisModule;
