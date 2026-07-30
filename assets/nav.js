/* Hocan Holdings — primary nav dropdown.
   Shared by every page so the Services menu behaves identically everywhere.
   Below 900px the CSS flattens the menu into inline links, so this script
   stays out of the way at those widths. */
(function () {
  var DESKTOP = window.matchMedia('(min-width: 901px)');

  function groups() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-nav-group]'));
  }

  // The panel is position:fixed to escape the navbar's backdrop-filter clip,
  // so its coordinates have to be derived from the button each time it opens.
  function place(group) {
    var btn = group.querySelector('button');
    var menu = group.querySelector('.nav-menu');
    if (!btn || !menu || !DESKTOP.matches) return;

    var r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 10) + 'px';

    // Measure before positioning horizontally, then keep the panel inside the
    // viewport rather than letting it run off the right edge.
    var width = menu.offsetWidth;
    var left = r.left;
    var margin = 12;
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    menu.style.left = left + 'px';
  }

  function setOpen(group, open) {
    group.setAttribute('data-open', open ? 'true' : 'false');
    var btn = group.querySelector('button');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) place(group);
  }

  function closeAll(except) {
    groups().forEach(function (g) { if (g !== except) setOpen(g, false); });
  }

  groups().forEach(function (group) {
    var btn = group.querySelector('button');
    if (!btn) return;

    // Pointer: open on hover, which is what people expect of a menu bar.
    group.addEventListener('mouseenter', function () {
      if (!DESKTOP.matches) return;
      closeAll(group);
      setOpen(group, true);
    });
    group.addEventListener('mouseleave', function () {
      if (!DESKTOP.matches) return;
      setOpen(group, false);
    });

    // Click/keyboard toggle, so the menu is reachable without a pointer.
    btn.addEventListener('click', function (e) {
      if (!DESKTOP.matches) return;
      e.preventDefault();
      e.stopPropagation();
      var open = group.getAttribute('data-open') === 'true';
      closeAll(group);
      setOpen(group, !open);
    });

    // Let focus move through the menu, but close once it leaves entirely.
    group.addEventListener('focusout', function (e) {
      if (!DESKTOP.matches) return;
      if (!group.contains(e.relatedTarget)) setOpen(group, false);
    });
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('[data-nav-group]')) closeAll(null);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = document.querySelector('[data-nav-group][data-open="true"]');
    if (!open) return;
    setOpen(open, false);
    var btn = open.querySelector('button');
    if (btn) btn.focus();
  });

  // A fixed panel doesn't travel with the button, so re-anchor it while open.
  // index.html's navbar is sticky and slides away on scroll — following it
  // keeps the two from drifting apart.
  function reposition() {
    var open = document.querySelector('[data-nav-group][data-open="true"]');
    if (open) place(open);
  }
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition);

  // Leaving desktop width flattens the menu in CSS; drop any open state so it
  // doesn't linger when the viewport comes back.
  var onChange = function () {
    if (DESKTOP.matches) return;
    closeAll(null);
    // Clear the inline coordinates, or they'd override the static layout the
    // mobile stylesheet switches the panel to.
    groups().forEach(function (g) {
      var menu = g.querySelector('.nav-menu');
      if (menu) { menu.style.top = ''; menu.style.left = ''; }
    });
  };
  if (DESKTOP.addEventListener) DESKTOP.addEventListener('change', onChange);
  else if (DESKTOP.addListener) DESKTOP.addListener(onChange);
})();
