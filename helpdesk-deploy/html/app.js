// claves de sesión y almacenamiento
const SESSION_KEY = 'helpdesk_session';
const USERS_KEY = 'helpdesk_users';
const DB_KEY = 'helpdesk_tickets';
const COUNTER_KEY = 'helpdesk_counter';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos

/** @type {Object} Estado global de la aplicación encapsulado */
const state = (() => ({
  session: null,
  db: null,
  useFirebase: false,
  unsubscribeTickets: null,
  tickets: [],
  users: [],
  currentSection: '',
  editingId: null,
  pendingDeleteId: null
}))();

/** Central logger */
function log(level, ...args) {
  const prefix = `[${level.toUpperCase()}]`;
  console[level] ? console[level](prefix, ...args) : console.log(prefix, ...args);
}

/**
 * Escapa texto para evitar XSS.
 * @param {string} str - Texto a escapar.
 * @returns {string} Texto escapado.
 */
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inicializa Firebase si la configuración está disponible.
 */
function initFirebase() {
  if (typeof FIREBASE_CONFIGURED === 'undefined' || !FIREBASE_CONFIGURED) return;
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    state.db = firebase.firestore();
    state.useFirebase = true;
    log('info', 'firestore conectado');
  } catch (err) {
    log('warn', 'firebase no disponible, fallback a localStorage:', err);
    state.useFirebase = false;
    state.db = null;
  }
}

/**
 * Actualiza el badge de conexión en el sidebar.
 * @param {boolean} online - Indica si está conectado a Firebase.
 */
function updateConnectionBadge(online) {
  const foot = document.getElementById('sidebarConnStatus');
  if (!foot) return;
  foot.innerHTML = online
    ? '<span style="color:#2e7d32;font-size:11px">online</span>'
    : '<span style="color:#b76e00;font-size:11px">modo local</span>';
}

/**
 * Inicializa la sesión a partir de sessionStorage.
 * Verifica expiración del token.
 * @returns {boolean} true si la sesión es válida
 */
function initAuth() {
  const s = sessionStorage.getItem(SESSION_KEY);
  if (!s) {
    redirectToLogin();
    return false;
  }

  try {
    const stored = JSON.parse(s);
    if (stored.expires && Date.now() > stored.expires) {
      sessionStorage.removeItem(SESSION_KEY);
      redirectToLogin();
      return false;
    }
    state.session = stored;
  } catch (e) {
    log('error', 'Error parsing session data:', e);
    redirectToLogin();
    return false;
  }

  document.body.classList.add(`role-${state.session.role}`);

  const nameEl = document.getElementById('userDisplayName');
  const roleEl = document.getElementById('userDisplayRole');
  const avatarEl = document.getElementById('userAvatar');
  const badgeEl = document.getElementById('topbarRoleBadge');

  if (nameEl) nameEl.textContent = state.session.name;
  if (roleEl) roleEl.textContent = state.session.role === 'admin' ? 'Administrador' : 'Usuario';
  if (avatarEl) avatarEl.textContent = state.session.name.charAt(0).toUpperCase();
  if (badgeEl) badgeEl.innerHTML = state.session.role === 'admin' ? 'Admin' : 'Usuario';

  return true;
}

/**
 * Redirige al login si no está ya en esa página.
 */
function redirectToLogin() {
  if (!window.location.pathname.endsWith('login.html')) {
    window.location.href = 'login.html';
  }
}

/**
 * Cierra sesión y limpia recursos.
 */
function logout() {
  if (state.unsubscribeTickets) state.unsubscribeTickets();
  sessionStorage.removeItem(SESSION_KEY);
  window.location.href = 'login.html';
}

/* ---------- Persistencia local ---------- */
function dbLoad() {
  try {
    return JSON.parse(localStorage.getItem(DB_KEY)) || [];
  } catch {
    return [];
  }
}
function dbSave(ticketsArr) {
  localStorage.setItem(DB_KEY, JSON.stringify(ticketsArr));
}
function dbNextId() {
  const current = parseInt(localStorage.getItem(COUNTER_KEY) || '0', 10);
  const next = current + 1;
  localStorage.setItem(COUNTER_KEY, String(next));
  return `TK-${String(next).padStart(4, '0')}`;
}
function usersLoad() {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY)) || [];
  } catch {
    return [];
  }
}
function usersSave(usersArr) {
  localStorage.setItem(USERS_KEY, JSON.stringify(usersArr));
}

/* ---------- Persistencia Firebase ---------- */
async function fbNextId() {
  if (!state.db) throw new Error('Firestore no inicializado');
  const counterRef = state.db.collection('meta').doc('counter');
  return state.db.runTransaction(async t => {
    const snap = await t.get(counterRef);
    const next = (snap.exists ? snap.data().value : 0) + 1;
    t.set(counterRef, { value: next });
    return `TK-${String(next).padStart(4, '0')}`;
  });
}
async function fbLoadUsers() {
  if (!state.db) throw new Error('Firestore no inicializado');
  const snap = await state.db.collection('users').get();
  return snap.docs.map(d => d.data());
}

/* ---------- Validación y Sanitización ---------- */
function validateTicketData(data) {
  if (!data.title || data.title.length < 3) {
    return { valid: false, message: 'El título es obligatorio y debe tener al menos 3 caracteres.' };
  }
  if (!data.category) return { valid: false, message: 'La categoría es obligatoria.' };
  if (!data.priority) return { valid: false, message: 'La prioridad es obligatoria.' };
  if (data.description && data.description.length > 2000) {
    return { valid: false, message: 'La descripción no puede exceder 2000 caracteres.' };
  }
  return { valid: true, message: '' };
}
function sanitizeText(str) {
  return escHtml(str);
}

/* ---------- Inicialización ---------- */
if (!window.location.pathname.endsWith('login.html')) {
  document.addEventListener('DOMContentLoaded', async () => {
    if (!initAuth()) return;

    initFirebase();

    if (state.useFirebase) {
      try {
        state.users = await fbLoadUsers();
        updateConnectionBadge(true);

        // Verificar usuarios por defecto
        const defaults = [
          { id: 'u1', username: 'admin', name: 'Administrador Principal', role: 'admin', email: 'admin@empresa.com', createdAt: new Date().toISOString() },
          { id: 'u2', username: 'profesor', name: 'Profesor', role: 'admin', email: 'profesor@empresa.com', createdAt: new Date().toISOString() },
          { id: 'u3', username: 'adrian', name: 'Adrian', role: 'user', email: 'adrian@empresa.com', createdAt: new Date().toISOString() },
          { id: 'u4', username: 'allison', name: 'Allison', role: 'user', email: 'allison@empresa.com', createdAt: new Date().toISOString() }
        ];
        const needsUpdate = state.users.length === 0 || defaults.some(d => !state.users.find(u => u.id === d.id));
        if (needsUpdate) {
          const batch = state.db.batch();
          defaults.forEach(u => batch.set(state.db.collection('users').doc(u.id), u));
          await batch.commit();
          state.users = defaults;
        }

        // Suscripción a tickets
        state.unsubscribeTickets = state.db.collection('tickets')
          .orderBy('createdAt', 'desc')
          .onSnapshot(snap => {
            state.tickets = snap.docs.map(d => d.data());
            renderAll();
            updateNavBadge();
          }, err => {
            log('error', 'onSnapshot error:', err);
          });

        // Carga inicial
        const initSnap = await state.db.collection('tickets').orderBy('createdAt', 'desc').get();
        state.tickets = initSnap.docs.map(d => d.data());

        if (state.tickets.length === 0) await seedDemoData();
      } catch (err) {
        log('error', 'bootstrap firebase error:', err);
        fallbackToLocal();
      }
    } else {
      fallbackToLocal();
    }

    renderAll();
    setupSidebar();
    setupCharCounter();

    if (state.session.role === 'admin') showSection('dashboard');
    else showSection('mytickets');
  });
}

/**
 * Fallback a almacenamiento local en caso de error con Firebase.
 */
function fallbackToLocal() {
  updateConnectionBadge(false);
  state.tickets = dbLoad();
  state.users = usersLoad();
  seedDemoData();
}

/**
 * Carga datos de demostración si la base está vacía.
 */
async function seedDemoData() {
  if (state.tickets.length > 0) return;
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
        const id = await fbNextId();
        batch.set(state.db.collection('tickets').doc(id), { id, ...d });
        state.tickets.push({ id, ...d });
      }
      await batch.commit();
    } catch (err) {
      log('error', 'seedDemoData firebase error:', err);
    }
  } else {
    demos.forEach(d => {
      const id = dbNextId();
      state.tickets.push({ id, ...d });
    });
    dbSave(state.tickets);
  }
}

/* ---------- UI Helpers ---------- */
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

/* ---------- Sección y Navegación ---------- */
const SECTION_META = {
  dashboard: { title: 'Panel de Control', subtitle: 'Resumen general del sistema' },
  tickets: { title: 'Todos los Tickets', subtitle: 'Gestión global de soporte' },
  mytickets: { title: 'Mis Tickets', subtitle: 'Gestión de tus solicitudes' },
  create: { title: 'Nuevo Ticket', subtitle: 'Crear un nuevo ticket' },
  reports: { title: 'Reportes', subtitle: 'Estadísticas del sistema' },
  users: { title: 'Usuarios', subtitle: 'Gestión de cuentas' }
};

function showSection(name) {
  if (state.session.role === 'user' && ['dashboard', 'tickets', 'reports', 'users'].includes(name)) return;

  state.currentSection = name;

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
  if (name === 'create' && !state.editingId) resetForm();
}

/* ---------- Contador de caracteres ---------- */
function setupCharCounter() {
  const desc = document.getElementById('ticketDescription');
  const count = document.getElementById('charCount');
  if (desc && count) {
    desc.addEventListener('input', () => {
      count.textContent = `${desc.value.length} / 2000`;
    });
  }
}

/* ---------- Renderizado ---------- */
function renderAll() {
  if (state.session.role === 'admin') {
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
  if (state.session.role === 'admin') {
    const open = state.tickets.filter(t => t.status === 'Abierto').length;
    const b = document.getElementById('nav-badge');
    if (b) b.textContent = open;
  } else {
    const open = state.tickets.filter(t => t.requesterId === state.session.userId && t.status !== 'Cerrado' && t.status !== 'Resuelto').length;
    const bu = document.getElementById('nav-badge-user');
    if (bu) bu.textContent = open;
  }
}

/* ---------- Dashboard ---------- */
function renderDashboard() {
  if (state.session.role !== 'admin') return;
  const total = state.tickets.length;
  const open = state.tickets.filter(t => t.status === 'Abierto').length;
  const progress = state.tickets.filter(t => t.status === 'En Progreso').length;
  const closed = state.tickets.filter(t => t.status === 'Resuelto' || t.status === 'Cerrado').length;

  trySet('stat-total', total);
  trySet('stat-open', open);
  trySet('stat-progress', progress);
  trySet('stat-closed', closed);

  const pc = { 'Crítica': 0, 'Alta': 0, 'Media': 0, 'Baja': 0 };
  state.tickets.forEach(t => { if (pc[t.priority] !== undefined) pc[t.priority]++; });
  const maxP = Math.max(...Object.values(pc), 1);

  tryWidth('bar-critica', `${(pc['Crítica'] / maxP) * 100}%`); trySet('count-critica', pc['Crítica']);
  tryWidth('bar-alta', `${(pc['Alta'] / maxP) * 100}%`); trySet('count-alta', pc['Alta']);
  tryWidth('bar-media', `${(pc['Media'] / maxP) * 100}%`); trySet('count-media', pc['Media']);
  tryWidth('bar-baja', `${(pc['Baja'] / maxP) * 100}%`); trySet('count-baja', pc['Baja']);

  const catCounts = {};
  state.tickets.forEach(t => { catCounts[t.category] = (catCounts[t.category] || 0) + 1; });
  const catEl = document.getElementById('categoryStats');
  if (catEl) {
    const s = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
    catEl.innerHTML = s.length
      ? s.map(([c, n]) => `<div class="category-stat-item"><span class="category-stat-name">${c}</span><span class="category-stat-count">${n}</span></div>`).join('')
      : '<div class="empty-state-small">Sin datos</div>';
  }

  const recent = [...state.tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  const recEl = document.getElementById('recentTicketsList');
  if (recEl) {
    recEl.innerHTML = recent.length
      ? recent.map(t => `<div class="recent-ticket-item" onclick="openTicketModal('${t.id}')"><span class="recent-ticket-id">${t.id}</span><span class="recent-ticket-title">${escHtml(t.title)}</span><span class="recent-ticket-meta">${statusBadgeHtml(t.status)}</span></div>`).join('')
      : '<div class="empty-state-small">No hay tickets</div>';
  }
}

/* ---------- Listado de tickets (admin) ---------- */
function renderTicketsList(filtered) {
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
            <button class="action-btn" title="Ver" onclick="openTicketModal('${t.id}')">👁️</button>
            <button class="action-btn" title="Editar" onclick="editTicket('${t.id}')">✏️</button>
            <button class="action-btn" title="Asignar técnico" onclick="asignarTecnico('${t.id}')">⚙️</button>
            <button class="action-btn danger" title="Eliminar" onclick="confirmDelete('${t.id}')">🗑️</button>
          </div>
        </td>
      </tr>
    `).join('');
  }
}

/* ---------- Mis tickets (usuario) ---------- */
function renderMyTickets() {
  if (state.session.role !== 'user') return;
  const myTickets = state.tickets.filter(t => t.requesterId === state.session.userId);

  trySet('bannerName', `Hola, ${state.session.name.split(' ')[0]}`);
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

/* ---------- Filtros ---------- */
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

/* ---------- Debounce de filtros ---------- */
let _filterTimer = null;
function filterTickets() {
  clearTimeout(_filterTimer);
  _filterTimer = setTimeout(() => {
    if (state.session.role === 'admin') renderTicketsList();
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

/* ---------- Modal de detalle ---------- */
function openTicketModal(id) {
  const t = state.tickets.find(x => x.id === id);
  if (!t) return;
  if (state.session.role === 'user' && t.requesterId !== state.session.userId) {
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
  if (state.session.role === 'admin' && t.notes) {
    notesHtml = `<div class="modal-notes-label">Notas internas (solo admin)</div>
                 <div class="modal-notes">${escHtml(t.notes)}</div>`;
  }

  document.getElementById('modalBody').innerHTML = `
    <div class="modal-detail-grid">
      <div class="modal-detail-item"><div class="modal-detail-label">Solicitante</div><div class="modal-detail-value">${escHtml(t.requester || '—')}</div></div>
      <div class="modal-detail-item"><div class="modal-detail-label">Asignado a</div><div class="modal-detail-value">${escHtml(t.assigned || '—')}</div></div>
      ${state.session.role === 'admin' ? `<div class="modal-detail-item"><div class="modal-detail-label">Email</div><div class="modal-detail-value">${t.email ? `<a href="mailto:${escHtml(t.email)}" style="color:var(--accent-light)">${escHtml(t.email)}</a>` : '—'}</div></div>` : ''}
      <div class="modal-detail-item"><div class="modal-detail-label">Creado</div><div class="modal-detail-value">${formatDateFull(t.createdAt)}</div></div>
    </div>
    <div class="modal-detail-label" style="margin-bottom:8px">Descripción</div>
    <div class="modal-description">${escHtml(t.description)}</div>
    ${notesHtml}
  `;

  const editBtn = document.getElementById('modalEditBtn');
  const delBtn = document.getElementById('modalDeleteBtn');

  if (editBtn) {
    if (state.session.role === 'admin' || (t.status !== 'Resuelto' && t.status !== 'Cerrado')) {
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

/* ---------- Formulario de ticket ---------- */
function resetForm() {
  state.editingId = null;
  const form = document.getElementById('ticketForm');
  if (form) form.reset();

  trySet('ticketId', '');
  const statusEl = document.getElementById('ticketStatus');
  if (statusEl) statusEl.value = 'Abierto';

  if (state.session.role === 'user') {
    const reqField = document.getElementById('ticketRequester');
    const mailField = document.getElementById('ticketEmail');
    if (reqField) { reqField.value = state.session.name; reqField.readOnly = true; }
    if (mailField) { mailField.value = state.session.email || ''; mailField.readOnly = true; }
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
  const t = state.tickets.find(x => x.id === id);
  if (!t) return;
  if (state.session.role === 'user' && t.requesterId !== state.session.userId) {
    showToast('Acceso denegado', 'error');
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
  if (badge) { badge.textContent = t.id; badge.style.display = 'inline-block'; }
  trySet('pageTitle', `Editar ${t.id}`);
  trySet('pageSubtitle', t.title);

  showSection('create');
}

/**
 * Guarda o actualiza un ticket.
 * @param {Event} e - Evento de submit del formulario.
 */
async function saveTicket(e) {
  e.preventDefault();

  const title = sanitizeText(document.getElementById('ticketTitle').value.trim());
  const category = document.getElementById('ticketCategory').value;
  const priority = document.getElementById('ticketPriority').value;
  const description = sanitizeText(document.getElementById('ticketDescription').value.trim());

  const status = document.getElementById('ticketStatus')?.value || 'Abierto';
  const assigned = document.getElementById('ticketAssigned')?.value.trim() || '';
  const requester = document.getElementById('ticketRequester')?.value.trim() || state.session.name;
  const email = document.getElementById('ticketEmail')?.value.trim() || '';
  const notes = sanitizeText(document.getElementById('ticketNotes')?.value.trim() || '');
  const requesterId = state.session.role === 'admin' ? null : state.session.userId;

  const validation = validateTicketData({ title, category, priority, description });
  if (!validation.valid) {
    showToast(validation.message, 'error');
    return;
  }

  if (state.useFirebase) {
    try {
      if (state.editingId) {
        const updateData = state.session.role === 'admin'
          ? { title, category, priority, status, assigned, requester, email, description, notes, updatedAt: new Date().toISOString() }
          : { title, category, priority, description, updatedAt: new Date().toISOString() };
        await state.db.collection('tickets').doc(state.editingId).update(updateData);
        showToast('Ticket actualizado', 'success');
      } else {
        const id = await fbNextId();
        const newTicket = { id, title, category, priority, status, assigned, requester, requesterId, email, description, notes, createdAt: new Date().toISOString() };
        await state.db.collection('tickets').doc(id).set(newTicket);
        showToast(`Ticket ${id} creado`, 'success');
      }
    } catch (err) {
      log('error', 'saveTicket Firebase error:', err);
      showToast('Error al guardar ticket: ' + err.message, 'error');
      return;
    }
  } else {
    if (state.editingId) {
      const idx = state.tickets.findIndex(t => t.id === state.editingId);
      if (idx !== -1) {
        if (state.session.role === 'admin') {
          state.tickets[idx] = { ...state.tickets[idx], title, category, priority, status, assigned, requester, email, description, notes, updatedAt: new Date().toISOString() };
        } else {
          state.tickets[idx] = { ...state.tickets[idx], title, category, priority, description, updatedAt: new Date().toISOString() };
        }
        dbSave(state.tickets);
        showToast('Ticket actualizado', 'success');
      }
    } else {
      const newTicket = { id: dbNextId(), title, category, priority, status, assigned, requester, requesterId, email, description, notes, createdAt: new Date().toISOString() };
      state.tickets.unshift(newTicket);
      dbSave(state.tickets);
      showToast(`Ticket ${newTicket.id} creado`, 'success');
    }
    renderAll();
  }

  state.editingId = null;
  showSection(state.session.role === 'admin' ? 'tickets' : 'mytickets');
}

function cancelForm() {
  state.editingId = null;
  showSection(state.session.role === 'admin' ? 'tickets' : 'mytickets');
}

/* ---------- Asignación rápida de técnico ---------- */
const TECNICOS = ['Ing. Jose Fernandez', 'Ing. Luis Marquez', 'Ing. Eric Villagomez', 'Ing. Ivan Rodrigues'];

function asignarTecnico(id) {
  if (state.session.role !== 'admin') {
    showToast('Acceso denegado', 'error');
    return;
  }
  cerrarMenuAsignar();
  const overlay = document.createElement('div');
  overlay.id = 'asignarOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:1000;display:flex;align-items:center;justify-content:center;';
  overlay.onclick = e => { if (e.target === overlay) cerrarMenuAsignar(); };
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:6px;padding:18px 20px;min-width:280px;box-shadow:0 4px 18px rgba(0,0,0,.22);';
  box.innerHTML = `<h3 style="margin:0 0 12px;font-size:15px;">Asignar técnico al ticket ${id}</h3>` +
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
  if (state.session.role !== 'admin') return;
  if (state.useFirebase) {
    try {
      await state.db.collection('tickets').doc(id).update({ assigned: tecnico, updatedAt: new Date().toISOString() });
      showToast(`Ticket ${id} asignado a ${tecnico}`, 'success');
    } catch (err) {
      showToast('Error al asignar: ' + err.message, 'error');
    }
  } else {
    const idx = state.tickets.findIndex(t => t.id === id);
    if (idx !== -1) {
      state.tickets[idx] = { ...state.tickets[idx], assigned: tecnico, updatedAt: new Date().toISOString() };
      dbSave(state.tickets);
      showToast(`Ticket ${id} asignado a ${tecnico}`, 'success');
      renderAll();
    }
  }
}

/* ---------- Borrado ---------- */
function confirmDelete(id) {
  if (state.session.role !== 'admin') return;
  state.pendingDeleteId = id;
  openModal('confirmModal');
}
async function executeDelete() {
  if (!state.pendingDeleteId) return;
  if (state.useFirebase) {
    try {
      await state.db.collection('tickets').doc(state.pendingDeleteId).delete();
      showToast('Ticket eliminado', 'info');
    } catch (err) {
      showToast('Error al eliminar: ' + err.message, 'error');
    }
  } else {
    state.tickets = state.tickets.filter(t => t.id !== state.pendingDeleteId);
    dbSave(state.tickets);
    showToast('Ticket eliminado', 'info');
    renderAll();
  }
  state.pendingDeleteId = null;
  closeConfirmModal();
}

/* ---------- Reportes ---------- */
function renderReports() {
  if (state.session.role !== 'admin') return;
  const total = state.tickets.length;
  const open = state.tickets.filter(t => t.status === 'Abierto').length;
  const progress = state.tickets.filter(t => t.status === 'En Progreso').length;
  const resolved = state.tickets.filter(t => t.status === 'Resuelto').length;
  const closed = state.tickets.filter(t => t.status === 'Cerrado').length;
  const critica = state.tickets.filter(t => t.priority === 'Crítica').length;
  const assigned = state.tickets.filter(t => t.assigned).length;

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

/* ---------- Exportar y limpiar ---------- */
function exportJSON() {
  const data = JSON.stringify({ tickets: state.tickets, users: state.users }, null, 2);
  downloadFile('helpdesk_backup.json', data, 'application/json');
}
function exportCSV() {
  const headers = ['ID', 'Título', 'Categoría', 'Prioridad', 'Estado', 'Asignado', 'Solicitante', 'Creado'];
  const rows = state.tickets.map(t => [t.id, t.title, t.category, t.priority, t.status, t.assigned || '', t.requester || '', formatDateFull(t.createdAt)]
    .map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
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
  if (state.useFirebase) {
    try {
      const snap = await state.db.collection('tickets').get();
      const batch = state.db.batch();
      snap.docs.forEach(doc => batch.delete(doc.ref));
      batch.set(state.db.collection('meta').doc('counter'), { value: 0 });
      await batch.commit();
      showToast('Base de datos depurada', 'info');
    } catch (err) {
      showToast('Error al limpiar: ' + err.message, 'error');
    }
  } else {
    state.tickets = [];
    localStorage.removeItem(DB_KEY);
    localStorage.removeItem(COUNTER_KEY);
    renderAll();
    showToast('Base de datos depurada', 'info');
  }
}

/* ---------- Gestión de usuarios ---------- */
function renderUsersList() {
  if (state.session.role !== 'admin') return;
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  tbody.innerHTML = state.users.map(u => `
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
  const u = state.users.find(x => x.id === id);
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
  const username = document.getElementById('userUsername').value.trim();
  const name = document.getElementById('userName').value.trim();
  const email = document.getElementById('userEmailField').value.trim();
  const password = document.getElementById('userPassword').value;
  const role = document.getElementById('userRole').value;

  if (!username) {
    showToast('El nombre de usuario es obligatorio', 'error');
    return;
  }

  if (state.useFirebase) {
    try {
      if (id) {
        const u = state.users.find(x => x.id === id);
        if (u && u.username === 'admin' && role !== 'admin') {
          showToast('El admin principal no puede cambiar de rol', 'error');
          return;
        }
        const updateData = { username, name, email, role };
        if (password) updateData.password = password;
        await state.db.collection('users').doc(id).update(updateData);
        const idx = state.users.findIndex(x => x.id === id);
        if (idx !== -1) state.users[idx] = { ...state.users[idx], ...updateData };
        showToast('Usuario actualizado', 'success');
      } else {
        const snap = await state.db.collection('users').where('username', '==', username.toLowerCase()).get();
        if (!snap.empty) {
          showToast('Nombre de usuario en uso', 'error');
          return;
        }
        const newUser = { id: `u${Date.now()}`, username, name, email, password, role, createdAt: new Date().toISOString() };
        await state.db.collection('users').doc(newUser.id).set(newUser);
        state.users.push(newUser);
        showToast('Usuario creado', 'success');
      }
    } catch (err) {
      showToast('Error al guardar usuario: ' + err.message, 'error');
      return;
    }
  } else {
    if (id) {
      const idx = state.users.findIndex(u => u.id === id);
      if (idx !== -1) {
        if (state.users[idx].username === 'admin' && role !== 'admin') {
          showToast('El admin principal no puede cambiar de rol', 'error');
          return;
        }
        state.users[idx] = { ...state.users[idx], username, name, email, role };
        if (password) state.users[idx].password = password;
        usersSave(state.users);
        showToast('Usuario actualizado', 'success');
      }
    } else {
      if (state.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
        showToast('Nombre de usuario en uso', 'error');
        return;
      }
      const newUser = { id: `u${Date.now()}`, username, name, email, password, role, createdAt: new Date().toISOString() };
      state.users.push(newUser);
      usersSave(state.users);
      showToast('Usuario creado', 'success');
    }
  }
  closeUserModal();
  renderUsersList();
}
async function deleteUser(id) {
  const u = state.users.find(x => x.id === id);
  if (!u || u.username === 'admin') return;
  if (confirm(`¿Eliminar usuario ${u.username}?`)) {
    if (state.useFirebase) {
      try {
        await state.db.collection('users').doc(id).delete();
      } catch (err) {
        showToast('Error al eliminar usuario: ' + err.message, 'error');
        return;
      }
    } else {
      usersSave(state.users.filter(x => x.id !== id));
    }
    state.users = state.users.filter(x => x.id !== id);
    renderUsersList();
    showToast('Usuario eliminado', 'info');
  }
}
function closeUserModal() { closeModalById('userModal'); }

/* ---------- UI Helpers ---------- */
function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
}
function closeModal(e) {
  if (e.target === e.currentTarget) closeModalById(e.currentTarget.id);
}
function closeUserModalOverlay(e) {
  if (e.target === e.currentTarget) closeUserModal();
}
function closeTicketModal() { closeModalById('ticketModal'); }
function closeConfirmModal(e) {
  if (e && e.target !== e.currentTarget) return;
  closeModalById('confirmModal');
  state.pendingDeleteId = null;
  if (document.getElementById('confirmDeleteBtn')) document.getElementById('confirmDeleteBtn').onclick = executeDelete;
}
function closeModalById(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('open');
    document.body.style.overflow = '';
  }
}

/* ---------- Toast ---------- */
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

/* ---------- Utilidades ---------- */
function trySet(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function tryVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function tryWidth(id, val) { const el = document.getElementById(id); if (el) el.style.width = val; }

function statusBadgeHtml(st) {
  const map = { 'Abierto': 'badge-abierto', 'En Progreso': 'badge-progreso', 'Resuelto': 'badge-resuelto', 'Cerrado': 'badge-cerrado' };
  return `<span class="badge ${map[st] || ''}">${st}</span>`;
}
function priorityBadgeHtml(pr) {
  const map = { 'Crítica': 'badge-critica', 'Alta': 'badge-alta', 'Media': 'badge-media', 'Baja': 'badge-baja' };
  return `<span class="badge ${map[pr] || ''}">${pr}</span>`;
}
function categoryEmoji(c) { return ''; }
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatDateFull(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
