// DataMonster launch directories: entrances, and the filter count/URL. No tracking, no storage, no network.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Entrances: each section's parts rise in order, once. Content is visible if this never runs.
  const rise = [...document.querySelectorAll('.rise')];
  if ('IntersectionObserver' in window && !reduce) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    rise.forEach((el) => io.observe(el));
  } else {
    rise.forEach((el) => el.classList.add('in'));
  }

  // Filters: CSS does the hiding; this keeps the count, the empty message and the URL in step.
  const form = document.querySelector('.filters');
  if (!form) return;
  const entries = [...document.querySelectorAll('.entry')];
  const count = document.querySelector('[data-count]');
  const empty = document.querySelector('.empty');

  const apply = () => {
    const cat = form.querySelector('input[name=category]:checked')?.value ?? 'all';
    const price = form.querySelector('input[name=pricing]:checked')?.value ?? 'all';
    const status = form.querySelector('input[name=status]:checked')?.value ?? 'all';
    let shown = 0;
    for (const el of entries) {
      const ok = (cat === 'all' || el.dataset.category === cat) &&
                 (price === 'all' || el.dataset.pricing === price) &&
                 (status === 'all' || el.dataset.status === status);
      if (ok) shown++;
    }
    if (count) count.textContent = `${shown} of ${entries.length} shown`;
    if (empty) empty.style.display = shown ? 'none' : 'block';
    const q = new URLSearchParams();
    if (status !== 'all') q.set('status', status);
    if (cat !== 'all') q.set('category', cat);
    if (price !== 'all') q.set('pricing', price);
    const url = q.toString() ? `?${q}#list` : location.pathname + (location.hash || '');
    history.replaceState(null, '', url);
  };

  // Restore from ?category=&pricing=&status= so a filtered view can be shared.
  const params = new URLSearchParams(location.search);
  for (const name of ['status', 'category', 'pricing']) {
    const v = params.get(name);
    const input = v && form.querySelector(`input[name=${name}][value="${CSS.escape(v)}"]`);
    if (input) input.checked = true;
  }
  form.addEventListener('change', apply);
  form.addEventListener('reset', () => setTimeout(apply));
  if (params.has('category') || params.has('pricing') || params.has('status')) apply();
  else if (count) count.textContent = `${entries.length} of ${entries.length} shown`;
})();
