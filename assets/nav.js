/* Hocan Holdings — primary nav dropdown.
   Shared by every page so the Services menu behaves identically everywhere.

   The panel is moved out to <body> while open ("portalled") rather than being
   positioned inside the navbar. The navbar sets `transform: translateZ(0)` and
   `.glass` sets `backdrop-filter`; either one makes that element the containing
   block for fixed/absolute descendants AND clips them to its border-radius, so
   a nested panel is cut off at the rounded edge no matter its z-index. Only
   reparenting escapes both. Below 900px the CSS flattens the menu into inline
   links, so the panel stays in place and this script does nothing. */
(function () {
  var DESKTOP = window.matchMedia('(min-width: 901px)');

  function groups() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-nav-group]'));
  }

  // Remember where each panel started so it can be put back for mobile.
  var homes = [];
  groups().forEach(function (group) {
    var menu = group.querySelector('.nav-menu');
    if (menu) homes.push({ group: group, menu: menu });
  });

  function portal(group) {
    var menu = group.querySelector('.nav-menu');
    if (menu && menu.parentNode !== document.body) document.body.appendChild(menu);
    return menu || document.querySelector('.nav-menu[data-owner="' + group.id + '"]');
  }

  function menuOf(group) {
    // Once portalled the panel is no longer a descendant, so look it up by the
    // marker written in setOpen.
    return group._menu || group.querySelector('.nav-menu');
  }

  function restoreAll() {
    homes.forEach(function (h) {
      if (h.menu.parentNode !== h.group) h.group.appendChild(h.menu);
      h.menu.style.top = '';
      h.menu.style.left = '';
      h.menu.style.width = '';
    });
  }

  function place(group) {
    var btn = group.querySelector('button');
    var menu = menuOf(group);
    if (!btn || !menu || !DESKTOP.matches) return;

    var r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 10) + 'px';

    var width = menu.offsetWidth;
    var left = r.left;
    var margin = 12;
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    menu.style.left = left + 'px';
  }

  function setOpen(group, open) {
    var menu = menuOf(group);
    if (!menu) return;

    if (open && DESKTOP.matches) {
      // Move to <body> first, then measure and position.
      if (menu.parentNode !== document.body) document.body.appendChild(menu);
      group._menu = menu;
    }

    group.setAttribute('data-open', open ? 'true' : 'false');
    // The panel is detached from the group, so it carries its own open flag for
    // the CSS to key off.
    menu.setAttribute('data-open', open ? 'true' : 'false');

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
    group._menu = group.querySelector('.nav-menu');

    // Hover opens the menu, as expected of a menu bar. Because the panel is
    // portalled away, hover has to be tracked on both the group and the panel.
    var hoverTimer = null;
    function open() {
      if (!DESKTOP.matches) return;
      clearTimeout(hoverTimer);
      closeAll(group);
      setOpen(group, true);
    }
    function closeSoon() {
      if (!DESKTOP.matches) return;
      // Short grace period so moving the pointer from the button to the panel
      // across the 10px gap doesn't close it.
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () { setOpen(group, false); }, 180);
    }

    group.addEventListener('mouseenter', open);
    group.addEventListener('mouseleave', closeSoon);

    var menu = group._menu;
    if (menu) {
      menu.addEventListener('mouseenter', function () {
        if (!DESKTOP.matches) return;
        clearTimeout(hoverTimer);
      });
      menu.addEventListener('mouseleave', closeSoon);
      menu.addEventListener('focusout', function (e) {
        if (!DESKTOP.matches) return;
        if (!menu.contains(e.relatedTarget) && !group.contains(e.relatedTarget)) {
          setOpen(group, false);
        }
      });
    }

    // Click/keyboard toggle, so the menu is reachable without a pointer.
    btn.addEventListener('click', function (e) {
      if (!DESKTOP.matches) return;
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(hoverTimer);
      var isOpen = group.getAttribute('data-open') === 'true';
      closeAll(group);
      setOpen(group, !isOpen);
    });

    group.addEventListener('focusout', function (e) {
      if (!DESKTOP.matches) return;
      var m = menuOf(group);
      if (!group.contains(e.relatedTarget) && !(m && m.contains(e.relatedTarget))) {
        setOpen(group, false);
      }
    });
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (e.target.closest('[data-nav-group]') || e.target.closest('.nav-menu')) return;
    closeAll(null);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = document.querySelector('[data-nav-group][data-open="true"]');
    if (!open) return;
    setOpen(open, false);
    var btn = open.querySelector('button');
    if (btn) btn.focus();
  });

  // A portalled panel doesn't travel with the button, so re-anchor it while
  // open — index.html's navbar is sticky and slides away on scroll.
  function reposition() {
    var open = document.querySelector('[data-nav-group][data-open="true"]');
    if (open) place(open);
  }
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition);

  /* ---- Mobile drawer --------------------------------------------------- */

  var links = document.querySelector('.nav-inner .links');
  var navInner = document.querySelector('.nav-inner');
  var toggle = null;
  var scrim = null;
  var linksHome = links ? links.parentNode : null;
  var lastFocus = null;

  if (links && navInner) {
    toggle = document.createElement('button');
    toggle.className = 'nav-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Open menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'primary-nav');
    toggle.appendChild(document.createElement('span'));
    navInner.appendChild(toggle);

    if (!links.id) links.id = 'primary-nav';

    scrim = document.createElement('div');
    scrim.className = 'nav-scrim';
    scrim.hidden = false;
    document.body.appendChild(scrim);
  }

  function drawerOpen() { return document.body.getAttribute('data-nav-open') === 'true'; }

  function setDrawer(open) {
    if (!links || !toggle) return;

    if (open) {
      // Same clipping constraint as the desktop dropdown: the navbar's
      // transform/backdrop-filter would trap a fixed drawer, so move it out.
      if (links.parentNode !== document.body) document.body.appendChild(links);
      lastFocus = document.activeElement;
    }

    document.body.setAttribute('data-nav-open', open ? 'true' : 'false');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');

    if (open) {
      var first = links.querySelector('a');
      if (first) first.focus({ preventScroll: true });
    } else if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus({ preventScroll: true });
      lastFocus = null;
    }
  }

  if (toggle) {
    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setDrawer(!drawerOpen());
    });
  }
  if (scrim) scrim.addEventListener('click', function () { setDrawer(false); });

  // Navigating away should not leave the drawer open behind the new page.
  if (links) {
    links.addEventListener('click', function (e) {
      if (e.target.closest('a') && !DESKTOP.matches) setDrawer(false);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawerOpen()) { setDrawer(false); return; }

    // Keep Tab inside the drawer while it's open.
    if (e.key !== 'Tab' || !drawerOpen() || !links) return;
    var focusables = links.querySelectorAll('a[href], button:not([disabled])');
    var list = Array.prototype.filter.call(focusables, function (el) {
      return el.offsetParent !== null && getComputedStyle(el).pointerEvents !== 'none';
    });
    if (!list.length) return;
    var first = list[0];
    var last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Below the desktop breakpoint the dropdown panel sits back inside the nav so
  // the CSS can render it as a labelled section of the drawer. Above it, the
  // drawer is dismissed and the link list returns to the bar.
  function syncToWidth() {
    if (DESKTOP.matches) {
      setDrawer(false);
      document.body.removeAttribute('data-nav-open');
      if (links && linksHome && links.parentNode !== linksHome) linksHome.appendChild(links);
    } else {
      closeAll(null);
      restoreAll();
    }
  }
  if (DESKTOP.addEventListener) DESKTOP.addEventListener('change', syncToWidth);
  else if (DESKTOP.addListener) DESKTOP.addListener(syncToWidth);
  syncToWidth();
})();
