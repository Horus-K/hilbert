const test = require('node:test');
const assert = require('node:assert/strict');
const { collectKvRows } = require('../public/auth-kv');

test('KV 行忽略空键、去除键名空格并由后项覆盖重复键', () => {
  const rows = [
    row(' tenant ', 'old'),
    row('', 'ignored'),
    row('tenant', 'new'),
    row('audience', 'api')
  ];
  const container = { querySelectorAll: () => rows };
  assert.deepEqual(collectKvRows(container), { tenant: 'new', audience: 'api' });
});

function row(key, value) {
  return {
    querySelector(selector) {
      return { value: selector === '.auth-kv-key' ? key : value };
    }
  };
}
