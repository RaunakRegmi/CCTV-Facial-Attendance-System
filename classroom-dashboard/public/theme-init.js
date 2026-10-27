// Apply the chosen theme before paint; compatible with script-src self.
try {
  const saved = localStorage.getItem('theme');
  document.documentElement.classList.toggle('dark', saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
} catch { /* Use the light theme if storage is unavailable. */ }
