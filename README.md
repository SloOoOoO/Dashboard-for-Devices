# Device Dashboard

Map-based device monitoring and management system.

## Features

- Map-based monitoring with per-floor maps (PDF only; converted to PNG automatically)
- Dark/light theme toggle; Kiosk mode (?kiosk=1)
- One-button map rotation (click = +90°, Shift+Click = −90°) with perfect fit
- Device categories (enable per floor): Global, Apple, DZB, BrightSign
- Authentication for settings; sessions invalidated on restart
- Logs CSV history and simple uptime stats
- **Storage Inventory Panel**: Manage non-operational devices in storage before deploying them
- **Device Promotion Flow**: Promote storage devices to operational status via map placement

Data paths (Windows)
- State: `C:\Users\YOU\AppData\Local\pc-monitor\state.json`
- Maps: `C:\Users\YOU\AppData\Local\pc-monitor\maps\`
- Logs: `C:\Users\YOU\AppData\Local\pc-monitor\logs\pings-YYYY-MM-DD.csv`

## Configuration

Set the application name via environment variable:
```powershell
$env:APP_NAME="Your Dashboard Name"
```

If not set, defaults to "Device Dashboard".

Run (dev)
```powershell
$env:PASSWORD="tpc"
$env:APP_NAME="Device Dashboard"  # Optional: customize the application name
$env:BIND="127.0.0.1:8080"  # or 0.0.0.0:8080 for LAN access
pip install -r requirements.txt
python app.py
```

Package (Windows)
```powershell
pip install pyinstaller
pyinstaller --onefile --name pc-monitor `
  --add-data "templates;templates" `
  --add-data "static;static" `
  --collect-all pypdfium2 `
  app.py
# Run:
$env:PASSWORD="tpc"; $env=BIND="0.0.0.0:8080"; .\dist\pc-monitor.exe
```

Kiosk
- Use `http://SERVER-IP:8080?kiosk=1`
- For auto-open on login, put a browser shortcut in `shell:startup`

## Storage Inventory Panel

The right-side Storage Inventory panel allows you to manage non-operational devices before deploying them to the map.

### Fixed Inventory Toggle
- A fixed toggle button appears in the top-left corner (always visible)
- Click to expand/collapse the Storage Inventory panel
- Keyboard accessible (Enter/Space keys)
- Panel state is synced between the fixed toggle and the in-panel toggle

### Adding Devices to Storage
1. Use the "Add to Storage" form in the storage panel
2. Enter device name (required), select category and floor
3. Click "Add to Storage"
4. The device is stored but not shown on the map

### Promoting Storage Devices to Operational
1. Find the device in the Storage Inventory panel
2. Click "Make operational" on the device
3. A map placement modal will open
4. Click on the map to set the device location
5. The device becomes operational and appears on the map

### Managing Devices in Client Settings
- Use "Add to inventory (non-operational)" checkbox when adding/editing machines
- Toggle devices between operational and storage states using table row buttons
- "To Storage" button: Demotes operational device to storage (clears position)
- "To Operational" button: Opens map placement to promote storage device

### Keyboard Shortcuts
- **Enter**: Submit forms (Add to Storage, Save machine)
- **Escape**: Cancel placement mode or clear machine form
- **Enter/Space**: Toggle Storage Inventory panel (when toggle button is focused)

### Validation
- Name is required when adding to storage
- Category and floor must be selected
- Devices must have a map position to become operational

## Backup & Restore

### Floors Backup
- **Export floors**: Backs up floor configuration (names, defaults, categories)
- **Import floors**: Restores floor configuration (preserves existing maps)

### Devices Backup
- **Export Devices**: Downloads JSON containing all machines (operational and storage) across all floors
- **Import Devices**: Restores/upserts devices from backup
  - Upserts machines by ID (adds new, replaces existing)
  - Auto-creates floors if they don't exist
  - Preserves x/y coordinates and operational flags