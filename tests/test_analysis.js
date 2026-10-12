// 用合成歌曲验证 analysis.js：node tests/test_analysis.js <wav>
const fs = require('fs');
const path = require('path');
const HR = require('../web/analysis.js')();

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

const wav = process.argv[2];
const truth = JSON.parse(fs.readFileSync(wav + '.truth.json'));
const { mono, sr } = readWav(wav);
const t0 = Date.now();
const r = HR.analyze(mono, sr);
const ms = Date.now() - t0;
console.log(`time ${ms}ms  bpm ${r.bpm.toFixed(3)} (truth ${truth.bpm})  constant=${r.constantTempo}`);
const period = sr * 60 / truth.bpm;
const errs = r.beats.slice(4, -4).map((b) => {
  const k = Math.round((b - truth.offsetSamples) / period);
  return b - (truth.offsetSamples + k * period);
});
const maxErr = Math.max(...errs.map(Math.abs));
console.log(`beat mean error ${(errs.reduce((a,b)=>a+b,0)/errs.length).toFixed(1)} samples`);
console.log(`beat max error ${maxErr.toFixed(0)} samples (${(maxErr / sr * 1000).toFixed(2)} ms)`);
const barP = period * 4;
const dbOk = r.downbeats.slice(1, -1).every((d) => {
  const k = (d - truth.offsetSamples) / barP;
  return Math.abs(k - Math.round(k)) < 0.05;
});
console.log('downbeats on true bar lines:', dbOk);
console.log('detected sections:');
for (const s of r.sections) console.log(`  ${s.label.padEnd(7)} ${(s.start / sr).toFixed(2).padStart(7)}s - ${(s.end / sr).toFixed(2).padStart(7)}s  ${s.energy.toFixed(1)}dB`);
console.log('truth sections:');
for (const s of truth.sections) console.log(`  ${s.label.padEnd(7)} ${(s.start / sr).toFixed(2).padStart(7)}s`);
console.log('markers:', Object.fromEntries(Object.entries(r.markers).map(([k, v]) => [k, (v / sr).toFixed(2) + 's'])));
console.log('loop candidates (TrackLoop):', r.loopsTrack.slice(0, 3).map((c) => `${(c.start / sr).toFixed(2)}-${(c.end / sr).toFixed(2)} (${c.bars} bars, ${c.score.toFixed(2)})`));

let fail = false;
if (Math.abs(r.bpm - truth.bpm) > 0.1) { console.error('FAIL bpm'); fail = true; }
if (maxErr > sr * 0.005) { console.error('FAIL beat alignment'); fail = true; }
if (!dbOk) { console.error('FAIL downbeats'); fail = true; }
const choruses = truth.sections.filter((s) => s.label === 'chorus');
const firstChorus = choruses[0].start;
if (Math.abs(r.markers.TrackDrop - firstChorus) > sr * 0.05) { console.error('FAIL TrackDrop not at first chorus'); fail = true; }
process.exit(fail ? 1 : 0);
