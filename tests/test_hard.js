// 困难合成用例的回归测试：node tests/test_hard.js [输出目录]
// 需要 python3 + numpy 来生成音频（没有就跳过）；音频只写到临时目录，不会进仓库。
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'hr-hard-'));
const CASES = ['dnb180', 'waltz96', 'pickup120', 'drift112', 'tempochg', 'compressed126', 'quietchorus116', 'edm128', 'base128'];

const py = ['python3', '/usr/bin/python3'].find((p) => spawnSync(p, ['-c', 'import numpy']).status === 0);
if (!py) { console.log('SKIP: 找不到带 numpy 的 python3'); process.exit(0); }
const missing = CASES.filter((c) => !fs.existsSync(path.join(dir, c + '.wav')));
if (missing.length) {
  const g = spawnSync(py, [path.join(__dirname, 'make_hard_songs.py'), dir, ...missing], { stdio: 'inherit' });
  if (g.status !== 0) { console.error('生成失败'); process.exit(1); }
}
// 只评测这几个文件：放进子目录
const sub = path.join(dir, 'subset');
fs.mkdirSync(sub, { recursive: true });
for (const c of CASES) for (const ext of ['.wav', '.wav.truth.json']) {
  const dst = path.join(sub, c + ext);
  if (!fs.existsSync(dst)) fs.copyFileSync(path.join(dir, c + ext), dst);
}
const out = path.join(dir, 'hard.json');
const r = spawnSync('node', [path.join(__dirname, 'eval.js'), 'synth', sub, '--json', out], { stdio: 'inherit' });
if (r.status !== 0) process.exit(1);
const rows = Object.fromEntries(JSON.parse(fs.readFileSync(out)).rows.map((x) => [x.name, x]));

let fail = false;
const check = (name, cond, msg) => { if (!cond) { console.error(`FAIL ${name}: ${msg}`); fail = true; } };
check('dnb180', rows.dnb180.acc1 && rows.dnb180.beatF >= 0.95, '180 BPM 速度 / 节拍');
check('waltz96', rows.waltz96.metre && rows.waltz96.downF >= 0.95, '3/4 拍号与强拍');
check('pickup120', rows.pickup120.downF >= 0.95, '弱起后的强拍');
check('drift112', rows.drift112.beatF >= 0.9, '速度漂移时的节拍');
check('tempochg', rows.tempochg.beatF >= 0.9, '变速时的节拍');
for (const c of ['compressed126', 'quietchorus116', 'edm128', 'base128']) {
  check(c, rows[c].chorusFirst <= 0.5 && rows[c].chorusLast <= 0.5, `副歌起点误差 ${rows[c].chorusFirst} / ${rows[c].chorusLast} 小节`);
}
for (const c of ['base128', 'dnb180', 'edm128']) {
  check(c, rows[c].seamClean && rows[c].loopMusical, `循环接缝 ${rows[c].seamDb} dB，音乐性 ${rows[c].loopMusical}`);
}
console.log(fail ? 'FAILED' : 'ALL OK');
process.exit(fail ? 1 : 0);
