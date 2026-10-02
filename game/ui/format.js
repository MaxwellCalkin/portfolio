export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const ARROW = '<svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg>';

/** 12 M, 840 M, 3.4 KM, 42 KM */
export function formatDistance(meters) {
  const m = Math.max(0, Number(meters) || 0);
  if (!Number.isFinite(m)) return '';
  return m >= 1000 ? `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} KM` : `${Math.round(m)} M`;
}

export function formatTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60), r = s - m * 60;
  return m ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${r.toFixed(1)}s`;
}

/** Strips the <br> used in chapter titles for single-line contexts. */
export const plainTitle = html => String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
