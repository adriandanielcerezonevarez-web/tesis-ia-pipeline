(() => {
  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------
  const CONFIG = {
    SESSION_KEY: 'helpdesk_session',
    USERS_KEY: 'helpdesk_users',
    DB_KEY: 'helpdesk_tickets',
    COUNTER_KEY: 'helpdesk_counter',
    TECNICOS: [
      'Ing. Jose Fernandez',
      'Ing. Luis Marquez',
      'Ing. Eric Villagomez',
      'Ing. Ivan Rodrigues'
    ]
  };

  // -------------------------------------------------------------------------
  // State (encapsulated)
  // -------------------------------------------------------------------------
  const state = {
    session: null,
    db: null,
    useFirebase: false,
    unsubscribeTickets: null,
    tickets: [],
    users: [],
    currentSection: '',
    editingId: null,
    pendingDeleteId: null
  };

  // -------------------------------------------------------------------------
  // Utility Functions
  // -------------------------------------------------------------------------
  const escHtml = (str) =>
    String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const sanitizeInput = (value) => value.replace(/[<>]/g, '');

  const trySet = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  const tryVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };

  const tryWidth = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.style.width = val;
  };

  const formatDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  };

  const formatDateFull = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const statusBadgeHtml = (status) => {
    const map = {
      Abierto: 'badge-abierto',
      'En Progreso': 'badge-progreso',
      Resuelto: 'badge-resuelto',
      Cerrado: 'badge-cerrado'
    };
    const cls = map[status] || '';
    const span = document.createElement('span');
    span.className = `badge ${cls}`;
    span.textContent = status;
    return span.outerHTML;
  };

  const priorityBadgeHtml = (priority) => {
    const map = {
      Crítica: 'badge-critica',
      Alta: 'badge-alta',
      Media: 'badge-media',
      Baja: 'badge-baja'
    };
    const cls = map[priority] || '';
    const span = document.createElement('span');
    span.className = `badge ${cls}`;
    span.textContent = priority;
    return span.outerHTML;
  };

  const categoryEmoji = () => '';

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  const handleError = (err, context = '') => {
    console.error(`Error${context ? ` (${context})` : ''}:`, err);
    showToast(`Error${context ? ` (${context})` : ''}: ${err.message || err}`, 'error');
  };

  // -------------------------------------------------------------------------
  // Firebase Service
  // -------------------------------------------------------------------------
  const firebaseService = {
    init() {
      if (typeof FIREBASE_CONFIGURED === 'undefined' || !FIREBASE_CONFIGURED) return;
      try {
        if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
        state.db = firebase.firestore();
        state.useFirebase = true;
        console.log('Firestore conectado');
      } catch (err) {
        handleError(err, 'Firebase init');
        state.useFirebase = false;
        state.db = null;
      }
    },

    async nextTicketId() {
      const counterRef = state.db.collection('meta').doc('counter');
      return state.db.runTransaction(async (t) => {
        const snap = await t.get(counterRef);
        const next = (snap.exists ? snap.data().value : 0) + 1;
        t.set(counterRef, { value: next });
        return `TK-${String(next).padStart(4, '0')}`;
      });
    },

    async loadUsers() {
      const snap = await state.db.collection('users').get();
      return snap.docs.map((d) => d.data());
    },

    async subscribeTickets(callback) {
      state.unsubscribeTickets = state.db
        .collection('tickets')
        .orderBy('createdAt', 'desc')
        .onSnapshot(
          (snap) => {
            state.tickets = snap.docs.map((d) => d.data());
            callback();
          },
          (err) => handleError(err, 'onSnapshot')
        );
    },

    async loadInitialTickets() {
      const snap = await state.db
        .collection('tickets')
        .orderBy('createdAt', 'desc')
        .get();
      state.tickets = snap.docs.map((d) => d.data());
    }
  };

  // -------------------------------------------------------------------------
  // Local Storage Service
  // -------------------------------------------------------------------------
  const localStorageService = {
    load(key) {
      try {
        return JSON.parse(localStorage.getItem(key)) || [];
      } catch {
        return [];
      }
    },

    save(key, data) {
      localStorage.setItem(key, JSON.stringify(data));
    },

    generateTicketId() {
      const current = parseInt(localStorage.getItem(CONFIG.COUNTER_KEY) || '0', 10);
      const next = current + 1;
      localStorage.setItem(CONFIG.COUNTER_KEY, String(next));
      return `TK-${String(next).padStart(4, '0')}`;
    }
  };

  // -------------------------------------------------------------------------
  // Authentication Module
  // -------------------------------------------------------------------------
  const auth = {
    init() {
      const stored = sessionStorage.getItem(CONFIG.SESSION_KEY);
      if (!stored) {
        if (!window.location.pathname.endsWith('login.html')) {
          window.location.href = 'login.html';
        }
        return false;
      }
      try {
        state.session = JSON.parse(stored);
      } catch (err) {
        handleError(err, 'Auth parse');
        sessionStorage.removeItem(CONFIG.SESSION_KEY);
        window.location.href = 'login.html';
        return false;
      }
      document.body.classList.add(`role-${state.session.role}`);

      const map = {
        userDisplayName: state.session.name,
        userDisplayRole: state.session.role === 'admin' ? 'Administrador' : 'Usuario',
        userAvatar: state.session.name.charAt(0).toUpperCase(),
        topbarRoleBadge: state.session.role === 'admin' ? 'Admin' : 'Usuario'
      };
      Object.entries(map).forEach(([id, text]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      });
      return true;
    },

    logout() {
      if (state.unsubscribeTickets) state.unsubscribeTickets();
      sessionStorage.removeItem(CONFIG.SESSION_KEY);
      window.location.href = 'login.html';
    }
  };

  // -------------------------------------------------------------------------
  // UI Module
  // -------------------------------------------------------------------------
  const ui = {
    updateConnectionBadge(online) {
      const foot = document.getElementById('sidebarConnStatus');
      if (!foot) return;
      foot.textContent = online ? 'online' : 'modo local';
      foot.style.color = online ? '#2e7d32' : '#b76e00';
    },

    setupSidebar() {
      const toggle = document.getElementById('sidebarToggle');
      const sidebar = document.getElementById('sidebar');
      if (toggle && sidebar) {
        toggle.addEventListener('click', () => {
          sidebar.classList.toggle('collapsed');
          document.body.classList.toggle('collapsed');
        });
      }
      const sidebarFoot = document.querySelector('.sidebar-footer');
      if (sidebarFoot && !document.getElementById('sidebarConnStatus')) {
        const statusDiv = document.createElement('div');
        statusDiv.id = 'sidebarConnStatus';
        statusDiv.style.cssText = 'padding:4px 8px;text-align:center';
        sidebarFoot.prepend(statusDiv);
      }
    },

    showSection(name) {
      if (state.session.role === 'user' && ['dashboard', 'tickets', 'reports', 'users'].includes(name)) return;

      state.currentSection = name;

      document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
      const navEl = document.getElementById(`nav-${name}`);
      if (navEl) navEl.classList.add('active');

      document.querySelectorAll('.section').forEach((el) => el.classList.remove('active'));
      const sec = document.getElementById(`section-${name}`);
      if (sec) sec.classList.add('active');

      const meta = SECTION_META[name] || { title: name, subtitle: '' };
      trySet('pageTitle', meta.title);
      trySet('pageSubtitle', meta.subtitle);

      const sbox = document.getElementById('searchBox');
      if (sbox) sbox.style.display = ['tickets', 'mytickets'].includes(name) ? 'flex' : 'none';

      switch (name) {
        case 'dashboard':
          renderDashboard();
          break;
        case 'tickets':
          renderTicketsList();
          break;
        case 'mytickets':
          renderMyTickets();
          break;
        case 'reports':
          renderReports();
          break;
        case 'users':
          renderUsersList();
          break;
        case 'create':
          if (!state.editingId) resetForm();
          break;
      }
    },

    showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      if (!container) return;
      const t = document.createElement('div');
      t.className = `toast toast-${type}`;
      t.textContent = message;
      container.appendChild(t);
      setTimeout(() => {
        t.classList.add('hide');
        t.addEventListener('animationend', () => t.remove());
      }, 3200);
    },

    openModal(id) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('open');
        document.body.style.overflow = 'hidden';
      }
    },

    closeModalById(id) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('open');
        document.body.style.overflow = '';
      }
    },

    closeTicketModal() {
      this.closeModalById('ticketModal');
    },

    closeConfirmModal(e) {
      if (e && e.target !== e.currentTarget) return;
      this.closeModalById('confirmModal');
      state.pendingDeleteId = null;
      const btn = document.getElementById('confirmDeleteBtn');
      if (btn) btn.onclick = executeDelete;
    },

    setupCharCounter() {
      const desc = document.getElementById('ticketDescription');
      const count = document.getElementById('charCount');
      if (desc && count) {
        desc.addEventListener('input', () => {
          count.textContent = `${desc.value.length} / 2000`;
        });
      }
    }
  };

  // -------------------------------------------------------------------------
  // Data Seeding
  // -------------------------------------------------------------------------
  const seedDemoData = async () => {
    if (state.tickets.length) return;
    const demos = [
      {
        title: 'No enciende la laptop',
        category: 'Hardware',
        priority: 'Alta',
        status: 'Abierto',
        assigned: 'profesor',
        requester: 'Adrian',
        requesterId: 'u3',
        email: 'adrian@empresa.com',
        description: 'La laptop no enciende al presionar el botón de encendido.',
        notes: '',
        createdAt: new Date(Date.now() - 86400000 * 3).toISOString()
      },
      {
        title: 'Actualización falla',
        category: 'Software',
        priority: 'Baja',
        status: 'Resuelto',
        assigned: 'admin',
        requester: 'Allison',
        requesterId: 'u4',
        email: 'allison@empresa.com',
        description: 'Error 0x8007 al actualizar Windows.',
        notes: 'Limpieza de cache.',
        createdAt: new Date(Date.now() - 86400000 * 5).toISOString()
      }
    ];

    if (state.useFirebase) {
      try {
        const batch = state.db.batch();
        for (const d of demos) {
          const id = await firebaseService.nextTicketId();
          batch.set(state.db.collection('tickets').doc(id), { id, ...d });
          state.tickets.push({ id, ...d });
        }
        await batch.commit();
      } catch (err) {
        handleError(err, 'seedDemoData Firebase');
      }
    } else {
      demos.forEach((d) => {
        const id = localStorageService.generateTicketId();
        state.tickets.push({ id, ...d });
      });
      localStorageService.save(CONFIG.DB_KEY, state.tickets);
    }
  };

  // -------------------------------------------------------------------------
  // Fallback to Local Storage
  // -------------------------------------------------------------------------
  const fallbackToLocal = () => {
    ui.updateConnectionBadge(false);
    state.tickets = localStorageService.load(CONFIG.DB_KEY);
    state.users = localStorageService.load(CONFIG.USERS_KEY);
    seedDemoData();
  };

  // -------------------------------------------------------------------------
  // Rendering Functions
  // -------------------------------------------------------------------------
  const renderAll = () => {
    if (state.session.role === 'admin') {
      renderDashboard();
      renderTicketsList();
      renderReports();
      renderUsersList();
    } else {
      renderMyTickets();
    }
    updateNavBadge();
  };

  const updateNavBadge = () => {
    if (state.session.role === 'admin') {
      const open = state.tickets.filter((t) => t.status === 'Abierto').length;
      const badge = document.getElementById('nav-badge');
      if (badge) badge.textContent = open;
    } else {
      const open = state.tickets.filter(
        (t) => t.requesterId === state.session.userId && !['Cerrado', 'Resuelto'].includes(t.status)
      ).length;
      const badge = document.getElementById('nav-badge-user');
      if (badge) badge.textContent = open;
    }
  };

  const renderDashboard = () => {
    if (state.session.role !== 'admin') return;
    const total = state.tickets.length;
    const open = state.tickets.filter((t) => t.status === 'Abierto').length;
    const progress = state.tickets.filter((t) => t.status === 'En Progreso').length;
    const closed = state.tickets.filter((t) => ['Resuelto', 'Cerrado'].includes(t.status)).length;

    trySet('stat-total', total);
    trySet('stat-open', open);
    trySet('stat-progress', progress);
    trySet('stat-closed', closed);

    const priorityCounts = { Crítica: 0, Alta: 0, Media: 0, Baja: 0 };
    state.tickets.forEach((t) => {
      if (priorityCounts[t.priority] !== undefined) priorityCounts[t.priority]++;
    });
    const maxP = Math.max(...Object.values(priorityCounts), 1);
    ['Crítica', 'Alta', 'Media', 'Baja'].forEach((p) => {
      tryWidth(`bar-${p.toLowerCase()}`, `${(priorityCounts[p] / maxP) * 100}%`);
      trySet(`count-${p.toLowerCase()}`, priorityCounts[p]);
    });

    const catCounts = {};
    state.tickets.forEach((t) => {
      catCounts[t.category] = (catCounts[t.category] || 0) + 1;
    });
    const catEl = document.getElementById('categoryStats');
    if (catEl) {
      const sorted = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
      catEl.innerHTML = sorted.length
        ? sorted
            .map(
              ([c, n]) =>
                `<div class="category-stat-item"><span class="category-stat-name">${escHtml(c)}</span><span class="category-stat-count">${n}</span></div>`
            )
            .join('')
        : '<div class="empty-state-small">Sin datos</div>';
    }

    const recent = [...state.tickets]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);
    const recEl = document.getElementById('recentTicketsList');
    if (recEl) {
      recEl.innerHTML = recent.length
        ? recent
            .map(
              (t) =>
                `<div class="recent-ticket-item" onclick="openTicketModal('${t.id}')"><span class="recent-ticket-id">${t.id}</span><span class="recent-ticket-title">${escHtml(t.title)}</span><span class="recent-ticket-meta">${statusBadgeHtml(t.status)}</span></div>`
            )
            .join('')
        : '<div class="empty-state-small">No hay tickets</div>';
    }
  };

  const renderTicketsList = (filtered) => {
    if (state.session.role !== 'admin') return;
    const list = filtered !== undefined ? filtered : applyFilters(state.tickets);
    const tbody = document.getElementById('ticketsTableBody');
    const empty = document.getElementById('emptyState');
    if (!tbody || !empty) return;

    if (list.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'flex';
      empty.style.flexDirection = 'column';
      empty.style.alignItems = 'center';
    } else {
      empty.style.display = 'none';
      tbody.innerHTML = list
        .map(
          (t) => `
        <tr onclick="openTicketModal('${t.id}')">
          <td class="ticket-id-cell">${t.id}</td>
          <td class="ticket-title-cell" title="${escHtml(t.title)}">${escHtml(t.title)}</td>
          <td><span class="badge badge-category">${categoryEmoji(t.category)} ${escHtml(t.category)}</span></td>
          <td>${priorityBadgeHtml(t.priority)}</td>
          <td>${statusBadgeHtml(t.status)}</td>
          <td style="color:var(--text-secondary)">${escHtml(t.assigned || '—')}</td>
          <td style="color:var(--text-secondary)">${escHtml(t.requester || '—')}</td>
          <td style="color:var(--text-muted);font-size:12px;">${formatDate(t.createdAt)}</td>
          <td onclick="event.stopPropagation()">
            <div class="action-buttons">
              <button class="action-btn" title="Ver" onclick="openTicketModal('${t.id}')">👁️</button>
              <button class="action-btn" title="Editar" onclick="editTicket('${t.id}')">✏️</button>
              <button class="action-btn" title="Asignar técnico" onclick="asignarTecnico('${t.id}')">⚙️</button>
              <button class="action-btn danger" title="Eliminar" onclick="confirmDelete('${t.id}')">🗑️</button>
            </div>
          </td>
        </tr>
      `
        )
        .join('');
    }
  };

  const renderMyTickets = () => {
    if (state.session.role !== 'user') return;
    const myTickets = state.tickets.filter((t) => t.requesterId === state.session.userId);

    trySet('bannerName', `Hola, ${state.session.name.split(' ')[0]}`);
    trySet('ustat-total', myTickets.length);
    trySet('ustat-open', myTickets.filter((t) => t.status === 'Abierto').length);
    trySet('ustat-progress', myTickets.filter((t) => t.status === 'En Progreso').length);
    trySet(
      'ustat-closed',
      myTickets.filter((t) => ['Resuelto', 'Cerrado'].includes(t.status)).length
    );

    const search = document.getElementById('searchInput')?.value.trim().toLowerCase() || '';
    let list = myTickets;
    if (search) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(search) ||
          t.id.toLowerCase().includes(search) ||
          (t.requester || '').toLowerCase().includes(search)
      );
    }
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const tbody = document.getElementById('myTicketsBody');
    const empty = document.getElementById('myEmptyState');
    if (!tbody || !empty) return;

    if (list.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'flex';
      empty.style.flexDirection = 'column';
      empty.style.alignItems = 'center';
    } else {
      empty.style.display = 'none';
      tbody.innerHTML = list
        .map(
          (t) => `
        <tr onclick="openTicketModal('${t.id}')">
          <td class="ticket-id-cell">${t.id}</td>
          <td class="ticket-title-cell" title="${escHtml(t.title)}">${escHtml(t.title)}</td>
          <td><span class="badge badge-category">${categoryEmoji(t.category)} ${escHtml(t.category)}</span></td>
          <td>${priorityBadgeHtml(t.priority)}</td>
          <td>${statusBadgeHtml(t.status)}</td>
          <td style="color:var(--text-muted);font-size:12px;">${formatDate(t.createdAt)}</td>
          <td onclick="event.stopPropagation()">
            <div class="action-buttons">
              <button class="action-btn" title="Ver" onclick="openTicketModal('${t.id}')">👁️</button>
              <button class="action-btn" title="Editar" onclick="editTicket('${t.id}')" ${
                ['Cerrado', 'Resuelto'].includes(t.status) ? 'disabled style="opacity:0.5"' : ''
              }>✏️</button>
            </div>
          </td>
        </tr>
      `
        )
        .join('');
    }
  };

  const applyFilters = (src) => {
    const status = document.getElementById('filterStatus')?.value || '';
    const priority = document.getElementById('filterPriority')?.value || '';
    const category = document.getElementById('filterCategory')?.value || '';
    const sort = document.getElementById('filterSort')?.value || 'newest';
    const search = document.getElementById('searchInput')?.value.trim().toLowerCase() || '';

    let result = src.filter((t) => {
      if (status && t.status !== status) return false;
      if (priority && t.priority !== priority) return false;
      if (category && t.category !== category) return false;
      if (
        search &&
        !t.title.toLowerCase().includes(search) &&
        !t.id.toLowerCase().includes(search) &&
        !(t.requester || '').toLowerCase().includes(search)
      )
        return false;
      return true;
    });

    result.sort((a, b) => {
      if (sort === 'newest') return new Date(b.createdAt) - new Date(a.createdAt);
      if (sort === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt);
      if (sort === 'priority') {
        const order = { Crítica: 0, Alta: 1, Media: 2, Baja: 3 };
        return (order[a.priority] ?? 99) - (order[b.priority] ?? 99);
      }
      if (sort === 'status') return a.status.localeCompare(b.status);
      return 0;
    });
    return result;
  };

  // -------------------------------------------------------------------------
  // Ticket Modal
  // -------------------------------------------------------------------------
  const openTicketModal = (id) => {
    const t = state.tickets.find((x) => x.id === id);
    if (!t) return;
    if (state.session.role === 'user' && t.requesterId !== state.session.userId) {
      ui.showToast('No tienes permiso para ver este ticket', 'error');
      return;
    }

    trySet('modalId', t.id);
    trySet('modalTitle', t.title);
    document.getElementById('modalBadges').innerHTML = `
      ${statusBadgeHtml(t.status)} ${priorityBadgeHtml(t.priority)} <span class="badge badge-category">${categoryEmoji(t.category)} ${escHtml(t.category)}</span>
    `;

    let notesHtml = '';
    if (state.session.role === 'admin' && t.notes) {
      notesHtml = `<div class="modal-notes-label">Notas internas (solo admin)</div><div class="modal-notas">${escHtml(t.notes)}</div>`;
    }

    document.getElementById('modalBody').innerHTML = `
      <div class="modal-detail-grid">
        <div class="modal-detail-item"><div class="modal-detail-label">Solicitante</div><div class="modal-detail-value">${escHtml(t.requester || '—')}</div></div>
        <div class="modal-detail-item"><div class="modal-detail-label">Asignado a</div><div class="modal-detail-value">${escHtml(t.assigned || '—')}</div></div>
        ${
          state.session.role === 'admin'
            ? `<div class="modal-detail-item"><div class="modal-detail-label">Email</div><div class="modal-detail-value">${
                t.email
                  ? `<a href="mailto:${escHtml(t.email)}" style="color:var(--accent-light)">${escHtml(t.email)}</a>`
                  : '—'
              }</div></div>`
            : ''
        }
        <div class="modal-detail-item"><div class="modal-detail-label">Creado</div><div class="modal-detail-value">${formatDateFull(t.createdAt)}</div></div>
      </div>
      <div class="modal-detail-label" style="margin-bottom:8px">Descripción</div>
      <div class="modal-description">${escHtml(t.description)}</div>
      ${notesHtml}
    `;

    const editBtn = document.getElementById('modalEditBtn');
    if (editBtn) {
      if (state.session.role === 'admin' || !['Resuelto', 'Cerrado'].includes(t.status)) {
        editBtn.style.display = 'inline-flex';
        editBtn.onclick = () => {
          ui.closeTicketModal();
          editTicket(id);
        };
      } else {
        editBtn.style.display = 'none';
      }
    }

    const delBtn = document.getElementById('modalDeleteBtn');
    if (delBtn) delBtn.onclick = () => {
      ui.closeTicketModal();
      confirmDelete(id);
    };

    ui.openModal('ticketModal');
  };

  // -------------------------------------------------------------------------
  // Ticket Form
  // -------------------------------------------------------------------------
  const resetForm = () => {
    state.editingId = null;
    const form = document.getElementById('ticketForm');
    if (form) form.reset();

    trySet('ticketId', '');
    const statusEl = document.getElementById('ticketStatus');
    if (statusEl) statusEl.value = 'Abierto';

    if (state.session.role === 'user') {
      const reqField = document.getElementById('ticketRequester');
      const mailField = document.getElementById('ticketEmail');
      if (reqField) {
        reqField.value = state.session.name;
        reqField.readOnly = true;
      }
      if (mailField) {
        mailField.value = state.session.email || '';
        mailField.readOnly = true;
      }
    }

    trySet('formTitle', 'Crear Nuevo Ticket');
    const badge = document.getElementById('formIdBadge');
    if (badge) badge.style.display = 'none';
    trySet('charCount', '0 / 2000');

    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) submitBtn.textContent = 'Guardar Ticket';

    trySet('pageTitle', 'Nuevo Ticket');
    trySet('pageSubtitle', 'Crear un nuevo ticket de soporte');
  };

  const editTicket = (id) => {
    const t = state.tickets.find((x) => x.id === id);
    if (!t) return;
    if (state.session.role === 'user' && t.requesterId !== state.session.userId) {
      ui.showToast('Acceso denegado', 'error');
      return;
    }

    state.editingId = id;
    tryVal('ticketId', t.id);
    tryVal('ticketTitle', t.title);
    tryVal('ticketCategory', t.category);
    tryVal('ticketPriority', t.priority);
    tryVal('ticketStatus', t.status);
    tryVal('ticketAssigned', t.assigned || '');
    tryVal('ticketRequester', t.requester);
    tryVal('ticketEmail', t.email || '');
    tryVal('ticketDescription', t.description);
    tryVal('ticketNotes', t.notes || '');
    trySet('charCount', `${t.description.length} / 2000`);

    trySet('formTitle', 'Editar Ticket');
    const badge = document.getElementById('formIdBadge');
    if (badge) {
      badge.textContent = t.id;
      badge.style.display = 'inline-block';
    }
    trySet('pageTitle', `Editar ${t.id}`);
    trySet('pageSubtitle', t.title);

    ui.showSection('create');
  };

  const saveTicket = async (e) => {
    e.preventDefault();
    const title = sanitizeInput(document.getElementById('ticketTitle').value.trim());
    const category = document.getElementById('ticketCategory').value;
    const priority = document.getElementById('ticketPriority').value;
    const description = sanitizeInput(document.getElementById('ticketDescription').value.trim());

    const status = document.getElementById('ticketStatus')?.value || 'Abierto';
    const assigned = sanitizeInput(document.getElementById('ticketAssigned').value.trim()) || '';
    const requester = sanitizeInput(document.getElementById('ticketRequester').value.trim()) || state.session.name;
    const email = sanitizeInput(document.getElementById('ticketEmail').value.trim()) || '';
    const notes = sanitizeInput(document.getElementById('ticketNotes').value.trim()) || '';
    const requesterId = state.session.role === 'admin' ? null : state.session.userId;

    try {
      if (state.useFirebase) {
        if (state.editingId) {
          const updateData =
            state.session.role === 'admin'
              ? { title, category, priority, status, assigned, requester, email, description, notes, updatedAt: new Date().toISOString() }
              : { title, category, priority, description, updatedAt: new Date().toISOString() };
          await state.db.collection('tickets').doc(state.editingId).update(updateData);
          ui.showToast('Ticket actualizado', 'success');
        } else {
          const id = await firebaseService.nextTicketId();
          const newTicket = {
            id,
            title,
            category,
            priority,
            status,
            assigned,
            requester,
            requesterId,
            email,
            description,
            notes,
            createdAt: new Date().toISOString()
          };
          await state.db.collection('tickets').doc(id).set(newTicket);
          ui.showToast(`Ticket ${id} creado`, 'success');
        }
      } else {
        if (state.editingId) {
          const idx = state.tickets.findIndex((t) => t.id === state.editingId);
          if (idx !== -1) {
            const base = {
              title,
              category,
              priority,
              description,
              updatedAt: new Date().toISOString()
            };
            if (state.session.role === 'admin') {
              Object.assign(state.tickets[idx], {
                ...base,
                status,
                assigned,
                requester,
                email,
                notes
              });
            } else {
              Object.assign(state.tickets[idx], base);
            }
            localStorageService.save(CONFIG.DB_KEY, state.tickets);
            ui.showToast('Ticket actualizado', 'success');
          }
        } else {
          const newTicket = {
            id: localStorageService.generateTicketId(),
            title,
            category,
            priority,
            status,
            assigned,
            requester,
            requesterId,
            email,
            description,
            notes,
            createdAt: new Date().toISOString()
          };
          state.tickets.unshift(newTicket);
          localStorageService.save(CONFIG.DB_KEY, state.tickets);
          ui.showToast(`Ticket ${newTicket.id} creado`, 'success');
        }
        renderAll();
      }
    } catch (err) {
      handleError(err, 'saveTicket');
      return;
    }

    state.editingId = null;
    ui.showSection(state.session.role === 'admin' ? 'tickets' : 'mytickets');
  };

  const cancelForm = () => {
    state.editingId = null;
    ui.showSection(state.session.role === 'admin' ? 'tickets' : 'mytickets');
  };

  // -------------------------------------------------------------------------
  // Technician Assignment
  // -------------------------------------------------------------------------
  const asignarTecnico = (id) => {
    if (state.session.role !== 'admin') {
      ui.showToast('Acceso denegado', 'error');
      return;
    }
    cerrarMenuAsignar();
    const overlay = document.createElement('div');
    overlay.id = 'asignarOverlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:1000;display:flex;align-items:center;justify-content:center;';
    overlay.onclick = (e) => {
      if (e.target === overlay) cerrarMenuAsignar();
    };
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:6px;padding:18px 20px;min-width:280px;box-shadow:0 4px 18px rgba(0,0,0,.22);';
    const title = document.createElement('h3');
    title.style.margin = '0 0 12px';
    title.style.fontSize = '15px';
    title.textContent = `Asignar técnico al ticket ${id}`;
    box.appendChild(title);
    CONFIG.TECNICOS.forEach((tec) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-sm';
      btn.style.cssText = 'display:block;width:100%;text-align:left;margin-bottom:6px;';
      btn.textContent = tec;
      btn.onclick = () => asignarTecnicoA(id, tec);
      box.appendChild(btn);
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost btn-sm';
    cancelBtn.style.cssText = 'margin-top:4px;color:var(--text-muted);';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.onclick = cerrarMenuAsignar;
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  };

  const cerrarMenuAsignar = () => {
    const o = document.getElementById('asignarOverlay');
    if (o) o.remove();
  };

  const asignarTecnicoA = async (id, tecnico) => {
    cerrarMenuAsignar();
    if (state.session.role !== 'admin') return;
    try {
      if (state.useFirebase) {
        await state.db.collection('tickets').doc(id).update({ assigned: tecnico, updatedAt: new Date().toISOString() });
      } else {
        const idx = state.tickets.findIndex((t) => t.id === id);
        if (idx !== -1) {
          state.tickets[idx] = { ...state.tickets[idx], assigned: tecnico, updatedAt: new Date().toISOString() };
          localStorageService.save(CONFIG.DB_KEY, state.tickets);
        }
      }
      ui.showToast(`Ticket ${id} asignado a ${tecnico}`, 'success');
      renderAll();
    } catch (err) {
      handleError(err, 'asignarTecnicoA');
    }
  };

  // -------------------------------------------------------------------------
  // Delete Ticket
  // -------------------------------------------------------------------------
  const confirmDelete = (id) => {
    if (state.session.role !== 'admin') return;
    state.pendingDeleteId = id;
    ui.openModal('confirmModal');
  };

  const executeDelete = async () => {
    if (!state.pendingDeleteId) return;
    try {
      if (state.useFirebase) {
        await state.db.collection('tickets').doc(state.pendingDeleteId).delete();
      } else {
        state.tickets = state.tickets.filter((t) => t.id !== state.pendingDeleteId);
        localStorageService.save(CONFIG.DB_KEY, state.tickets);
      }
      ui.showToast('Ticket eliminado', 'info');
      renderAll();
    } catch (err) {
      handleError(err, 'executeDelete');
    }
    state.pendingDeleteId = null;
    ui.closeConfirmModal();
  };

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------
  const renderReports = () => {
    if (state.session.role !== 'admin') return;
    const total = state.tickets.length;
    const open = state.tickets.filter((t) => t.status === 'Abierto').length;
    const progress = state.tickets.filter((t) => t.status === 'En Progreso').length;
    const resolved = state.tickets.filter((t) => t.status === 'Resuelto').length;
    const closed = state.tickets.filter((t) => t.status === 'Cerrado').length;
    const critica = state.tickets.filter((t) => t.priority === 'Crítica').length;
    const assigned = state.tickets.filter((t) => t.assigned).length;

    const sumEl = document.getElementById('reportSummary');
    if (!sumEl) return;
    sumEl.innerHTML = [
      ['Total de tickets', total],
      ['Abiertos', open],
      ['En Progreso', progress],
      ['Resueltos', resolved],
      ['Cerrados', closed],
      ['Prioridad Crítica', critica],
      ['Sin asignar', total - assigned],
      ['Tasa resolución', total ? `${Math.round(((resolved + closed) / total) * 100)}%` : '—']
    ]
      .map(
        ([l, v]) => `<div class="report-item"><span class="report-item-label">${l}</span><span class="report-item-value">${v}</span></div>`
      )
      .join('');
  };

  // -------------------------------------------------------------------------
  // Export & Download
  // -------------------------------------------------------------------------
  const exportJSON = () => {
    const data = JSON.stringify({ tickets: state.tickets, users: state.users }, null, 2);
    downloadFile('helpdesk_backup.json', data, 'application/json');
  };

  const exportCSV = () => {
    const headers = ['ID', 'Título', 'Categoría', 'Prioridad', 'Estado', 'Asignado', 'Solicitante', 'Creado'];
    const rows = state.tickets.map((t) =>
      [
        t.id,
        t.title,
        t.category,
        t.priority,
        t.status,
        t.assigned || '',
        t.requester || '',
        formatDateFull(t.createdAt)
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    const csv = [headers.join(','), ...rows].join('\r\n');
    downloadFile('tickets.csv', '\uFEFF' + csv, 'text/csv;charset=utf-8');
  };

  const downloadFile = (fname, content, type) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearAllData = async () => {
    if (!confirm('Vas a borrar TODOS los tickets. No hay vuelta atrás. ¿Seguro?')) return;
    try {
      if (state.useFirebase) {
        const snap = await state.db.collection('tickets').get();
        const batch = state.db.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        batch.set(state.db.collection('meta').doc('counter'), { value: 0 });
        await batch.commit();
      } else {
        state.tickets = [];
        localStorage.removeItem(CONFIG.DB_KEY);
        localStorage.removeItem(CONFIG.COUNTER_KEY);
      }
      renderAll();
      ui.showToast('Base de datos depurada', 'info');
    } catch (err) {
      handleError(err, 'clearAllData');
    }
  };

  // -------------------------------------------------------------------------
  // User Management
  // -------------------------------------------------------------------------
  const renderUsersList = () => {
    if (state.session.role !== 'admin') return;
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    tbody.innerHTML = state.users
      .map(
        (u) => `
      <tr>
        <td style="font-weight:600">${escHtml(u.username)}</td>
        <td>${escHtml(u.name)}</td>
        <td style="color:var(--text-secondary)">${escHtml(u.email || '—')}</td>
        <td>${u.role === 'admin' ? '<span class="badge badge-abierto">admin</span>' : '<span class="badge">usuario</span>'}</td>
        <td style="color:var(--text-muted);font-size:12px">${formatDate(u.createdAt)}</td>
        <td>
          <button class="action-btn" title="Editar" onclick="editUser('${u.id}')">✏️</button>
          <button class="action-btn danger" title="Eliminar" onclick="deleteUser('${u.id}')" ${u.username === 'admin' ? 'disabled' : ''}>🗑️</button>
        </td>
      </tr>
    `
      )
      .join('');
  };

  const openUserModal = () => {
    tryVal('userEditId', '');
    tryVal('userUsername', '');
    tryVal('userName', '');
    tryVal('userEmailField', '');
    tryVal('userPassword', '');
    tryVal('userRole', 'user');
    trySet('userModalTitle', 'Nuevo Usuario');
    const hint = document.getElementById('pwdHint');
    if (hint) hint.style.display = 'none';
    const req = document.getElementById('pwdReq');
    if (req) req.style.display = 'inline';
    document.getElementById('userPassword').required = true;
    ui.openModal('userModal');
  };

  const editUser = (id) => {
    const u = state.users.find((x) => x.id === id);
    if (!u) return;
    tryVal('userEditId', u.id);
    tryVal('userUsername', u.username);
    tryVal('userName', u.name);
    tryVal('userEmailField', u.email || '');
    tryVal('userRole', u.role);
    tryVal('userPassword', '');
    trySet('userModalTitle', 'Editar Usuario');

    const hint = document.getElementById('pwdHint');
    if (hint) hint.style.display = 'block';
    const req = document.getElementById('pwdReq');
    if (req) req.style.display = 'none';
    document.getElementById('userPassword').required = false;
    ui.openModal('userModal');
  };

  const saveUser = async (e) => {
    e.preventDefault();
    const id = document.getElementById('userEditId').value;
    const username = document.getElementById('userUsername').value.trim();
    const name = document.getElementById('userName').value.trim();
    const email = document.getElementById('userEmailField').value.trim();
    const password = document.getElementById('userPassword').value;
    const role = document.getElementById('userRole').value;

    try {
      if (state.useFirebase) {
        if (id) {
          const u = state.users.find((x) => x.id === id);
          if (u && u.username === 'admin' && role !== 'admin') {
            ui.showToast('El admin principal no puede cambiar de rol', 'error');
            return;
          }
          const updateData = { username, name, email, role };
          if (password) updateData.password = password;
          await state.db.collection('users').doc(id).update(updateData);
          const idx = state.users.findIndex((x) => x.id === id);
          if (idx !== -1) state.users[idx] = { ...state.users[idx], ...updateData };
          ui.showToast('Usuario actualizado', 'success');
        } else {
          const snap = await state.db.collection('users').where('username', '==', username.toLowerCase()).get();
          if (!snap.empty) {
            ui.showToast('Nombre de usuario en uso', 'error');
            return;
          }
          const newUser = {
            id: `u${Date.now()}`,
            username,
            name,
            email,
            role,
            createdAt: new Date().toISOString()
          };
          await state.db.collection('users').doc(newUser.id).set(newUser);
          state.users.push(newUser);
          ui.showToast('Usuario creado', 'success');
        }
      } else {
        if (id) {
          const idx = state.users.findIndex((u) => u.id === id);
          if (idx !== -1) {
            if (state.users[idx].username === 'admin' && role !== 'admin') {
              ui.showToast('El admin principal no puede cambiar de rol', 'error');
              return;
            }
            state.users[idx] = { ...state.users[idx], username, name, email, role };
            if (password) state.users[idx].password = password;
            localStorageService.save(CONFIG.USERS_KEY, state.users);
            ui.showToast('Usuario actualizado', 'success');
          }
        } else {
          if (state.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
            ui.showToast('Nombre de usuario en uso', 'error');
            return;
          }
          const newUser = {
            id: `u${Date.now()}`,
            username,
            name,
            email,
            role,
            createdAt: new Date().toISOString()
          };
          state.users.push(newUser);
          localStorageService.save(CONFIG.USERS_KEY, state.users);
          ui.showToast('Usuario creado', 'success');
        }
      }
    } catch (err) {
      handleError(err, 'saveUser');
      return;
    }
    ui.closeModalById('userModal');
    renderUsersList();
  };

  const deleteUser = async (id) => {
    const u = state.users.find((x) => x.id === id);
    if (!u || u.username === 'admin') return;
    if (!confirm(`¿Eliminar usuario ${u.username}?`)) return;
    try {
      if (state.useFirebase) {
        await state.db.collection('users').doc(id).delete();
      } else {
        localStorageService.save(
          CONFIG.USERS_KEY,
          state.users.filter((x) => x.id !== id)
        );
      }
      state.users = state.users.filter((x) => x.id !== id);
      renderUsersList();
      ui.showToast('Usuario eliminado', 'info');
    } catch (err) {
      handleError(err, 'deleteUser');
    }
  };

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------
  if (!window.location.pathname.endsWith('login.html')) {
    document.addEventListener('DOMContentLoaded', async () => {
      if (!auth.init()) return;

      firebaseService.init();

      if (state.useFirebase) {
        try {
          state.users = await firebaseService.loadUsers();
          ui.updateConnectionBadge(true);
          await firebaseService.subscribeTickets(renderAll);
          await firebaseService.loadInitialTickets();
          if (state.tickets.length === 0) await seedDemoData();
        } catch (err) {
          handleError(err, 'Bootstrap Firebase');
          fallbackToLocal();
        }
      } else {
        fallbackToLocal();
      }

      renderAll();
      ui.setupSidebar();
      ui.setupCharCounter();

      if (state.session.role === 'admin') ui.showSection('dashboard');
      else ui.showSection('mytickets');
    });
  }

  // -------------------------------------------------------------------------
  // Global Event Handlers (required for inline onclick)
  // -------------------------------------------------------------------------
  window.openTicketModal = openTicketModal;
  window.editTicket = editTicket;
  window.asignarTecnico = asignarTecnico;
  window.confirmDelete = confirmDelete;
  window.executeDelete = executeDelete;
  window.saveTicket = saveTicket;
  window.cancelForm = cancelForm;
  window.openUserModal = openUserModal;
  window.editUser = editUser;
  window.saveUser = saveUser;
  window.deleteUser = deleteUser;
  window.exportJSON = exportJSON;
  window.exportCSV = exportCSV;
  window.clearAllData = clearAllData;
  window.logout = auth.logout;
  window.filterTickets = () => {
    clearTimeout(window.filterTimer);
    window.filterTimer = setTimeout(() => {
      if (state.session.role === 'admin') renderTicketsList();
      else renderMyTickets();
    }, 150);
  };
  window.clearFilters = () => {
    ['filterStatus', 'filterPriority', 'filterCategory', 'searchInput'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const sortEl = document.getElementById('filterSort');
    if (sortEl) sortEl.value = 'newest';
    window.filterTickets();
  };
})();
