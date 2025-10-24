// Dashboard 2.0 - Common utilities

// Utility functions
function parseMoney(str) {
  if (!str) return 0;
  const n = Number(String(str).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseES(str) {
  if (!str) return 0;
  const n = Number(String(str).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function formatNumber(num) {
  return new Intl.NumberFormat().format(num);
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(amount);
}

// Tooltip management
class Tooltip {
  constructor() {
    this.element = document.getElementById('tooltip');
    if (!this.element) {
      this.element = document.createElement('div');
      this.element.id = 'tooltip';
      this.element.className = 'tooltip';
      this.element.style.display = 'none';
      document.body.appendChild(this.element);
    }
  }

  show(event, content) {
    this.element.innerHTML = content;
    this.element.style.display = 'block';
    this.element.style.left = (event.pageX + 10) + 'px';
    this.element.style.top = (event.pageY - 10) + 'px';
  }

  hide() {
    this.element.style.display = 'none';
  }
}

// Modal management
class Modal {
  constructor() {
    this.element = document.getElementById('modal');
    if (!this.element) {
      this.element = document.createElement('div');
      this.element.id = 'modal';
      this.element.className = 'modal';
      this.element.style.display = 'none';
      document.body.appendChild(this.element);
    }
  }

  show(content) {
    this.element.innerHTML = content;
    this.element.style.display = 'flex';
  }

  hide() {
    this.element.style.display = 'none';
  }
}

// EventSource wrapper for SSE
class EventSourceManager {
  constructor(url) {
    this.url = url;
    this.eventSource = null;
    this.listeners = new Map();
  }

  connect() {
    if (this.eventSource) return;
    
    try {
      this.eventSource = new EventSource(this.url);
      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.notifyListeners('message', data);
        } catch (e) {
          console.error('Failed to parse SSE data:', e);
        }
      };
      
      this.eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        this.notifyListeners('error', error);
      };
    } catch (e) {
      console.error('Failed to create EventSource:', e);
    }
  }

  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  addEventListener(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  removeEventListener(event, callback) {
    if (this.listeners.has(event)) {
      const callbacks = this.listeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  notifyListeners(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => callback(data));
    }
  }
}

// Global instances
window.tooltip = new Tooltip();
window.modal = new Modal();

// Initialize SSE if on overview page
if (window.location.pathname === '/' || window.location.pathname === '/index.html') {
  window.sseManager = new EventSourceManager('/events');
  window.sseManager.connect();
}

// Utility for updating DOM elements safely
function updateElement(id, content) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = content;
  }
}

function updateElementHTML(id, content) {
  const element = document.getElementById(id);
  if (element) {
    element.innerHTML = content;
  }
}

// Export for use in other scripts
window.DashboardUtils = {
  parseMoney,
  parseES,
  formatNumber,
  formatCurrency,
  updateElement,
  updateElementHTML
};
