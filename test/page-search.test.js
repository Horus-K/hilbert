const test = require('node:test');
const assert = require('node:assert/strict');

const { matchesPageSearch } = require('../public/page-search');

test('页面搜索按名称忽略大小写匹配', () => {
  const page = { name: 'GitHub Docs', url: 'https://example.com/secret' };

  assert.equal(matchesPageSearch(page, ' github '), true);
  assert.equal(matchesPageSearch(page, 'SECRET'), false);
});
