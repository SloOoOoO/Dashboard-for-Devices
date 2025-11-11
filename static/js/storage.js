/**
 * Storage Inventory Management
 * Manages devices in storage (not yet operational) with localStorage persistence
 * and provides promotion flow to make devices operational via map placement.
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'dashboard_storage_devices';
  const CAT_LABELS = {
    global: 'Global clients',
    apple: 'Apple devices',
    dzb: 'DZB',
    brightsign: 'BrightSign'
  };

  /**
   * StorageInventory class - manages storage devices and UI
   */
  class StorageInventory {
    constructor() {
      this.devices = [];
      this.floors = [];
      this.promotingDevice = null;
      this.mapContainer = null;
      this.initialized = false;
    }

    /**
     * Initialize the storage inventory
     * @param {Object} options - Configuration options
     * @param {string} options.mapSelector - CSS selector for map container (default: '#map-area')
     * @param {Array} options.floors - Available floors for dropdown
     */
    init(options = {}) {
      if (this.initialized) {
        console.warn('[StorageInventory] Already initialized');
        return;
      }

      this.mapSelector = options.mapSelector || '#map-area';
      this.floors = options.floors || [];
      
      this.loadDevices();
      this.setupEventListeners();
      this.populateFloorDropdown();
      this.render();
      
      this.initialized = true;
      console.log('[StorageInventory] Initialized successfully');
    }

    /**
     * Load devices from localStorage
     */
    loadDevices() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        this.devices = stored ? JSON.parse(stored) : [];
      } catch (e) {
        console.error('[StorageInventory] Failed to load devices:', e);
        this.devices = [];
      }
    }

    /**
     * Save devices to localStorage
     */
    saveDevices() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.devices));
      } catch (e) {
        console.error('[StorageInventory] Failed to save devices:', e);
      }
    }

    /**
     * Add a new device to storage
     * @param {Object} device - Device data (name, category, floor)
     * @returns {Object} - Added device with generated ID
     */
    addDevice(device) {
      if (!device.name || !device.name.trim()) {
        throw new Error('Device name is required');
      }

      const newDevice = {
        id: this.generateId(),
        name: device.name.trim(),
        category: device.category || 'global',
        floor: device.floor || 'main',
        status: 'storage',
        createdAt: new Date().toISOString()
      };

      this.devices.push(newDevice);
      this.saveDevices();
      this.render();
      
      console.log('[StorageInventory] Device added:', newDevice);
      return newDevice;
    }

    /**
     * Remove a device from storage
     * @param {string} deviceId - ID of device to remove
     */
    removeDevice(deviceId) {
      const index = this.devices.findIndex(d => d.id === deviceId);
      if (index === -1) {
        console.warn('[StorageInventory] Device not found:', deviceId);
        return;
      }

      const device = this.devices[index];
      this.devices.splice(index, 1);
      this.saveDevices();
      this.render();
      
      console.log('[StorageInventory] Device removed:', device);
    }

    /**
     * Start promotion flow for a device
     * @param {string} deviceId - ID of device to promote
     */
    promoteDevice(deviceId) {
      const device = this.devices.find(d => d.id === deviceId);
      if (!device) {
        console.error('[StorageInventory] Device not found:', deviceId);
        return;
      }

      this.promotingDevice = device;
      this.enterPlacementMode();
    }

    /**
     * Enter placement mode - show overlay and enable map clicking
     */
    enterPlacementMode() {
      const overlay = document.getElementById('placement-overlay');
      const mapContainer = document.querySelector(this.mapSelector);
      
      if (!overlay) {
        console.error('[StorageInventory] Placement overlay not found');
        return;
      }

      if (!mapContainer) {
        console.error('[StorageInventory] Map container not found:', this.mapSelector);
        return;
      }

      this.mapContainer = mapContainer;
      overlay.classList.remove('hidden');
      
      // Add click handler to map
      this.mapClickHandler = this.handleMapClick.bind(this);
      mapContainer.addEventListener('click', this.mapClickHandler);
      
      console.log('[StorageInventory] Entered placement mode for:', this.promotingDevice.name);
    }

    /**
     * Exit placement mode - hide overlay and remove handlers
     */
    exitPlacementMode() {
      const overlay = document.getElementById('placement-overlay');
      
      if (overlay) {
        overlay.classList.add('hidden');
      }

      if (this.mapContainer && this.mapClickHandler) {
        this.mapContainer.removeEventListener('click', this.mapClickHandler);
      }

      this.promotingDevice = null;
      this.mapContainer = null;
      this.mapClickHandler = null;
      
      console.log('[StorageInventory] Exited placement mode');
    }

    /**
     * Handle click on map during placement mode
     * @param {MouseEvent} event - Click event
     */
    handleMapClick(event) {
      if (!this.promotingDevice) return;

      const rect = this.mapContainer.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;

      // Clamp coordinates to [0, 1]
      const coords = {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y))
      };

      console.log('[StorageInventory] Map clicked at:', coords);
      this.completePromotion(coords);
    }

    /**
     * Complete the promotion process
     * @param {Object} coords - Map coordinates {x, y}
     */
    completePromotion(coords) {
      if (!this.promotingDevice) return;

      const device = { ...this.promotingDevice };
      
      // Remove from storage
      this.removeDevice(device.id);
      
      // Exit placement mode
      this.exitPlacementMode();

      // Dispatch custom event for integration
      this.dispatchPromotionEvent(device, coords);

      // Try calling integration hook if available
      if (typeof window.addOperationalDeviceFromStorage === 'function') {
        try {
          window.addOperationalDeviceFromStorage(device, coords);
          console.log('[StorageInventory] Called addOperationalDeviceFromStorage hook');
        } catch (e) {
          console.error('[StorageInventory] Error calling integration hook:', e);
        }
      }

      console.log('[StorageInventory] Device promoted:', device.name);
    }

    /**
     * Dispatch custom event for device promotion
     * @param {Object} device - Promoted device
     * @param {Object} coords - Map coordinates {x, y}
     */
    dispatchPromotionEvent(device, coords) {
      const event = new CustomEvent('storage:device-promoted', {
        detail: {
          device: device,
          x: coords.x,
          y: coords.y
        },
        bubbles: true,
        cancelable: false
      });

      document.dispatchEvent(event);
      console.log('[StorageInventory] Dispatched storage:device-promoted event');
    }

    /**
     * Setup event listeners for form and interactions
     */
    setupEventListeners() {
      // Form submission
      const form = document.getElementById('storage-form');
      if (form) {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          this.handleFormSubmit();
        });
      }

      // Cancel placement button
      const cancelBtn = document.getElementById('cancel-placement');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          this.exitPlacementMode();
        });
      }

      // Listen for floor changes from main app
      document.addEventListener('floors:updated', (e) => {
        if (e.detail && e.detail.floors) {
          this.floors = e.detail.floors;
          this.populateFloorDropdown();
        }
      });
    }

    /**
     * Handle form submission
     */
    handleFormSubmit() {
      const nameInput = document.getElementById('storage-name');
      const categorySelect = document.getElementById('storage-category');
      const floorSelect = document.getElementById('storage-floor');

      if (!nameInput || !nameInput.value.trim()) {
        alert('Please enter a device name');
        return;
      }

      try {
        this.addDevice({
          name: nameInput.value,
          category: categorySelect ? categorySelect.value : 'global',
          floor: floorSelect ? floorSelect.value : 'main'
        });

        // Reset form
        nameInput.value = '';
        if (categorySelect) categorySelect.value = 'global';
        if (floorSelect && this.floors.length > 0) {
          floorSelect.value = this.floors[0].id || 'main';
        }

        // Show success message (optional)
        this.showMessage('Device added to storage');
      } catch (e) {
        alert('Error adding device: ' + e.message);
      }
    }

    /**
     * Show temporary message (uses toast if available)
     * @param {string} message - Message to display
     */
    showMessage(message) {
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = message;
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 3000);
      } else {
        console.log('[StorageInventory]', message);
      }
    }

    /**
     * Populate floor dropdown
     */
    populateFloorDropdown() {
      const select = document.getElementById('storage-floor');
      if (!select) return;

      const currentValue = select.value;
      select.innerHTML = '';

      if (this.floors.length === 0) {
        select.innerHTML = '<option value="main">Floor 1</option>';
        return;
      }

      this.floors.forEach(floor => {
        const option = document.createElement('option');
        option.value = floor.id;
        option.textContent = floor.name;
        select.appendChild(option);
      });

      // Restore previous value if it exists
      if (currentValue && this.floors.some(f => f.id === currentValue)) {
        select.value = currentValue;
      }
    }

    /**
     * Group devices by category and floor
     * @returns {Object} - Grouped devices
     */
    groupDevices() {
      const groups = {};

      this.devices.forEach(device => {
        const key = `${device.category}|${device.floor}`;
        if (!groups[key]) {
          groups[key] = {
            category: device.category,
            floor: device.floor,
            devices: []
          };
        }
        groups[key].devices.push(device);
      });

      return Object.values(groups).sort((a, b) => {
        // Sort by floor first, then category
        if (a.floor !== b.floor) return a.floor.localeCompare(b.floor);
        return a.category.localeCompare(b.category);
      });
    }

    /**
     * Render the storage list
     */
    render() {
      const container = document.getElementById('storage-list');
      if (!container) return;

      container.innerHTML = '';

      if (this.devices.length === 0) {
        container.innerHTML = '<div class="storage-empty">No devices in storage</div>';
        return;
      }

      const groups = this.groupDevices();

      groups.forEach(group => {
        const groupEl = this.createGroupElement(group);
        container.appendChild(groupEl);
      });
    }

    /**
     * Create a group element
     * @param {Object} group - Device group
     * @returns {HTMLElement} - Group element
     */
    createGroupElement(group) {
      const groupEl = document.createElement('div');
      groupEl.className = 'storage-group';
      
      const categoryLabel = CAT_LABELS[group.category] || group.category;
      const floorName = this.getFloorName(group.floor);
      const count = group.devices.length;

      // Group header
      const header = document.createElement('div');
      header.className = 'storage-group-header';
      header.innerHTML = `
        <div class="storage-group-title">
          ${this.escapeHtml(categoryLabel)} · ${this.escapeHtml(floorName)}
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="storage-group-count">${count}</span>
          <span class="storage-group-toggle">▼</span>
        </div>
      `;

      // Toggle collapse on header click
      header.addEventListener('click', () => {
        groupEl.classList.toggle('collapsed');
      });

      groupEl.appendChild(header);

      // Group items
      const itemsContainer = document.createElement('div');
      itemsContainer.className = 'storage-group-items';

      group.devices.forEach(device => {
        const itemEl = this.createDeviceElement(device);
        itemsContainer.appendChild(itemEl);
      });

      groupEl.appendChild(itemsContainer);

      return groupEl;
    }

    /**
     * Create a device element
     * @param {Object} device - Device data
     * @returns {HTMLElement} - Device element
     */
    createDeviceElement(device) {
      const itemEl = document.createElement('div');
      itemEl.className = 'storage-item';

      const categoryLabel = CAT_LABELS[device.category] || device.category;
      const floorName = this.getFloorName(device.floor);

      itemEl.innerHTML = `
        <div class="storage-item-info">
          <div class="storage-item-name">${this.escapeHtml(device.name)}</div>
          <div class="storage-item-meta">${this.escapeHtml(categoryLabel)} · ${this.escapeHtml(floorName)}</div>
        </div>
        <div class="storage-item-actions">
          <button class="btn-promote" data-device-id="${device.id}" title="Make this device operational">
            Make Operational
          </button>
          <button class="btn-delete" data-device-id="${device.id}" title="Remove from storage">
            ✕
          </button>
        </div>
      `;

      // Promote button
      const promoteBtn = itemEl.querySelector('.btn-promote');
      promoteBtn.addEventListener('click', () => {
        this.promoteDevice(device.id);
      });

      // Delete button
      const deleteBtn = itemEl.querySelector('.btn-delete');
      deleteBtn.addEventListener('click', () => {
        if (confirm(`Remove "${device.name}" from storage?`)) {
          this.removeDevice(device.id);
        }
      });

      return itemEl;
    }

    /**
     * Get floor name by ID
     * @param {string} floorId - Floor ID
     * @returns {string} - Floor name
     */
    getFloorName(floorId) {
      const floor = this.floors.find(f => f.id === floorId);
      return floor ? floor.name : floorId;
    }

    /**
     * Generate unique ID
     * @returns {string} - Unique ID
     */
    generateId() {
      return 'storage-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} str - String to escape
     * @returns {string} - Escaped string
     */
    escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    /**
     * Get all devices in storage (for external access)
     * @returns {Array} - Array of devices
     */
    getDevices() {
      return [...this.devices];
    }

    /**
     * Update floors list (can be called externally)
     * @param {Array} floors - Array of floor objects
     */
    updateFloors(floors) {
      this.floors = floors || [];
      this.populateFloorDropdown();
    }
  }

  // Expose StorageInventory globally
  window.StorageInventory = StorageInventory;

  // Auto-initialize if ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log('[StorageInventory] Module loaded, ready for initialization');
    });
  } else {
    console.log('[StorageInventory] Module loaded, ready for initialization');
  }

})();
