const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('页面弹窗固定尺寸且公共信息位于类型配置之前', () => {
  const form = html.slice(html.indexOf('<form id="pageForm">'), html.indexOf('</form>', html.indexOf('<form id="pageForm">')));

  assert.match(html, /<div class="modal page-modal">/);
  assert.ok(form.indexOf('id="fieldName"') < form.indexOf('id="typeSwitch"'));
  assert.ok(form.indexOf('id="fieldLogoUrl"') < form.indexOf('id="typeSwitch"'));
  assert.ok(form.indexOf('id="fieldGroup"') < form.indexOf('id="typeSwitch"'));
  assert.match(css, /\.page-modal\s*{[^}]*width:\s*760px;[^}]*height:\s*min\(680px,\s*calc\(100vh\s*-\s*40px\)\);/s);
});
