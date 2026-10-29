// Runs before the page paints (a same-origin file: the Content Security
// Policy forbids inline scripts), so the page never flashes the wrong theme.
// An explicit choice (stored by the theme controls) wins; otherwise follow
// the operating system.
;(function () {
  var theme = null
  try {
    theme = localStorage.getItem('collabspace-theme')
  } catch (e) {}
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  document.documentElement.setAttribute('data-theme', theme)
})()
