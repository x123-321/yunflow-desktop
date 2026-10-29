const { app } = require('electron');
const fs = require('node:fs');
app.setPath('userData', 'D:/ds/.tmp-ps');
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const out = [];
  for (const p of ['F:/__ps.txt', 'D:/ds/__ps.txt']) {
    try { fs.writeFileSync(p, 'x'); out.push('write ok ' + p); fs.unlinkSync(p); }
    catch (e) { out.push('write FAIL ' + p + ' ' + e.code); }
  }
  try { fs.mkdirSync('F:/__ps_dir'); out.push('mkdir F ok'); fs.rmdirSync('F:/__ps_dir'); }
  catch (e) { out.push('mkdir F FAIL ' + e.code); }
  fs.writeFileSync('D:/ds/yunflow-desktop/ps-result.txt', out.join('\n'));
  app.exit(0);
});
