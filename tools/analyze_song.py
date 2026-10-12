#!/usr/bin/env python3
"""FH6 电台标记编辑器 —— 可选的离线分析脚本。

输出的 JSON 可以直接拖进编辑器（打开对应音频后），会替换节拍网格与段落。

引擎：
  allin1   使用 All-In-One Music Structure Analyzer（深度学习，能给出 intro/verse/chorus/bridge/outro 标签，
           需要 `pip install allin1`，以及 PyTorch / madmom / natten，安装较麻烦但最准）
  librosa  使用 librosa 节拍跟踪 + 自相似矩阵分段 + 能量/重复度启发式打标签（`pip install librosa`）
  auto     （默认）能导入 allin1 就用 allin1，否则用 librosa

用法：
  python analyze_song.py song.wav                 # 生成 song.analysis.json
  python analyze_song.py a.wav b.flac -o out_dir  # 批量
  python analyze_song.py song.wav --engine librosa --bpm 128

输出格式（位置均为采样点，基于 sampleRate，默认 48000，与 FH6 一致）：
{
  "file": "song.wav", "sampleRate": 48000, "length": 11417378,
  "bpm": 128.0, "beatsPerBar": 4,
  "beats": [...], "downbeats": [...],
  "sections": [{"start": 0, "end": 1234567, "label": "intro"}, ...]
}
label 可用：intro / verse / build / chorus / bridge / outro（drop、pre-chorus、inst、solo 等也会被编辑器识别）。
你也可以用自己的脚本生成同样格式的 JSON。
"""
import argparse
import json
import os
import sys

TARGET_SR = 48000


def load_audio(path, sr):
    import librosa
    y, _ = librosa.load(path, sr=sr, mono=True)
    return y


# --------------------------------------------------------------------- allin1
def analyze_allin1(path, sr, length):
    import allin1  # noqa: F401  (ImportError 时由调用方回退)
    r = allin1.analyze(path)
    beats = [int(round(t * sr)) for t in r.beats]
    downbeats = [int(round(t * sr)) for t in r.downbeats]
    sections = []
    for seg in r.segments:
        label = str(seg.label).lower()
        if label in ("start", "end") and seg.end - seg.start < 3:
            label = "intro" if label == "start" else "outro"
        sections.append({"start": int(round(seg.start * sr)), "end": int(round(seg.end * sr)), "label": label})
    return {"bpm": float(r.bpm), "beats": beats, "downbeats": downbeats, "sections": clean_sections(sections, length)}


# --------------------------------------------------------------------- librosa
def analyze_librosa(y, sr, bpm_hint=None, beats_per_bar=4):
    import numpy as np
    import librosa
    import scipy.ndimage

    hop = 512
    ana_sr = 22050
    ya = librosa.resample(y, orig_sr=sr, target_sr=ana_sr)
    onset_env = librosa.onset.onset_strength(y=ya, sr=ana_sr, hop_length=hop)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=ana_sr, hop_length=hop, start_bpm=bpm_hint or 120.0, units="frames")
    tempo = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=ana_sr, hop_length=hop)
    if len(beat_times) < 8:
        raise RuntimeError("检测到的节拍太少")

    # 恒定速度拟合（流行 / 电子音乐大多是恒速），残差小时使用规则网格
    idx = np.arange(len(beat_times))
    period, t0 = np.polyfit(idx, beat_times, 1)
    resid = beat_times - (t0 + period * idx)
    if np.std(resid) < period * 0.06:
        t0, period = refine_grid(y, sr, t0, period)
        first = t0 - np.floor(t0 / period) * period
        beat_times = np.arange(first, len(y) / sr, period)
        tempo = 60.0 / period

    # 选强拍相位：低频起音最强的相位
    S = np.abs(librosa.stft(ya, n_fft=2048, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=ana_sr, n_fft=2048)
    low = S[freqs < 150].sum(axis=0)
    low_flux = np.maximum(0, np.diff(np.log1p(low), prepend=0))
    bf = np.clip(librosa.time_to_frames(beat_times, sr=ana_sr, hop_length=hop), 0, len(low_flux) - 1)
    low_peak = scipy.ndimage.maximum_filter1d(low_flux, size=3)
    chroma = librosa.feature.chroma_stft(S=S ** 2, sr=ana_sr)
    # pad=False：第 i 列正好对应 [bf[i], bf[i+1]) 这一拍
    sync_chroma = librosa.util.sync(chroma, np.r_[bf, chroma.shape[1]], aggregate=np.median, pad=False)
    chg = np.r_[0, 1 - np.sum(librosa.util.normalize(sync_chroma[:, 1:], axis=0) *
                             librosa.util.normalize(sync_chroma[:, :-1], axis=0), axis=0)]
    chg = chg[: len(bf)]
    z = lambda a: (a - a.mean()) / (a.std() + 1e-9)  # noqa: E731
    cue = z(low_peak[bf]) + z(np.pad(chg, (0, max(0, len(bf) - len(chg)))))
    phase = int(np.argmax([cue[p::beats_per_bar].mean() for p in range(beats_per_bar)]))
    downbeat_times = beat_times[phase::beats_per_bar]

    # 小节级特征：chroma + MFCC + 响度
    bars = np.r_[0.0, downbeat_times] if downbeat_times[0] > 0.5 else downbeat_times
    bar_frames = np.clip(librosa.time_to_frames(bars, sr=ana_sr, hop_length=hop), 0, S.shape[1] - 1)
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(librosa.feature.melspectrogram(S=S ** 2, sr=ana_sr)), n_mfcc=13)[1:]
    rms = librosa.feature.rms(S=S)[0]
    feat = np.vstack([librosa.util.normalize(chroma, axis=0), mfcc])
    bar_idx = np.r_[bar_frames, S.shape[1]]
    bar_feat = librosa.util.sync(feat, bar_idx, aggregate=np.mean, pad=False)[:, : len(bars)]
    bar_energy = 20 * np.log10(librosa.util.sync(rms[None], bar_idx, aggregate=np.mean, pad=False)[0, : len(bars)] + 1e-9)
    bar_feat = (bar_feat - bar_feat.mean(axis=1, keepdims=True)) / (bar_feat.std(axis=1, keepdims=True) + 1e-9)
    n = bar_feat.shape[1]

    # 自相似矩阵 + 棋盘核新颖度
    X = librosa.util.normalize(bar_feat, axis=0)
    R = X.T @ X
    K = 4
    g = np.exp(-0.5 * (np.arange(-K, K) + 0.5) ** 2 / (K * K * 0.5))
    kern = np.outer(g, g) * np.sign(np.outer(np.r_[-np.ones(K), np.ones(K)], np.r_[-np.ones(K), np.ones(K)]))
    Rp = np.pad(R, K, mode="edge")
    nov = np.array([np.sum(kern * Rp[i:i + 2 * K, i:i + 2 * K]) for i in range(n)])
    enov = np.array([abs(bar_energy[i:i + 4].mean() - bar_energy[max(0, i - 4):i].mean()) if i > 0 else 0 for i in range(n)])
    score = z(nov) + 0.6 * z(enov)
    peaks = [i for i in range(2, n - 1) if score[i] == score[max(0, i - 2):i + 3].max() and score[i] > 0.6]
    off = 1 if bars[0] == 0 and downbeat_times[0] > 0.5 else 0
    peaks.sort(key=lambda i: -(score[i] + (0.5 if (i - off) % 4 == 0 else 0)))
    chosen = [0]
    for p in peaks:
        if len(chosen) >= max(2, n // 6):
            break
        if all(abs(p - c) >= 4 for c in chosen):
            chosen.append(p)
    chosen.sort()

    # 段落标签：聚类 + 能量
    segs = []
    for k, a in enumerate(chosen):
        b = chosen[k + 1] if k + 1 < len(chosen) else n
        segs.append({"a": a, "b": b, "vec": bar_feat[:, a:b].mean(axis=1),
                     "energy": 10 * np.log10(np.mean(10 ** (bar_energy[a:b] / 10)))})
    labels = cluster_and_label(segs, bar_energy)

    length = len(y)
    sections = []
    for s, lab in zip(segs, labels):
        start = 0 if s["a"] == 0 else int(round(bars[s["a"]] * sr))
        end = length if s["b"] >= len(bars) else int(round(bars[s["b"]] * sr))
        sections.append({"start": start, "end": end, "label": lab})
    return {
        "bpm": tempo,
        "beats": [int(round(t * sr)) for t in beat_times],
        "downbeats": [int(round(t * sr)) for t in downbeat_times],
        "sections": clean_sections(sections, length),
    }


def fine_onset_envelope(y, sr, hop_sec):
    """高时间分辨率起音包络：预加重后的对数能量差分。返回 (env, 帧->秒函数)"""
    import numpy as np
    hop = max(16, int(round(sr * hop_sec)))
    win = hop * 4
    d = np.r_[0, y[1:] - 0.95 * y[:-1]] ** 2
    c = np.r_[0, np.cumsum(d)]
    n = max(1, (len(y) - win) // hop + 1)
    starts = np.arange(n) * hop
    e = (c[starts + win] - c[starts]) / win
    le = 10 * np.log10(e + 1e-10)
    env = np.maximum(0, np.diff(le, prepend=le[0]))
    # 能量跳变最大的帧，是起音刚进入窗口尾部的那一帧
    return env, (lambda f: (f * hop + win - hop / 2) / sr), hop, win


def refine_grid(y, sr, t0, period):
    """把恒速网格对齐到采样级：先整体平移，再对每拍真实起音做回归。"""
    import numpy as np
    dur = len(y) / sr
    env, f2t, hop, win = fine_onset_envelope(y, sr, 0.00266)
    t2f = lambda t: np.round((t * sr - win + hop / 2) / hop).astype(int)  # noqa: E731
    k = np.arange(np.ceil(-t0 / period), np.floor((dur - t0) / period))
    best, best_sh = -1, 0.0
    for sh in np.arange(-period * 0.12, period * 0.12, hop / 2 / sr):
        f = t2f(t0 + sh + k * period)
        f = f[(f >= 1) & (f < len(env) - 1)]
        v = np.maximum(np.maximum(env[f - 1], env[f]), env[f + 1]).sum()
        if v > best:
            best, best_sh = v, sh
    t0 += best_sh
    env2, f2t2, hop2, win2 = fine_onset_envelope(y, sr, 0.0007)
    r = int(np.ceil(0.004 * sr / hop2))
    pts, ids = [], []
    for kk in k:
        t = t0 + kk * period
        f0 = int(round((t * sr - win2 + hop2 / 2) / hop2))
        lo, hi = max(0, f0 - r), min(len(env2), f0 + r + 1)
        if hi <= lo:
            continue
        j = lo + int(np.argmax(env2[lo:hi]))
        if env2[j] > 0:
            pts.append(f2t2(j))
            ids.append(kk)
    if len(pts) > 16:
        p2, t02 = np.polyfit(ids, pts, 1)
        if abs(p2 / period - 1) < 0.002:
            return t02, p2
    return t0, period


def cluster_and_label(segs, bar_energy):
    import numpy as np
    m = len(segs)
    if m == 1:
        return ["chorus"]
    cos = lambda a, b: float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))  # noqa: E731
    parent = list(range(m))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(m):
        for j in range(i + 1, m):
            if cos(segs[i]["vec"], segs[j]["vec"]) > 0.55:
                parent[find(i)] = find(j)
    clusters = {}
    for i in range(m):
        clusters.setdefault(find(i), []).append(i)
    e = np.array([s["energy"] for s in segs])
    rel = (e - e.min()) / (e.max() - e.min() + 1e-9)
    med = float(np.median(e))
    best = max(clusters.values(), key=lambda c: rel[c].mean() * 1.6 + (0.35 if len(c) >= 2 else 0) + min(0.3, 0.05 * len(c)))
    labels = ["verse"] * m
    for i in best:
        labels[i] = "chorus"
    ce = e[best].mean()
    for i in range(m):
        if labels[i] != "chorus" and e[i] >= ce - 0.8 and e[i] >= med:
            labels[i] = "chorus"
    if labels[0] != "chorus" and (e[0] < med - 1 or segs[0]["b"] - segs[0]["a"] <= 8):
        labels[0] = "intro"
    if m > 2 and labels[-1] != "chorus" and (e[-1] < e[-2] - 1.5 or e[-1] < med - 2):
        labels[-1] = "outro"
    first_chorus = labels.index("chorus") if "chorus" in labels else -1
    for i in range(1, m - 1):
        if labels[i] != "verse":
            continue
        s = segs[i]
        half = max(1, (s["b"] - s["a"]) // 2)
        rise = bar_energy[s["a"] + half:s["b"]].mean() - bar_energy[s["a"]:s["a"] + half].mean()
        quiet = e[i] < med - 2.5
        if labels[i + 1] == "chorus" and s["b"] - s["a"] <= 8 and (rise > 1 or not quiet):
            labels[i] = "build"
        elif 0 <= first_chorus < i and quiet:
            labels[i] = "bridge"
    return labels


def clean_sections(sections, length):
    sections = sorted((s for s in sections if s["end"] > s["start"]), key=lambda s: s["start"])
    merged = []
    for s in sections:
        if merged and merged[-1]["label"] == s["label"]:
            merged[-1]["end"] = s["end"]
        else:
            merged.append(dict(s))
    if merged:
        merged[0]["start"] = 0
        merged[-1]["end"] = length
        for a, b in zip(merged, merged[1:]):
            a["end"] = b["start"]
    return merged


def main():
    ap = argparse.ArgumentParser(description="为 FH6 电台标记编辑器生成节拍 / 段落分析 JSON")
    ap.add_argument("files", nargs="+")
    ap.add_argument("-o", "--out", help="输出目录（默认与音频同目录）")
    ap.add_argument("--engine", choices=["auto", "allin1", "librosa"], default="auto")
    ap.add_argument("--bpm", type=float, help="速度提示（librosa 引擎）")
    ap.add_argument("--sr", type=int, default=TARGET_SR, help="输出位置所用的采样率，默认 48000")
    args = ap.parse_args()

    for path in args.files:
        y = load_audio(path, args.sr)
        length = len(y)
        result = None
        engine = args.engine
        if engine in ("auto", "allin1"):
            try:
                result = analyze_allin1(path, args.sr, length)
                engine = "allin1"
            except ImportError:
                if args.engine == "allin1":
                    sys.exit("未安装 allin1：pip install allin1（另需 PyTorch、madmom、natten）")
                engine = "librosa"
        if result is None:
            result = analyze_librosa(y, args.sr, args.bpm)
        out = {"file": os.path.basename(path), "sampleRate": args.sr, "length": length,
               "engine": engine, "beatsPerBar": 4, **result}
        out_dir = args.out or os.path.dirname(os.path.abspath(path))
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, os.path.splitext(os.path.basename(path))[0] + ".analysis.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        labels = " | ".join(f"{s['label']}@{s['start'] / args.sr:.1f}s" for s in out["sections"])
        print(f"[{engine}] {os.path.basename(path)}: {out['bpm']:.2f} BPM, {len(out['sections'])} 段 -> {out_path}")
        print("   ", labels)


if __name__ == "__main__":
    main()
