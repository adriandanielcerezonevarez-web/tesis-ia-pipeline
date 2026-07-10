// app.js
import { initAuth, logout, getSession } from './auth.js';
import {
  initFirebase,
  loadUsers,
  loadTickets,
  generateTicketId,
  generateLocalTicketId,
  saveTicketLocal,
  loadTicketsLocal,
  loadUsersLocal,
  clearAllData as clearDataBackend
} from './firebaseAdapter.js';
import { loadFromStorage, saveToStorage, clearStorage } from './storage.js';
import {
  renderAll,
  renderDashboard,
  renderTicketsList,
  renderMyTickets,
  renderReports,
  renderUsersList,
  showSection,
  updateNavBadge,
  updateConnectionBadge,
  showToast,
  openModal,
  closeModalById
} from './ui.js';
import {
  sanitizeInput,
  escapeHtml,
  formatDate,
  isValidEmail
} from './utils.js';

/**
 * Centralized logger.
 * @param {'info'|'warn'|'error'} level - Log level.
 * @param {...any} args - Values to log.
 */
function logger(level, ...args) {
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  console[level](`${prefix}`, ...args);
}

/**
 * Centralized error handler that logs and shows a toast.
 * @param {Error} err - The error object.
 * @param {string} userMessage - Message to display to the user.
 * @param {string} [context] - Optional operation context.
 */
function handleError(err, userMessage, context = '') {
  logger('error', `${context}:`, err);
  showToast(userMessage, 'error');
}

/* ---------- State Store (immutable pattern) ---------- */
const StateStore = (() => {
  /** @type {Object} Internal immutable state */
  let _state = {
    session: null,
    db: null,
    useFirebase: false,
    tickets: [],
    users: [],
    currentSection: '',
    editingTicketId: null,
    pendingDeleteTicketId: null
  };

  /**
   * Returns a shallow copy of the current state.
   * @returns {Object}
   */
  function getState() {
    return { ..._state };
  }

  /**
   * Merges a new partial state into the internal state.
   * @param {Object} newState
   */
  function setState(newState) {
    _state = { ..._state, ...newState };
  }

  /**
   * Public update method.
   * @param {Object} partial
   */
  function update(partial) {
    setState(partial);
  }

  return { getState, update };
})();

/* ---------- Repository Abstraction ---------- */
class TicketRepository {
  /**
   * @param {boolean} useFirebase
   * @param {Object} db
   */
  constructor(useFirebase, db) {
    this.useFirebase = useFirebase;
    this.db = db;
  }

  /**
   * Create a new ticket.
   * @param {Object} ticket
   * @param {Array} currentTickets
   * @returns {Promise<void>}
   */
  async create(ticket, currentTickets) {
    if (this.useFirebase) {
      const id = await generateTicketId();
      await this.db.collection('tickets').doc(id).set({ id, ...ticket });
    } else {
      const id = generateLocalTicketId();
      const newTicket = { id, ...ticket };
      const newList = [newTicket, ...currentTickets];
      StateStore.update({ tickets: newList });
      saveTicketLocal(newList);
    }
  }

  /**
   * Update an existing ticket.
   * @param {string} id
   * @param {Object} ticket
   * @param {Array} currentTickets
   * @returns {Promise<void>}
   */
  async update(id, ticket, currentTickets) {
    if (this.useFirebase) {
      await this.db.collection('tickets').doc(id).update(ticket);
    } else {
      const idx = currentTickets.findIndex(t => t.id === id);
      if (idx === -1) throw new Error('Ticket to update not found');
      const updated = {
        ...currentTickets[idx],
        ...ticket,
        updatedAt: new Date().toISOString()
      };
      const newList = [...currentTickets];
      newList[idx] = updated;
      StateStore.update({ tickets: newList });
      saveTicketLocal(newList);
    }
  }
}

/* ---------- Data Service ---------- */
const DataService = (() => {
  /**
   * Validates data loaded from storage.
   * @param {any} data - Raw data from storage.
   * @param {'tickets'|'users'} type - Expected type.
   * @returns {Array|Object|null}
   */
  function validateStorageData(data, type) {
    if (!data) return null;
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      if (type === 'tickets' && Array.isArray(parsed)) return parsed;
      if (type === 'users' && Array.isArray(parsed)) return parsed;
    } catch (e) {
      logger('warn', `Invalid ${type} data in storage`, e);
    }
    return null;
  }

  /**
   * Loads initial data from Firebase; falls back to local storage on error.
   */
  async function loadInitialData() {
    try {
      await loadUsers();
      await loadTickets();
      updateConnectionBadge(true);
    } catch (err) {
      logger('error', 'Error loading data from Firebase:', err);
      fallbackToLocalStorage();
    }
  }

  /**
   * Loads data from local storage with validation.
   */
  function fallbackToLocalStorage() {
    updateConnectionBadge(false);
    const ticketsRaw = loadFromStorage('helpdesk_tickets');
    const usersRaw = loadFromStorage('helpdesk_users');

    const tickets = validateStorageData(ticketsRaw, 'tickets');
    const users = validateStorageData(usersRaw, 'users');

    if (tickets) StateStore.update({ tickets });
    if (users) StateStore.update({ users });
  }

  return { loadInitialData, fallbackToLocalStorage };
})();

/* ---------- Ticket Service ---------- */
const TicketService = (() => {
  /**
   * Validate and sanitize ticket fields.
   * @param {Object} raw - Raw input values.
   * @returns {{valid: boolean, data?: Object, errors?: string[]}}
   */
  function validateAndSanitize(raw) {
    const errors = [];

    const title = escapeHtml(sanitizeInput(raw.title?.trim() ?? ''));
    if (!title) errors.push('El título es obligatorio');

    const category = escapeHtml(sanitizeInput(raw.category?.trim() ?? ''));
    const priority = escapeHtml(sanitizeInput(raw.priority?.trim() ?? ''));
    const description = escapeHtml(sanitizeInput(raw.description?.trim() ?? ''));
    const status = escapeHtml(sanitizeInput(raw.status?.trim() ?? 'Abierto'));
    const assigned = escapeHtml(sanitizeInput(raw.assigned?.trim() ?? ''));
    const requester = escapeHtml(sanitizeInput(raw.requester?.trim() ?? ''));
    const email = escapeHtml(sanitizeInput(raw.email?.trim() ?? ''));
    const notes = escapeHtml(sanitizeInput(raw.notes?.trim() ?? ''));

    if (email && !isValidEmail(email)) errors.push('Formato de email inválido');

    if (errors.length) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      data: { title, category, priority, description, status, assigned, requester, email, notes }
    };
  }

  /**
   * Build a ticket object ready for persistence.
   * @param {Object} fields - Sanitized ticket fields.
   * @param {Object} session - Current session.
   * @returns {Object}
   */
  function buildTicket(fields, session) {
    return {
      ...fields,
      createdAt: new Date().toISOString(),
      requesterId: session.role === 'admin' ? null : session.userId
    };
  }

  /**
   * Authorization check before persisting.
   * @param {Object} session
   * @param {Object} ticketData
   * @throws {Error} If not authorized.
   */
  function authorize(session, ticketData) {
    // Only admin can assign tickets to others
    if (ticketData.assigned && session.role !== 'admin') {
      throw new Error('Solo administradores pueden asignar tickets');
    }
    // Requester must match session unless admin
    if (session.role !== 'admin' && ticketData.requesterId && ticketData.requesterId !== session.userId) {
      throw new Error('No está autorizado a crear tickets para otro usuario');
    }
  }

  /**
   * Public API to save a ticket (create or update).
   * @param {Object} rawFields - Raw input values from UI.
   * @returns {Promise<void>}
   */
  async function save(rawFields) {
    const validation = validateAndSanitize(rawFields);
    if (!validation.valid) {
      validation.errors.forEach(msg => showToast(msg, 'error'));
      return;
    }

    const { session, db, useFirebase, tickets } = StateStore.getState();
    const ticketData = buildTicket(validation.data, session);
    try {
      authorize(session, ticketData);
    } catch (authErr) {
      handleError(authErr, 'Operación no autorizada', 'Authorization');
      return;
    }

    const { editingTicketId } = StateStore.getState();
    const isUpdate = Boolean(editingTicketId);
    const repo = new TicketRepository(useFirebase, db);

    try {
      if (isUpdate) {
        await repo.update(editingTicketId, ticketData, tickets);
      } else {
        await repo.create(ticketData, tickets);
      }
      showToast(isUpdate ? 'Ticket actualizado' : 'Ticket creado', 'success');
      StateStore.update({ editingTicketId: null });
    } catch (err) {
      handleError(err, 'Error al guardar ticket', 'TicketService.save');
    }
  }

  return { save, validateAndSanitize };
})();

/* ---------- UI Controller ---------- */
const UIController = (() => {
  /**
   * Initialize authentication layer.
   * @returns {boolean} True if auth initialized successfully.
   */
  function initAuthentication() {
    const ok = initAuth();
    if (!ok) {
      showToast('Error al iniciar sesión', 'error');
    }
    return ok;
  }

  /**
   * Initialize Firebase layer with error handling.
   * @returns {Promise<void>}
   */
  async function initFirebaseLayer() {
    try {
      await initFirebase();
    } catch (err) {
      handleError(err, 'Error de conexión con la base de datos', 'FirebaseInit');
    }
  }

  /**
   * Initialize UI components and event listeners.
   */
  function initUI() {
    renderAll();
    setupSidebar();
    setupCharCounter();

    const session = getSession();
    StateStore.update({ session });
    showSection(session.role === 'admin' ? 'dashboard' : 'mytickets');
  }

  /**
   * Main entry point for the application.
   */
  async function init() {
    if (!initAuthentication()) return;
    await initFirebaseLayer();
    await DataService.loadInitialData();
    initUI();
  }

  /**
   * Configures sidebar toggle and connection status indicator.
   */
  function setupSidebar() {
    const toggle = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    if (toggle && sidebar) {
      toggle.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        document.body.classList.toggle('collapsed');
      });
    }
    const footer = document.querySelector('.sidebar-footer');
    if (footer && !document.getElementById('sidebarConnStatus')) {
      const statusDiv = document.createElement('div');
      statusDiv.id = 'sidebarConnStatus';
      statusDiv.style.cssText = 'padding:4px 8px;text-align:center';
      footer.prepend(statusDiv);
    }
  }

  /**
   * Sets up character counter for ticket description field.
   */
  function setupCharCounter() {
    const desc = document.getElementById('ticketDescription');
    const count = document.getElementById('charCount');
    if (desc && count) {
      desc.addEventListener('input', () => {
        count.textContent = `${desc.value.length} / 2000`;
      });
    }
  }

  /**
   * Handler attached to the ticket form submit event.
   * @param {Event} e
   */
  async function handleSaveTicket(e) {
    e.preventDefault();
    const fields = {
      title: document.getElementById('ticketTitle')?.value,
      category: document.getElementById('ticketCategory')?.value,
      priority: document.getElementById('ticketPriority')?.value,
      description: document.getElementById('ticketDescription')?.value,
      status: document.getElementById('ticketStatus')?.value,
      assigned: document.getElementById('ticketAssigned')?.value,
      requester: document.getElementById('ticketRequester')?.value,
      email: document.getElementById('ticketEmail')?.value,
      notes: document.getElementById('ticketNotes')?.value
    };
    await TicketService.save(fields);
    const { session } = StateStore.getState();
    showSection(session.role === 'admin' ? 'tickets' : 'mytickets');
  }

  return { init, handleSaveTicket };
})();

/* ---------- Exported Public API ---------- */
export {
  // State (read‑only)
  StateStore as state,
  // UI entry point
  UIController as uiController,
  // Auth utilities
  logout,
  // Ticket id generators (kept for backward compatibility)
  generateLocalTicketId,
  generateTicketId,
  // Fallback utilities
  DataService.fallbackToLocalStorage,
  clearDataBackend
};

document.addEventListener('DOMContentLoaded', UIController.init);
