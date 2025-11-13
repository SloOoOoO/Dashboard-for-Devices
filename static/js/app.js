document.addEventListener("DOMContentLoaded", () => {
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const pct = (a,b)=> !b ? "—" : (100*a/b).toFixed(1)+"%";
  const fmt = t=> t? new Date(t).toLocaleString() : "—";

  const CAT_LABEL = {global:"Global clients", apple:"Apple devices", dzb:"DZB", brightsign:"BrightSign"};

  // State
  let authed=false, floors=[], currentFloor=null, machines=[], timer=null, chart=null;
  let naturalW=0,naturalH=0,fitScale=1,zoom=1, scaledW=0, scaledH=0;
  let activeCategory="all";
  let tableCategory="all";
  let tableFloorId="all";

  // Elements (Map)
  const mapImg=$("#map-img"), markers=$("#markers"), noMap=$("#no-map"), canvasWrap=$("#canvas-wrap");
  const mapArea=$("#map-area"), mapRot=$("#map-rot");
  const floorSel=$("#floor-select"), search=$("#search"), zoomLabel=$("#zoom-label"), toast=$("#toast");
  const tooltip=$("#tooltip"), countdownEl=$("#countdown"), lastUpdated=$("#last-updated");
  const pillbar=$("#category-bar"), kioskStats=$("#kiosk-stats");
  const rotateBtn=$("#rotate");

  // Elements (Settings)
  const settingsLock=$("#settings-lock");
  const floorSettingsSel=$("#floor-settings-select");
  const floorCategoriesChk=$("#floor-categories-enabled");

  // Placement modal
  const placeModal=$("#place-modal"), placeImg=$("#place-img"), placeMarkers=$("#place-markers"), placeNoMap=$("#place-no-map");
  const placeFloor=$("#place-floor"), placeMachine=$("#place-machine");
  const placeWrap=$("#place-wrap"), placeArea=$("#place-area"), placeRot=$("#place-rot");
  let placement={mid:null,x:null,y:null,floor_id:null}, placeNaturalW=0, placeNaturalH=0, placeFit=1, placeZoom=1, placeScaledW=0, placeScaledH=0;

  const showToast = msg => { if(!toast) return; toast.textContent=msg; toast.classList.remove("hidden"); setTimeout(()=>toast.classList.add("hidden"), 3000); };

  // Theme
  function setTheme(t){ document.documentElement.setAttribute("data-theme", t); localStorage.setItem("theme", t); $("#theme-toggle").textContent = t==="dark" ? "☀️" : "🌙"; }
  $("#theme-toggle")?.addEventListener("click", ()=> setTheme(document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark"));
  setTheme(localStorage.getItem("theme")||"light");

  // Rotation persistence
  const rotKey = fid => `rot:${fid||""}`;
  const getRot = fid => { const v=+localStorage.getItem(rotKey(fid)); return [0,90,180,270].includes(v)?v:0; };
  const setRot = (fid,deg)=> localStorage.setItem(rotKey(fid), String(((deg%360)+360)%360));

  // Kiosk quick open
  $("#open-kiosk")?.addEventListener("click", ()=>{
    const url = new URL(location.href); url.searchParams.set("kiosk","1"); window.open(url.toString(), "_blank");
  });
  if (new URLSearchParams(location.search).get("kiosk")==="1"){
    document.body.classList.add("kiosk"); kioskStats?.classList.remove("hidden");
    document.querySelector('[data-tab="settings"]')?.classList.add("hidden");
  }

  // Tabs
  document.addEventListener("click", ev=>{
    const seg = ev.target.closest(".seg"); if (!seg || seg.classList.contains("hidden")) return;
    $$(".seg").forEach(b=>b.classList.remove("active")); seg.classList.add("active");
    const tab = seg.dataset.tab; $$(".tab").forEach(t=>t.classList.remove("active")); $(`#tab-${tab}`)?.classList.add("active");
    if (tab==="map") initMapTab();
    if (tab==="settings") checkAuth();
  });

  // Auth lock
  function setSettingsEnabled(on){
    authed=!!on;
    settingsLock?.classList.toggle("hidden", on);
    $$("#settings-auth input, #settings-auth select, #settings-auth textarea, #settings-auth button").forEach(el=>{
      if (el.id==="logout") { el.disabled=!on; return; }
      el.disabled=!on;
    });
    $("#ping-all") && ($("#ping-all").disabled=!on);
  }
  setSettingsEnabled(false);

  async function checkAuth(){
    const j = await fetch("/api/whoami").then(r=>r.json()).catch(()=>({authenticated:false}));
    setSettingsEnabled(!!j.authenticated);
    if (j.authenticated){
      await loadFloors();
      populateFloorSelectors();
      populateTableFloorFilter();
      await loadMachinesTable();
      await showConverters();
      syncFloorCategoriesUI();
    }
  }

  $("#login")?.addEventListener("click", async ()=>{
    const pw=$("#pw")?.value||""; const r=await fetch("/api/login",{method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({password:pw})});
    if (r.ok){ $("#login-msg").textContent=""; await checkAuth(); showToast("Signed in"); } else { $("#login-msg").textContent="Invalid password."; }
  });
  $("#logout")?.addEventListener("click", async ()=>{ await fetch("/api/logout",{method:"POST"}); await checkAuth(); showToast("Signed out"); });

  async function showConverters(){
    try{
      const d=await fetch("/api/diagnostics").then(r=>r.json());
      const pdf = d.pdfium_ok ? "PDF: OK" : `PDF: missing`;
      $("#conv-status") && ($("#conv-status").textContent = `Converters: ${pdf}`);
    }catch{}
  }

  // Rotation + sizing helpers
  function orientedWH(w,h,deg){ return (deg%180===0)?{ow:w, oh:h}:{ow:h, oh:w}; }
  function applyRotationSizing(deg) {
    const wrap = canvasWrap.getBoundingClientRect();
    const {ow,oh} = orientedWH(naturalW, naturalH, deg);
    fitScale = Math.min((wrap.width-24)/ow, (wrap.height-24)/oh) || 1;
    const scale = fitScale*zoom;
    scaledW = Math.max(1, Math.round(naturalW*scale));
    scaledH = Math.max(1, Math.round(naturalH*scale));
    const areaW = (deg%180===0)? scaledW : scaledH;
    const areaH = (deg%180===0)? scaledH : scaledW;
    mapArea.style.width = areaW+"px";
    mapArea.style.height = areaH+"px";
    mapRot.style.width = scaledW+"px";
    mapRot.style.height = scaledH+"px";
    mapImg.style.width = scaledW+"px";
    mapImg.style.height = scaledH+"px";
    mapRot.style.transformOrigin = "top left";
    if (deg===0) mapRot.style.transform = `translate(0px,0px) rotate(0deg)`;
    else if (deg===90) mapRot.style.transform = `translate(${scaledH}px,0px) rotate(90deg)`;
    else if (deg===180) mapRot.style.transform = `translate(${scaledW}px,${scaledH}px) rotate(180deg)`;
    else if (deg===270) mapRot.style.transform = `translate(0px,${scaledW}px) rotate(270deg)`;
    zoomLabel && (zoomLabel.textContent = `${Math.round(100*zoom)}% · ${deg}°`);
  }

  // Floors
  async function loadFloors(){
    const r=await fetch("/api/public/floors",{cache:"no-store"}); floors=await r.json();
    if (!floors.length) return;
    const saved=localStorage.getItem("floor_id");
    const pick = floors.find(f=>f.id===saved) || floors.find(f=>f.has_map) || floors.find(f=>f.default) || floors[0];
    currentFloor = pick;
    if (floorSel){ floorSel.innerHTML=floors.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join(""); floorSel.value=currentFloor.id; }
    renderCategoryBar();
  }
  floorSel?.addEventListener("change", ()=>{
    currentFloor=floors.find(f=>f.id===floorSel.value)||floors[0];
    localStorage.setItem("floor_id", currentFloor.id);
    activeCategory="all"; renderCategoryBar(); refreshPublic();
  });

  function renderCategoryBar(){
    if (!pillbar) return;
    const f = floors.find(x=>x.id===currentFloor?.id);
    const enabled = !!f?.categories_enabled;
    pillbar.classList.toggle("hidden", !enabled);
  }

  // Category pills
  $("#category-bar")?.addEventListener("click", (ev)=>{
    const btn = ev.target.closest(".pill"); if (!btn) return;
    $$("#category-bar .pill").forEach(p=>p.classList.remove("active"));
    btn.classList.add("active"); activeCategory = btn.dataset.cat || "all"; drawMarkers();
  });

  // Rotation control
  rotateBtn?.addEventListener("click", ev=>{
    const fid=currentFloor?.id||"";
    const cur=getRot(fid);
    const next = ev.shiftKey ? (cur+270)%360 : (cur+90)%360;
    setRot(fid, next);
    computeFit(); applyZoom();
  });

  // Map image + markers
  mapImg?.addEventListener("load", ()=>{
    noMap?.classList.add("hidden");
    naturalW = mapImg.naturalWidth || 1600;
    naturalH = mapImg.naturalHeight || 900;
    computeFit(); applyZoom(); drawMarkers();
  });
  mapImg?.addEventListener("error", ()=>{
    noMap?.classList.remove("hidden");
    markers.innerHTML="";
  });

  async function refreshPublic(){
    if (!floors.length){
      await loadFloors();
      if (!floors.length) return;
    }
    const fid = (floorSel && floorSel.value) || (currentFloor && currentFloor.id) || floors[0].id;
    currentFloor = floors.find(f=>f.id===fid) || floors[0];
    const q = `?floor_id=${encodeURIComponent(fid)}`;
    const [ms, status] = await Promise.all([
      fetch("/api/public/machines"+q,{cache:"no-store"}).then(r=>r.json()),
      fetch("/api/public/status",{cache:"no-store"}).then(r=>r.json()).catch(()=>null),
    ]);
    machines=ms;
    mapImg.src="/map-image"+q+"&ts="+Date.now();
    lastUpdated && (lastUpdated.textContent=new Date().toLocaleString());
    updateCounts(); forceDrawMarkers(); if (status) startCountdown(status);
  }

  function updateCounts(){
    let u=0,d=0; machines.forEach(m=> (m.last_status==="up")?u++:d++);
    $("#cnt-ok") && ($("#cnt-ok").textContent=u); $("#cnt-down") && ($("#cnt-down").textContent=d);
    $("#k-ok") && ($("#k-ok").textContent=u); $("#k-down") && ($("#k-down").textContent=d);
  }

  // Countdown
  let countdownTimer=null;
  function startCountdown(st){
    if (countdownTimer) clearInterval(countdownTimer);
    let left=st.seconds_left||0; renderCountdown(left);
    countdownTimer=setInterval(()=>{ left=Math.max(0,left-1); renderCountdown(left); if(!left){clearInterval(countdownTimer); refreshPublic();}},1000);
  }
  function renderCountdown(sec){
    countdownEl && (countdownEl.textContent = `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`);
  }

  // Markers and tooltip
  function hasCoords(m){ return typeof m.x==="number" && typeof m.y==="number" && m.x>=0 && m.x<=1 && m.y>=0 && m.y<=1; }
  function filterMatch(m){
    const q=(search?.value||"").trim().toLowerCase();
    if (activeCategory!=="all" && (m.category||"global")!==activeCategory) return false;
    if (!q) return true;
    return (m.name||"").toLowerCase().includes(q) || (m.ip||"").toLowerCase().includes(q) || (m.serial||"").toLowerCase().includes(q) || (m.os||"").toLowerCase().includes(q);
  }
  function drawMarkers(){
    markers.innerHTML="";
    if (!scaledW || !scaledH) return;
    machines.filter(filterMatch).forEach(m=>{
      if (!hasCoords(m)) return;
      const dot=document.createElement("div");
      dot.className="marker "+((m.last_status==="up")?"ok":"down");
      dot.style.left=(m.x*scaledW-6)+"px"; dot.style.top=(m.y*scaledH-6)+"px";
      dot.addEventListener("mouseenter", ev=>{ showTip(ev,m); dot.classList.add("hover");});
      dot.addEventListener("mousemove", ev=> moveTip(ev));
      dot.addEventListener("mouseleave", ()=>{ hideTip(); dot.classList.remove("hover");});
      markers.appendChild(dot);
    });
  }
  function forceDrawMarkers(){ requestAnimationFrame(()=>requestAnimationFrame(drawMarkers)); }
  search?.addEventListener("input", drawMarkers);

  function showTip(ev,m){
    tooltip.classList.remove("hidden");
    const cls=(m.last_status==="up")?"ok":"down";
    const cat = CAT_LABEL[m.category||"global"] || "—";
    tooltip.innerHTML = `
      <div class="tip-title"><span class="dot ${cls}"></span><strong>${esc(m.name||"(unnamed)")}</strong></div>
      <div class="tip-row"><span class="k">Category</span><span class="v">${esc(cat)}</span></div>
      <div class="tip-row"><span class="k">OS</span><span class="v">${esc(m.os||"")}</span></div>
      <div class="tip-row"><span class="k">IP</span><span class="v">${esc(m.ip||"")}</span></div>
      <div class="tip-row"><span class="k">Serial</span><span class="v">${esc(m.serial||"")}</span></div>
      <div class="tip-row"><span class="k">RTT</span><span class="v">${m.last_rtt_ms||0} ms</span></div>
      <div class="tip-row"><span class="k">Uptime</span><span class="v">${pct(m.up_pings,m.total_pings)}</span></div>
      <div class="tip-row"><span class="k">Last seen</span><span class="v">${fmt(m.last_seen)}</span></div>`;
    moveTip(ev);
  }
  function moveTip(ev){
    const pad=12, tw=tooltip.offsetWidth||240, th=tooltip.offsetHeight||140;
    let x=ev.clientX+pad, y=ev.clientY+pad;
    if (x+tw>window.innerWidth-6) x=window.innerWidth-tw-6;
    if (y+th>window.innerHeight-6) y=window.innerHeight-th-6;
    tooltip.style.left=x+"px"; tooltip.style.top=y+"px";
  }
  function hideTip(){ tooltip.classList.add("hidden"); }

  // Zoom
  function computeFit(){
    const deg=getRot(currentFloor?.id||"");
    const wrap = canvasWrap.getBoundingClientRect();
    const {ow,oh} = orientedWH(naturalW,naturalH,deg);
    fitScale = Math.min((wrap.width-24)/ow, (wrap.height-24)/oh) || 1;
  }
  function applyZoom(){
    const deg=getRot(currentFloor?.id||"");
    applyRotationSizing(deg);
    drawMarkers();
  }
  $("#zoom-in")?.addEventListener("click", ()=>{ zoom=Math.min(8,zoom*1.2); applyZoom();});
  $("#zoom-out")?.addEventListener("click", ()=>{ zoom=Math.max(0.1,zoom/1.2); applyZoom();});
  $("#zoom-fit")?.addEventListener("click", ()=>{ computeFit(); zoom=1; applyZoom();});
  $("#zoom-full")?.addEventListener("click", ()=>{ const el=canvasWrap; if(!document.fullscreenElement) el.requestFullscreen?.(); else document.exitFullscreen?.();});
  document.addEventListener("fullscreenchange", ()=> setTimeout(()=>{ computeFit(); applyZoom();}, 50));

  // Ping
  $("#ping-all")?.addEventListener("click", async ()=>{
    const r=await fetch("/api/ping-all",{method:"POST"});
    if (r.status===401){ showToast("Sign in to use Ping All"); return; }
    const j=await r.json().catch(()=>null);
    if (j?.stats) showToast(`Pinged ${j.stats.total}: ${j.stats.up} up, ${j.stats.down} down`);
    await refreshPublic();
  });

  // Settings — Floors
  function populateFloorSelectors(){
    if(!floorSettingsSel) return;
    floorSettingsSel.innerHTML=floors.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join("");
    floorSettingsSel.value=(floors.find(f=>f.default)||floors[0]).id;
    syncFloorCategoriesUI();
  }

  function populateTableFloorFilter(){
    const sel = $("#table-floor-filter"); if (!sel) return;
    const saved = localStorage.getItem("table_floor_id") || "all";
    const opts = [`<option value="all">All Floors</option>`]
      .concat(floors.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`));
    sel.innerHTML = opts.join("");
    sel.value = floors.some(f=>f.id===saved) || saved==="all" ? saved : "all";
    tableFloorId = sel.value;
    sel.addEventListener("change", ()=>{
      tableFloorId = sel.value;
      localStorage.setItem("table_floor_id", tableFloorId);
      populateMachinesTableRows();
    });
  }

  function syncFloorCategoriesUI(){
    const f = floors.find(x=>x.id===(floorSettingsSel?.value||""));
    const enabled = !!f?.categories_enabled;
    if (floorCategoriesChk) floorCategoriesChk.checked = enabled;
    const catSel = $("#m-category");
    if (catSel){ catSel.disabled = !enabled; catSel.title = enabled ? "" : "Enable categories on this floor to assign categories"; }
  }
  floorSettingsSel?.addEventListener("change", syncFloorCategoriesUI);

  $("#add-floor")?.addEventListener("click", async ()=>{
    const name=$("#new-floor-name")?.value.trim()||"Floor";
    const r=await fetch("/api/floors",{method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name})});
    if(!r.ok){ showToast("Add floor failed"); return; }
    $("#new-floor-name").value=""; await loadFloors(); populateFloorSelectors(); populateTableFloorFilter(); refreshPublic(); showToast("Floor added");
  });
  $("#rename-floor")?.addEventListener("click", async ()=>{
    const fid=floorSettingsSel?.value, name=$("#rename-floor-name")?.value.trim();
    if(!name){ showToast("Enter a name"); return; }
    const r=await fetch("/api/floors/"+encodeURIComponent(fid),{method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name})});
    if(!r.ok){ showToast("Rename failed"); return; }
    $("#rename-floor-name").value=""; await loadFloors(); populateFloorSelectors(); populateTableFloorFilter(); refreshPublic(); showToast("Renamed");
  });
  $("#make-default")?.addEventListener("click", async ()=>{
    const fid=floorSettingsSel?.value;
    await fetch("/api/floors/"+encodeURIComponent(fid),{method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({default:true})});
    await loadFloors(); populateFloorSelectors(); populateTableFloorFilter(); refreshPublic(); showToast("Default floor set");
  });
  $("#delete-floor")?.addEventListener("click", async ()=>{
    const fid=floorSettingsSel?.value;
    if(!fid){ showToast("Select a floor"); return; }
    const r=await fetch("/api/floors/"+encodeURIComponent(fid),{method:"DELETE"});
    if (!r.ok){
      const j=await r.json().catch(()=>({})); showToast(j.error||"Floor has machines — move/delete them first.");
      return;
    }
    await loadFloors(); populateFloorSelectors(); populateTableFloorFilter(); refreshPublic(); showToast("Floor deleted");
  });
  floorCategoriesChk?.addEventListener("change", async (ev)=>{
    const fid=floorSettingsSel?.value;
    const r=await fetch("/api/floors/"+encodeURIComponent(fid),{method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({categories_enabled: !!ev.target.checked})});
    if (!r.ok){ showToast("Update failed"); return; }
    await loadFloors(); populateFloorSelectors(); populateTableFloorFilter(); refreshPublic(); showToast("Updated");
  });

  $("#upload-floor")?.addEventListener("click", async ()=>{
    const file=$("#floor-file")?.files?.[0]; if(!file){ $("#upload-msg").textContent="Choose a PDF"; return; }
    const fid=floorSettingsSel?.value; const fd=new FormData();
    fd.append("file", file, file.name);
    fd.append("floor_id", fid||"");
    const r=await fetch("/api/floors/upload",{method:"POST", body:fd});
    const j=await r.json().catch(()=>({}));
    $("#upload-msg").textContent = r.ok ? `Uploaded (${j.map_type||"?"})` : (j.error||"Upload failed");
    await loadFloors(); populateTableFloorFilter(); refreshPublic();
  });

  // Export floors (backup)
  $("#export-floors")?.addEventListener("click", async ()=>{
    try {
      const r = await fetch("/api/export/floors");
      if (!r.ok) {
        showToast("Export failed");
        return;
      }
      const blob = await r.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `floors-backup-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      showToast("Floors exported successfully");
    } catch(e) {
      showToast("Export failed: " + e.message);
    }
  });

  // Import floors (restore)
  $("#import-floors")?.addEventListener("click", ()=>{
    $("#import-floors-file").click();
  });

  $("#import-floors-file")?.addEventListener("change", async (ev)=>{
    const file = ev.target.files?.[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      
      if (!confirm(`Import ${data.floors?.length || 0} floors? This will replace existing floor configuration but preserve maps.`)) {
        $("#import-floors-file").value = "";
        return;
      }
      
      const r = await fetch("/api/import/floors", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(data)
      });
      
      const j = await r.json().catch(()=>({}));
      $("#import-msg").textContent = r.ok ? (j.message || "Import successful") : (j.error || "Import failed");
      
      if (r.ok) {
        await loadFloors();
        populateFloorSelectors();
        populateTableFloorFilter();
        await refreshPublic();
        showToast("Floors imported successfully");
      }
    } catch(e) {
      $("#import-msg").textContent = "Import failed: " + e.message;
    }
    
    $("#import-floors-file").value = "";
  });

  // Settings — Machines
  function clearForm(){
    $("#m-id").value=""; $("#m-name").value="";
    $("#m-os").value="";
    $("#m-ip").value=""; $("#m-serial").value="";
    $("#m-notes").value=""; $("#m-tcp").value=""; $("#m-check").value="icmp"; $("#m-pos").textContent="(use Map placement)";
    $("#m-category").value="global";
    $("#m-non-operational").checked = false;
    placement={mid:null,x:null,y:null,floor_id:null};
  }
  $("#clear-form")?.addEventListener("click", clearForm);

  // Keyboard shortcuts for machine form
  const machineFormInputs = ["#m-name", "#m-ip", "#m-serial", "#m-tcp"];
  machineFormInputs.forEach(sel=>{
    $(sel)?.addEventListener("keydown", (ev)=>{
      if (ev.key === "Enter"){
        ev.preventDefault();
        $("#save-machine")?.click();
      } else if (ev.key === "Escape"){
        clearForm();
      }
    });
  });

  $("#save-machine")?.addEventListener("click", async ()=>{
    const name=$("#m-name").value.trim();
    const ip=$("#m-ip").value.trim();
    if (!name && !ip){ showToast("Enter at least a Name or an IP"); return; }
    let defaultFloorId = placement.floor_id || floorSettingsSel?.value || floorSel?.value || (currentFloor?.id||"");
    const body={
      id: $("#m-id").value || undefined,
      name,
      os: $("#m-os").value, // dropdown value
      ip,
      serial: $("#m-serial").value.trim(),
      notes: $("#m-notes").value.trim(),
      check: $("#m-check").value,
      tcp_port: +($("#m-tcp").value||0),
      category: $("#m-category").disabled ? "global" : ($("#m-category").value || "global"),
      floor_id: defaultFloorId || undefined,
      operational: !$("#m-non-operational")?.checked,
    };
    if (placement.x!=null && placement.y!=null){
      body.x=placement.x; body.y=placement.y;
      if (placement.floor_id) body.floor_id=placement.floor_id;
    }
    const method=body.id?"PUT":"POST";
    const url=body.id?(`/api/machines/${body.id}`):"/api/machines";
    const res = await fetch(url,{method, headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
    if (!res.ok){
      let err=""; try{ const j=await res.json(); err=j.error||JSON.stringify(j);}catch{err=`HTTP ${res.status}`;}
      showToast(`Save failed: ${err}`); return;
    }
    await res.json().catch(()=>null);
    placement={mid:null,x:null,y:null,floor_id:null}; $("#m-pos").textContent="(use Map placement)";
    await loadMachinesTable(); await refreshPublic(); showToast("Machine saved");
  });

  $("#clear-pos")?.addEventListener("click", async ()=>{
    const id=$("#m-id").value;
    if (!id){ placement={mid:null,x:null,y:null,floor_id:null}; $("#m-pos").textContent="(use Map placement)"; drawMarkers(); showToast("Position cleared (unsaved)"); return; }
    const r=await fetch("/api/machines/"+id,{method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({clear_pos:true})});
    if (!r.ok){ showToast("Clear position failed"); return; }
    await loadMachinesTable(); await refreshPublic(); showToast("Position cleared");
  });

  async function loadMachinesTable(){
    const ms=await fetch("/api/machines").then(r=>r.json()).catch(()=>[]);
    machines=ms; populateMachinesTableRows();
  }
  function populateMachinesTableRows(){
    const tb=$("#list tbody"); if (!tb) return; tb.innerHTML="";
    machines
      .filter(m=>{
        const catOk = tableCategory==="all" ? true : (m.category||"global")===tableCategory;
        const floorOk = tableFloorId==="all" ? true : (m.floor_id===tableFloorId);
        return catOk && floorOk;
      })
      .sort((a,b)=> (a.floor_id||"").localeCompare(b.floor_id||"") || (a.category||"").localeCompare(b.category||"") || (a.name||"").localeCompare(b.name||""))
      .forEach(m=>{
        const floorName = floors.find(f=>f.id===m.floor_id)?.name || m.floor_id || "";
        const operational = m.operational !== false;
        const stateLabel = operational ? "Operational" : "Storage";
        const toggleLabel = operational ? "To Storage" : "To Operational";
        const tr=document.createElement("tr");
        tr.innerHTML=`
          <td>${esc((CAT_LABEL[m.category||"global"])||"Global")}</td>
          <td>${esc(m.name||"")}</td>
          <td>${esc(m.os||"")}</td>
          <td>${esc(m.ip||"")}</td>
          <td>${esc(m.serial||"")}</td>
          <td>${esc(floorName)}</td>
          <td>${esc(stateLabel)}</td>
          <td>${esc((m.last_status||"down").toUpperCase())}</td>
          <td>${m.last_rtt_ms||0} ms</td>
          <td>
            <button class="btn mini" data-act="edit" data-id="${m.id}">Edit</button>
            <button class="btn mini" data-act="toggle-op" data-id="${m.id}">${esc(toggleLabel)}</button>
            <button class="btn mini" data-act="ping" data-id="${m.id}">Ping</button>
            <button class="btn mini" data-act="del" data-id="${m.id}">Delete</button>
          </td>`;
        tb.appendChild(tr);
      });
    tb.querySelectorAll("button").forEach(b=>{
      b.addEventListener("click", async ()=>{
        const id=b.dataset.id, act=b.dataset.act, m=machines.find(x=>x.id===id);
        if (act==="del"){ if(!confirm("Delete machine?")) return; await fetch("/api/machines/"+id,{method:"DELETE"}); await loadMachinesTable(); refreshPublic(); showToast("Machine deleted"); }
        else if (act==="ping"){ const res=await fetch("/api/ping/"+id); await res.json().catch(()=>null); await loadMachinesTable(); refreshPublic(); }
        else if (act==="toggle-op" && m){
          const newState = !m.operational;
          const body = { operational: newState };
          const r = await fetch(`/api/machines/${id}`, {method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
          if (r.ok) {
            await loadMachinesTable(); 
            await loadStorageDevices(); 
            await refreshPublic(); 
            showToast(newState ? "Device moved to operational" : "Device moved to storage");
          } else {
            showToast("Failed to change device state");
          }
        }
        else if (act==="edit" && m){
          $("#m-id").value=m.id; $("#m-name").value=m.name||"";
          $("#m-os").value=m.os||""; // set dropdown
          $("#m-ip").value=m.ip||""; $("#m-serial").value=m.serial||"";
          $("#m-notes").value=m.notes||""; $("#m-category").value=m.category||"global";
          $("#m-non-operational").checked = !m.operational;
          $("#m-pos").textContent = (typeof m.x==="number"&&typeof m.y==="number") ? `x:${m.x.toFixed(3)}, y:${m.y.toFixed(3)}` : "(use Map placement)";
          placement={mid:m.id,x:m.x,y:m.y,floor_id:m.floor_id};
          syncFloorCategoriesUI();
        }
      });
    });
  }

  // Table pills
  $("#table-pills")?.addEventListener("click", (ev)=>{
    const btn = ev.target.closest(".pill"); if (!btn) return;
    $$("#table-pills .pill").forEach(p=>p.classList.remove("active"));
    btn.classList.add("active"); tableCategory = btn.dataset.tcat || "all"; populateMachinesTableRows();
  });

  // Placement modal — rotation-aware (unchanged logic)
  $("#open-placement")?.addEventListener("click", async ()=>{
    await loadFloors();
    const startFid = floorSel?.value || currentFloor?.id || floors[0].id;
    placeFloor.innerHTML=floors.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join("");
    placeFloor.value=startFid;

    await loadMachinesTable();
    const currentId=$("#m-id").value||"";
    const options=[`<option value="__new__">Use current form (new)</option>`];
    machines.forEach(m=> options.push(`<option value="${m.id}" ${m.id===currentId?"selected":""}>${esc(m.name||m.id)}</option>`));
    placeMachine.innerHTML=options.join("");

    placement.mid = placeMachine.value==="__new__" ? null : placeMachine.value;
    placement.floor_id = placeFloor.value;

    loadPlacementMap();
    placeModal.classList.remove("hidden");
  });
  $("#place-close")?.addEventListener("click", ()=> placeModal.classList.add("hidden"));

  placeFloor?.addEventListener("change", ()=>{
    placement.floor_id=placeFloor.value;
    loadPlacementMap();
  });
  placeMachine?.addEventListener("change", ()=>{
    placement.mid = (placeMachine.value==="__new__")?null:placeMachine.value;
  });

  function placeApplyRotationSizing(deg){
    const wrap = $("#place-wrap").getBoundingClientRect();
    const ow = (deg%180===0)? placeNaturalW : placeNaturalH;
    const oh = (deg%180===0)? placeNaturalH : placeNaturalW;
    placeFit = Math.min((wrap.width-24)/ow,(wrap.height-24)/oh)||1;
    const scale=placeFit*placeZoom;
    placeScaledW = Math.max(1,Math.round(placeNaturalW*scale));
    placeScaledH = Math.max(1,Math.round(placeNaturalH*scale));
    const areaW = (deg%180===0)? placeScaledW : placeScaledH;
    const areaH = (deg%180===0)? placeScaledH : placeScaledW;
    placeArea.style.width=areaW+"px"; placeArea.style.height=areaH+"px";
    placeRot.style.width=placeScaledW+"px"; placeRot.style.height=placeScaledH+"px";
    placeImg.style.width=placeScaledW+"px"; placeImg.style.height=placeScaledH+"px";
    placeRot.style.transformOrigin="top left";
    if (deg===0) placeRot.style.transform=`translate(0px,0px) rotate(0deg)`;
    else if (deg===90) placeRot.style.transform=`translate(${placeScaledH}px,0px) rotate(90deg)`;
    else if (deg===180) placeRot.style.transform=`translate(${placeScaledW}px,${placeScaledH}px) rotate(180deg)`;
    else if (deg===270) placeRot.style.transform=`translate(0px,${placeScaledW}px) rotate(270deg)`;
  }

  function loadPlacementMap(){
    const q=`?floor_id=${encodeURIComponent(placeFloor.value)}`;
    placeImg.onerror=()=>{ placeNoMap.classList.remove("hidden"); placeMarkers.innerHTML=""; };
    placeImg.onload=()=>{
      placeNoMap.classList.add("hidden");
      placeNaturalW=placeImg.naturalWidth||1600; placeNaturalH=placeImg.naturalHeight||900;
      const deg=getRot(placeFloor.value);
      placeApplyRotationSizing(deg);
      drawPlacementMarkers();
    };
    placeImg.src="/map-image"+q+"&ts="+Date.now();
  }
  function drawPlacementMarkers(){
    placeMarkers.innerHTML="";
    machines.filter(m=>m.floor_id===placeFloor.value && typeof m.x==="number" && typeof m.y==="number").forEach(m=>{
      const dot=document.createElement("div"); dot.className="marker "+((m.last_status==="up")?"ok":"down");
      dot.style.left=(m.x*placeScaledW-6)+"px"; dot.style.top=(m.y*placeScaledH-6)+"px";
      placeMarkers.appendChild(dot);
    });
  }
  placeArea?.addEventListener("click", ev=>{
    if (!placeScaledW || !placeScaledH) return;
    const rect=placeArea.getBoundingClientRect();
    const X=ev.clientX-rect.left, Y=ev.clientY-rect.top;
    const deg=getRot(placeFloor.value);
    let ux=0, uy=0;
    if (deg===0){ ux = X; uy = Y; }
    else if (deg===90){ ux = Y; uy = placeScaledH - X; }
    else if (deg===180){ ux = placeScaledW - X; uy = placeScaledH - Y; }
    else if (deg===270){ ux = placeScaledW - Y; uy = X; }
    const xn = Math.min(1,Math.max(0, ux/placeScaledW));
    const yn = Math.min(1,Math.max(0, uy/placeScaledH));
    placement.x=xn; placement.y=yn; placement.floor_id=placeFloor.value;

    placeMarkers.querySelectorAll(".marker.new").forEach(n=>n.remove());
    const dot=document.createElement("div"); dot.className="marker ok new"; dot.style.left=(xn*placeScaledW-6)+"px"; dot.style.top=(yn*placeScaledH-6)+"px";
    placeMarkers.appendChild(dot);
  });

  $("#place-save")?.addEventListener("click", async ()=>{
    if (!placement.floor_id){ showToast("Choose a floor"); return; }
    if (placement.x==null || placement.y==null){ showToast("Click on the map to set a position"); return; }
    if (!placement.mid){
      $("#m-pos").textContent=`x:${placement.x.toFixed(3)}, y:${placement.y.toFixed(3)}`;
      placeModal.classList.add("hidden");
      return;
    }
    const body={ x:placement.x, y:placement.y, floor_id:placement.floor_id };
    const r=await fetch("/api/machines/"+placement.mid,{method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
    if(!r.ok){
      let j={}; try{ j=await r.json(); }catch{}
      showToast("Saving position failed"+(j.error?`: ${j.error}`:""));
      return;
    }
    const target=floors.find(f=>f.id===placement.floor_id);
    if (target && floorSel){ currentFloor=target; floorSel.value=target.id; }
    placeModal.classList.add("hidden");
    await loadMachinesTable(); await refreshPublic(); showToast("Position saved");
  });

  // Map tab init + auto refresh
  async function initMapTab(){ await loadFloors(); await refreshPublic(); await syncAuth(); await loadStorageDevices(); }
  async function syncAuth(){ const j=await fetch("/api/whoami").then(r=>r.json()).catch(()=>({authenticated:false})); $("#ping-all") && ($("#ping-all").disabled = !j.authenticated); }
  function startAutoRefresh(){ if(timer) clearInterval(timer); const secs=+($("#refresh-interval")?.value||60); timer=setInterval(refreshPublic, secs*1000); }
  $("#refresh-interval")?.addEventListener("change", startAutoRefresh);
  $("#refresh")?.addEventListener("click", refreshPublic);

  // Credits hover
  const creditWrap = $(".credit-wrap");
  creditWrap?.addEventListener("mouseenter", ()=> $("#credit-tip")?.classList.add("show"));
  creditWrap?.addEventListener("mouseleave", ()=> $("#credit-tip")?.classList.remove("show"));

  // Storage Inventory Panel
  let storageDevices = [];
  let promotingDevice = null;
  const storagePanel = $("#storage-panel");
  const storageToggle = $("#storage-toggle");
  const storageItems = $("#storage-items");
  const storFloor = $("#stor-floor");

  // Toggle panel collapse
  storageToggle?.addEventListener("click", ()=>{
    storagePanel?.classList.toggle("collapsed");
    storageToggle.textContent = storagePanel?.classList.contains("collapsed") ? "▶" : "◀";
    storageToggle.setAttribute("title", storagePanel?.classList.contains("collapsed") ? "Expand panel" : "Collapse panel");
  });
  
  // Keyboard support for storage toggle
  storageToggle?.addEventListener("keydown", (ev)=>{
    if (ev.key === "Enter" || ev.key === " "){
      ev.preventDefault();
      storageToggle.click();
    }
  });

  // Populate floor dropdown for storage
  function populateStorageFloors(){
    if (!storFloor) return;
    storFloor.innerHTML = floors.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join("");
    if (currentFloor) storFloor.value = currentFloor.id;
  }

  // Load storage devices
  async function loadStorageDevices(){
    try {
      const r = await fetch("/api/public/storage", {cache:"no-store"});
      storageDevices = await r.json();
      renderStorageDevices();
    } catch(e){
      console.error("Failed to load storage devices:", e);
    }
  }

  // Render storage devices
  function renderStorageDevices(){
    if (!storageItems) return;
    if (storageDevices.length === 0){
      storageItems.innerHTML = '<div class="muted" style="padding:8px;">No devices in storage</div>';
      return;
    }
    storageItems.innerHTML = storageDevices.map(m=>{
      const floorName = floors.find(f=>f.id===m.floor_id)?.name || m.floor_id || "—";
      const cat = CAT_LABEL[m.category||"global"] || "Global";
      return `
        <div class="storage-item" data-id="${m.id}">
          <div class="storage-item-header">
            <span class="storage-item-name">${esc(m.name||"(unnamed)")}</span>
          </div>
          <div class="storage-item-details">
            <div>Category: ${esc(cat)}</div>
            <div>Floor: ${esc(floorName)}</div>
            ${m.ip ? `<div>IP: ${esc(m.ip)}</div>` : ''}
          </div>
          <button class="btn mini" data-act="promote" data-id="${m.id}">Make operational</button>
        </div>
      `;
    }).join("");

    // Add event listeners
    storageItems.querySelectorAll("button").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const id = btn.dataset.id;
        const device = storageDevices.find(d=>d.id===id);
        if (!device) return;
        
        if (btn.dataset.act === "promote"){
          startPromotionMode(device);
        }
      });
    });
  }

  // Add device to storage
  $("#stor-save")?.addEventListener("click", async ()=>{
    const name = $("#stor-name")?.value.trim();
    const category = $("#stor-category")?.value || "global";
    const floor_id = $("#stor-floor")?.value;
    const errorEl = $("#stor-error");
    
    if (errorEl) errorEl.textContent = "";
    
    // Validation
    if (!name){
      if (errorEl) errorEl.textContent = "Name is required";
      return;
    }
    if (!category){
      if (errorEl) errorEl.textContent = "Category is required";
      return;
    }
    if (!floor_id){
      if (errorEl) errorEl.textContent = "Floor is required";
      return;
    }

    const body = {
      name,
      category,
      floor_id,
      operational: false,
      ip: "",
      serial: "",
      os: "",
      notes: ""
    };

    try {
      const r = await fetch("/api/machines", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
      });
      
      if (!r.ok){
        const j = await r.json().catch(()=>({}));
        if (errorEl) errorEl.textContent = j.error || "Failed to add device";
        return;
      }
      
      // Clear form
      $("#stor-name").value = "";
      $("#stor-category").value = "global";
      
      await loadStorageDevices();
      showToast("Device added to storage");
    } catch(e){
      if (errorEl) errorEl.textContent = "Failed to add device";
    }
  });

  // Keyboard support for storage form
  $("#stor-name")?.addEventListener("keydown", (ev)=>{
    if (ev.key === "Enter"){
      ev.preventDefault();
      $("#stor-save")?.click();
    }
  });

  // Start promotion mode
  function startPromotionMode(device){
    promotingDevice = device;
    
    // Switch to map tab if not already there
    const mapTab = $('[data-tab="map"]');
    if (mapTab && !mapTab.classList.contains("active")){
      mapTab.click();
    }
    
    // Show placement modal
    setTimeout(async ()=>{
      await loadFloors();
      const startFid = device.floor_id || currentFloor?.id || floors[0].id;
      placeFloor.innerHTML=floors.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join("");
      placeFloor.value=startFid;

      await loadMachinesTable();
      placeMachine.innerHTML=`<option value="${device.id}" selected>${esc(device.name||device.id)}</option>`;
      
      placement.mid = device.id;
      placement.floor_id = startFid;
      placement.x = null;
      placement.y = null;

      loadPlacementMap();
      placeModal.classList.remove("hidden");
      
      showToast("Click on the map to place the device");
    }, 100);
  }

  // Override place-save to handle promotion
  const originalPlaceSave = $("#place-save");
  if (originalPlaceSave){
    const origHandler = originalPlaceSave.onclick;
    $("#place-save").onclick = null;
    $("#place-save").addEventListener("click", async ()=>{
      if (!placement.floor_id){ showToast("Choose a floor"); return; }
      if (placement.x==null || placement.y==null){ showToast("Click on the map to set a position"); return; }
      
      // Check if we're promoting a storage device
      if (promotingDevice && placement.mid === promotingDevice.id){
        const body = { 
          x: placement.x, 
          y: placement.y, 
          floor_id: placement.floor_id,
          operational: true
        };
        const r = await fetch("/api/machines/"+placement.mid, {
          method:"PUT", 
          headers:{"Content-Type":"application/json"}, 
          body:JSON.stringify(body)
        });
        if(!r.ok){
          let j={}; try{ j=await r.json(); }catch{}
          showToast("Promotion failed"+(j.error?`: ${j.error}`:""));
          return;
        }
        const target=floors.find(f=>f.id===placement.floor_id);
        if (target && floorSel){ currentFloor=target; floorSel.value=target.id; }
        placeModal.classList.add("hidden");
        promotingDevice = null;
        await loadStorageDevices();
        await loadMachinesTable(); 
        await refreshPublic(); 
        showToast("Device promoted to operational");
        return;
      }
      
      // Original logic for non-storage devices
      if (!placement.mid){
        $("#m-pos").textContent=`x:${placement.x.toFixed(3)}, y:${placement.y.toFixed(3)}`;
        placeModal.classList.add("hidden");
        return;
      }
      const body={ x:placement.x, y:placement.y, floor_id:placement.floor_id };
      const r=await fetch("/api/machines/"+placement.mid,{method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
      if(!r.ok){
        let j={}; try{ j=await r.json(); }catch{}
        showToast("Saving position failed"+(j.error?`: ${j.error}`:""));
        return;
      }
      const target=floors.find(f=>f.id===placement.floor_id);
      if (target && floorSel){ currentFloor=target; floorSel.value=target.id; }
      placeModal.classList.add("hidden");
      await loadMachinesTable(); await refreshPublic(); showToast("Position saved");
    });
  }

  // Cancel promotion on Escape or close
  $("#place-close")?.addEventListener("click", ()=>{
    promotingDevice = null;
    placeModal.classList.add("hidden");
  });
  
  document.addEventListener("keydown", (ev)=>{
    if (ev.key === "Escape" && !placeModal?.classList.contains("hidden")){
      promotingDevice = null;
      placeModal.classList.add("hidden");
    }
  });

  // Boot
  (async function boot(){ 
    await loadFloors(); 
    populateStorageFloors();
    await refreshPublic(); 
    await loadStorageDevices();
    await checkAuth(); 
    startAutoRefresh(); 
  })();
});