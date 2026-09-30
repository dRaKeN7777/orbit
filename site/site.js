/* CyberPresalesOS — small progressive enhancements. No dependencies. */
(function () {
  'use strict';

  var nav = document.getElementById('nav');
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  // Nav gains a solid background once the hero starts to leave.
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle('stuck', window.scrollY > 40);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  var items = document.querySelectorAll('.reveal');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('in'); });
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      // Stagger siblings slightly so grids cascade rather than snapping in.
      var siblings = Array.prototype.slice.call(entry.target.parentNode.children);
      var i = siblings.indexOf(entry.target);
      entry.target.style.transitionDelay = Math.min(i, 5) * 60 + 'ms';
      entry.target.classList.add('in');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

  items.forEach(function (el) { io.observe(el); });
})();
