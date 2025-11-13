# Note: unchanged server except version bump to reflect UI update
import csv
import json
import os
import re
import socket
import subprocess
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Any, Tuple, Optional, List

import requests
from flask import Flask, request, jsonify, send_file, session, render_template, abort, make_response
from werkzeug.utils import secure_filename

PDFIUM_IMPORT_ERROR = ""
try:
    import pypdfium2 as pdfium
except Exception as _e:
    pdfium = None
    PDFIUM_IMPORT_ERROR = repr(_e)

APP_NAME = os.getenv("APP_NAME", "Device Dashboard")
APP_VERSION = "2025.11.13-storage-inventory.v1"

CATEGORIES = ["global", "apple", "dzb", "brightsign"]

def sys_is_macos() -> bool:
    try:
        return os.uname().sysname.lower() == "darwin"
    except Exception:
        return False

def user_data_dir() -> Path:
    try:
        if os.name == "nt":
            root = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
        elif sys_is_macos():
            root = Path.home() / "Library" / "Application Support"
        else:
            root = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    except Exception:
        root = Path.home()
    d = root / "pc-monitor"
    (d / "logs").mkdir(parents=True, exist_ok=True)
    (d / "maps").mkdir(parents=True, exist_ok=True)
    return d

DATA_DIR = user_data_dir()
LOG_DIR = DATA_DIR / "logs"
MAPS_DIR = DATA_DIR / "maps"
STATE_FILE = DATA_DIR / "state.json"
SECRET_FILE = DATA_DIR / ".flask_secret"

AUTH_EPOCH = os.urandom(8).hex()
PING_PERIOD_SECONDS = 15 * 60

app = Flask(__name__, static_folder="static", template_folder="templates")
if SECRET_FILE.exists():
    app.secret_key = SECRET_FILE.read_bytes()
else:
    sec = os.urandom(32)
    SECRET_FILE.write_bytes(sec)
    app.secret_key = sec
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")

state_lock = threading.RLock()
STATE: Dict[str, Any] = {}
NEXT_PING_AT_UTC: Optional[datetime] = None

def require_password() -> str:
    pw = os.getenv("PASSWORD", "")
    if not pw:
        raise RuntimeError("PASSWORD environment variable not set. Set PASSWORD and run again.")
    return pw

def authed() -> bool:
    return bool(session.get("auth_ok")) and session.get("auth_epoch") == AUTH_EPOCH

def require_auth():
    if not authed():
        abort(401)

def load_state() -> Dict[str, Any]:
    if STATE_FILE.exists():
        try:
            st = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            st = {}
    else:
        st = {}
    st.setdefault("machines", {})
    st.setdefault("floors", [{
        "id": "main",
        "name": "Floor 1",
        "map_file": "",
        "map_type": "",
        "categories_enabled": False,
    }])
    st.setdefault("default_floor_id", "main")
    for fl in st["floors"]:
        fl.setdefault("categories_enabled", False)
        mf = (fl.get("map_file") or "").strip()
        if mf and not Path(mf).exists():
            fl["map_file"] = ""
            fl["map_type"] = ""
    for m in st["machines"].values():
        m.setdefault("floor_id", st["default_floor_id"])
        m.setdefault("check", "icmp")
        m.setdefault("tcp_port", 0)
        m.setdefault("os", "")
        m.setdefault("category", "global")
        m.setdefault("operational", True)
        if m["category"] not in CATEGORIES:
            m["category"] = "global"
    return st

def save_state(st: Dict[str, Any]) -> None:
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=2), encoding="utf-8")
    tmp.replace(STATE_FILE)

def get_floor(fid: Optional[str]) -> Dict[str, Any]:
    with state_lock:
        floors = STATE.get("floors", [])
        if not floors:
            return {"id":"main","name":"Floor","map_file":"","map_type":"","categories_enabled":False}
        if not fid:
            fid = STATE.get("default_floor_id", floors[0]["id"])
        for fl in floors:
            if fl["id"] == fid:
                return fl
        return floors[0]

def log_path_for(dt: datetime) -> Path:
    return LOG_DIR / f"pings-{dt.strftime('%Y-%m-%d')}.csv"

def append_log(m: Dict[str, Any], ok: bool, rtt_ms: int, err: str) -> None:
    p = log_path_for(datetime.utcnow())
    new = not p.exists()
    with p.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["timestamp","id","name","ip","serial","ok","status","rtt_ms","error"])
        w.writerow([
            datetime.utcnow().isoformat(),
            m.get("id",""), m.get("name",""), m.get("ip",""), m.get("serial",""),
            "1" if ok else "0", m.get("last_status","unknown"), rtt_ms, err
        ])

def parse_rtt_ms(text: str) -> int:
    m = re.search(r"time[=<]\s*([\d.,]+)\s*ms", text, re.IGNORECASE)
    if m:
        try:
            return int(float(m.group(1).replace(",", ".")) + 0.5)
        except Exception:
            pass
    m = re.search(r"Average\s*=\s*(\d+)\s*ms", text, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return 0

def ping_icmp(ip: str, timeout_ms: int = 2000) -> Tuple[bool,int,str]:
    if not ip:
        return False, 0, "empty ip"
    try:
        if os.name == "nt":
            cmd = ["ping","-n","1","-w",str(timeout_ms),ip]
        else:
            if sys_is_macos():
                cmd = ["ping","-c","1","-W",str(timeout_ms),ip]
            else:
                cmd = ["ping","-c","1","-W",str(max(1,int(timeout_ms/1000))),ip]
        out = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=max(1,int(timeout_ms/1000)+2))
        text = (out.stdout or "") + (out.stderr or "")
        if out.returncode != 0:
            return False, 0, f"ping failed ({out.returncode}): {text.strip()[:240]}"
        return True, parse_rtt_ms(text), ""
    except Exception as e:
        return False, 0, str(e)

def ping_tcp(ip: str, port: int, timeout_ms: int = 2000) -> Tuple[bool,int,str]:
    if not ip or not port:
        return False, 0, "tcp requires ip and port"
    start = time.perf_counter()
    try:
        with socket.create_connection((ip, port), timeout_ms/1000.0):
            pass
        return True, int((time.perf_counter()-start)*1000+0.5), ""
    except Exception as e:
        return False, 0, str(e)

def do_check(m: Dict[str, Any]) -> Tuple[bool,int,str]:
    if (m.get("check") or "icmp").lower() == "tcp":
        return ping_tcp(m.get("ip",""), int(m.get("tcp_port") or 0), 2000)
    return ping_icmp(m.get("ip",""), 2000)

def notify_state_change(mid: str, old: str, new: str):
    if old == new:
        return
    with state_lock:
        m = STATE["machines"].get(mid)
    if not m:
        return
    slack = os.getenv("SLACK_WEBHOOK_URL","")
    if slack:
        try:
            text = f"[{APP_NAME}] {m.get('name','(unnamed)')} is {new.upper()}\nIP: {m.get('ip','')}\nOS: {m.get('os','')}\nRTT: {m.get('last_rtt_ms',0)} ms"
            requests.post(slack, json={"text": text}, timeout=6)
        except Exception as e:
            print("Slack alert failed:", e)

def update_after_ping(mid: str, ok: bool, rtt_ms: int, err: str) -> None:
    with state_lock:
        m = STATE["machines"].get(mid)
        if not m:
            return
        prev = m.get("last_status","down")
        m["total_pings"] = int(m.get("total_pings",0)) + 1
        if ok:
            m["up_pings"] = int(m.get("up_pings",0)) + 1
            m["last_seen"] = datetime.utcnow().isoformat()
            m["last_status"] = "up"
            m["consec_down"] = 0
            m["last_rtt_ms"] = rtt_ms
            m["last_error"] = ""
        else:
            m["consec_down"] = int(m.get("consec_down",0)) + 1
            m["last_status"] = "down"
            m["last_rtt_ms"] = 0
            m["last_error"] = err
        save_state(STATE); append_log(m, ok, rtt_ms, err)
    if prev != m["last_status"]:
        notify_state_change(mid, prev, m["last_status"])

def ping_all_once() -> Dict[str,int]:
    with state_lock:
        ids = list(STATE["machines"].keys())
    up = down = 0
    for mid in ids:
        with state_lock:
            mm = STATE["machines"][mid].copy()
        ok,rtt,err = do_check(mm)
        update_after_ping(mid, ok, rtt, err)
        if ok: up+=1
        else: down+=1
    return {"up":up,"down":down,"total":len(ids)}

def convert_pdf_to_png(input_path: Path, output_png: Path, page: int = 1, dpi: int = 220) -> None:
    if pdfium is None:
        raise RuntimeError(f"PDF not supported: pypdfium2 not available. Import error: {PDFIUM_IMPORT_ERROR or 'install pypdfium2'}")
    doc = pdfium.PdfDocument(str(input_path))
    try:
        if page < 1 or page > len(doc):
            raise RuntimeError(f"PDF page {page} out of range (1..{len(doc)})")
        page_index = page - 1
        page_obj = doc.get_page(page_index)
        try:
            bitmap = page_obj.render(scale=(dpi/72.0))
            pil_img = bitmap.to_pil()
            pil_img.save(str(output_png))
        finally:
            page_obj.close()
    finally:
        doc.close()

@app.get("/")
def ui():
    return render_template("index.html", app_name=APP_NAME, app_version=APP_VERSION)

@app.get("/api/diagnostics")
def diagnostics():
    return jsonify({
        "name": APP_NAME,
        "version": APP_VERSION,
        "data_dir": str(DATA_DIR),
        "pdfium_ok": pdfium is not None,
        "pdfium_error": PDFIUM_IMPORT_ERROR,
        "authenticated": authed(),
    })

@app.post("/api/login")
def api_login():
    body = request.get_json(silent=True) or {}
    try:
        pw = require_password()
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500
    if (body.get("password") or "") != pw:
        return jsonify({"error":"invalid credentials"}), 401
    session["auth_ok"] = True
    session["auth_epoch"] = AUTH_EPOCH
    return "", 204

@app.post("/api/logout")
def api_logout():
    session.clear()
    return "", 204

@app.get("/api/whoami")
def api_whoami():
    return jsonify({"authenticated": authed()})

@app.get("/api/public/status")
def public_status():
    now = datetime.utcnow()
    nxt = NEXT_PING_AT_UTC or next_quarter_utc(now)
    return jsonify({"now": now.isoformat()+"Z",
                    "next_ping_at": nxt.isoformat()+"Z",
                    "seconds_left": max(0, int((nxt-now).total_seconds()))})

@app.get("/api/public/floors")
def public_floors():
    with state_lock:
        fl = [{
            "id": f["id"],
            "name": f["name"],
            "default": (f["id"]==STATE.get("default_floor_id","main")),
            "categories_enabled": bool(f.get("categories_enabled", False)),
            "has_map": bool(f.get("map_file")),
        } for f in STATE.get("floors",[])]
    resp = make_response(jsonify(fl)); resp.headers["Cache-Control"]="no-store"; return resp

@app.route("/api/floors", methods=["GET","POST"])
def floors_list_create():
    require_auth()
    if request.method == "GET":
        with state_lock:
            return jsonify(STATE.get("floors", []))
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "Floor").strip()
    fid = (body.get("id") or re.sub(r"[^a-z0-9\-]+","", name.lower().replace(" ","-")) or f"floor-{int(time.time())}")
    with state_lock:
        STATE.setdefault("floors", []).append({"id": fid, "name": name, "map_file": "", "map_type": "", "categories_enabled": False})
        save_state(STATE)
    return jsonify({"id": fid, "name": name, "map_file": "", "map_type": "", "categories_enabled": False})

@app.route("/api/floors/<fid>", methods=["PUT","DELETE"])
def floors_update_delete(fid):
    require_auth()
    with state_lock:
        floors = STATE.get("floors",[])
        idx = next((i for i,f in enumerate(floors) if f["id"]==fid), -1)
        if idx<0: abort(404)
        if request.method=="PUT":
            body = request.get_json(silent=True) or {}
            if "name" in body and str(body["name"]).strip():
                floors[idx]["name"] = str(body["name"]).strip()
            if "categories_enabled" in body:
                floors[idx]["categories_enabled"] = bool(body["categories_enabled"])
            if body.get("default") is True:
                STATE["default_floor_id"] = fid
            save_state(STATE); return jsonify(floors[idx])
        if any(m.get("floor_id")==fid for m in STATE.get("machines",{}).values()):
            return jsonify({"error":"floor has machines"}), 400
        floors.pop(idx)
        if STATE.get("default_floor_id")==fid and floors:
            STATE["default_floor_id"]=floors[0]["id"]
        save_state(STATE); return "",204

@app.post("/api/floors/upload")
def floors_upload():
    require_auth()
    floor_id = request.form.get("floor_id") or STATE.get("default_floor_id","main")
    with state_lock:
        fl = get_floor(floor_id)
    if "file" not in request.files:
        return jsonify({"error":"missing file"}),400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error":"empty filename"}),400
    name = secure_filename(f.filename)
    ext = os.path.splitext(name)[1].lower()
    if ext != ".pdf":
        return jsonify({"error":"Only PDF is supported for maps"}), 400
    out_file = MAPS_DIR / f"{fl['id']}.png"
    tmp = MAPS_DIR / f"{fl['id']}.upload.pdf"
    try:
        f.save(tmp)
        try:
            convert_pdf_to_png(tmp, out_file, page=1, dpi=220)
        finally:
            tmp.unlink(missing_ok=True)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    with state_lock:
        for old in [MAPS_DIR / f"{fl['id']}.svg",
                    MAPS_DIR / f"{fl['id']}.jpg", MAPS_DIR / f"{fl['id']}.jpeg", MAPS_DIR / f"{fl['id']}.webp"]:
            if old.exists():
                try: old.unlink()
                except: pass
        for floor in STATE["floors"]:
            if floor["id"] == fl["id"]:
                floor["map_file"] = str(out_file.resolve())
                floor["map_type"] = "raster"
        save_state(STATE)
    return jsonify({"ok":True,"map_type":"raster"})

@app.get("/map-image")
def map_image():
    floor_id = request.args.get("floor_id")
    fl = get_floor(floor_id)
    mf = (fl.get("map_file") or "").strip()
    if not mf:
        abort(404)
    p = Path(mf)
    if not p.exists(): abort(404)
    resp = make_response(send_file(p))
    resp.headers["Cache-Control"] = "no-store"
    return resp

@app.get("/api/public/machines")
def public_machines():
    floor_id = request.args.get("floor_id")
    with state_lock:
        ms = list(STATE["machines"].values())
        # Only return operational devices for the map
        ms = [m for m in ms if m.get("operational", True)]
        if floor_id:
            ms = [m for m in ms if m.get("floor_id")==floor_id]
    resp = make_response(jsonify(ms)); resp.headers["Cache-Control"]="no-store"; return resp

@app.get("/api/public/storage")
def public_storage():
    with state_lock:
        ms = [m for m in STATE["machines"].values() if not m.get("operational", True)]
    resp = make_response(jsonify(ms)); resp.headers["Cache-Control"]="no-store"; return resp

@app.route("/api/machines", methods=["GET","POST"])
def machines_list_create():
    if request.method=="GET":
        require_auth()
        with state_lock: return jsonify(list(STATE["machines"].values()))
    require_auth()
    m = request.get_json(silent=True) or {}
    now = datetime.utcnow().isoformat()
    with state_lock:
        mid = m.get("id") or generate_id(m.get("name",""), m.get("ip",""))
        floor_id = m.get("floor_id") or STATE.get("default_floor_id","main")
        cat = m.get("category") or "global"
        if cat not in CATEGORIES:
            cat = "global"
        cur = {
            "id": mid, "name": m.get("name",""), "ip": m.get("ip",""), "serial": m.get("serial",""),
            "os": m.get("os",""), "grid": m.get("grid",""), "notes": m.get("notes",""),
            "floor_id": floor_id,
            "category": cat,
            "check": (m.get("check") or "icmp").lower(), "tcp_port": int(m.get("tcp_port") or 0),
            "created_at": now, "last_seen":"", "last_status":"down", "last_rtt_ms":0,
            "total_pings":0, "up_pings":0, "consec_down":0, "last_error":"",
            "operational": m.get("operational", True)
        }
        if "x" in m and "y" in m and m["x"] is not None and m["y"] is not None:
            try:
                cur["x"] = float(m["x"]); cur["y"] = float(m["y"])
            except Exception:
                pass
        STATE["machines"][mid]=cur; save_state(STATE)
    threading.Thread(target=lambda: update_after_ping(mid, *do_check(cur)), daemon=True).start()
    return jsonify(cur)

@app.route("/api/machines/<mid>", methods=["GET","PUT","DELETE"])
def machine_by_id(mid):
    require_auth()
    with state_lock:
        m = STATE["machines"].get(mid)
    if not m: abort(404)
    if request.method=="GET": return jsonify(m)
    if request.method=="PUT":
        body = request.get_json(silent=True) or {}
        with state_lock:
            cur = STATE["machines"][mid]
            if body.get("clear_pos"):
                cur.pop("x", None); cur.pop("y", None)
            if "x" in body and "y" in body and body["x"] is not None and body["y"] is not None:
                try: cur["x"] = float(body["x"]); cur["y"] = float(body["y"])
                except Exception: pass
            cur["name"] = body.get("name",cur["name"])
            cur["ip"] = body.get("ip",cur["ip"])
            cur["serial"] = body.get("serial",cur["serial"])
            cur["os"] = body.get("os",cur["os"])
            cur["grid"] = body.get("grid",cur["grid"])
            cur["notes"] = body.get("notes",cur["notes"])
            cur["check"] = (body.get("check",cur["check"]) or "icmp").lower()
            cur["tcp_port"] = int(body.get("tcp_port",cur["tcp_port"]))
            if "floor_id" in body and body["floor_id"]:
                cur["floor_id"] = body["floor_id"]
            if "category" in body and body["category"]:
                cur["category"] = body["category"] if body["category"] in CATEGORIES else "global"
            if "operational" in body:
                cur["operational"] = bool(body["operational"])
            save_state(STATE)
        return jsonify(cur)
    with state_lock:
        STATE["machines"].pop(mid,None); save_state(STATE)
    return "",204

@app.get("/api/ping/<mid>")
def ping_now(mid):
    require_auth()
    with state_lock:
        m = STATE["machines"].get(mid)
    if not m: abort(404)
    ok,rtt,err = do_check(m)
    update_after_ping(mid, ok, rtt, err)
    with state_lock:
        status = STATE["machines"][mid]["last_status"]
    return jsonify({"id":mid,"ok":ok,"rtt_ms":rtt,"status":status,"error":err})

@app.post("/api/ping-all")
def ping_all():
    require_auth()
    stats = ping_all_once()
    return jsonify({"ok":True,"stats":stats})

@app.get("/api/history/<mid>")
def history(mid):
    days = int(request.args.get("days","7"))
    since = datetime.utcnow() - timedelta(days=days)
    pts=[]
    cur = datetime.utcnow()
    for i in range(days+1):
        p = log_path_for(cur - timedelta(days=i))
        if not p.exists(): continue
        with p.open("r", encoding="utf-8") as f:
            rdr = csv.DictReader(f)
            for row in rdr:
                if row.get("id")!=mid: continue
                try: ts = datetime.fromisoformat(row["timestamp"])
                except: continue
                if ts < since: continue
                pts.append({"t":ts.isoformat(),"rtt_ms":int(row.get("rtt_ms") or 0),
                            "ok":row.get("ok")=="1","status":row.get("status","unknown")})
    pts.sort(key=lambda x: x["t"])
    return jsonify(pts)

@app.get("/api/export/")
def export_data():
    require_auth()
    with state_lock:
        export_data = {
            "version": APP_VERSION,
            "export_timestamp": datetime.utcnow().isoformat() + "Z",
            "floors": STATE.get("floors", []),
            "default_floor_id": STATE.get("default_floor_id", "main"),
            "machines": list(STATE.get("machines", {}).values())
        }
    response = make_response(jsonify(export_data))
    response.headers["Content-Disposition"] = f"attachment; filename=dashboard-export-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.json"
    response.headers["Content-Type"] = "application/json"
    return response

@app.post("/api/import/")
def import_data():
    require_auth()
    try:
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "No data provided"}), 400
        
        # Validate the import data
        if "floors" not in data or "machines" not in data:
            return jsonify({"error": "Invalid export format"}), 400
        
        with state_lock:
            # Import floors
            if data.get("floors"):
                STATE["floors"] = data["floors"]
            
            # Import default floor ID
            if data.get("default_floor_id"):
                STATE["default_floor_id"] = data["default_floor_id"]
            
            # Import machines
            if data.get("machines"):
                machines_dict = {}
                for m in data["machines"]:
                    if "id" in m:
                        machines_dict[m["id"]] = m
                STATE["machines"] = machines_dict
            
            save_state(STATE)
        
        return jsonify({"success": True, "message": "Data imported successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def generate_id(name: str, ip: str) -> str:
    base = re.sub(r"[^a-z0-9\-]+","", (name or "pc").lower().replace(" ","-"))
    ipn = (ip or "").replace(".","_")
    return f"{base}-{ipn}-{int(time.time()*1000)}"

def start_background():
    if os.environ.get("DISABLE_SCHEDULER") == "1":
        return
    def _first_ping():
        try:
            ping_all_once()
        except Exception as e:
            print("Initial ping failed:", e)
    threading.Thread(target=_first_ping, daemon=True).start()
    threading.Thread(target=scheduler_loop, daemon=True).start()

def next_quarter_utc(now: Optional[datetime]=None) -> datetime:
    if not now: now = datetime.utcnow()
    q = ((now.minute // 15) + 1) * 15
    if q >= 60:
        return now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return now.replace(minute=0, second=0, microsecond=0) + timedelta(minutes=q)

def scheduler_loop():
    global NEXT_PING_AT_UTC
    while True:
        now = datetime.utcnow()
        NEXT_PING_AT_UTC = next_quarter_utc(now)
        sleep_sec = max(1, int((NEXT_PING_AT_UTC - now).total_seconds()))
        time.sleep(sleep_sec)
        try:
            ping_all_once()
        except Exception as e:
            print("Scheduled ping failed:", e)

if __name__ == "__main__":
    try: _ = require_password()
    except RuntimeError as e: print(str(e)); raise SystemExit(1)
    with state_lock:
        STATE = load_state(); save_state(STATE)
    bind = os.getenv("BIND", ":8080")
    host,port=("127.0.0.1",8080)
    if ":" in bind:
        h,p=bind.split(":",1); host=h if h else "127.0.0.1"; port=int(p) if p else 8080
    print(f"{APP_NAME} {APP_VERSION}")
    print(f"Data directory: {DATA_DIR}")
    print(f"Running on http://{host}:{port}")
    start_background()
    app.run(host=host, port=port, debug=False)