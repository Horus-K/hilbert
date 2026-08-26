function matchesPageSearch(page, query) {
  return page.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

if (typeof module !== 'undefined') module.exports = { matchesPageSearch };
