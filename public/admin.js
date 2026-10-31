(function () {
  'use strict';
  var allUsers = [];
  var pendingConfirm = null;

  function getAdminKey() { return sessionStorage.getItem('bp_admin_key'); }
  function adminHeaders() { return { 'Content-Type': 'application/json', 'x-admin-key': getAdminKey() }; }

  // ── Login / Logout ─────────────────────────────────────────────
  function adminLogin() {
    var email = document.getElementById('adminEmail').value.trim();
    var pass  = document.getElementById('adminPass').value;
    var btn   = document.getElementById('adminLoginBtn');
    var err   = document.getElementById('loginError');
    err.classList.remove('show');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    var key;
    try {
      key = btoa(unescape(encodeURIComponent(email + ':' + pass)));
    } catch (e) {
      err.textContent = 'Invalid characters in credentials.';
      err.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Sign In';
      return;
    }
    fetch('/api/admin/login', { method: 'POST', headers: { 'x-admin-key': key } })
      .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
      .then(function(r) {
        if (r.ok && r.data.success) {
          sessionStorage.setItem('bp_admin_key', key);
          showAdmin();
        } else {
          err.textContent = r.data.message || 'Invalid credentials.';
          err.classList.add('show');
          btn.classList.add('anim-shake');
          setTimeout(function() { btn.classList.remove('anim-shake'); }, 600);
        }
      })
      .catch(function() { err.textContent = 'Could not connect to server.'; err.classList.add('show'); })
      .finally(function() { btn.disabled = false; btn.textContent = 'Sign In'; });
  }

  function adminLogout() {
    sessionStorage.removeItem('bp_admin_key');
    document.getElementById('adminLayout').classList.remove('visible');
    document.getElementById('loginScreen').style.display = 'flex';
  }

  function showAdmin() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('adminLayout').classList.add('visible');
    boot();
  }

  function boot() { loadStats(); loadUsers(); loadLeads(); loadSettings(); loadDbStatus(); loadSupportCounts(); }

  // ── Stats ──────────────────────────────────────────────────────
  function loadStats() {
    fetch('/api/admin/stats', { headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.success) return;
        animVal('statUsers', 0, d.users || 0);
        animVal('statLeads', 0, d.leads || 0);
        animVal('statPro',   0, d.proUsers || 0);
        var ra = document.getElementById('recentActivity');
        if (!d.recent || !d.recent.length) {
          ra.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:4px 0">No recent signups.</div>';
          return;
        }
        ra.innerHTML = d.recent.map(function(u) {
          return '<div class="activity-item">' +
            '<div class="activity-dot"></div>' +
            '<div class="activity-text">' + esc(u.name || 'Unknown') + ' — <span style="color:var(--text3)">' + esc(u.email) + '</span></div>' +
            '<div class="activity-time">' + (u.created_at ? String(u.created_at).slice(0,10) : '—') + '</div>' +
            '</div>';
        }).join('');
      })
      .catch(function(e) { console.error('[Admin] Stats:', e); });
  }

  // ── Users ──────────────────────────────────────────────────────
  function loadUsers() {
    fetch('/api/admin/users', { headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) { if (!d.success) return; allUsers = d.users || []; renderUserRows(allUsers); })
      .catch(function(e) { console.error('[Admin] Users:', e); });
  }

  function renderUserRows(users) {
    var tb = document.getElementById('usersTbody');
    if (!users.length) {
      tb.innerHTML = '<tr><td colspan="7" style="color:var(--text3);text-align:center;padding:24px">No users found.</td></tr>';
      return;
    }
    tb.innerHTML = users.map(function(u, i) {
      return '<tr style="animation:fadeInLeft 0.4s ease ' + (i * 0.03) + 's both">' +
        '<td data-label="Name" style="color:var(--text)">' + esc(u.name || '—') + '</td>' +
        '<td data-label="Email">' + esc(u.email) + '</td>' +
        '<td data-label="Plan"><select class="plan-select" data-user-id="' + u.id + '">' +
          '<option value="free"'       + (u.plan === 'free'       ? ' selected' : '') + '>Free</option>' +
          '<option value="starter"'    + (u.plan === 'starter'    ? ' selected' : '') + '>Starter</option>' +
          '<option value="growth"'     + (u.plan === 'growth'     ? ' selected' : '') + '>Growth</option>' +
          '<option value="business"'   + (u.plan === 'business'   ? ' selected' : '') + '>Pro</option>' +
        '</select></td>' +
        '<td data-label="Joined">' + (u.created_at ? String(u.created_at).slice(0,10) : '—') + '</td>' +
        '<td data-label="Leads">' + (u.leads_count != null ? u.leads_count : '—') + '</td>' +
        '<td data-label="Status">' + (u.is_banned ? '<span class="chip chip-banned">Banned</span>' : '<span class="chip chip-active">Active</span>') + '</td>' +
        '<td>' +
          '<button class="tbl-btn ' + (u.is_banned ? 'success' : 'warn') + '" data-action="ban" data-user-id="' + u.id + '" data-banned="' + (u.is_banned ? 1 : 0) + '" data-email="' + esc(u.email) + '">' + (u.is_banned ? 'Unban' : 'Ban') + '</button> ' +
          '<button class="tbl-btn danger" data-action="delete-user" data-user-id="' + u.id + '" data-email="' + esc(u.email) + '">Delete</button>' +
        '</td></tr>';
    }).join('');
  }

  function filterUsers() {
    var q = document.getElementById('userSearch').value.toLowerCase();
    renderUserRows(allUsers.filter(function(u) {
      return (u.name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
    }));
  }

  function changePlan(userId, plan) {
    fetch('/api/admin/users/' + userId + '/plan', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ plan: plan }) })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) showToast('Plan updated to ' + plan, 'success');
        else showToast(d.message || 'Failed', 'error');
      })
      .catch(function() { showToast('Network error', 'error'); });
  }

  function toggleBan(userId, currentlyBanned, email) {
    var action = currentlyBanned ? 'unban' : 'ban';
    confirmAction(
      (action === 'ban' ? 'Ban' : 'Unban') + ' User',
      'Are you sure you want to ' + action + ' ' + email + '?',
      function() {
        fetch('/api/admin/users/' + userId + '/ban', { method: 'POST', headers: adminHeaders() })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.success) { showToast('User ' + (d.banned ? 'banned' : 'unbanned'), 'success'); loadUsers(); }
            else showToast(d.message || 'Failed', 'error');
          })
          .catch(function() { showToast('Network error', 'error'); });
      }
    );
  }

  function confirmDeleteUser(userId, email) {
    confirmAction('Delete User', 'Permanently delete ' + email + ' and all their data? This cannot be undone.', function() {
      fetch('/api/admin/users/' + userId, { method: 'DELETE', headers: adminHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.success) { showToast('User deleted', 'success'); loadUsers(); loadStats(); }
          else showToast(d.message || 'Failed', 'error');
        })
        .catch(function() { showToast('Network error', 'error'); });
    });
  }

  // ── Leads ──────────────────────────────────────────────────────
  function loadLeads() {
    fetch('/api/admin/leads', { headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var tb = document.getElementById('leadsTbody');
        var rows = (d.success && d.leads) ? d.leads : [];
        if (!rows.length) {
          tb.innerHTML = '<tr><td colspan="7" style="color:var(--text3);text-align:center;padding:24px">No leads yet.</td></tr>';
          return;
        }
        tb.innerHTML = rows.map(function(l, i) {
          var statusCls = l.status === 'sent' ? 'chip-active' : l.status === 'error' ? 'chip-banned' : 'chip-warn';
          return '<tr style="animation:fadeInLeft 0.4s ease ' + (i * 0.03) + 's both">' +
            '<td data-label="Company" style="color:var(--text)">' + esc(l.company_name || l.domain || '—') + '</td>' +
            '<td data-label="Contact">' + esc(l.contact_name || l.contact_email || '—') + '</td>' +
            '<td data-label="User">' + esc(l.user_email || '—') + '</td>' +
            '<td data-label="Status"><span class="chip ' + statusCls + '">' + esc(l.status || 'new') + '</span></td>' +
            '<td data-label="Score" style="font-family:var(--font-mono);color:' + scoreColor(l.score) + '">' + (l.score != null ? l.score : '—') + '</td>' +
            '<td data-label="Date" style="color:var(--text3)">' + (l.created_at ? String(l.created_at).slice(0,10) : '—') + '</td>' +
            '<td><button class="tbl-btn danger" data-action="delete-lead" data-lead-id="' + l.id + '">Delete</button></td>' +
            '</tr>';
        }).join('');
      })
      .catch(function(e) { console.error('[Admin] Leads:', e); });
  }

  function confirmDeleteLead(id) {
    confirmAction('Delete Lead', 'Delete this lead record? This cannot be undone.', function() {
      fetch('/api/admin/leads/' + id, { method: 'DELETE', headers: adminHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.success) { showToast('Lead deleted', 'success'); loadLeads(); loadStats(); }
          else showToast(d.message || 'Failed', 'error');
        })
        .catch(function() { showToast('Network error', 'error'); });
    });
  }

  // ── Settings ───────────────────────────────────────────────────
  function loadSettings() {
    fetch('/api/admin/settings', { headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.success) return;
        var s = d.settings || {};
        setToggleState('toggle-signups',     s.signups_enabled !== '0');
        setToggleState('toggle-freetier',    s.free_tier_analyses !== '0');
        setToggleState('toggle-maintenance', s.maintenance_mode === '1');
        // whatsapp_feature_enabled defaults ON when not set
        setToggleState('toggle-whatsapp',    s.whatsapp_feature_enabled !== '0');
      })
      .catch(function(e) { console.error('[Admin] Settings:', e); });
  }

  function setToggleState(id, on) {
    var el = document.getElementById(id);
    if (!el) return;
    if (on) el.classList.add('on'); else el.classList.remove('on');
  }

  function toggleSetting(el, key) {
    el.classList.add('saving');
    var newOn = !el.classList.contains('on');
    fetch('/api/admin/settings', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ key: key, value: newOn ? '1' : '0' }) })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) { if (newOn) el.classList.add('on'); else el.classList.remove('on'); showToast('Setting saved', 'success'); }
        else showToast(d.message || 'Failed to save', 'error');
      })
      .catch(function() { showToast('Network error', 'error'); })
      .finally(function() { el.classList.remove('saving'); });
  }

  // ── DB Status ──────────────────────────────────────────────────
  function loadDbStatus() {
    fetch('/api/admin/db-status', { headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var dot = document.getElementById('dbDot');
        var msg = document.getElementById('dbConnMsg');
        var stat = document.getElementById('dbConnStatus');
        if (d.success) {
          dot.classList.remove('bad'); msg.textContent = 'Connected';
          stat.textContent = '✓'; stat.style.color = 'var(--good)';
        } else {
          dot.classList.add('bad'); msg.textContent = 'Disconnected';
          stat.textContent = '✗'; stat.style.color = 'var(--bad)';
        }
        animVal('dbUsersRows', 0, d.usersCount || 0);
        animVal('dbLeadsRows', 0, d.leadsCount || 0);
        var info = d.info || {};
        if (info.Driver)   document.getElementById('dbDriver').textContent  = info.Driver;
        if (info.Version)  document.getElementById('dbVersion').textContent = info.Version;
        if (info.Host)     document.getElementById('dbHost').textContent    = info.Host;
        if (info.Database) document.getElementById('dbName').textContent    = info.Database;
      })
      .catch(function(e) { console.error('[Admin] DB status:', e); });
  }

  // ── Navigation ─────────────────────────────────────────────────
  function switchSection(name, btn) {
    document.querySelectorAll('.admin-section').forEach(function(s) { s.classList.remove('active'); });
    document.querySelectorAll('.admin-nav-item').forEach(function(b) { b.classList.remove('active'); });
    document.getElementById('section-' + name).classList.add('active');
    btn.classList.add('active');
    if (name === 'overview') loadStats();
    if (name === 'users')    loadUsers();
    if (name === 'leads')    loadLeads();
    if (name === 'settings') loadSettings();
    if (name === 'db')       loadDbStatus();
    if (name === 'support')  { loadSupport(); }
  }

  // ── Utilities ──────────────────────────────────────────────────
  function confirmAction(title, body, onConfirm) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').textContent  = body;
    pendingConfirm = onConfirm;
    document.getElementById('confirmModal').classList.add('open');
  }

  function closeModal() {
    document.getElementById('confirmModal').classList.remove('open');
    pendingConfirm = null;
  }

  function showToast(msg, type) {
    var t = document.getElementById('adminToast');
    t.textContent = msg;
    t.className = 'admin-toast' + (type === 'success' ? ' success' : type === 'error' ? ' error' : '');
    t.style.display = 'block';
    t.style.animation = 'none';
    requestAnimationFrame(function() { t.style.animation = 'slideUp 0.3s ease'; });
    clearTimeout(t._timer);
    t._timer = setTimeout(function() { t.style.display = 'none'; }, 3000);
  }

  function animVal(id, from, to) {
    var el = document.getElementById(id);
    if (!el) return;
    var dur = 800, steps = 40, step = 0;
    var iv = setInterval(function() {
      step++;
      el.textContent = Math.round(from + (to - from) * (step / steps)).toLocaleString();
      if (step >= steps) { el.textContent = to.toLocaleString(); clearInterval(iv); }
    }, dur / steps);
  }

  function scoreColor(s) {
    if (s == null) return 'var(--text3)';
    return s >= 75 ? 'var(--good)' : s >= 50 ? 'var(--warn)' : 'var(--bad)';
  }

  function esc(s) {
    return String(s).replace(/[<>&"']/g, function(c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#x27;' }[c];
    });
  }

  // ── Event Listeners ────────────────────────────────────────────
  document.getElementById('adminLoginBtn').addEventListener('click', adminLogin);
  document.getElementById('adminLogoutBtn').addEventListener('click', adminLogout);
  document.getElementById('adminPass').addEventListener('keydown', function(e) { if (e.key === 'Enter') adminLogin(); });

  // Mobile sidebar
  var sidebar = document.getElementById('adminSidebar');
  var overlay = document.getElementById('sidebarOverlay');
  function toggleMobileMenu() { sidebar.classList.toggle('open'); overlay.classList.toggle('visible'); }
  document.getElementById('mobileNavToggle').addEventListener('click', toggleMobileMenu);
  overlay.addEventListener('click', toggleMobileMenu);

  // Mobile topbar visibility
  (function() {
    var topbar = document.getElementById('mobileTopbar');
    function checkTopbar() { if (topbar) topbar.style.display = window.innerWidth <= 1024 ? 'flex' : 'none'; }
    checkTopbar();
    window.addEventListener('resize', checkTopbar);
  })();

  // Nav buttons
  ['overview', 'users', 'leads', 'settings', 'db'].forEach(function(name) {
    document.getElementById('nav-' + name).addEventListener('click', function() {
      switchSection(name, this);
      if (window.innerWidth <= 1024) toggleMobileMenu();
    });
  });

  document.getElementById('userSearch').addEventListener('input', filterUsers);

  ['toggle-signups', 'toggle-freetier', 'toggle-maintenance', 'toggle-whatsapp'].forEach(function(id) {
    document.getElementById(id).addEventListener('click', function() { toggleSetting(this, this.dataset.key); });
  });

  document.getElementById('adminEmailInfoBtn').addEventListener('click', function() {
    showToast('Admin email set via ADMIN_EMAIL in .env — requires server restart.', 'info');
  });

  document.getElementById('confirmCancelBtn').addEventListener('click', closeModal);
  document.getElementById('modalConfirmBtn').addEventListener('click', function() {
    if (pendingConfirm) { pendingConfirm(); pendingConfirm = null; }
    closeModal();
  });
  document.getElementById('confirmModal').addEventListener('click', function(e) { if (e.target === this) closeModal(); });
  document.getElementById('editCancelBtn').addEventListener('click', function() { document.getElementById('editModal').classList.remove('open'); });

  // User table events
  document.getElementById('usersTbody').addEventListener('change', function(e) {
    var sel = e.target.closest('select.plan-select');
    if (sel) changePlan(sel.dataset.userId, sel.value);
  });
  document.getElementById('usersTbody').addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'ban')         toggleBan(btn.dataset.userId, Number(btn.dataset.banned), btn.dataset.email);
    if (btn.dataset.action === 'delete-user') confirmDeleteUser(btn.dataset.userId, btn.dataset.email);
  });

  // Leads table events
  document.getElementById('leadsTbody').addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action="delete-lead"]');
    if (btn) confirmDeleteLead(btn.dataset.leadId);
  });

  // ── Auto-login if key in session ───────────────────────────────
  (function() {
    var key = getAdminKey();
    if (!key) return;
    fetch('/api/admin/stats', { headers: { 'x-admin-key': key } })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
      .then(function(r) {
        if (r.ok && r.data.success) showAdmin();
        else sessionStorage.removeItem('bp_admin_key');
      })
      .catch(function() { sessionStorage.removeItem('bp_admin_key'); });
  })();

  // ── Support: messages from signed-in users ─────────────────────
  var SUP_STATUS = { open: 'Needs a reply', answered: 'Answered', resolved: 'Resolved' };
  var SUP_TOPIC  = { question: 'Question', problem: 'Problem', billing: 'Billing', feature: 'Feature idea', other: 'Other' };
  var currentTicketId = null;

  function supWhen(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function supNode(tag, text, style) { var n = document.createElement(tag); if (text != null) n.textContent = text; if (style) n.style.cssText = style; return n; }

  function setSupportBadge(open) {
    var b = document.getElementById('nav-support-badge');
    if (open > 0) { b.textContent = open; b.style.display = 'inline-flex'; } else { b.style.display = 'none'; }
  }
  function loadSupportCounts() {
    fetch('/api/admin/support/counts', { headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) { if (d.success) setSupportBadge(d.open); })
      .catch(function() {});
  }

  function loadSupport() {
    var tbody  = document.getElementById('supportInboxTbody');
    var filter = document.getElementById('supportInboxFilter').value;
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text3);text-align:center;padding:24px">Loading\u2026</td></tr>';
    fetch('/api/admin/support' + (filter ? '?status=' + encodeURIComponent(filter) : ''), { headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.success) { tbody.innerHTML = '<tr><td colspan="6" style="color:var(--bad);text-align:center;padding:24px">' + esc(d.message || 'Error') + '</td></tr>'; return; }
        setSupportBadge(d.open);
        document.getElementById('supportInboxTitle').textContent = 'Inbox' + (d.open ? ' \u00b7 ' + d.open + ' waiting for a reply' : '');
        if (!d.tickets.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text3);text-align:center;padding:24px">' + (filter === 'needs_reply' ? 'Nothing is waiting for a reply.' : 'No messages here.') + '</td></tr>';
          return;
        }
        tbody.innerHTML = '';
        d.tickets.forEach(function(t) {
          var tr = document.createElement('tr');
          var chipHtml = t.status === 'open' ? '<span class="chip chip-warn">' + SUP_STATUS.open + '</span>'
                       : t.status === 'answered' ? '<span class="chip chip-active">' + SUP_STATUS.answered + '</span>'
                       : '<span class="chip" style="background:rgba(11,37,42,0.05);color:var(--text3)">' + SUP_STATUS.resolved + '</span>';
          var who = t.user_name || t.user_email || 'Deleted user';
          tr.innerHTML =
            '<td data-label="From">' + esc(who) + (t.user_name && t.user_email ? '<div style="font-size:11px;color:var(--text3)">' + esc(t.user_email) + '</div>' : '') + '</td>' +
            '<td data-label="Subject" style="' + (t.admin_unread ? 'font-weight:600;color:var(--text)' : '') + '">' + esc(t.subject) +
              (t.admin_unread ? ' <span class="chip" style="background:var(--accent);color:#fff;margin-left:4px">New</span>' : '') +
              '<div style="font-size:11px;color:var(--text3);font-weight:400">' + t.message_count + (t.message_count === 1 ? ' message' : ' messages') + '</div></td>' +
            '<td data-label="Topic">' + esc(SUP_TOPIC[t.category] || t.category) + '</td>' +
            '<td data-label="Status">' + chipHtml + '</td>' +
            '<td data-label="Last activity">' + esc(supWhen(t.last_message_at)) + '</td>' +
            '<td><button class="tbl-btn" data-ticket="' + esc(t.id) + '">Open</button></td>';
          tbody.appendChild(tr);
        });
      })
      .catch(function() { tbody.innerHTML = '<tr><td colspan="6" style="color:var(--bad);text-align:center;padding:24px">Failed to load.</td></tr>'; });
  }

  function paintTicket(d) {
    var t = d.ticket;
    document.getElementById('ticketModalTitle').textContent = t.subject;
    var meta = document.getElementById('ticketModalMeta');
    meta.textContent = '';
    var who = (t.user_name || 'Unknown') + (t.user_email ? ' <' + t.user_email + '>' : '');
    meta.appendChild(document.createTextNode(who));
    meta.appendChild(document.createElement('br'));
    meta.appendChild(document.createTextNode(
      [SUP_TOPIC[t.category] || t.category, t.user_plan ? t.user_plan + ' plan' : '', t.user_company || ''].filter(Boolean).join(' \u00b7 ')));
    var thread = document.getElementById('ticketModalThread');
    thread.textContent = '';
    d.messages.forEach(function(m) {
      var admin = m.from === 'admin';
      var box = supNode('div', null, 'max-width:88%;' + (admin ? 'align-self:flex-end;' : ''));
      box.appendChild(supNode('div', (admin ? 'You' : (t.user_name || 'User')) + ' \u00b7 ' + supWhen(m.createdAt), 'font-size:11px;color:var(--text3);margin-bottom:4px;' + (admin ? 'text-align:right;' : '')));
      box.appendChild(supNode('div', m.body,
        'padding:10px 13px;border-radius:10px;font-size:13.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;' +
        (admin ? 'background:var(--accent);color:#fff;' : 'background:var(--surface2);border:1px solid var(--border);color:var(--text);')));
      thread.appendChild(box);
    });
    thread.scrollTop = thread.scrollHeight;
    document.getElementById('ticketStatus').value = t.status;
    document.getElementById('ticketNote').value = t.admin_note || '';
  }

  function openTicket(id) {
    currentTicketId = id;
    fetch('/api/admin/support/' + encodeURIComponent(id), { headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.success) { showToast(d.message || 'Failed to load', 'error'); return; }
        paintTicket(d);
        document.getElementById('ticketReply').value = '';
        document.getElementById('ticketAfter').value = 'answered';
        document.getElementById('ticketModal').classList.add('open');
        document.getElementById('ticketReply').focus();
        loadSupport();
      })
      .catch(function() { showToast('Failed to load', 'error'); });
  }
  function closeTicket() { document.getElementById('ticketModal').classList.remove('open'); currentTicketId = null; loadSupport(); }

  function ticketPost(path, body, okMsg, after) {
    return fetch('/api/admin/support/' + encodeURIComponent(currentTicketId) + path, { method: 'POST', headers: adminHeaders(), body: JSON.stringify(body) })
      .then(function(r) { return r.json(); })
      .then(function(d) { if (d.success) { showToast(okMsg(d), 'success'); if (after) after(d); } else showToast(d.message || 'Failed', 'error'); })
      .catch(function() { showToast('Failed', 'error'); });
  }

  document.getElementById('nav-support').addEventListener('click', function() { switchSection('support', this); });
  document.getElementById('supportInboxFilter').addEventListener('change', loadSupport);
  document.getElementById('supportInboxRefresh').addEventListener('click', loadSupport);
  document.getElementById('supportInboxTbody').addEventListener('click', function(e) {
    var b = e.target.closest('[data-ticket]'); if (b) openTicket(b.dataset.ticket);
  });
  document.getElementById('ticketCloseBtn').addEventListener('click', closeTicket);
  document.getElementById('ticketSendBtn').addEventListener('click', function() {
    var btn = this, ta = document.getElementById('ticketReply'), text = ta.value.trim();
    if (!text) { showToast('Write a reply first', 'error'); return; }
    var id = currentTicketId;
    btn.disabled = true;
    ticketPost('/reply', { message: text, status: document.getElementById('ticketAfter').value },
      function(d) { return d.emailed ? 'Reply sent and emailed' : 'Reply sent (email could not be delivered)'; },
      function() { ta.value = ''; openTicket(id); loadSupportCounts(); }
    ).then(function() { btn.disabled = false; });
  });
  document.getElementById('ticketStatus').addEventListener('change', function() {
    ticketPost('', { status: this.value }, function() { return 'Status updated'; }, function() { loadSupportCounts(); });
  });
  document.getElementById('ticketNoteBtn').addEventListener('click', function() {
    ticketPost('', { admin_note: document.getElementById('ticketNote').value }, function() { return 'Note saved'; });
  });
  document.getElementById('ticketDeleteBtn').addEventListener('click', function() {
    var id = currentTicketId;
    confirmAction('Delete conversation', 'This permanently removes the conversation and all its messages, including from the user\u2019s Support page.', function() {
      fetch('/api/admin/support/' + encodeURIComponent(id), { method: 'DELETE', headers: adminHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.success) { showToast('Deleted', 'success'); closeTicket(); loadSupportCounts(); } else showToast(d.message || 'Failed', 'error');
        });
    });
  });

})();
