// Applies the Light / Dark / System setting to an extension page (side panel, Settings).
// Loaded as a classic script in <head> so the page never flashes the wrong theme.
(() => {
  const apply = (t) => (document.documentElement.dataset.theme = ['light', 'dark', 'system'].includes(t) ? t : 'light');
  apply('light');
  try {
    chrome.storage.local.get({ theme: 'light' }).then((s) => apply(s.theme));
    chrome.storage.onChanged.addListener((ch, area) => area === 'local' && ch.theme && apply(ch.theme.newValue));
  } catch {}
})();
