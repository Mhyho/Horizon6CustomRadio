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
  function gaussSmooth(x, sigma) {
    const rad = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * rad + 1);
    let ks = 0;
    for (let i = -rad; i <= rad; i++) { k[i + rad] = Math.exp(-0.5 * (i / sigma) * (i / sigma)); ks += k[i + rad]; }
    const n = x.length, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = -rad; j <= rad; j++) { const q = i + j; if (q >= 0 && q < n) s += x[q] * k[j + rad]; }
      out[i] = s / ks;
    }
    return out;
  }

  function interp(a, t) {
    const i = Math.floor(t), f = t - i;
    if (i < 0 || i + 1 >= a.length) return 0;
    return a[i] * (1 - f) + a[i + 1] * f;
  }

  /**
   * 速度候选：对每个候选速度，把一条等间隔的拍网格放到起音包络上，在每个 ~10 秒窗口里取最佳相位，
   * 累加「网格上的起音强度 - 背景」。这样网格必须同时解释强拍和弱拍（二倍速要求半拍位置也有起音，
   * 半速则会漏掉奇数拍），比单个自相关峰更不容易出八度错误；窗口内各自取相位，也容忍速度漂移。
   * 返回 [{bpm, score}]（已叠加弱先验）。
   */
  function tempoCandidates(onset, fps, opts = {}) {
    const n = onset.length;
    const o = gaussSmooth(onset, 1.0);
    const bg = mean(o) * (opts.bg == null ? 1.0 : opts.bg);
    const winN = Math.max(Math.round(fps * 10), 64), hopW = winN >> 1;
    const sigma = opts.priorSigma || 0.8;
    const out = [];
    for (let bpm = 55; bpm <= 220; bpm += 0.5) {
      const L = fps * 60 / bpm;
      let total = 0;
      for (let s = 0; s + winN <= n || s === 0; s += hopW) {
        const e = Math.min(n - 1, s + winN);
        let best = -Infinity;
        for (let ph = 0; ph < L; ph += 0.5) {
          let acc = 0;
          for (let t = s + ph; t < e; t += L) acc += interp(o, t) - bg;
          if (acc > best) best = acc;
        }
        total += best;
        if (s + winN >= n) break;
      }
      out.push({ bpm, raw: total, score: total * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / sigma, 2)) });
    }
    return out;
  }

  function estimateTempo(onset, fps) {
    const c = tempoCandidates(onset, fps);
    let bi = 0;
    for (let i = 1; i < c.length; i++) if (c[i].score > c[bi].score) bi = i;
    return c[bi].bpm;
  }

  /**
   * 局部速度：在 ~12 秒窗口内、全局速度 ±25% 范围里找网格得分最高的速度，窗口每 3 秒滑动一次，
   * 再做中值平滑。用来给节拍跟踪提供随时间变化的期望拍长（帧 / 拍），应对漂移和变速。
   */
  function localPeriods(o, fps, bpm0) {
    const n = o.length, os = gaussSmooth(o, 1.0), bg = mean(os);
    const winN = Math.round(fps * 12), hopW = Math.round(fps * 3);
    const pts = [];
    for (let s = 0; s === 0 || s + winN <= n; s += hopW) {
      const e = Math.min(n - 1, s + winN);
      let best = -Infinity, bb = bpm0;
      for (let r = -0.25; r <= 0.25001; r += 0.005) {
        const bpm = bpm0 * Math.exp(r * 0.9);
        const L = fps * 60 / bpm;
        let top = -Infinity;
        for (let ph = 0; ph < L; ph += 0.5) {
          let acc = 0;
          for (let t = s + ph; t < e; t += L) acc += interp(os, t) - bg;
          if (acc > top) top = acc;
        }
        top *= Math.exp(-0.5 * Math.pow(Math.log(bpm / bpm0) / 0.12, 2));
        if (top > best) { best = top; bb = bpm; }
      }
      pts.push({ c: Math.min(n - 1, s + winN / 2), bpm: bb });
      if (s + winN >= n) break;
    }
    const sm = pts.map((_, i) => median(pts.slice(Math.max(0, i - 2), i + 3).map((p) => p.bpm)));
    const per = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      let k = 0;
      while (k + 1 < pts.length && pts[k + 1].c <= t) k++;
      let bpm;
      if (k + 1 >= pts.length || t <= pts[0].c) bpm = sm[Math.min(k, sm.length - 1)];
      else { const f = (t - pts[k].c) / (pts[k + 1].c - pts[k].c); bpm = sm[k] * (1 - f) + sm[k + 1] * f; }
      per[t] = fps * 60 / bpm;
    }
    return per;
  }

  /** Ellis 动态规划节拍跟踪；per 为数字（帧 / 拍）或每帧的期望拍长数组 */
  function trackBeats(onset, fps, per) {
    const n = onset.length;
    const perAt = typeof per === 'number' ? () => per : (t) => per[t];
    const p0 = perAt(Math.floor(n / 2));
    const sigma = Math.max(1, p0 / 32), rad = Math.ceil(sigma * 3);
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
    for (let t = 0; t < n; t++) {
      const period = perAt(t);
      const lo = Math.round(period / 2), hi = Math.round(period * 2);
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
    for (let t = Math.max(0, n - Math.round(p0 * 1.5)); t < n; t++) if (cum[t] > bestEnd) { bestEnd = cum[t]; end = t; }
    const beats = [];
    for (let t = end; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
    beats.reverse();
    // 修剪首尾弱拍
    const thr = 0.3 * mean(Array.from(beats, (b) => local[b]));
    while (beats.length && local[beats[0]] < thr) beats.shift();
    while (beats.length && local[beats[beats.length - 1]] < thr) beats.pop();
    return { beats, period: p0 };
  }

  /**
   * 在全局速度附近（±2%）整体搜索「周期 + 相位」：一条恒速网格在整首歌上的起音得分最高者。
   * 整首歌共用一个相位，因此即使某些段落（鼓组缺席、反拍低音很响）局部相位有歧义，也不会被带偏。
   * 返回帧单位的 {L, ph}。
   */
  function searchGlobalGrid(o, fps, bpm0) {
    const os = gaussSmooth(o, 1.0), bg = mean(os), n = os.length;
    const L0 = fps * 60 / bpm0;
    let best = -Infinity, res = { L: L0, ph: 0 };
    for (let r = -0.02; r <= 0.02001; r += 0.0005) {
      const L = L0 * (1 + r);
      for (let ph = 0; ph < L; ph += 0.5) {
        let acc = 0;
        for (let t = ph; t < n - 1; t += L) acc += interp(os, t) - bg;
        if (acc > best) { best = acc; res = { L, ph }; }
      }
    }
    return res;
  }

  /**
   * 检验恒速网格：在每个网格拍点 ±40ms 内找高分辨率起音包络的峰，统计相对整体偏移的离散程度。
   * 漂移 / 变速的歌，网格会逐渐偏离起音，p80 偏差会明显变大。返回 {ok, spread, used}。
   */
  function verifyGrid(beatSamples, fine, sr) {
    const win = Math.round(0.04 * sr / fine.hop);
    let thr = 0;
    {
      const sorted = Array.from(fine.env).sort((a, b) => a - b);
      thr = Math.max(1.5, sorted[Math.floor(sorted.length * 0.9)]);
    }
    const devs = [];
    for (const b of beatSamples) {
      const f0 = Math.round((b - fine.win + fine.hop / 2) / fine.hop);
      let bv = 0, bf = -1;
      for (let f = f0 - win; f <= f0 + win; f++) {
        if (f < 0 || f >= fine.env.length) continue;
        if (fine.env[f] > bv) { bv = fine.env[f]; bf = f; }
      }
      if (bf >= 0 && bv >= thr) devs.push((fine.toSample(bf) - b) / sr * 1000);
    }
    if (devs.length < 16 || devs.length < 0.25 * beatSamples.length) return { ok: false, spread: Infinity, used: devs.length };
    const m = median(devs);
    const ad = devs.map((d) => Math.abs(d - m)).sort((a, b) => a - b);
    const spread = ad[Math.floor(ad.length * 0.8)];
    return { ok: spread <= 15, spread, used: devs.length };
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

  /** 每拍的「强拍倾向」特征：低频起音、和声变化、响度跳变（只统计有声的拍） */
  function beatSyncNovelty(F, beats) {
    const nb = beats.length;
    const low = new Float32Array(nb), chg = new Float32Array(nb), eng = new Float32Array(nb), active = new Uint8Array(nb);
    const chromaOf = (a, b) => {
      const v = new Float32Array(12);
      const fa = frameOfSample(F, a), fb = Math.max(fa + 1, frameOfSample(F, b));
      for (let f = fa; f < fb; f++) for (let c = 0; c < 12; c++) v[c] += F.chroma[f * 12 + c];
      return v;
    };
    const rmsAt = (a, b) => {
      const fa = frameOfSample(F, a), fb = Math.max(fa + 1, frameOfSample(F, b));
      let e = 0;
      for (let f = fa; f < fb; f++) e += Math.pow(10, F.rms[f] / 10);
      return 10 * Math.log10(e / (fb - fa) + 1e-10);
    };
    let prevC = null, prevE = null;
    for (let i = 0; i < nb; i++) {
      const f = frameOfSample(F, beats[i]);
      let m = 0;
      for (let k = -1; k <= 1; k++) { const j = f + k; if (j >= 0 && j < F.nFrames) m = Math.max(m, F.lowOnset[j]); }
      low[i] = m;
      const next = i + 1 < nb ? beats[i + 1] : beats[i] + (beats[i] - beats[Math.max(0, i - 1)]);
      const c = chromaOf(beats[i], next), e = rmsAt(beats[i], next);
      chg[i] = prevC ? 1 - cosine(prevC, c) : 0;
      eng[i] = prevE != null ? e - prevE : 0;
      active[i] = e > -55 ? 1 : 0;
      prevC = c; prevE = e;
    }
    return { low, chg, eng, active };
  }

  /**
   * 拍号 + 强拍相位。对候选每小节拍数 k 和相位 p，比较「强拍位置」与其余位置的特征差（对比度）；
   * 4 拍是默认，3 / 2 / 6 需要明显更好才会被选中。
   * 不提供 8：8 小节的乐句结构会让「隔一小节」的对比度虚高，容易把 4/4 误判成 8 拍。
   * fixed：外部指定拍号时只选相位。
   */
  function analyzeMetre(F, beats, fixed, bpm) {
    const nb = beats.length;
    const res = { beatsPerBar: fixed || 4, phase: 0, scores: {} };
    if (nb < 16) return res;
    const nv = beatSyncNovelty(F, beats);
    const idx = [];
    for (let i = 0; i < nb; i++) if (nv.active[i]) idx.push(i);
    const z = (a) => {
      const v = idx.map((i) => a[i]);
      const m = mean(v), s = std(v) || 1;
      return (x) => (x - m) / s;
    };
    const zl = z(nv.low), zc = z(nv.chg), ze = z(nv.eng);
    const N = new Float32Array(nb);
    for (let i = 0; i < nb; i++) N[i] = nv.active[i] ? zl(nv.low[i]) + zc(nv.chg[i]) + 0.5 * ze(nv.eng[i]) : 0;
    const contrast = (k) => {
      let best = -Infinity, bp = 0;
      for (let p = 0; p < k; p++) {
        let s = 0, c = 0, o = 0, oc = 0;
        for (const i of idx) { if (i % k === p) { s += N[i]; c++; } else { o += N[i]; oc++; } }
        if (c < 4 || !oc) continue;
        const d = s / c - o / oc;
        if (d > best) { best = d; bp = p; }
      }
      return { d: best, p: bp };
    };
    const ks = fixed ? [fixed] : [2, 3, 4, 6];
    const sc = {};
    for (const k of ks) sc[k] = contrast(k);
    let k = fixed || 4;
    if (!fixed) {
      const d4 = sc[4].d;
      let best = 4, bd = d4;
      // 偏向 4：其它拍号需要超出一定倍数
      const need = { 2: 1.25, 3: 1.15, 6: 1.35 };
      for (const kk of [3, 2, 6]) {
        if (sc[kk].d > bd * need[kk] && sc[kk].d > 0.2) { best = kk; bd = sc[kk].d; }
      }
      k = best;
    }
    if (!fixed && k === 4 && bpm >= 125) {
      // 跟踪到了八分音符层级的慢歌：4 拍位相上，隔一个的和声变化明显弱 → 真实的一小节是 8 个脉冲
      const p4 = sc[4].p;
      let ma = 0, ca = 0, mb = 0, cb = 0;
      for (const i of idx) {
        const r = ((i - p4) % 8 + 8) % 8;
        if (r === 0) { ma += nv.chg[i]; ca++; } else if (r === 4) { mb += nv.chg[i]; cb++; }
      }
      ma /= Math.max(1, ca); mb /= Math.max(1, cb);
      res.chordRatio = Math.min(ma, mb) / (Math.max(ma, mb) || 1);
      const d8 = contrast(8);
      sc[8] = d8;
      if (res.chordRatio < 0.45 && d8.d > 1.05 * sc[4].d) k = 8;
    }
    for (const kk of Object.keys(sc)) res.scores[kk] = sc[kk].d;
    res.beatsPerBar = k;
    res.phase = sc[k].p;
    return res;
  }

  /** 每小节的特征向量：12 维 chroma + 12 维音色（对数频带 DCT）+ 响度 */
  function barFeatures(F, bars, length) {
    const NB = F.NB, feats = [], energy = [];
    const full = [], bright = [], dens = [], low = [];
    for (let i = 0; i < bars.length; i++) {
      const a = bars[i], b = i + 1 < bars.length ? bars[i + 1] : length;
      const fa = frameOfSample(F, a), fb = Math.max(fa + 1, frameOfSample(F, b));
      const chroma = new Float64Array(12), band = new Float64Array(NB), bandLin = new Float64Array(NB);
      let e = 0, od = 0;
      for (let f = fa; f < fb; f++) {
        for (let c = 0; c < 12; c++) chroma[c] += F.chroma[f * 12 + c];
        for (let k = 0; k < NB; k++) { band[k] += F.bands[f * NB + k]; bandLin[k] += Math.pow(10, F.bands[f * NB + k] / 10); }
        e += Math.pow(10, F.rms[f] / 10);
        od += F.onset[f];
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
      // 听感描述量：谱的「满度」（各频带 dB 的平均）、亮度（谱质心）、起音密度、低频占比
      let fl = 0, tot = 0, cen = 0, lw = 0;
      for (let k = 0; k < NB; k++) { fl += Math.max(-70, band[k]); tot += bandLin[k]; cen += k * bandLin[k]; if (k < 6) lw += bandLin[k]; }
      full.push(fl / NB);
      bright.push(tot > 0 ? cen / tot / NB : 0);
      low.push(tot > 0 ? lw / tot : 0);
      dens.push(od / cnt);
    }
    // 维度标准化
    const D = feats.length ? feats[0].length : 0;
    for (let d = 0; d < D; d++) {
      const col = feats.map((f) => f[d]);
      const m = mean(col), s = std(col) || 1;
      for (const f of feats) f[d] = (f[d] - m) / s;
    }
    return { feats, energy, full, bright, dens, low };
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
  /**
   * 段落标签。副歌 = 「会重复出现、和声接近、听感更满更亮更密」的那一类段落，响度只是其中一项，
   * 所以压缩过度的母带（副歌不比主歌响）和 EDM（drop 比铺垫轻）也能识别。
   * extra: barFeatures 给出的每小节描述量 {full, bright, dens, low}。
   */
  function labelSegments(segBars, feats, energy, extra) {
    const n = feats.length;
    const segs = segBars.map((s, k) => ({ a: s, b: k + 1 < segBars.length ? segBars[k + 1] : n }));
    const D = feats[0].length;
    for (const sg of segs) {
      const v = new Float64Array(D), len = sg.b - sg.a;
      for (let i = sg.a; i < sg.b; i++) for (let d = 0; d < D; d++) v[d] += feats[i][d];
      sg.vec = Array.from(v, (x) => x / len);
      let e = 0;
      for (let i = sg.a; i < sg.b; i++) e += Math.pow(10, energy[i] / 10);
      sg.energy = 10 * Math.log10(e / len);
      sg.full = extra ? mean(extra.full, sg.a, sg.b) : 0;
      sg.bright = extra ? mean(extra.bright, sg.a, sg.b) : 0;
      sg.dens = extra ? mean(extra.dens, sg.a, sg.b) : 0;
      sg.low = extra ? mean(extra.low, sg.a, sg.b) : 0;
      sg.label = 'verse';
    }
    const m = segs.length;
    if (m === 1) { segs[0].label = 'chorus'; return segs; }

    // 段落两两相似度：按小节逐一对齐比较（比整段平均向量更能区分「同和声、不同编排」）
    const barSim = (x, y) => {
      const L = Math.min(x.b - x.a, y.b - y.a);
      let s = 0;
      for (let i = 0; i < L; i++) s += cosine(feats[x.a + i], feats[y.a + i]);
      return L ? s / L : 0;
    };
    const sim = segs.map((x, i) => segs.map((y, j) => (i === j ? 1 : Math.max(barSim(x, y), 0.5 * cosine(x.vec, y.vec) + 0.5 * barSim(x, y)))));
    // 平均连接的层次聚类，阈值 0.5
    let groups = segs.map((_, i) => [i]);
    for (;;) {
      let bi = -1, bj = -1, bs = 0.5;
      for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
        let s = 0;
        for (const x of groups[i]) for (const y of groups[j]) s += sim[x][y];
        s /= groups[i].length * groups[j].length;
        if (s > bs) { bs = s; bi = i; bj = j; }
      }
      if (bi < 0) break;
      groups[bi] = groups[bi].concat(groups[bj]);
      groups.splice(bj, 1);
    }

    // 段落描述量标准化（按时长加权的 z 分数），响度只占一部分
    const wts = segs.map((s) => s.b - s.a), wsum = wts.reduce((a, b) => a + b, 0);
    const zscore = (key) => {
      const mu = segs.reduce((t, s, i) => t + s[key] * wts[i], 0) / wsum;
      const sd = Math.sqrt(segs.reduce((t, s, i) => t + (s[key] - mu) * (s[key] - mu) * wts[i], 0) / wsum) || 1;
      segs.forEach((s) => { s['z_' + key] = (s[key] - mu) / sd; });
    };
    ['energy', 'full', 'bright', 'dens', 'low'].forEach(zscore);
    for (const s of segs) {
      s.hi = 0.35 * s.z_energy + 0.55 * s.z_full + 0.3 * s.z_bright + 0.4 * s.z_dens + 0.2 * s.z_low;
    }

    // 铺垫（build-up）特征：短、段内响度 / 起音密度持续上升。它们常常很响很亮，但不是副歌；
    // 紧跟在这类段落之后、而且更长的那一类，才是副歌 / drop。
    const slope = (arr, a, b) => {
      const L = b - a;
      if (L < 3) return 0;
      const mi = (L - 1) / 2, mv = mean(arr, a, b);
      let sxx = 0, sxy = 0;
      for (let q = 0; q < L; q++) { sxx += (q - mi) * (q - mi); sxy += (q - mi) * (arr[a + q] - mv); }
      return sxy / sxx;
    };
    const dens = extra ? extra.dens : null;
    for (const s of segs) {
      const L = s.b - s.a;
      s.rising = L <= 12 && (slope(energy, s.a, s.b) > 0.3 || (dens && slope(dens, s.a, s.b) > 0.05));
    }
    const groupOf = new Array(m);
    groups.forEach((g, gi) => g.forEach((i) => { groupOf[i] = gi; }));
    const buildGroup = groups.map((g) => g.filter((i) => segs[i].rising).length >= 0.6 * g.length && g.every((i) => i + 1 < m));
    const succBonus = new Array(groups.length).fill(0);
    groups.forEach((g, gi) => {
      if (!buildGroup[gi]) return;
      const nx = new Set(g.map((i) => groupOf[i + 1]));
      if (nx.size !== 1) return;
      const h = [...nx][0];
      if (h !== gi && groups[h].length >= 1 && mean(groups[h].map((i) => segs[i].b - segs[i].a)) > mean(g.map((i) => segs[i].b - segs[i].a))) succBonus[h] += 1.0;
    });

    let bestG = null, bestScore = -Infinity;
    groups.forEach((g, gi) => {
      const bars = g.reduce((t, i) => t + segs[i].b - segs[i].a, 0);
      const hi = g.reduce((t, i) => t + segs[i].hi * (segs[i].b - segs[i].a), 0) / bars;
      let near = 0, pc = 0;
      for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) { near += sim[g[x]][g[y]]; pc++; }
      near = pc ? near / pc : 0;
      const avgLen = bars / g.length;
      let score = hi
        + (g.length >= 2 ? 0.8 + 0.8 * Math.max(0, near - 0.5) : 0)
        + 0.12 * Math.min(g.length, 4)
        + Math.min(0.5, bars / n * 1.5)
        + succBonus[gi]
        - (buildGroup[gi] ? 2.0 : 0)
        - (avgLen < 4 ? 0.6 : 0)
        - (g.includes(0) && g.length === 1 ? 0.8 : 0);       // 只出现一次、又在开头：多半是前奏
      if (g.every((i) => i === 0 || i === m - 1) && g.length === 1) score -= 0.5;
      if (score > bestScore) { bestScore = score; bestG = g; }
    });
    for (const i of bestG) segs[i].label = 'chorus';
    // 与副歌原型高度相似、且不低于副歌水平的其它段，也算副歌（变奏 / 尾部重复）
    const proto = new Array(D).fill(0);
    let pw = 0;
    for (const i of bestG) { const w = segs[i].b - segs[i].a; segs[i].vec.forEach((v, d) => { proto[d] += v * w; }); pw += w; }
    for (let d = 0; d < D; d++) proto[d] /= pw;
    const chorusHi = mean(bestG.map((i) => segs[i].hi));
    for (const s of segs) {
      if (s.label !== 'chorus' && cosine(s.vec, proto) > 0.8 && s.hi >= chorusHi - 0.3) s.label = 'chorus';
    }

    const energies = segs.map((s) => s.energy), medE = median(energies);
    const first = segs[0], last = segs[m - 1];
    if (first.label !== 'chorus' && (first.hi < 0 || first.b - first.a <= 8)) first.label = 'intro';
    if (last.label !== 'chorus' && m > 2 && (last.energy < segs[m - 2].energy - 1.5 || last.energy < medE - 2 || last.hi < segs[m - 2].hi - 0.4)) last.label = 'outro';

    const firstChorus = segs.findIndex((s) => s.label === 'chorus');
    for (let i = 1; i < m - 1; i++) {
      const s = segs[i];
      if (s.label !== 'verse') continue;
      // 铺垫段：紧挨副歌之前、较短、且能量或密度在段内上升
      const half = Math.max(1, (s.b - s.a) >> 1);
      const rise = mean(energy, s.a + half, s.b) - mean(energy, s.a, s.a + half);
      const riseD = extra ? mean(extra.dens, s.a + half, s.b) - mean(extra.dens, s.a, s.a + half) : 0;
      if (segs[i + 1].label === 'chorus' && s.b - s.a <= 8 && (rise > 1 || riseD > 0.15 || s.rising)) s.label = 'build';
      else if (firstChorus >= 0 && i > firstChorus && s.hi < -0.3 && groups.every((g) => !(g.includes(i) && g.length > 1))) s.label = 'bridge';
    }
    refineChorusStarts(segs, feats, proto);

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

  /**
   * 副歌起点微调：在 ±2 小节内选一个边界，使「边界之后 4 小节更像副歌原型、之前 4 小节更不像」。
   * 起点（TrackDrop / PostDrop）必须落在正确的小节上，所以只动「非副歌 → 副歌」的边界。
   */
  function refineChorusStarts(segs, feats, proto) {
    const n = feats.length;
    const simTo = (i) => (i >= 0 && i < n ? cosine(feats[i], proto) : null);
    for (let k = 1; k < segs.length; k++) {
      if (segs[k].label !== 'chorus' || segs[k - 1].label === 'chorus') continue;
      const cur = segs[k].a;
      let best = -Infinity, bb = cur;
      for (let d = -2; d <= 2; d++) {
        const b = cur + d;
        if (b - segs[k - 1].a < 2 || segs[k].b - b < 4) continue;
        let after = 0, ac = 0, before = 0, bc = 0;
        for (let j = 0; j < 4; j++) { const v = simTo(b + j); if (v != null) { after += v; ac++; } }
        for (let j = 1; j <= 4; j++) { const v = simTo(b - j); if (v != null) { before += v; bc++; } }
        const sc = (ac ? after / ac : 0) - (bc ? before / bc : 0) - 0.03 * Math.abs(d);
        if (sc > best) { best = sc; bb = b; }
      }
      if (bb !== cur) { segs[k].a = bb; segs[k - 1].b = bb; }
    }
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
    progress && progress(0.02, '准备');
    const F = computeFrameFeatures(mono, sr, progress);
    progress && progress(0.52, '估计速度');
    let bpm = opts.bpmHint || estimateTempo(F.onset, F.fps);
    const fine = fineOnsetEnvelope(mono, sr);
    let beats, grid = null, constantTempo = false;
    // 先试整首歌一条恒速网格（共用一个相位），再用高分辨率起音包络回归出精确周期，并检验是否真的恒速
    const toSample = (t) => (t * F.hop + F.nfft / 2 - F.hop / 2) * F.decim;
    const gg = searchGlobalGrid(F.onset, F.fps, bpm);
    const coarse = gridBeats(toSample(gg.ph), gg.L * F.hop * F.decim, length);
    let fit = fitConstantGrid(refineBeatsToOnsets(coarse, fine, sr * 0.03));
    if (fit && !(verifyGrid(gridBeats(fit.t0, fit.period, length), fine, sr).ok && fit.residualStd < fit.period * 0.06)) fit = null;
    progress && progress(0.62, '节拍对齐');
    if (fit) {
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
      // 速度漂移 / 变速：用随时间变化的期望拍长做动态规划
      const tb = trackBeats(F.onset, F.fps, localPeriods(F.onset, F.fps, bpm));
      const rawBeats = tb.beats.map((f) => F.frameToSample(f));
      beats = refineBeatsToOnsets(rawBeats, fine, sr * 0.015);
      if (beats.length > 1) bpm = 60 * sr / median(beats.slice(1).map((b, i) => b - beats[i]));
    }
    progress && progress(0.7, '识别小节');
    const metre = analyzeMetre(F, beats, opts.beatsPerBar, bpm);
    const beatsPerBar = metre.beatsPerBar, phase = metre.phase;
    const downbeats = [];
    for (let i = phase; i < beats.length; i += beatsPerBar) downbeats.push(beats[i]);
    // 小节序列：从 0 开始（补一个 0 号伪小节以覆盖前奏前的空白）
    const bars = downbeats.slice();
    if (!bars.length || bars[0] > sr * 0.5) bars.unshift(0);
    progress && progress(0.78, '段落分割');
    const bf = barFeatures(F, bars, length);
    const segBars = segmentBars(bf.feats, bf.energy, { phraseOffset: bars[0] === 0 && downbeats[0] !== 0 ? 1 : 0 });
    progress && progress(0.9, '段落标注');
    const labeled = labelSegments(segBars, bf.feats, bf.energy, bf);
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
      beats, downbeats, beatsPerBar, bars, metreScores: metre.scores, chordRatio: metre.chordRatio,
      barFeats: bf.feats, barEnergy: bf.energy,
      sections, markers, loopsTrack, loopsPost,
    };
  }

  return {
    analyze, deriveMarkers, findLoopCandidates, alignLoopEndToBars, gridBeats,
    _internal: { fftInPlace, computeFrameFeatures, tempoCandidates, estimateTempo, trackBeats, fitConstantGrid, segmentBars, labelSegments },
  };
}

if (typeof module !== 'undefined') module.exports = HRAnalysisModule;
