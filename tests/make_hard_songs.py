"""生成一批「困难」合成测试歌曲（48kHz 立体声 16-bit WAV）和精确真值，用于 tests/eval.js。

用法：python3 tests/make_hard_songs.py <输出目录> [用例名 ...]

每首歌写出 <name>.wav 和 <name>.wav.truth.json，真值包括：
  bpm（主导速度）、beatsPerBar、beats、downbeats、sections（label/start/end/bars）、
  choruses（副歌 / drop 起点）、loops（已知无缝循环：起止点前后的音频逐采样一致）。
本脚本只用 numpy，音频不要提交进仓库。
"""
import json
import math
import os
import sys
import wave

import numpy as np

SR = 48000


def midi(m):
    return 440 * 2 ** ((m - 69) / 12)


VERSE_CH = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]    # Am F C G
CHORUS_CH = [[53, 57, 60], [55, 59, 62], [52, 55, 59], [57, 60, 64]]   # F G Em Am
BRIDGE_CH = [[50, 53, 57], [46, 50, 53], [48, 52, 55], [55, 58, 62]]   # Dm Bb C G
EXTRA_CH = [  # 「无副歌」用例里每段都用不同的和弦循环
    [[57, 60, 64], [52, 55, 59], [53, 57, 60], [55, 59, 62]],
    [[50, 53, 57], [55, 59, 62], [48, 52, 55], [52, 56, 59]],
    [[60, 64, 67], [58, 62, 65], [56, 60, 63], [55, 58, 62]],
    [[62, 66, 69], [59, 62, 66], [55, 59, 62], [57, 61, 64]],
    [[45, 49, 52], [47, 51, 54], [49, 53, 56], [52, 56, 59]],
    [[53, 56, 60], [51, 55, 58], [49, 52, 56], [46, 50, 53]],
    [[64, 67, 71], [62, 65, 69], [60, 64, 67], [59, 62, 66]],
]

S4 = [("intro", 8), ("verse", 16), ("build", 8), ("chorus", 16), ("verse", 16),
      ("build", 8), ("chorus", 16), ("bridge", 8), ("chorus", 16), ("outro", 8)]
S4_HALF = [("intro", 4), ("verse", 8), ("build", 4), ("chorus", 12), ("verse", 8),
           ("build", 4), ("chorus", 12), ("bridge", 4), ("chorus", 12), ("outro", 4)]
S_FADE = [("intro", 8), ("verse", 16), ("build", 8), ("chorus", 16), ("verse", 16),
          ("build", 8), ("chorus", 16), ("chorus", 16)]
S_EDM = [("intro", 8), ("build", 8), ("drop", 16), ("bridge", 8), ("build", 8), ("drop", 16),
         ("bridge", 8), ("build", 8), ("drop", 16), ("outro", 8)]
S_V3 = [("intro", 8), ("verse", 16), ("build", 8), ("chorus", 16), ("verse", 16), ("verse", 16),
        ("build", 8), ("chorus", 16), ("outro", 8)]
S_NOCH = [("part0", 8), ("part1", 8), ("part2", 8), ("part3", 8), ("part4", 8), ("part5", 8), ("part6", 8)]

CASES = {
    'base128':  dict(bpm=128, S=S4),
    'slow72':   dict(bpm=72, S=S4_HALF, kick=[0, 2], snare=[1, 3]),
    'dnb180':   dict(bpm=180, S=S4, kick=[0, 2.5], snare=[1, 3], sub=4),
    'swing110': dict(bpm=110, S=S4, swing=True),
    'sync100':  dict(bpm=100, S=S4, kick=[0, 1.5, 2.5, 3.5]),
    'waltz96':  dict(bpm=96, bpb=3, S=S4, kick=[0], snare=[1, 2]),
    'six8_75':  dict(bpm=75, bpb=2, sub=3, S=S4_HALF, kick=[0], snare=[1]),
    'pickup120': dict(bpm=120, S=S4, pickup=1.0),
    'silence124': dict(bpm=124, S=S4, offset=2.5),
    'drift112': dict(bpm=112, S=S4, drift=0.03),
    'tempochg':  dict(bpm=100, S=S4, tempo_change=(4, 115)),
    'fadeout118': dict(bpm=118, S=S_FADE, fade=True),
    'compressed126': dict(bpm=126, S=S4, compress=True),
    'edm128':   dict(bpm=128, S=S_EDM, edm=True),
    'nochorus120': dict(bpm=120, S=S_NOCH, nochorus=True),
    'quietchorus116': dict(bpm=116, S=S4, chorus_gain=0.5),
    'verse3comp122': dict(bpm=122, S=S_V3, compress=True),
}

_rng = np.random.default_rng(7)
NOISE = _rng.standard_normal(SR * 4)   # 固定噪声：鼓点在每次出现时逐采样一致，循环才是真正无缝的
_cache = {}


def cached(key, fn):
    if key not in _cache:
        _cache[key] = fn()
    return _cache[key]


def kick():
    def f():
        t = np.arange(int(0.25 * SR)) / SR
        fr = 50 + 120 * np.exp(-t * 30)
        return np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t * 12)
    return cached('kick', f)


def hat():
    def f():
        t = np.arange(int(0.05 * SR)) / SR
        return np.diff(NOISE[:len(t)], prepend=0) * np.exp(-t * 80) * 0.15
    return cached('hat', f)


def snare():
    def f():
        t = np.arange(int(0.15 * SR)) / SR
        return (NOISE[1000:1000 + len(t)] * 0.4 + np.sin(2 * np.pi * 190 * t) * 0.4) * np.exp(-t * 25)
    return cached('snare', f)


def tone(freqs, length, amp, saw=False):
    n = int(length * SR)

    def f():
        t = np.arange(n) / SR
        s = np.zeros_like(t)
        for fr in freqs:
            if saw:
                for h in range(1, 8):
                    s += np.sin(2 * np.pi * fr * h * t) / h
            else:
                s += np.sin(2 * np.pi * fr * t)
        env = np.minimum(1, t / 0.01) * np.minimum(1, (length - t) / 0.02)
        return s * env / len(freqs)
    return cached(('tone', tuple(round(x, 3) for x in freqs), n, saw), f) * amp


def build_beat_times(case, n_beats):
    """每一拍的时间（秒）；tempo 函数以「拍序号」为变量，周期性的漂移保证每 4 小节逐采样重复。"""
    bpb = case.get('bpb', 4)
    bpm = case['bpm']
    t = [case.get('offset', 0.3)]
    for b in range(n_beats + 8):
        tempo = bpm
        if case.get('drift'):
            tempo = bpm * (1 + case['drift'] * math.sin(2 * math.pi * b / (4 * bpb)))
        if case.get('tempo_change') and b >= case['tempo_change'][0] * bpb + 0:
            tempo = case['tempo_change'][1]
        t.append(t[-1] + 60.0 / tempo)
    return np.array(t)


def render(name, case, outdir):
    bpb = case.get('bpb', 4)
    sub = case.get('sub', 2)
    pickup = case.get('pickup', 0.0)
    swing = case.get('swing', False)
    kicks = case.get('kick', [i for i in range(bpb)])
    snares = case.get('snare', [1, 3] if bpb == 4 else [1])
    structure = case['S']
    total_bars = sum(n for _, n in structure)
    # tempo_change 的位置按「小节」给，这里换算成拍序号：放在 verse2 起点
    case = dict(case)
    if case.get('tempo_change'):
        bars_before = 0
        seen_verse = 0
        for lab, nb in structure:
            if lab == 'verse':
                seen_verse += 1
                if seen_verse == 2:
                    break
            bars_before += nb
        case['tempo_change'] = (bars_before, case['tempo_change'][1])
    n_pick = int(math.ceil(pickup))
    n_beats = n_pick + total_bars * bpb
    bt_int = build_beat_times(case, n_beats)

    def bt(b):
        """拍位置（可为小数，0 = 第一个可听的拍）→ 秒；pickup 之后的第 0 拍 = 第一小节downbeat。"""
        b = b + n_pick
        i = int(math.floor(b))
        return bt_int[i] + (b - i) * (bt_int[i + 1] - bt_int[i])

    end_t = bt(total_bars * bpb)
    N = int((end_t + 1.0) * SR)
    out = np.zeros(N)

    def add(sig, t, g=1.0):
        i = int(round(t * SR))
        j = min(N, i + len(sig))
        if 0 <= i < N:
            out[i:j] += sig[: j - i] * g

    edm = case.get('edm', False)
    sections = []
    barno = 0
    for si, (label, nbars) in enumerate(structure):
        sections.append({"label": label, "start": int(round(bt(barno * bpb) * SR)), "bars": nbars})
        for b in range(nbars):
            gb = (barno + b) * bpb       # 本小节第一拍的拍序号
            tb = bt(gb)
            bar_len = bt(gb + bpb) - tb
            beat_len = bar_len / bpb
            if case.get('nochorus'):
                cyc = EXTRA_CH[si % len(EXTRA_CH)]
            else:
                cyc = {'chorus': CHORUS_CH, 'drop': CHORUS_CH, 'bridge': BRIDGE_CH}.get(label, VERSE_CH)
            ch = cyc[b % 4]
            frac = b / max(1, nbars - 1)

            def sub_times():
                # 一拍内的细分位置（swing：二分的反拍放到三连音的 2/3）
                for k in range(bpb):
                    for s in range(sub):
                        p = s / sub
                        if swing and sub == 2 and s == 1:
                            p = 2 / 3
                        yield k + p

            if edm:
                if label == 'intro' or label == 'outro':
                    add(tone([midi(m) for m in ch], bar_len, 0.12), tb)
                    for k in range(bpb):
                        add(kick(), bt(gb + k), 0.5)
                elif label == 'bridge':
                    add(tone([midi(m) for m in ch], bar_len, 0.12), tb)
                elif label == 'build':
                    add(tone([midi(m + 12) for m in ch], bar_len, 0.2 + 0.03 * b, saw=True), tb)
                    dens = 4 if b < 3 else (8 if b < 6 else 16)
                    for k in range(dens):
                        add(snare(), bt(gb + k * bpb / dens), 0.5 + 0.06 * b)
                    for k in range(bpb):
                        add(kick(), bt(gb + k), 0.6)
                    # 上升噪声
                    seg = NOISE[:int(bar_len * SR)] * (0.2 + 0.7 * (barno_in(label, structure, si, b)))
                    seg = np.diff(seg, prepend=0)
                    add(seg, tb, 0.45)
                else:  # drop：更低的整体电平，以低频 + 稀疏为主
                    for k in range(bpb):
                        add(kick(), bt(gb + k), 0.85)
                        add(tone([midi(ch[0] - 24)], beat_len * 0.45, 0.55, saw=True), bt(gb + k + 0.5))
                    add(tone([midi(m) for m in ch], beat_len * 0.5, 0.12, saw=True), bt(gb + 1.5))
            elif label in ('intro', 'outro', 'bridge'):
                add(tone([midi(m) for m in ch], bar_len, 0.15), tb)
                if label != 'bridge':
                    for p in kicks:
                        add(kick(), bt(gb + p), 0.5)
            elif label == 'verse' or case.get('nochorus'):
                add(tone([midi(m) for m in ch], bar_len, 0.18), tb)
                for p in kicks:
                    add(kick(), bt(gb + p), 0.8)
                for k in range(bpb):
                    add(tone([midi(ch[0] - 24)], beat_len * 0.9, 0.35, saw=True), bt(gb + k))
                for p in snares:
                    add(snare(), bt(gb + p), 0.5)
                if case.get('nochorus') and si % 2:
                    for p in sub_times():
                        add(hat(), bt(gb + p), 1.0)
            elif label == 'build':
                add(tone([midi(m) for m in ch], bar_len, 0.2 + 0.02 * b), tb)
                dens = 8 if b < 6 else 16
                for k in range(dens):
                    add(snare(), bt(gb + k * bpb / dens), 0.3 + 0.05 * b)
            elif label == 'chorus':
                cg = case.get('chorus_gain', 1.0)   # <1：副歌比主歌更轻（但和弦更厚、有 hat）
                add(tone([midi(m + 12) for m in ch], bar_len, 0.3 * cg, saw=True), tb)
                add(tone([midi(m) for m in ch], bar_len, 0.15 * cg, saw=True), tb)
                for p in kicks:
                    add(kick(), bt(gb + p), 1.0 * cg)
                for k in range(bpb):
                    add(tone([midi(ch[0] - 24)], beat_len * 0.9, 0.5 * cg, saw=True), bt(gb + k))
                for p in snares:
                    add(snare(), bt(gb + p), 0.8 * cg)
                for p in sub_times():
                    add(hat(), bt(gb + p), 1.0 * cg)
        barno += nbars

    # 前奏拍（pickup）：弱起音符，只有 pickup 区间内的小鼓 / 短音
    if pickup > 0:
        for p in np.arange(-n_pick, 0, 0.5):
            if p >= -pickup:
                add(snare(), bt(p), 0.35)
                add(tone([midi(69)], 0.2, 0.2), bt(p))

    # 真值：拍 / 小节线
    beats_idx = np.arange(math.ceil(-pickup), total_bars * bpb)
    beats = [int(round(bt(float(b)) * SR)) for b in beats_idx]
    downbeats = [int(round(bt(float(b * bpb)) * SR)) for b in range(total_bars)]
    bounds = [s['start'] for s in sections] + [int(round(bt(total_bars * bpb) * SR))]
    for i, s in enumerate(sections):
        s['end'] = bounds[i + 1]

    # 母带处理
    if case.get('compress'):
        out = leveler(out, int(2 * SR * 60 / case['bpm']))
    if case.get('fade'):
        fb = 8 * bpb
        t0 = bt(total_bars * bpb - fb)
        i0 = int(t0 * SR)
        i1 = int(end_t * SR)
        ramp = np.linspace(1, 0, i1 - i0)
        out[i0:i1] *= ramp
        out[i1:] = 0
    out /= np.max(np.abs(out)) * 1.1

    # 已知无缝循环：第一段副歌内，起点 = 副歌第 4 小节，终点 = 起点 + 8（或 4）小节（和弦周期 4 小节，漂移周期也是 4 小节）
    loops = []
    for si, s in enumerate(sections):
        if s['label'] in ('chorus', 'drop') and s['bars'] >= 12:
            sb = sum(n for _, n in structure[:si])
            lb = 8 if s['bars'] >= 16 else 4
            a = int(round(bt((sb + 4) * bpb) * SR))
            z = int(round(bt((sb + 4 + lb) * bpb) * SR))
            loops.append({"start": a, "end": z, "bars": lb})
            break
    if case.get('nochorus'):
        loops = []

    pcm = (np.stack([out, out * 0.98], axis=1) * 32767).astype("<i2")
    path = os.path.join(outdir, name + '.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    ioi = np.diff(beats)
    chorus_starts = []   # 连续的副歌 / drop 只算一段，取起点
    for i, s in enumerate(sections):
        if s['label'] in ('chorus', 'drop') and (i == 0 or sections[i - 1]['label'] not in ('chorus', 'drop')):
            chorus_starts.append(s['start'])
    truth = {
        "name": name, "sr": SR, "length": int(N), "bpm": float(60 * SR / np.median(ioi)),
        "beatsPerBar": bpb, "beats": beats, "downbeats": downbeats, "sections": sections,
        "choruses": chorus_starts, "loops": loops, "flags": {k: v for k, v in case.items() if k not in ('S',)},
    }
    json.dump(truth, open(path + '.truth.json', 'w'))
    # 自检：已知循环的接缝残差
    msg = ''
    if loops:
        mono = out
        a, z = loops[0]['start'], loops[0]['end']
        n = 4800
        d = mono[a - n:a] - mono[z - n:z]
        r = 10 * math.log10((d @ d + 1e-20) / (0.5 * (mono[a - n:a] @ mono[a - n:a] + mono[z - n:z] @ mono[z - n:z]) + 1e-20))
        msg = ' truth-loop seam %.0f dB' % r
    print('%-14s %7.1fs  bpm %.2f  %s' % (name, N / SR, truth['bpm'], msg))


def barno_in(label, structure, si, b):
    return b / max(1, structure[si][1] - 1)


def leveler(x, win):
    """粗暴的「响度压平」：把每小节的 RMS 拉到同一电平，再软削波，模拟被压得很死的母带。"""
    e = np.sqrt(np.convolve(x * x, np.ones(win) / win, mode='same') + 1e-8)
    y = x / e * 0.1
    return np.tanh(3 * y) / 3


if __name__ == '__main__':
    outdir = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(outdir, exist_ok=True)
    names = sys.argv[2:] or list(CASES)
    for n in names:
        _cache.clear()
        render(n, CASES[n], outdir)
