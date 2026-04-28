/* =============================================================
   main.js — cursor, reveals, section rail, alignment widget
   ============================================================= */
(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Custom cursor ----------
  const cursor = document.querySelector('.cursor');
  const supportsFinePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (cursor && supportsFinePointer) {
    const pos = { x: -100, y: -100, tx: -100, ty: -100 };
    window.addEventListener('pointermove', (e) => {
      pos.tx = e.clientX;
      pos.ty = e.clientY;
    }, { passive: true });
    (function loop() {
      pos.x += (pos.tx - pos.x) * 0.2;
      pos.y += (pos.ty - pos.y) * 0.2;
      cursor.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      requestAnimationFrame(loop);
    })();

    const hoverTargets = 'a, button, input, .channel, .pillar, .chapter, .article, .holon, .cons__viz, [data-reveal]';
    document.addEventListener('pointerover', (e) => {
      if (e.target.closest(hoverTargets)) cursor.classList.add('is-hovering');
    });
    document.addEventListener('pointerout', (e) => {
      if (e.target.closest(hoverTargets)) cursor.classList.remove('is-hovering');
    });
  } else if (cursor) {
    cursor.remove();
    document.body.style.cursor = 'auto';
  }

  // ---------- Scroll progress ----------
  const scrollBar = document.getElementById('scrollBar');
  if (scrollBar) {
    const onScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      const pct = max > 0 ? (h.scrollTop / max) * 100 : 0;
      scrollBar.style.width = pct + '%';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---------- Hero letter reveals ----------
  const heroWords = document.querySelectorAll('.hero__word');
  requestAnimationFrame(() => {
    setTimeout(() => {
      heroWords.forEach((w) => w.classList.add('is-revealed'));
    }, 400);
  });

  // ---------- Text splitting (safe DOM) ----------
  document.querySelectorAll('[data-split]').forEach((el) => {
    const wrapper = document.createElement('span');
    wrapper.className = 'word-line';
    while (el.firstChild) wrapper.appendChild(el.firstChild);
    el.appendChild(wrapper);
  });

  // ---------- Generic reveals ----------
  const reveals = document.querySelectorAll('[data-reveal], [data-split], .in-view-up');
  const ioReveal = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('is-revealed', 'is-in-view');
        ioReveal.unobserve(e.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
  reveals.forEach((el) => ioReveal.observe(el));

  // Tag common content blocks to fade up
  const contentBlocks = document.querySelectorAll(
    '.credo__quote, .credo__aside, .mission__text, .mission__viz, .cons__viz, .cons__prose, .chapter, .pillar, .article, .channel, .cons__header, .journey__header, .pillars__header, .constitution__preface'
  );
  contentBlocks.forEach((el) => {
    el.classList.add('in-view-up');
    ioReveal.observe(el);
  });

  // ---------- Section rail ----------
  const sectionIds = ['hero', 'credo', 'mission', 'consciousness', 'journey', 'pillars', 'constitution', 'connect'];
  const sections = sectionIds
    .map((id) => ({ id, el: document.getElementById(id) }))
    .filter((s) => s.el);
  const railLinks = document.querySelectorAll('.rail a');

  const ioSections = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        const id = e.target.id;
        railLinks.forEach((link) => {
          link.classList.toggle('is-active', link.dataset.rail === id);
        });
      }
    });
  }, { threshold: 0.4 });
  sections.forEach((s) => ioSections.observe(s.el));

  // ---------- Alignment visualization ----------
  const capSlider = document.getElementById('capSlider');
  const alignSlider = document.getElementById('alignSlider');
  const capValue = document.getElementById('capValue');
  const alignValue = document.getElementById('alignValue');
  const orbGood = document.getElementById('orbGood');
  const orbLine = document.getElementById('orbLine');
  const vizState = document.getElementById('vizState');

  function updateAlignment() {
    if (!capSlider || !alignSlider) return;
    const cap = +capSlider.value / 100;
    const align = +alignSlider.value / 100;
    capValue.textContent = cap.toFixed(2);
    alignValue.textContent = align.toFixed(2);

    // Viewbox is 320×320 with axes from (20,300) to (300,20)
    const xMin = 20, xMax = 300, yTop = 20, yBottom = 300;
    const vbX = xMin + cap * (xMax - xMin);
    const vbY = yBottom - align * (yBottom - yTop);

    // Boundary y for a given cap (alignment == capability)
    const boundaryY = yBottom - cap * (yBottom - yTop);

    const canvas = document.getElementById('viz-alignment');
    if (!canvas) return;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const toPx = (vx, vy) => ({ x: (vx / 320) * cw, y: (vy / 320) * ch });

    const orbPx = toPx(vbX, vbY);
    orbGood.style.left = orbPx.x + 'px';
    orbGood.style.top = orbPx.y + 'px';

    // Gap: positive when alignment >= capability (safe), negative when below
    const gap = align - cap;
    const inDanger = gap < 0;

    // Drop line: only show in danger zone, drawn from orb up to the boundary
    if (inDanger) {
      const boundaryPx = toPx(vbX, boundaryY);
      const dropLen = Math.abs(boundaryPx.y - orbPx.y);
      orbLine.style.left = orbPx.x + 'px';
      orbLine.style.top = boundaryPx.y + 'px';
      orbLine.style.height = dropLen + 'px';
      orbLine.style.background = 'linear-gradient(to bottom, rgba(224,100,100,0.85), rgba(224,100,100,0))';
      orbLine.style.opacity = String(Math.min(-gap * 2, 0.9));
    } else {
      orbLine.style.opacity = '0';
      orbLine.style.height = '0px';
    }

    // Orb color
    let r, g, b;
    if (gap >= 0) {
      // safe zone — gold → teal as we go higher above the line
      const t = Math.min(gap * 1.4, 1);
      r = Math.round(244 * (1 - t) + 122 * t);
      g = Math.round(201 * (1 - t) + 211 * t);
      b = Math.round(113 * (1 - t) + 192 * t);
    } else {
      // danger zone — gold → red as we drift below
      const t = Math.min(-gap * 1.4, 1);
      r = Math.round(244 * (1 - t) + 224 * t);
      g = Math.round(201 * (1 - t) + 80 * t);
      b = Math.round(113 * (1 - t) + 80 * t);
    }
    orbGood.style.setProperty('--orb-color', `${r}, ${g}, ${b}`);

    // Adaptive scale: bigger orb at higher capability so the "stakes" feel real
    const scale = 0.75 + cap * 0.7;
    orbGood.style.width = (44 * scale) + 'px';
    orbGood.style.height = (44 * scale) + 'px';

    // State label
    let label;
    if (cap < 0.15 && align < 0.15) label = 'nascent';
    else if (gap >= 0.4) label = 'wisdom anchor — safe';
    else if (gap >= 0.1 && cap > 0.7) label = 'aligned superintelligence — the goal';
    else if (gap >= 0.1) label = 'aligned';
    else if (gap >= -0.05) label = 'on the line';
    else if (gap > -0.2) label = 'drift — attention required';
    else if (cap > 0.7) label = 'DANGER — misaligned scale-up';
    else label = 'misaligned';
    vizState.textContent = label;
    vizState.style.color = gap < -0.2 ? '#e06464' : gap > 0.2 ? '#7ad3c0' : '#f4c971';
  }

  if (capSlider && alignSlider) {
    capSlider.addEventListener('input', updateAlignment);
    alignSlider.addEventListener('input', updateAlignment);
    window.addEventListener('resize', updateAlignment);
    requestAnimationFrame(() => requestAnimationFrame(updateAlignment));
  }

  // ---------- Pillar meter fill ----------
  const pillarMeters = document.querySelectorAll('.pillar__meter-bar span');
  pillarMeters.forEach((m) => {
    const meter = m.closest('.pillar__meter');
    const v = meter && meter.dataset.value ? meter.dataset.value : 80;
    m.style.width = v + '%';
  });

  // ---------- Smooth scroll ----------
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href').slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    });
  });

  // ---------- Consciousness holon — subtle hover highlight ----------
  const consViz = document.getElementById('consViz');
  if (consViz) {
    consViz.addEventListener('pointermove', (e) => {
      const r = consViz.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const pct = Math.min(dist / (r.width / 2), 1);
      // highlight the ring that corresponds to the cursor's distance from center
      const ringPcts = [0.07, 0.13, 0.20, 0.275, 0.35, 0.43, 0.50];
      let closest = 0, best = 1;
      ringPcts.forEach((p, i) => {
        const d = Math.abs(p - pct / 2);
        if (d < best) { best = d; closest = i; }
      });
      consViz.querySelectorAll('.holon').forEach((h, i) => {
        h.classList.toggle('is-active', i === closest);
      });
    });
    consViz.addEventListener('pointerleave', () => {
      consViz.querySelectorAll('.holon').forEach(h => h.classList.remove('is-active'));
    });
  }

  // ---------- Stagger transitions ----------
  document.querySelectorAll('.chapter').forEach((c, i) => {
    c.style.transitionDelay = (i * 0.1) + 's';
  });
  document.querySelectorAll('.pillar').forEach((p, i) => {
    p.style.transitionDelay = (i * 0.15) + 's';
  });
  document.querySelectorAll('.article').forEach((a, i) => {
    a.style.transitionDelay = (i * 0.08) + 's';
  });

  // ---------- Easter egg: press 'M' to pulse the site ----------
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      document.body.animate(
        [{ filter: 'brightness(1)' }, { filter: 'brightness(1.4)' }, { filter: 'brightness(1)' }],
        { duration: 600, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
      );
    }
  });
})();
