(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  root.AuthKv = api;
})(typeof window === 'undefined' ? globalThis : window, () => ({
  collectKvRows(container) {
    return Object.fromEntries([...container.querySelectorAll('.auth-kv-row')]
      .map(row => [
        row.querySelector('.auth-kv-key').value.trim(),
        row.querySelector('.auth-kv-value').value
      ])
      .filter(([key]) => key));
  }
}));
