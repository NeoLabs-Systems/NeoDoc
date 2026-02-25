/* Theme detection — loaded synchronously in <head> to prevent flash */
(function () {
  var d = document.documentElement;
  var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  d.dataset.theme = dark ? 'dark' : 'light';
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
    d.dataset.theme = e.matches ? 'dark' : 'light';
  });
}());
