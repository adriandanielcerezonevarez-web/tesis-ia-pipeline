/*************************************************************
 * app.js
 * -----------------------------------------------------------
 * Flujo de arranque de la aplicación HelpDesk:
 * 1. Verifica sesión (initAuth) y redirige a login si es necesario.
 * 2. Inicializa Firebase (initFirebase) y decide entre Firestore
 *    o localStorage como backend de persistencia.
 * 3. Carga usuarios y tickets (fbLoadUsers / dbLoad) con fallback
 *    en caso de error.
 * 4. Si la base está vacía, crea datos de demostración (seedDemoData).
 * 5. Renderiza la UI según el rol del usuario y configura los
 *    manejadores de eventos del sidebar y del contador de caracteres.
 *
 * Todas las variables de estado global se encapsulan en el objeto
 * `HelpDeskApp` para evitar colisiones con otros scripts.
 *************************************************************/

const HelpDeskApp = (function () {
  // -----------------------------------------------------------------
  // Constantes de claves de almacenamiento
  // -----------------------------------------------------------------
  const SESSION_KEY = 'helpdesk_session';
  const USERS_KEY = 'helpdesk_users';
  const DB_KEY = 'helpdesk_tickets';
  const COUNTER_KEY = 'helpdesk_counter';

  // -----------------------------------------------------------------
  // Estado interno (encapsulado)
  // -----------------------------------------------------------------
  let session = null;
  let db = null;
  let useFirebase = false;
  let unsubscribeTickets = null;

  let tickets = [];
  let users = [];
  let currentSection = '';
  let editingId = null;
  let pendingDeleteId = null;

  // -----------------------------------------------------------------
  // Logger configurable (simple)
  // -----------------------------------------------------------------
  const logger = {
    info: (...args) => console.info('[HelpDesk]', ...args),
    warn: (...args) => console.warn('[HelpDesk]', ...args),
    error: (...args) => console.error('[HelpDesk]', ...args)
  };

  // -----------------------------------------------------------------
  // Utilidades de almacenamiento
  // -----------------------------------------------------------------
  function isLocalStorageAvailable() {
    try {
      const testKey = '__test__';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return true;
    } catch (e) {
      logger.warn('localStorage no disponible:', e);
      return false;
    }
  }

  function safeParse(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || [];
    } catch (e) {
      logger.warn(`Error al parsear ${key}:`, e);
      return [];
    }
  }

  function dbLoad() {
    return isLocalStorageAvailable() ? safeParse(DB_KEY) : [];
  }

  function dbSave(ticketsArr) {
    if (!isLocalStorageAvailable()) return;
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(ticketsArr));
    } catch (e) {
      logger.error('Error al guardar tickets en localStorage:', e);
      showToast('Espacio insuficiente en el almacenamiento local', 'error');
    }
  }

  function dbNextId() {
    const current = parseInt(localStorage.getItem(COUNTER_KEY) || '0', 10);
    const next = current + 1;
    try {
      localStorage.setItem(COUNTER_KEY, String(next));
    } catch (e) {
      logger.error('Error al actualizar contador en localStorage:', e);
    }
    return `TK-${String(next).padStart(4, '0')}`;
  }

  function usersLoad() {
    return isLocalStorageAvailable() ? safeParse(USERS_KEY) : [];
  }

  function usersSave(usersArr) {
    if (!isLocalStorageAvailable()) return;
    try {
      localStorage.setItem(USERS_KEY, JSON.stringify(usersArr));
    } catch (e) {
      logger.error('Error al guardar usuarios en localStorage:', e);
      showToast('Espacio insuficiente en el almacenamiento local', 'error');
    }
  }

  // -----------------------------------------------------------------
  // Inicialización de Firebase
  // -----------------------------------------------------------------
  function initFirebase() {
    if (typeof FIREBASE_CONFIGURED === 'undefined' || !FIREBASE_CONFIGURED) return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      useFirebase = true;
      logger.info('firestore conectado');
    } catch (err) {
      logger.warn('Firebase no disponible, se usará localStorage:', err.message);
      useFirebase = false;
      db = null;
    }
  }

  // -----------------------------------------------------------------
  // UI: badge de conexión
  // -----------------------------------------------------------------
  function updateConnectionBadge(online) {
    const foot = document.getElementById('sidebarConnStatus');
    if (!foot) return;
    foot.innerHTML = online
      ? '<span style="color:#2e7d32;font-size:11px">online</span>'
      : '<span style="color:#b76e00;font-size:11px">modo local</span>';
  }

  // -----------------------------------------------------------------
  // Autenticación
  // -----------------------------------------------------------------
  /**
   * Inicializa la sesión del usuario.
   * @returns {boolean} true si la sesión es válida, false en caso contrario.
   */
  function initAuth() {
    const s = sessionStorage.getItem(SESSION_KEY);
    if (!s) {
      if (!window.location.pathname.endsWith('login.html')) {
        window.location.href = 'login.html';
      }
      return false;
    }
    try {
      session = JSON.parse(s);
    } catch (e) {
      logger.error('Sesión corrupta, se redirige a login:', e);
      sessionStorage.removeItem(SESSION_KEY);
      window.location.href = 'login.html';
      return false;
    }
    document.body.classList.add(`role-${session.role}`);

    const nameEl = document.getElementById('userDisplayName');
    const roleEl = document.getElementById('userDisplayRole');
    const avatarEl = document.getElementById('userAvatar');
    const badgeEl = document.getElementById('topbarRoleBadge');

    if (nameEl) nameEl.textContent = session.name;
    if (roleEl) roleEl.textContent = session.role === 'admin' ? 'Administrador' : 'Usuario';
    if (avatarEl) avatarEl.textContent = session.name.charAt(0).toUpperCase();
    if (badgeEl) badgeEl.innerHTML = session.role === 'admin' ? 'Admin' : 'Usuario';

    return true;
  }

  /**
   * Cierra la sesión actual.
   */
  function logout() {
    if (unsubscribeTickets) unsubscribeTickets();
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = 'login.html';
  }

  // -----------------------------------------------------------------
  // Persistencia (Firebase)
  // -----------------------------------------------------------------
  async function fbNextId() {
    const counterRef = db.collection('meta').doc('counter');
    return await db.runTransaction(async t => {
      const snap = await t.get(counterRef);
      const next = (snap.exists ? snap.data().value : 0) + 1;
      t.set(counterRef, { value: next });
      return `TK-${String(next).padStart(4, '0')}`;
    });
  }

  async function fbLoadUsers() {
    const snap = await db.collection('users').get();
    return snap.docs.map(d => d.data());
  }

  // -----------------------------------------------------------------
  // Seguridad: hashing con sal (PBKDF2)
  // -----------------------------------------------------------------
  async function hashPassword(pwd) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(pwd),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      256
    );
    const hashArray = Array.from(new Uint8Array(derivedBits));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${saltHex}$${hashHex}`;
  }

  // -----------------------------------------------------------------
  // Utilidades de sanitización
  // -----------------------------------------------------------------
  function sanitize(input) {
    return String(input || '')
      .replace(/[&<>"'\/]/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '/': '&#x2F;'
      })[c]);
  }

  // -----------------------------------------------------------------
  // Arranque de la aplicación (sub‑funciones)
  // -----------------------------------------------------------------
  async function bootstrap() {
    if (!initAuth()) return;
    initFirebase();
    await loadData();
    await ensureDemoData();
    renderAll();
    setupSidebar();
    setupCharCounter();
    if (session.role === 'admin') showSection('dashboard');
    else showSection('mytickets');
  }

  async function loadData() {
    if (useFirebase) {
      try {
        users = await fbLoadUsers();
        updateConnectionBadge(true);
        unsubscribeTickets = db.collection('tickets')
          .orderBy('createdAt', 'desc')
          .onSnapshot(snap => {
            tickets = snap.docs.map(d => d.data());
            renderAll();
            updateNavBadge();
          }, err => {
            logger.error('onSnapshot error:', err);
            showToast('Error de sincronización en tiempo real', 'error');
          });
        const initSnap = await db.collection('tickets')
          .orderBy('createdAt', 'desc')
          .get();
        tickets = initSnap.docs.map(d => d.data());
      } catch (err) {
        logger.error('Bootstrap Firebase falló:', err);
        showToast('No se pudo conectar a Firebase, se usará modo local', 'error');
        useFirebase = false;
        tickets = dbLoad();
        users = usersLoad();
      }
    } else {
      updateConnectionBadge(false);
      tickets = dbLoad();
      users = usersLoad();
    }
  }

  async function ensureDemoData() {
    if (tickets.length === 0) await seedDemoData();
  }

  // -----------------------------------------------------------------
  // Datos de demostración
  // -----------------------------------------------------------------
  async function seedDemoData() {
    if (tickets.length > 0) return;
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

    if (useFirebase) {
      try {
        const batch = db.batch();
        for (const d of demos) {
          const id = await fbNextId();
          batch.set(db.collection('tickets').doc(id), { id, ...d });
          tickets.push({ id, ...d });
        }
        await batch.commit();
      } catch (err) {
        logger.error('seedDemoData Firebase error:', err);
        showToast('Error al crear datos de demostración', 'error');
      }
    } else {
      demos.forEach(d => {
        const id = dbNextId();
        tickets.push({ id, ...d });
      });
      dbSave(tickets);
    }
  }

  // -----------------------------------------------------------------
  // UI: Sidebar
  // -----------------------------------------------------------------
  function setupSidebar() {
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
  }

  // -----------------------------------------------------------------
  // Navegación entre secciones
  // -----------------------------------------------------------------
  const SECTION_META = {
    dashboard: { title: 'Panel de Control', subtitle: 'Resumen general del sistema' },
    tickets: { title: 'Todos los Tickets', subtitle: 'Gestión global de soporte' },
    mytickets: { title: 'Mis Tickets', subtitle: 'Gestión de tus solicitudes' },
    create: { title: 'Nuevo Ticket', subtitle: 'Crear un nuevo ticket' },
    reports: { title: 'Reportes', subtitle: 'Estadísticas del sistema' },
    users: { title: 'Usuarios', subtitle: 'Gestión de cuentas' }
  };

  function showSection(name) {
    if (session.role === 'user' && ['dashboard', 'tickets', 'reports', 'users'].includes(name)) return;
    currentSection = name;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const navEl = document.getElementById(`nav-${name}`);
    if (navEl) navEl.classList.add('active');
    document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
    const sec = document.getElementById(`section-${name}`);
    if (sec) sec.classList.add('active');
    const meta = SECTION_META[name] || { title: name, subtitle: '' };
    const titleEl = document.getElementById('pageTitle');
    const subtitleEl = document.getElementById('pageSubtitle');
    if (titleEl) titleEl.textContent = meta.title;
    if (subtitleEl) subtitleEl.textContent = meta.subtitle;
    const sbox = document.getElementById('searchBox');
    if (sbox) sbox.style.display = (name === 'tickets' || name === 'mytickets') ? 'flex' : 'none';
    if (name === 'dashboard') renderDashboard();
    if (name === 'tickets') renderTicketsList();
    if (name === 'mytickets') renderMyTickets();
    if (name === 'reports') renderReports();
    if (name === 'users') renderUsersList();
    if (name === 'create' && !editingId) resetForm();
  }

  // -----------------------------------------------------------------
  // Contador de caracteres
  // -----------------------------------------------------------------
  function setupCharCounter() {
    const desc = document.getElementById('ticketDescription');
    const count = document.getElementById('charCount');
    if (desc && count) {
      desc.addEventListener('input', () => {
        count.textContent = `${desc.value.length} / 2000`;
      });
    }
  }

  // -----------------------------------------------------------------
  // Renderizado global
  // -----------------------------------------------------------------
  function renderAll() {
    if (session.role === 'admin') {
      renderDashboard();
      renderTicketsList();
      renderReports();
      renderUsersList();
      updateNavBadge();
    } else {
      renderMyTickets();
      updateNavBadge();
    }
  }

  function updateNavBadge() {
    if (session.role === 'admin') {
      const open = tickets.filter(t => t.status === 'Abierto').length;
      const b = document.getElementById('nav-badge');
      if (b) b.textContent = open;
    } else {
      const open = tickets.filter(t => t.requesterId === session.userId && t.status !== 'Cerrado' && t.status !== 'Resuelto').length;
      const bu = document.getElementById('nav-badge-user');
      if (bu) bu.textContent = open;
    }
  }

  // -----------------------------------------------------------------
  // Dashboard (admin)
  // -----------------------------------------------------------------
  function renderDashboard() {
    if (session.role !== 'admin') return;
    const total = tickets.length;
    const open = tickets.filter(t => t.status === 'Abierto').length;
    const progress = tickets.filter(t => t.status === 'En Progreso').length;
    const closed = tickets.filter(t => t.status === 'Resuelto' || t.status === 'Cerrado').length;

    trySet('stat-total', total);
    trySet('stat-open', open);
    trySet('stat-progress', progress);
    trySet('stat-closed', closed);

    const pc = { 'Crítica': 0, 'Alta': 0, 'Media': 0, 'Baja': 0 };
    tickets.forEach(t => { if (pc[t.priority] !== undefined) pc[t.priority]++; });
    const maxP = Math.max(...Object.values(pc), 1);

    tryWidth('bar-critica', `${(pc['Crítica'] / maxP) * 100}%`);
    trySet('count-critica', pc['Crítica']);
    tryWidth('bar-alta', `${(pc['Alta'] / maxP) * 100}%`);
    trySet('count-alta', pc['Alta']);
    tryWidth('bar-media', `${(pc['Media'] / maxP) * 100}%`);
    trySet('count-media', pc['Media']);
    tryWidth('bar-baja', `${(pc['Baja'] / maxP) * 100}%`);
    trySet('count-baja', pc['Baja']);

    const catCounts = {};
    tickets.forEach(t => { catCounts[t.category] = (catCounts[t.category] || 0) + 1; });
    const catEl = document.getElementById('categoryStats');
    if (catEl) {
      const sorted = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
      catEl.innerHTML = sorted.length
        ? sorted.map(([c, n]) => `<div class="category-stat-item"><span class="category-stat-name">${c}</span><span class="category-stat-count">${n}</span></div>`).join('')
        : '<div class="empty-state-small">Sin datos</div>';
    }

    const recent = [...tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
    const recEl = document.getElementById('recentTicketsList');
    if (recEl) {
      recEl.innerHTML = recent.length
        ? recent.map(t => `<div class="recent-ticket-item" onclick="openTicketModal('${t.id}')"><span class="recent-ticket-id">${t.id}</span><span class="recent-ticket-title">${escHtml(t.title)}</span><span class="recent-ticket-meta">${statusBadgeHtml(t.status)}</span></div>`).join('')
        : '<div class="empty-state-small">No hay tickets</div>';
    }
  }

  // -----------------------------------------------------------------
  // Listado de tickets (admin)
  // -----------------------------------------------------------------
  function renderTicketsList(filtered) {
    if (session.role !== 'admin') return;
    const list = filtered !== undefined ? filtered : applyFilters(tickets);
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
      tbody.innerHTML = list.map(t => `
        <tr onclick="openTicketModal('${t.id}')">
          <td class="ticket-id-cell">${t.id}</td>
          <td class="ticket-title-cell" title="${escHtml(t.title)}">${escHtml(t.title)}</td>
          <td><span class="badge badge-category">${categoryEmoji(t.category)} ${t.category}</span></td>
          <td>${priorityBadgeHtml(t.priority)}</td>
          <td>${statusBadgeHtml(t.status)}</td>
          <td style="color:var(--text-secondary)">${escHtml(t.assigned || '—')}</td>
          <td style="color:var(--text-secondary)">${escHtml(t.requester || '—')}</td>
          <td style="color:var(--text-muted);font-size:12px;">${formatDate(t.createdAt)}</td>
          <td onclick="event.stopPropagation()">
            <div class="action-buttons">
              <button class="action-btn" title="Ver" onclick="openTicketModal('${t.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
              <button class="action-btn" title="Editar" onclick="editTicket('${t.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
              <button class="action-btn" title="Asignar técnico" onclick="asignarTecnico('${t.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></button>
              <button class="action-btn danger" title="Eliminar" onclick="confirmDelete('${t.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
            </div>
          </td>
        </tr>
      `).join('');
    }
  }

  // -----------------------------------------------------------------
  // Listado de tickets (usuario)
  // -----------------------------------------------------------------
  function renderMyTickets() {
    if (session.role !== 'user') return;
    const myTickets = tickets.filter(t => t.requesterId === session.userId);
    trySet('bannerName', `Hola, ${session.name.split(' ')[0]}`);
    trySet('ustat-total', myTickets.length);
    trySet('ustat-open', myTickets.filter(t => t.status === 'Abierto').length);
    trySet('ustat-progress', myTickets.filter(t => t.status === 'En Progreso').length);
    trySet('ustat-closed', myTickets.filter(t => t.status === 'Resuelto' || t.status === 'Cerrado').length);

    const search = document.getElementById('searchInput')?.value.trim().toLowerCase() || '';
    let list = myTickets;
    if (search) {
      list = list.filter(t => t.title.toLowerCase().includes(search) || t.id.toLowerCase().includes(search));
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
      tbody.innerHTML = list.map(t => `
        <tr onclick="openTicketModal('${t.id}')">
          <td class="ticket-id-cell">${t.id}</td>
          <td class="ticket-title-cell" title="${escHtml(t.title)}">${escHtml(t.title)}</td>
          <td><span class="badge badge-category">${categoryEmoji(t.category)} ${t.category}</span></td>
          <td>${priorityBadgeHtml(t.priority)}</td>
          <td>${statusBadgeHtml(t.status)}</td>
          <td style="color:var(--text-muted);font-size:12px;">${formatDate(t.createdAt)}</td>
          <td onclick="event.stopPropagation()">
            <div class="action-buttons">
              <button class="action-btn" title="Ver" onclick="openTicketModal('${t.id}')">👁️</button>
              <button class="action-btn" title="Editar" onclick="editTicket('${t.id}')" ${t.status === 'Cerrado' || t.status === 'Resuelto' ? 'disabled style="opacity:0.5"' : ''}>✏️</button>
            </div>
          </td>
        </tr>
      `).join('');
    }
  }

  // -----------------------------------------------------------------
  // Filtros y búsqueda
  // -----------------------------------------------------------------
  function applyFilters(src) {
    const status = document.getElementById('filterStatus')?.value || '';
    const priority = document.getElementById('filterPriority')?.value || '';
    const category = document.getElementById('filterCategory')?.value || '';
    const sort = document.getElementById('filterSort')?.value || 'newest';
    const search = document.getElementById('searchInput')?.value.trim().toLowerCase() || '';

    let result = src.filter(t => {
      if (status && t.status !== status) return false;
      if (priority && t.priority !== priority) return false;
      if (category && t.category !== category) return false;
      if (search && !t.title.toLowerCase().includes(search) && !t.id.toLowerCase().includes(search) && !(t.requester || '').toLowerCase().includes(search)) return false;
      return true;
    });

    result.sort((a, b) => {
      if (sort === 'newest') return new Date(b.createdAt) - new Date(a.createdAt);
      if (sort === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt);
      if (sort === 'priority') {
        const order = { 'Crítica': 0, 'Alta': 1, 'Media': 2, 'Baja': 3 };
        return (order[a.priority] ?? 99) - (order[b.priority] ?? 99);
      }
      if (sort === 'status') return a.status.localeCompare(b.status);
      return 0;
    });
    return result;
  }

  // -----------------------------------------------------------------
  // Debounce de filtros
  // -----------------------------------------------------------------
  let _filterTimer = null;
  function filterTickets() {
    clearTimeout(_filterTimer);
    _filterTimer = setTimeout(() => {
      if (session.role === 'admin') renderTicketsList();
      else renderMyTickets();
    }, 150);
  }

  function clearFilters() {
    ['filterStatus', 'filterPriority', 'filterCategory', 'searchInput'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const sortEl = document.getElementById('filterSort');
    if (sortEl) sortEl.value = 'newest';
    filterTickets();
  }

  // -----------------------------------------------------------------
  // Modal de ticket
  // -----------------------------------------------------------------
  function openTicketModal(id) {
    const t = tickets.find(x => x.id === id);
    if (!t) return;
    if (session.role === 'user' && t.requesterId !== session.userId) {
      showToast('No tienes permiso para ver este ticket', 'error');
      return;
    }

    trySet('modalId', t.id);
    trySet('modalTitle', t.title);

    document.getElementById('modalBadges').innerHTML = `
      ${statusBadgeHtml(t.status)} ${priorityBadgeHtml(t.priority)}
      <span class="badge badge-category">${categoryEmoji(t.category)} ${t.category}</span>
    `;

    let notesHtml = '';
    if (session.role === 'admin' && t.notes) {
      notesHtml = `<div class="modal-notes-label">Notas internas (solo admin)</div>
                   <div class="modal-notes">${escHtml(t.notes)}</div>`;
    }

    document.getElementById('modalBody').innerHTML = `
      <div class="modal-detail-grid">
        <div class="modal-detail-item"><div class="modal-detail-label">Solicitante</div><div class="modal-detail-value">${escHtml(t.requester || '—')}</div></div>
        <div class="modal-detail-item"><div class="modal-detail-label">Asignado a</div><div class="modal-detail-value">${escHtml(t.assigned || '—')}</div></div>
        ${session.role === 'admin' ? `<div class="modal-detail-item"><div class="modal-detail-label">Email</div><div class="modal-detail-value">${t.email ? `<a href="mailto:${escHtml(t.email)}" style="color:var(--accent-light)">${escHtml(t.email)}</a>` : '—'}</div></div>` : ''}
        <div class="modal-detail-item"><div class="modal-detail-label">Creado</div><div class="modal-detail-value">${formatDateFull(t.createdAt)}</div></div>
      </div>
      <div class="modal-detail-label" style="margin-bottom:8px">Descripción</div>
      <div class="modal-description">${escHtml(t.description)}</div>
      ${notesHtml}
    `;

    const editBtn = document.getElementById('modalEditBtn');
    const delBtn = document.getElementById('modalDeleteBtn');

    if (editBtn) {
      if (session.role === 'admin' || (t.status !== 'Resuelto' && t.status !== 'Cerrado')) {
        editBtn.style.display = 'inline-flex';
        editBtn.onclick = () => { closeTicketModal(); editTicket(id); };
      } else {
        editBtn.style.display = 'none';
      }
    }

    if (delBtn) {
      delBtn.onclick = () => { closeTicketModal(); confirmDelete(id); };
    }

    openModal('ticketModal');
  }

  // -----------------------------------------------------------------
  // Formulario de ticket
  // -----------------------------------------------------------------
  function resetForm() {
    editingId = null;
    const form = document.getElementById('ticketForm');
    if (form) form.reset();

    trySet('ticketId', '');
    const statusEl = document.getElementById('ticketStatus');
    if (statusEl) statusEl.value = 'Abierto';

    if (session.role === 'user') {
      const reqField = document.getElementById('ticketRequester');
      const mailField = document.getElementById('ticketEmail');
      if (reqField) { reqField.value = session.name; reqField.readOnly = true; }
      if (mailField) { mailField.value = session.email || ''; mailField.readOnly = true; }
    }

    trySet('formTitle', 'Crear Nuevo Ticket');
    const badge = document.getElementById('formIdBadge');
    if (badge) badge.style.display = 'none';
    trySet('charCount', '0 / 2000');

    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) submitBtn.innerHTML = `Guardar Ticket`;

    trySet('pageTitle', 'Nuevo Ticket');
    trySet('pageSubtitle', 'Crear un nuevo ticket de soporte');
  }

  function editTicket(id) {
    const t = tickets.find(x => x.id === id);
    if (!t) return;
    if (session.role === 'user' && t.requesterId !== session.userId) {
      showToast('Acceso denegado', 'error');
      return;
    }

    editingId = id;
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
    if (badge) { badge.textContent = t.id; badge.style.display = 'inline-block'; }
    trySet('pageTitle', `Editar ${t.id}`);
    trySet('pageSubtitle', t.title);

    showSection('create');
  }

  async function saveTicket(e) {
    e.preventDefault();
    const title = sanitize(document.getElementById('ticketTitle').value.trim());
    const category = sanitize(document.getElementById('ticketCategory').value);
    const priority = sanitize(document.getElementById('ticketPriority').value);
    const description = sanitize(document.getElementById('ticketDescription').value.trim());

    let status = document.getElementById('ticketStatus')?.value || 'Abierto';
    let assigned = sanitize(document.getElementById('ticketAssigned')?.value.trim() || '');
    let requester = sanitize(document.getElementById('ticketRequester')?.value.trim() || session.name);
    let email = sanitize(document.getElementById('ticketEmail')?.value.trim() || '');
    let notes = sanitize(document.getElementById('ticketNotes')?.value.trim() || '');
    let requesterId = session.role === 'admin' ? null : session.userId;

    if (useFirebase) {
      try {
        if (editingId) {
          const updateData = session.role === 'admin'
            ? { title, category, priority, status, assigned, requester, email, description, notes, updatedAt: new Date().toISOString() }
            : { title, category, priority, description, updatedAt: new Date().toISOString() };
          await db.collection('tickets').doc(editingId).update(updateData);
          showToast('Ticket actualizado', 'success');
        } else {
          const id = await fbNextId();
          const newTicket = { id, title, category, priority, status, assigned, requester, requesterId, email, description, notes, createdAt: new Date().toISOString() };
          await db.collection('tickets').doc(id).set(newTicket);
          showToast(`Ticket ${id} creado`, 'success');
        }
      } catch (err) {
        logger.error('saveTicket Firebase error:', err);
        showToast('Error al guardar ticket: ' + err.message, 'error');
        return;
      }
    } else {
      if (editingId) {
        const idx = tickets.findIndex(t => t.id === editingId);
        if (idx !== -1) {
          if (session.role === 'admin') {
            tickets[idx] = { ...tickets[idx], title, category, priority, status, assigned, requester, email, description, notes, updatedAt: new Date().toISOString() };
          } else {
            tickets[idx] = { ...tickets[idx], title, category, priority, description, updatedAt: new Date().toISOString() };
          }
          dbSave(tickets);
          showToast('Ticket actualizado', 'success');
        }
      } else {
        const newTicket = { id: dbNextId(), title, category, priority, status, assigned, requester, requesterId, email, description, notes, createdAt: new Date().toISOString() };
        tickets.unshift(newTicket);
        dbSave(tickets);
        showToast(`Ticket ${newTicket.id} creado`, 'success');
      }
      renderAll();
    }

    editingId = null;
    showSection(session.role === 'admin' ? 'tickets' : 'mytickets');
  }

  function cancelForm() {
    editingId = null;
    showSection(session.role === 'admin' ? 'tickets' : 'mytickets');
  }

  // -----------------------------------------------------------------
  // Asignación rápida de técnico
  // -----------------------------------------------------------------
  const TECNICOS = ['Ing. Jose Fernandez', 'Ing. Luis Marquez', 'Ing. Eric Villagomez', 'Ing. Ivan Rodrigues'];

  function asignarTecnico(id) {
    if (session.role !== 'admin') { showToast('Acceso denegado', 'error'); return; }
    cerrarMenuAsignar();
    const overlay = document.createElement('div');
    overlay.id = 'asignarOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:1000;display:flex;align-items:center;justify-content:center;';
    overlay.onclick = e => { if (e.target === overlay) cerrarMenuAsignar(); };
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:6px;padding:18px 20px;min-width:280px;box-shadow:0 4px 18px rgba(0,0,0,.22);';
    box.innerHTML = '<h3 style="margin:0 0 12px;font-size:15px;">Asignar técnico al ticket ' + escHtml(id) + '</h3>' +
      TECNICOS.map(tec => `<button class="btn btn-ghost btn-sm" style="display:block;width:100%;text-align:left;margin-bottom:6px;" onclick="asignarTecnicoA('${id}','${tec}')">${tec}</button>`).join('') +
      '<button class="btn btn-ghost btn-sm" style="margin-top:4px;color:var(--text-muted);" onclick="cerrarMenuAsignar()">Cancelar</button>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  function cerrarMenuAsignar() {
    const o = document.getElementById('asignarOverlay');
    if (o) o.remove();
  }

  async function asignarTecnicoA(id, tecnico) {
    cerrarMenuAsignar();
    if (session.role !== 'admin') return;
    if (useFirebase) {
      try {
        await db.collection('tickets').doc(id).update({ assigned: tecnico, updatedAt: new Date().toISOString() });
        showToast(`Ticket ${id} asignado a ${tecnico}`, 'success');
      } catch (err) {
        showToast('Error al asignar: ' + err.message, 'error');
      }
    } else {
      const idx = tickets.findIndex(t => t.id === id);
      if (idx !== -1) {
        tickets[idx] = { ...tickets[idx], assigned: tecnico, updatedAt: new Date().toISOString() };
        dbSave(tickets);
        showToast(`Ticket ${id} asignado a ${tecnico}`, 'success');
        renderAll();
      }
    }
  }

  // -----------------------------------------------------------------
  // Borrado de ticket
  // -----------------------------------------------------------------
  function confirmDelete(id) {
    if (session.role !== 'admin') return;
    pendingDeleteId = id;
    openModal('confirmModal');
  }

  async function executeDelete() {
    if (!pendingDeleteId) return;
    if (useFirebase) {
      try {
        await db.collection('tickets').doc(pendingDeleteId).delete();
        showToast('Ticket eliminado', 'info');
      } catch (err) {
        showToast('Error al eliminar: ' + err.message, 'error');
      }
    } else {
      tickets = tickets.filter(t => t.id !== pendingDeleteId);
      dbSave(tickets);
      showToast('Ticket eliminado', 'info');
      renderAll();
    }
    pendingDeleteId = null;
    closeConfirmModal();
  }

  // -----------------------------------------------------------------
  // Reportes (admin)
  // -----------------------------------------------------------------
  function renderReports() {
    if (session.role !== 'admin') return;
    const total = tickets.length;
    const open = tickets.filter(t => t.status === 'Abierto').length;
    const progress = tickets.filter(t => t.status === 'En Progreso').length;
    const resolved = tickets.filter(t => t.status === 'Resuelto').length;
    const closed = tickets.filter(t => t.status === 'Cerrado').length;
    const critica = tickets.filter(t => t.priority === 'Crítica').length;
    const assigned = tickets.filter(t => t.assigned).length;

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
    ].map(([l, v]) => `<div class="report-item"><span class="report-item-label">${l}</span><span class="report-item-value">${v}</span></div>`).join('');
  }

  // -----------------------------------------------------------------
  // Export / limpieza
  // -----------------------------------------------------------------
  function exportJSON() {
    const data = JSON.stringify({ tickets, users }, null, 2);
    downloadFile('helpdesk_backup.json', data, 'application/json');
  }

  function exportCSV() {
    const headers = ['ID', 'Título', 'Categoría', 'Prioridad', 'Estado', 'Asignado', 'Solicitante', 'Creado'];
    const rows = tickets.map(t => [
      t.id, t.title, t.category, t.priority, t.status, t.assigned || '', t.requester || '', formatDateFull(t.createdAt)
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = [headers.join(','), ...rows].join('\r\n');
    downloadFile('tickets.csv', '\uFEFF' + csv, 'text/csv;charset=utf-8');
  }

  function downloadFile(fname, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function clearAllData() {
    if (!confirm('Vas a borrar TODOS los tickets. No hay vuelta atrás. ¿Seguro?')) return;
    if (useFirebase) {
      try {
        const snap = await db.collection('tickets').get();
        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        batch.set(db.collection('meta').doc('counter'), { value: 0 });
        await batch.commit();
        showToast('Base de datos depurada', 'info');
      } catch (err) {
        showToast('Error al limpiar: ' + err.message, 'error');
      }
    } else {
      tickets = [];
      localStorage.removeItem(DB_KEY);
      localStorage.removeItem(COUNTER_KEY);
      renderAll();
      showToast('Base de datos depurada', 'info');
    }
  }

  // -----------------------------------------------------------------
  // Gestión de usuarios (admin)
  // -----------------------------------------------------------------
  function renderUsersList() {
    if (session.role !== 'admin') return;
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    tbody.innerHTML = users.map(u => `
      <tr>
        <td style="font-weight:600">${escHtml(u.username)}</td>
        <td>${escHtml(u.name)}</td>
        <td style="color:var(--text-secondary)">${escHtml(u.email || '—')}</td>
        <td>${u.role === 'admin' ? '<span class="badge badge-abierto">admin</span>' : '<span class="badge">usuario</span>'}</td>
        <td style="color:var(--text-muted);font-size:12px">${formatDate(u.createdAt)}</td>
        <td>
          <button class="action-btn" title="Editar" onclick="editUser('${u.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="action-btn danger" title="Eliminar" onclick="deleteUser('${u.id}')" ${u.username === 'admin' ? 'disabled' : ''}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
        </td>
      </tr>
    `).join('');
  }

  function openUserModal() {
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
    openModal('userModal');
  }

  function editUser(id) {
    const u = users.find(x => x.id === id);
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
    openModal('userModal');
  }

  async function saveUser(e) {
    e.preventDefault();
    const id = document.getElementById('userEditId').value;
    const username = sanitize(document.getElementById('userUsername').value.trim());
    const name = sanitize(document.getElementById('userName').value.trim());
    const email = sanitize(document.getElementById('userEmailField').value.trim());
    const passwordRaw = document.getElementById('userPassword').value;
    const role = document.getElementById('userRole').value;

    let passwordHash = null;
    if (passwordRaw) {
      passwordHash = await hashPassword(passwordRaw);
    }

    if (useFirebase) {
      try {
        if (id) {
          const u = users.find(x => x.id === id);
          if (u && u.username === 'admin' && role !== 'admin') {
            showToast('El admin principal no puede cambiar de rol', 'error');
            return;
          }
          const updateData = { username, name, email, role };
          if (passwordHash) updateData.password = passwordHash;
          await db.collection('users').doc(id).update(updateData);
          const idx = users.findIndex(x => x.id === id);
          if (idx !== -1) users[idx] = { ...users[idx], ...updateData };
          showToast('Usuario actualizado', 'success');
        } else {
          const snap = await db.collection('users').where('username', '==', username.toLowerCase()).get();
          if (!snap.empty) { showToast('Nombre de usuario en uso', 'error'); return; }
          const newUser = { id: `u${Date.now()}`, username, name, email, password: passwordHash || '', role, createdAt: new Date().toISOString() };
          await db.collection('users').doc(newUser.id).set(newUser);
          users.push(newUser);
          showToast('Usuario creado', 'success');
        }
      } catch (err) {
        showToast('Error al guardar usuario: ' + err.message, 'error');
        return;
      }
    } else {
      if (id) {
        const idx = users.findIndex(u => u.id === id);
        if (idx !== -1) {
          if (users[idx].username === 'admin' && role !== 'admin') {
            showToast('El admin principal no puede cambiar de rol', 'error');
            return;
          }
          users[idx] = { ...users[idx], username, name, email, role };
          if (passwordHash) users[idx].password = passwordHash;
          usersSave(users);
          showToast('Usuario actualizado', 'success');
        }
      } else {
        if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
          showToast('Nombre de usuario en uso', 'error');
          return;
        }
        const newUser = { id: `u${Date.now()}`, username, name, email, password: passwordHash || '', role, createdAt: new Date().toISOString() };
        users.push(newUser);
        usersSave(users);
        showToast('Usuario creado', 'success');
      }
    }
    closeUserModal();
    renderUsersList();
  }

  async function deleteUser(id) {
    const u = users.find(x => x.id === id);
    if (!u || u.username === 'admin') return;
    if (confirm(`¿Eliminar usuario ${u.username}?`)) {
      if (useFirebase) {
        try {
          await db.collection('users').doc(id).delete();
        } catch (err) {
          showToast('Error al eliminar usuario: ' + err.message, 'error');
          return;
        }
      } else {
        usersSave(users.filter(x => x.id !== id));
      }
      users = users.filter(x => x.id !== id);
      renderUsersList();
      showToast('Usuario eliminado', 'info');
    }
  }

  function closeUserModal() { closeModalById('userModal'); }

  // -----------------------------------------------------------------
  // Helpers UI genéricos
  // -----------------------------------------------------------------
  function openModal(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.add('open'); document.body.style.overflow = 'hidden'; }
  }

  function closeModal(e) {
    if (e.target === e.currentTarget) closeModalById(e.currentTarget.id);
  }

  function closeTicketModal() { closeModalById('ticketModal'); }

  function closeConfirmModal(e) {
    if (e && e.target !== e.currentTarget) return;
    closeModalById('confirmModal');
    pendingDeleteId = null;
    const btn = document.getElementById('confirmDeleteBtn');
    if (btn) btn.onclick = executeDelete;
  }

  function closeModalById(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('open'); document.body.style.overflow = ''; }
  }

  /**
   * Muestra un toast.
   * @param {string} message
   * @param {string} [type='info']
   */
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<span>${escHtml(message)}</span>`;
    container.appendChild(t);
    setTimeout(() => {
      t.classList.add('hide');
      t.addEventListener('animationend', () => t.remove());
    }, 3200);
  }

  function escHtml(str) { return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function trySet(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
  function tryVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
  function tryWidth(id, val) { const el
