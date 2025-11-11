# Ford Device Dashboard by TechM

- Map-based monitoring with per-floor maps (PDF only; converted to PNG automatically)
- Dark/light theme toggle; Kiosk mode (?kiosk=1)
- One-button map rotation (click = +90°, Shift+Click = −90°) with perfect fit
- Device categories (enable per floor): Global, Apple, DZB, BrightSign
- Authentication for settings; sessions invalidated on restart
- Logs CSV history and simple uptime stats

Data paths (Windows)
- State: `C:\Users\YOU\AppData\Local\pc-monitor\state.json`
- Maps: `C:\Users\YOU\AppData\Local\pc-monitor\maps\`
- Logs: `C:\Users\YOU\AppData\Local\pc-monitor\logs\pings-YYYY-MM-DD.csv`

Run (dev)
```powershell
$env:PASSWORD="tpc"
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