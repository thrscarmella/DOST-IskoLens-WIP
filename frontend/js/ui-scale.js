/* Theme (Settings > Appearance): applied before the page paints so there is
   no flash of the light theme. 'system' follows the device setting. */
(function () {
  var t = 'light';
  try { t = localStorage.getItem('iskolens_theme') || 'light'; } catch (e) {}
  if (t === 'system') t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();
/* ==========================================================================
   DOST-IskoLens — UI scale
   Keeps the interface at the same visual proportions as the design reference
   on any display resolution / Windows scaling (100%, 125%, 150% ...).

   The reference layout was designed for a ~1750px-wide viewport. On narrower
   viewports (e.g. a 1920x1080 laptop at 125% scaling = ~1536 CSS px) the UI is
   scaled down proportionally instead of rendering larger and bulkier.
   Wider viewports render at 100% (never scaled up). Tablet/mobile widths
   (<= 1100px) are untouched and keep their existing responsive layout.

   Loaded synchronously in <head> so there is no flash of the unscaled page.
   ========================================================================== */
(function () {
  var REFERENCE_WIDTH = 1750; // viewport width the design reference was made at
  var MIN_SCALE       = 0.8;  // never shrink below this (keeps text readable)
  var MOBILE_MAX      = 1100; // at/below this the responsive CSS takes over

  var root = document.documentElement;

  function apply() {
    var vw = window.innerWidth;
    var scale = 1;
    if (vw > MOBILE_MAX && vw < REFERENCE_WIDTH) {
      scale = Math.max(MIN_SCALE, vw / REFERENCE_WIDTH);
    }
    // Font size preference (Settings tab): small / medium / large.
    var pref = 'medium';
    try { pref = localStorage.getItem('iskolens_font_size') || 'medium'; } catch (e) {}
    scale = scale * ({ small: 0.92, medium: 1, large: 1.1 }[pref] || 1);
    scale = Math.round(scale * 1000) / 1000;
    root.style.zoom = scale === 1 ? '' : String(scale);
    root.style.setProperty('--ui-zoom', String(scale));
  }

  apply();
  window.addEventListener('resize', apply);
})();
