// Runs before first paint so a stored theme never flashes the other one.
try {
  var saved = localStorage.getItem('stator-theme')
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved
} catch (e) {}
