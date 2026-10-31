/* ═══════════════════════════════════════════════════════════════
   PERFORMANCE.JS — Win-rate / reply-rate dashboard
   Renders into #view-performance-content. Self-contained, follows
   the same conventions as workflows.js (api/toast/el helpers).

   All numbers shown here come straight from /api/leads/performance,
   which computes them from real lead rows — nothing is simulated.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  let currentRange = '30'; // '7' | '30' | '90' | 'all'
  let stats = null;
  let loading = false;

  const el  = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  function getCsrf() {
    try {
      const m = document.cookie.split('; ').find(r => r.startsWith('bp_csrf='));
      return m ? decodeURIComponent(m.split('=')[1]) : '';
    } catch (_) { return ''; }
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      credentials: 'include', ...opts,
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrf(), ...(opts.headers || {}) },
    });
    if (res.status === 401) { window.location.href = '/login.html'; return null; }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data) throw new Error((data && data.message) || `Request failed (${res.status})`);
    return data;
  }

  function pct(n) {
    if (n == null) return '—';
    return Math.round(n * 100) + '%';
  }

  function fmtDuration(seconds) {
    if (seconds == null) return '—';
    if (seconds < 60) return Math.round(seconds) + 's';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm';
    if (seconds < 86400) return (seconds / 3600).toFixed(1) + 'h';
    return (seconds / 86400).toFixed(1) + 'd';
  }

  async function render() {
    const root = el('view-performance-content');
    if (!root) return;

    if (!stats || loading) {
      root.innerHTML = `<div class="lc-empty" style="margin-top:60px"><div class="lc-spinner" style="margin:0 auto 14px"></div><div class="lc-empty-text">Loading performance…</div></div>`;
    }

    loading = true;
    try {
      const res = await api(`/api/leads/performance?range=${encodeURIComponent(currentRange)}`);
      stats = (res && res.stats) || null;
    } catch (e) {
      root.innerHTML = `<div class="lc-empty" style="margin-top:60px"><div class="lc-empty-title">Couldn't load performance data</div><div class="lc-empty-text">${esc(e.message)}</div></div>`;
      loading = false;
      return;
    }
    loading = false;

    if (!stats) {
      root.innerHTML = `<div class="lc-empty" style="margin-top:60px"><div class="lc-empty-text">No data available.</div></div>`;
      return;
    }

    if (stats.totalLeads === 0) {
      root.innerHTML = emptyStateHtml();
      bindRangeButtons();
      return;
    }

    root.innerHTML = `
      <div class="perf-wrap">
        <div class="perf-head">
          <h2>Performance</h2>
          <div class="perf-range">
            ${rangeButton('7', '7 days')}
            ${rangeButton('30', '30 days')}
            ${rangeButton('90', '90 days')}
            ${rangeButton('all', 'All time')}
          </div>
        </div>

        <div class="perf-stats">
          <div class="perf-stat">
            <div class="perf-stat-label">Leads received</div>
            <div class="perf-stat-value">${stats.totalLeads}</div>
            <div class="perf-stat-sub">${rangeLabel()}</div>
          </div>
          <div class="perf-stat">
            <div class="perf-stat-label">AI reply rate</div>
            <div class="perf-stat-value ${gradeClass(stats.replyRate)}">${pct(stats.replyRate)}</div>
            <div class="perf-stat-sub">${stats.repliedCount} replied of ${stats.totalLeads}</div>
          </div>
          <div class="perf-stat">
            <div class="perf-stat-label">Reply → booked rate</div>
            <div class="perf-stat-value ${gradeClass(stats.bookingRate)}">${pct(stats.bookingRate)}</div>
            <div class="perf-stat-sub">${stats.bookedCount} meetings booked</div>
          </div>
          <div class="perf-stat">
            <div class="perf-stat-label">Avg. response time</div>
            <div class="perf-stat-value">${fmtDuration(stats.avgResponseSeconds)}</div>
            <div class="perf-stat-sub">from lead received to reply sent</div>
          </div>
        </div>

        <div class="perf-funnel">
          <div class="perf-section-title">Funnel</div>
          ${funnelRow('Leads received', stats.totalLeads, stats.totalLeads, false)}
          ${funnelRow('AI replied', stats.repliedCount, stats.totalLeads, false)}
          ${funnelRow('Meeting booked', stats.bookedCount, stats.totalLeads, true)}
          ${funnelRow('Closed', stats.closedCount, stats.totalLeads, false)}
        </div>

        <div class="perf-funnel">
          <div class="perf-section-title">By source</div>
          ${sourceTable(stats.bySource)}
        </div>

        <div class="perf-note">
          These numbers are calculated directly from your leads — not estimated. "Reply rate" is the share of received leads the AI has sent a reply to; "Reply → booked rate" is the share of replied leads that resulted in a calendar booking.
        </div>
      </div>
    `;

    bindRangeButtons();
  }

  function rangeLabel() {
    if (currentRange === 'all') return 'all time';
    return `last ${currentRange} days`;
  }

  function rangeButton(value, label) {
    return `<button data-range="${value}" class="${currentRange === value ? 'active' : ''}">${label}</button>`;
  }

  function gradeClass(rate) {
    if (rate == null) return '';
    if (rate >= 0.5) return 'good';
    if (rate < 0.2) return 'warn';
    return '';
  }

  function funnelRow(label, count, max, isBooked) {
    const width = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0;
    return `
      <div class="perf-funnel-row">
        <div class="perf-funnel-label">${esc(label)}</div>
        <div class="perf-funnel-bar-track"><div class="perf-funnel-bar${isBooked ? ' booked' : ''}" style="width:${width}%"></div></div>
        <div class="perf-funnel-count">${count}</div>
      </div>
    `;
  }

  function sourceTable(bySource) {
    if (!bySource || !bySource.length) {
      return `<div class="lc-empty-text">No leads in this range yet.</div>`;
    }
    const rows = bySource.map(s => `
      <tr>
        <td><span class="perf-pill">${esc(s.source)}</span></td>
        <td>${s.total}</td>
        <td>${s.replied}</td>
        <td>${s.booked}</td>
        <td>${pct(s.replyRate)}</td>
      </tr>
    `).join('');
    return `
      <table class="perf-source-table">
        <thead>
          <tr><th>Source</th><th>Leads</th><th>Replied</th><th>Booked</th><th>Reply rate</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function emptyStateHtml() {
    return `
      <div class="perf-wrap">
        <div class="perf-head">
          <h2>Performance</h2>
          <div class="perf-range">
            ${rangeButton('7', '7 days')}
            ${rangeButton('30', '30 days')}
            ${rangeButton('90', '90 days')}
            ${rangeButton('all', 'All time')}
          </div>
        </div>
        <div class="lc-empty" style="margin-top:40px">
          <svg class="lc-empty-icon" viewBox="0 0 48 48" fill="none"><path d="M9 36l7-9 6 5 8-12 8 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 39h30" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          <div class="lc-empty-title">No leads yet in this range</div>
          <div class="lc-empty-text">Once leads start coming in, your reply rate and booking rate will show up here automatically.</div>
        </div>
      </div>
    `;
  }

  function bindRangeButtons() {
    document.querySelectorAll('.perf-range button').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.range;
        if (v === currentRange) return;
        currentRange = v;
        render();
      });
    });
  }

  window.PerformanceUI = { render };
})();
