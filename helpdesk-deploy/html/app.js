// app.js
import { initAuth, logout, getSession } from './auth.js';
import { initFirebase, loadUsers, loadTickets, generateTicketId, generateLocalTicketId, saveTicketLocal, loadTicketsLocal, loadUsersLocal, clearAllData as clearDataBackend } from './firebaseAdapter.js';
import { loadFromStorage, saveToStorage, clearStorage } from './storage.js';
import { renderAll, renderDashboard, renderTicketsList, renderMyTickets, renderReports, renderUsersList, showSection, updateNavBadge, updateConnectionBadge, showToast, openModal, closeModalById } from './ui.js';
import { sanitizeInput, escapeHtml, formatDate, formatDateFull, statusBadgeHtml, priorityBadgeHtml, categoryEmoji } from './utils.js';

/**
 * Centralized logger.
 * @param {string} level - Log level ('info', 'warn', 'error').
 * @param {...any} args - Values to log.
 */
function logger(level, ...args) {
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  console[level](`${prefix}`, ...args);
}

/* ---------- State Store (immutable pattern) ---------- */
const StateStore = (() => {
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

  /** Get a shallow copy of the current state */
  function getState() {
    return { ..._state };
  }

  /** Replace the whole state (used internally) */
  function setState(newState) {
    _state = { ..._state, ...newState };
  }

  /** Update a slice of the state immutably */
  function update(partial) {
    setState(partial);
  }

  return { getState, update };
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

    const title = sanitizeInput(raw.title?.trim() ?? '');
    if (!title) errors.push('El título es obligatorio');

    const category = sanitizeInput(raw.category?.trim() ?? '');
    const priority = sanitizeInput(raw.priority?.trim() ?? '');
    const description = sanitizeInput(raw.description?.trim() ?? '');
    const status = sanitizeInput(raw.status?.trim() ?? 'Abierto');
    const assigned = sanitizeInput(raw.assigned?.trim() ?? '');
    const requester = sanitizeInput(raw.requester?.trim() ?? '');
    const email = sanitizeInput(raw.email?.trim() ?? '');
    const notes = sanitizeInput(raw.notes?.trim() ?? '');

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
   * @param {Object} context - Contextual info (session, ids).
   * @returns {Object}
   */
  function buildTicket(fields, context) {
    const base = {
      ...fields,
      createdAt: new Date().toISOString(),
      requesterId: context.session.role === 'admin' ? null : context.session.userId
    };
    return base;
  }

  /**
   * Persist ticket using Firebase or local storage.
   * @param {Object} ticket - Ticket object.
   * @param {boolean} isUpdate - True if updating existing ticket.
   * @param {string|null} editId - Id of ticket being edited.
   * @returns {Promise<void>}
   */
  async function persistTicket(ticket, isUpdate, editId) {
    const { db, useFirebase, tickets } = StateStore.getState();

    if (useFirebase) {
      if (isUpdate && editId) {
        await db.collection('tickets').doc(editId).update(ticket);
      } else {
        const id = await generateTicketId();
        await db.collection('tickets').doc(id).set({ id, ...ticket });
      }
    } else {
      if (isUpdate && editId) {
        const idx = tickets.findIndex(t => t.id === editId);
        if (idx !== -1) {
          const updated = { ...tickets[idx], ...ticket, updatedAt: new Date().toISOString() };
          const newList = [...tickets];
          newList[idx] = updated;
          StateStore.update({ tickets: newList });
          saveTicketLocal(newList);
        }
      } else {
        const id = generateLocalTicketId();
        const newTicket = { id, ...ticket };
        const newList = [newTicket, ...tickets];
        StateStore.update({ tickets: newList });
        saveTicketLocal(newList);
      }
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

    const { session } = StateStore.getState();
    const ticketData = buildTicket(validation.data, { session });

    const { editingTicketId } = StateStore.getState();
    const isUpdate = Boolean(editingTicketId);
    try {
      await persistTicket(ticketData, isUpdate, editingTicketId);
      showToast(isUpdate ? 'Ticket actualizado' : `Ticket ${isUpdate ? '' : ''}creado`, 'success');
      StateStore.update({ editingTicketId: null });
    } catch (err) {
      logger('error', 'Error persisting ticket:', err);
      showToast('Error al guardar ticket', 'error');
    }
  }

  return { save };
})();

/* ---------- UI Controller ---------- */
const UIController = (() => {
  /**
   * Initialize the application UI.
   */
  async function init() {
    if (!initAuth()) return;

    await initFirebase();
    await loadInitialData();
    renderAll();
    setupSidebar();
    setupCharCounter();

    const session = getSession();
    StateStore.update({ session });
    showSection(session.role === 'admin' ? 'dashboard' : 'mytickets');
  }

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

  function fallbackToLocalStorage() {
    updateConnectionBadge(false);
    const tickets = loadFromStorage('helpdesk_tickets');
    const users = loadFromStorage('helpdesk_users');
    if (tickets) StateStore.update({ tickets });
    if (users) StateStore.update({ users });
    // seedDemoData could be defined elsewhere if needed
  }

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
  // Metadata
  SECTION_META,
  // UI entry point
  UIController as uiController,
  // Auth utilities
  logout,
  // Ticket id generators (kept for backward compatibility)
  generateLocalTicketId,
  generateTicketId,
  // Fallback utilities
  fallbackToLocalStorage,
  clearDataBackend
};

document.addEventListener('DOMContentLoaded', UIController.init);
