function getPageLogo(page, fallback) {
  return page.logo
    ? { src: page.logo, text: '' }
    : { src: '', text: page.icon || fallback };
}

if (typeof module !== 'undefined') module.exports = { getPageLogo };
