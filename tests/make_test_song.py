"""生成一首结构已知的合成测试歌曲（48kHz 立体声 16-bit WAV），用于验证自动识别。

结构 (128 BPM, 4/4)，开头有 0.3 秒静音：
intro 8 | verse 16 | build 8 | chorus 16 | verse 16 | build 8 | chorus 16 | bridge 8 | chorus 16 | outro 8
"""
import json
import sys
import wave

import numpy as np

SR = 48000
BPM = 128.0
OFFSET = 0.3
STRUCTURE = [("intro", 8), ("verse", 16), ("build", 8), ("chorus", 16), ("verse", 16),
             ("build", 8), ("chorus", 16), ("bridge", 8), ("chorus", 16), ("outro", 8)]

beat = 60.0 / BPM
bar = beat * 4
total_bars = sum(n for _, n in STRUCTURE)
dur = OFFSET + total_bars * bar + 1.0
N = int(dur * SR)
out = np.zeros(N)
rng = np.random.default_rng(1)


def add(sig, t):
    i = int(round(t * SR))
    j = min(N, i + len(sig))
    if i < N:
        out[i:j] += sig[: j - i]


def kick():
    t = np.arange(int(0.25 * SR)) / SR
    f = 50 + 120 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 12)


def hat():
    t = np.arange(int(0.05 * SR)) / SR
    n = rng.standard_normal(len(t))
    n = np.diff(n, prepend=0)
    return n * np.exp(-t * 80) * 0.15


def snare():
    t = np.arange(int(0.15 * SR)) / SR
    return (rng.standard_normal(len(t)) * 0.4 + np.sin(2 * np.pi * 190 * t) * 0.4) * np.exp(-t * 25)


def tone(freqs, length, amp, saw=False):
    t = np.arange(int(length * SR)) / SR
    s = np.zeros_like(t)
    for f in freqs:
        if saw:
            for h in range(1, 8):
                s += np.sin(2 * np.pi * f * h * t) / h
        else:
            s += np.sin(2 * np.pi * f * t)
    env = np.minimum(1, t / 0.01) * np.minimum(1, (length - t) / 0.02)
    return s * env * amp / len(freqs)


def midi(m):
    return 440 * 2 ** ((m - 69) / 12)


VERSE_CH = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]   # Am F C G
CHORUS_CH = [[53, 57, 60], [55, 59, 62], [52, 55, 59], [57, 60, 64]]  # F G Em Am
truth = []
t = OFFSET
for name, nbars in STRUCTURE:
    truth.append({"label": name, "start": int(round(t * SR)), "bars": nbars})
    for b in range(nbars):
        bt = t + b * bar
        ch = (CHORUS_CH if name == "chorus" else VERSE_CH)[b % 4]
        if name in ("intro", "bridge", "outro"):
            add(tone([midi(m) for m in ch], bar, 0.15), bt)
            if name != "bridge":
                for k in range(4):
                    add(kick() * 0.5, bt + k * beat)
        elif name == "verse":
            add(tone([midi(m) for m in ch], bar, 0.18), bt)
            for k in range(4):
                add(kick() * 0.8, bt + k * beat)
                add(tone([midi(ch[0] - 24)], beat * 0.9, 0.35, saw=True), bt + k * beat)
            for k in (1, 3):
                add(snare() * 0.5, bt + k * beat)
        elif name == "build":
            add(tone([midi(m) for m in ch], bar, 0.2 + 0.02 * b), bt)
            for k in range(8 if b < 6 else 16):
                add(snare() * (0.3 + 0.05 * b), bt + k * bar / (8 if b < 6 else 16))
        elif name == "chorus":
            add(tone([midi(m + 12) for m in ch], bar, 0.3, saw=True), bt)
            for k in range(4):
                add(kick(), bt + k * beat)
                add(tone([midi(ch[0] - 24)], beat * 0.9, 0.5, saw=True), bt + k * beat)
            for k in (1, 3):
                add(snare() * 0.8, bt + k * beat)
            for k in range(8):
                add(hat(), bt + k * beat / 2)
    t += nbars * bar

out /= np.max(np.abs(out)) * 1.1
pcm = (np.stack([out, out * 0.98], axis=1) * 32767).astype("<i2")
path = sys.argv[1] if len(sys.argv) > 1 else "test_song.wav"
with wave.open(path, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
json.dump({"bpm": BPM, "offsetSamples": int(OFFSET * SR), "length": N, "sections": truth},
          open(path + ".truth.json", "w"), indent=1)
print(path, N, "samples")
