# Horizon6CustomRadio · FH6 电台标记编辑器

给《极限竞速：地平线 6》自定义电台歌曲打 Marker（TrackDrop / Loop / PostDrop …）的图形化工具。

和现有工具里「自己换算采样点、填数字」的方式不同，这里像非编 / AE 一样直接在**带波形的时间线**上拖动标记、切分段落，
并且可以**自动识别**节拍、小节和歌曲段落（前奏 / 主歌 / 铺垫 / 副歌 / 桥段 / 尾奏），再根据段落一键生成标记。

导出的 CSV 与 [FH6 Radio Tool](https://github.com/Disthinker/FH6_Radio_tool) 的 Marker Import 格式相同，也可以复制 RadioInfo XML 的 `<Marker>` 片段。

## 使用

不需要安装：直接用 Chrome / Edge / Firefox 打开 `web/index.html`。

1. 打开音频，或直接拖进窗口（可以一次拖入多首）。**推荐使用 48kHz WAV**，最好是 FH6 Radio Tool 处理后的那个文件，这样采样点数和游戏里完全一致。
2. 「自动识别」页 → **自动识别节拍与段落**，几秒钟后会得到：
   - 节拍网格与小节线（恒速歌曲会拟合成规则网格，并对齐到采样级；速度漂移 / 变速的歌逐拍跟踪）。每小节拍数（3 / 4 等）自动检测
   - 段落划分和类型
   - 一套建议标记：TrackDrop = 第一段副歌，TrackLoop = 第一段副歌 → 最后一段副歌结束，PostDrop / 赛后循环 = 最后一段副歌，循环长度对齐到整小节
3. 在时间线上微调：
   - 拖动标记的旗标或竖线移动它，默认吸附到节拍 / 小节和过零点，**按住 Alt 临时关闭吸附**
   - 放大后可以看到单个采样点
   - 在空白处右键可以把任意标记放到那里；数字键 `1`–`6` 把标记放到播放头位置
   - 段落轨道：`S` 在播放头切分，右键 / 双击改类型，拖动分界线调整；改完点「由段落生成标记」
4. 「标记」页 → **试听**：「循环衔接」会从循环终点前 4 秒开始播放、跨过跳转点，用来听接缝是否自然；也可以模拟比赛开始（从 TrackDrop 播放）和冲线（从 PostDrop 播放）。
5. 「自动识别」页的**循环点候选**会在小节线上搜索「跳转前后听起来相似」的起止点，并在波形层面评估接缝（游戏从 End 硬跳回 Start，没有交叉淡化）：终点会按互相关微调到最吻合的采样点，列表里显示接缝残差（dB，越低越好）。可以逐个试听再应用。起止点吸附过零点时是成对平移的，不会破坏微调出来的精确循环长度。
6. **导出 CSV** → 在 FH6 Radio Tool 里导入；或点 **XML 片段** 复制 `<Marker Name=".." Position=".." />`。

右侧的校验区会提示常见问题：循环终点早于起点、TrackDrop 在 TrackLoopEnd 之后、循环长度不是整小节等。

标记和段落会按「文件名 + 采样点数」自动保存在浏览器本地，下次打开同一首歌时会自动恢复。也可以用 **导出项目** 保存成 JSON 文件，之后再导入接着改。

### 快捷键

| 按键 | 作用 |
| --- | --- |
| 空格 | 播放 / 暂停 |
| ← / → | 播放头移动一拍（Shift：一小节） |
| 1 – 6 | 把 TrackDrop、TrackLoopStart、TrackLoopEnd、PostDrop、PostRaceLoopStart、PostRaceLoopEnd 放到播放头 |
| [ / ] | 选中的标记移动一拍（Alt：±10 采样点） |
| S | 在播放头切分段落 |
| L | 试听 TrackLoop 衔接 |
| Delete | 清除选中标记 / 删除选中的段落分界 |
| Ctrl+Z / Ctrl+Shift+Z | 撤销 / 重做 |
| Ctrl+滚轮、+ / -、0 | 缩放 / 显示全部 |

## 标记说明

| 标记 | 含义 |
| --- | --- |
| TrackStart | 歌曲开始，通常为 0 |
| TrackDrop | 比赛开始时切入的高潮位置（第一段副歌 / Drop） |
| TrackLoopStart / TrackLoopEnd | 普通播放 / 比赛中的循环段，播到 End 跳回 Start |
| PostDrop | 冲线 / 赛后切入的高潮位置 |
| PostRaceLoopStart / PostRaceLoopEnd | 赛后循环段 |
| End | 最后一个采样点（SampleLength − 1） |
| DJDrop / DJSegment / DJStart / StingerStart | DJ 语音与转场。留空 = 自动（由 FH6 Radio Tool 推导），也可以设为 DISABLE |

这些含义来自社区工具和测试经验（参考 FH6 Radio Tool 的 Marker 文档），具体效果请以游戏内实测为准。

## 更准确的段落识别（可选）

内置识别用的是传统信号处理方法（谱通量节拍跟踪 + 自相似矩阵分段 + 能量 / 重复度打标签），不需要安装任何东西。
需要更准确的段落标签时，可以运行离线脚本，把生成的 `*.analysis.json` 拖进编辑器：

```bash
pip install librosa
python tools/analyze_song.py song.wav            # 生成 song.analysis.json
python tools/analyze_song.py *.wav -o analysis/  # 批量
```

如果装了 [allin1](https://github.com/mir-aidj/all-in-one)（深度学习的音乐结构分析，需要 PyTorch），脚本会自动改用它，能直接给出 intro / verse / chorus / bridge / outro 标签。

JSON 格式很简单，也可以用自己的脚本生成：

```json
{
  "file": "song.wav", "sampleRate": 48000, "length": 11417378, "bpm": 128.0,
  "beats": [14400, 36900, ...], "downbeats": [14400, 104400, ...],
  "sections": [{"start": 0, "end": 734400, "label": "intro"}, {"start": 734400, "end": 2174400, "label": "verse"}]
}
```

## 自动识别的做法、评测和已知局限

`web/analysis.js` 全是传统信号处理，不需要模型：

- **速度**：对每个候选速度，把等间隔拍网格放到起音包络上、分 ~10 秒窗口取最佳相位，累加网格上的起音强度（比单个自相关峰更不容易八度错误），再叠加一个很弱的先验。
- **节拍**：先搜整首歌共用一个相位的恒速网格（避免段落里反拍低音太响时相位被带偏），用高分辨率包络检验是否真的恒速；不是就用随时间变化的期望拍长做动态规划（漂移、变速）。
- **拍号 / 强拍**：用低频起音、和声变化、响度跳变在 2 / 3 / 4 / 6 拍里比较对比度，4 拍是默认；跟踪到八分音符层级的慢歌会按 8 拍一小节。
- **副歌**：段落按逐小节相似度聚类；副歌 = 会重复出现、和声接近、谱更满更亮更密的那一类，响度只占一部分；短而持续上升的段落当作铺垫（它后面那一类才是 drop）；起点在 ±2 小节内按「后面像副歌、前面不像」微调。
- **循环**：小节级特征挑出音乐上合理的起止点，再用降采样互相关快速筛选、完整接缝评分（波形残差、响度、频谱形状、跳转点值 / 斜率连续性）并微调终点。

评测（`tests/`，音频不入库）：

```bash
python3 tests/make_hard_songs.py /tmp/hard             # 17 首带精确真值的困难合成歌曲（需要 numpy）
node tests/eval.js synth /tmp/hard                      # 速度 / 节拍 F / 强拍 F / 小节长度 / 副歌起点误差 / 循环接缝
python3 tests/fetch_real_data.py /tmp/salsa             # 真实音乐：Salsa 数据集（Zenodo，CC BY 4.0）
node tests/eval.js real /tmp/salsa
node tests/test_hard.js                                 # 回归测试（会自己生成其中 9 首）
```

局限（请以实际听感为准）：

- 合成歌曲的真值很干净，**不能当成真实音乐上的准确率**。真实音乐只验证了速度和节拍（Salsa，30 秒片段、没有强拍 / 段落标注，节拍 F 只能在整体平移后评），副歌识别和循环接缝没有真实音乐的真值。
- 八度（倍速 / 半速）本质上有歧义：慢歌可能被跟踪成两倍速（此时会把一小节算成 8 拍，小节线仍然正确），反拍很强的切分节奏也可能被跟踪成两倍速。
- 6/8 一类的复合拍子按两拍 / 四拍分组，小节线有时是真实小节的整数倍。
- 真人演奏的歌波形不会逐采样重复，接缝评分只能把节拍相位和低频对齐，听感上仍需要试听。

## 关于采样点精度

- 所有位置以 48kHz 采样点保存（FH6 电台统一用 48kHz）。
- 打开 48kHz WAV 时，位置与文件中的采样点完全一致。
- 打开其他采样率或压缩格式（MP3 / FLAC / OGG …）时，音频会先解码并重采样到 48kHz，再计算位置。MP3 编码器延迟等原因可能带来几毫秒误差；CSV 中会写入当前的 SampleLength，FH6 Radio Tool 发现长度不同时会按比例换算。

## 目录

```
web/            编辑器（纯静态网页，无需构建）
  index.html
  app.js        时间线、交互、播放、导入导出
  analysis.js   自动识别：节拍 / 小节 / 段落 / 标签 / 循环候选（可在 Web Worker 中运行）
  style.css
tools/
  analyze_song.py  可选的离线分析脚本（librosa / allin1）
tests/
  make_test_song.py  生成结构已知的合成测试歌曲
  test_analysis.js   用合成歌曲验证 analysis.js（BPM、节拍误差、强拍、段落、TrackDrop）
  make_hard_songs.py 生成 17 首困难合成歌曲（速度 / 拍号 / 切分 / 漂移 / 压缩母带 / EDM drop …）和精确真值
  eval.js            评测脚本：速度、节拍 F、强拍 F、副歌起点误差、循环接缝
  fetch_real_data.py 下载真实音乐评测数据（Salsa，CC BY 4.0，不入库）
  test_hard.js       困难用例的回归测试
  e2e.js             Playwright 端到端测试（载入、识别、拖动、撤销、CSV 往返、截图）
```

运行测试：

```bash
python tests/make_test_song.py /tmp/test_song.wav
node tests/test_analysis.js /tmp/test_song.wav
node tests/e2e.js /tmp/test_song.wav /tmp   # 需要 playwright
```
