// 端到端测试：node tests/e2e.js <wav> <截图输出目录>
const path = require('path');
const { chromium } = require(process.env.PW_PATH || 'playwright');

(async () => {
  const wav = path.resolve(process.argv[2]);
  const outDir = path.resolve(process.argv[3] || '.');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('file://' + path.resolve(__dirname, '../web/index.html'));
  await page.setInputFiles('#fileInput', wav);
  await page.waitForFunction(() => window.__fh6.state.cur && window.__fh6.state.cur.loaded, null, { timeout: 30000 });
  await page.screenshot({ path: path.join(outDir, '01_loaded.png') });

  // 自动识别
  await page.click('.tab[data-tab=analysis]');
  await page.click('#btnAnalyze');
  await page.waitForFunction(() => window.__fh6.state.cur.analysis, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const res = await page.evaluate(() => {
    const s = window.__fh6.state.cur;
    return { bpm: s.analysis.bpm, sections: s.sections.map((x) => [x.label, +(x.start / 48000).toFixed(2)]), markers: s.markers, len: s.length };
  });
  console.log('bpm', res.bpm.toFixed(3));
  console.log('sections', JSON.stringify(res.sections));
  console.log('markers', JSON.stringify(res.markers));
  await page.screenshot({ path: path.join(outDir, '02_analyzed.png') });

  // 拖动 TrackDrop 标记：找到它在画布上的 x
  const box = await page.locator('#timeline').boundingBox();
  const before = res.markers.TrackDrop;
  const x = await page.evaluate(() => {
    const st = window.__fh6.state;
    return (st.cur.markers.TrackDrop - st.view.start) / st.view.spp;
  });
  const y = box.y + 300;
  await page.mouse.move(box.x + x, y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 40, y, { steps: 5 });
  await page.mouse.move(box.x + x + 80, y, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.__fh6.state.cur.markers.TrackDrop);
  console.log('drag TrackDrop', before, '->', after);
  const onBeat = await page.evaluate((v) => window.__fh6.state.cur.analysis.beats.some((b) => Math.abs(b - v) < 100), after);
  console.log('dragged marker snapped to beat:', onBeat);

  // 撤销
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => window.__fh6.state.cur.markers.TrackDrop);
  console.log('undo ->', undone, undone === before ? 'OK' : 'FAIL');

  // 放大到某个循环点附近
  await page.click('.tab[data-tab=markers]');
  await page.evaluate(() => {
    const st = window.__fh6.state;
    st.view.spp = 120; st.view.start = st.cur.markers.TrackLoopStart - 600 * 120;
  });
  await page.mouse.move(box.x + 500, box.y + 400);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, '03_zoomed_markers.png') });

  // 采样级放大
  await page.evaluate(() => {
    const st = window.__fh6.state;
    st.view.spp = 0.12; st.view.start = st.cur.markers.TrackLoopStart - 60;
  });
  await page.mouse.move(box.x + 700, box.y + 500);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, '04_sample_level.png') });

  // 段落切分（S 键）与右键菜单
  await page.click('#btnZoomFit');
  await page.click('.tab[data-tab=sections]');
  await page.screenshot({ path: path.join(outDir, '05_sections.png') });

  // CSV 导出 / 导入往返
  const csv = await page.evaluate(() => window.__fh6.buildCsv());
  console.log(csv.trim().split(/\r\n/).join('\n'));
  await page.evaluate(() => { const s = window.__fh6.state.cur; s.markers.TrackDrop = 12345; });
  await page.evaluate((t) => window.__fh6.importCsv(t), csv);
  const back = await page.evaluate(() => window.__fh6.state.cur.markers.TrackDrop);
  console.log('csv roundtrip TrackDrop', back === before ? 'OK' : 'FAIL ' + back);

  // 帮助
  await page.click('#btnHelp');
  await page.screenshot({ path: path.join(outDir, '06_help.png') });
  await page.keyboard.press('Escape');

  // 窄屏
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, '07_narrow.png'), fullPage: true });

  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
