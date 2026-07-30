/* Hocan Holdings — primary nav dropdown.
   Shared by every page so the Services menu behaves identically everywhere.
   Below 900px the CSS flattens the menu into inline links, so this script
   stays out of the way at those widths. */
(function () {
  var DESKTOP = window.matchMedia('(min-width: 901px)');

  function groups() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-nav-group]'));
  }

  function setOpen(group, open) {
    group.setAttribute('data-open', open ? 'true' : 'false');
    var btn = group.querySelector('button');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
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

  // Leaving desktop width flattens the menu in CSS; drop any open state so it
  // doesn't linger when the viewport comes back.
  var onChange = function () { if (!DESKTOP.matches) closeAll(null); };
  if (DESKTOP.addEventListener) DESKTOP.addEventListener('change', onChange);
  else if (DESKTOP.addListener) DESKTOP.addListener(onChange);
})();
