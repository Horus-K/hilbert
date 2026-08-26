const test = require('node:test');
const assert = require('node:assert/strict');
const { getPageLogo } = require('../public/page-logo');

test('优先使用缓存 Logo，缺失时返回页面默认图标', () => {
  assert.deepEqual(getPageLogo({ logo: '/hilbert-api/pages/1/logo', icon: '🔗' }, '□'), {
    src: '/hilbert-api/pages/1/logo', text: ''
  });
  assert.deepEqual(getPageLogo({ icon: '📝' }, '□'), { src: '', text: '📝' });
  assert.deepEqual(getPageLogo({}, '□'), { src: '', text: '□' });
});
