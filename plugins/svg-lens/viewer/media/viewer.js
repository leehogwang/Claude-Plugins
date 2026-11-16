(() => {
  const vscode = acquireVsCodeApi();
  const vp = document.getElementById("vp");
  const stage = document.getElementById("stage");
  const macro = document.getElementById("macro");
  const zLbl = document.getElementById("zLbl");
  const qIn = document.getElementById("q");
  const qLbl = document.getElementById("qLbl");
  const listEl = document.getElementById("list");
  const modList = document.getElementById("modList");
  const iCnt = document.getElementById("iCnt");
  const side = document.getElementById("side");
  const mods = document.getElementById("mods");
  const flowPanelEl = document.getElementById("flowPanel");
  const flowBtn = document.getElementById("flowBtn");
  const mm = document.getElementById("mm");
  const mmBox = document.getElementById("mmBox");
  const mmRect = document.getElementById("mmRect");

  let svgEl = null, svgW = 1000, svgH = 1000;
  let vx = 0, vy = 0, vw = 1000, vh = 1000;
  let drag = false, sx = 0, sy = 0, svx = 0, svy = 0;
  let mmDrag = false, showDiag = true, useLod = true, allCollapsed = false;
  let matches = [], mIdx = -1, hlTimer = null;
  let macroNodes = [];
  let wasm = null;
  let flowPanel = null;
  let activeTrace = null;

  function findSvgNodeForStep(step) {
    if (!svgEl || !step) return null;
    if (step.node_id) {
      const byId = svgEl.querySelector(`#${CSS.escape(step.node_id)}`);
      if (byId) return byId;
    }
    const q = String(step.label || step.module || "").trim().toLowerCase();
    if (!q) return null;
    const candidates = svgEl.querySelectorAll("g.ctr, g.chip");
    for (const el of candidates) {
      const txt = (el.querySelector(":scope > g.hdr .hdr-txt, :scope > g.hdr text, text")?.textContent || "").trim().toLowerCase();
      if (txt && (txt === q || txt.includes(q) || q.includes(txt))) return el;
    }
    return null;
  }

  function applyFlowHighlights(stepIdx, step, meta) {
    if (!svgEl || !flowPanelEl || flowPanelEl.classList.contains("hide")) return;
    svgEl.classList.toggle("flow-dim-mode", Boolean(meta && meta.dimOthers));
    svgEl.querySelectorAll(".flow-active, .flow-visited").forEach((el) => {
      el.classList.remove("flow-active", "flow-visited");
    });
    const steps = (meta && meta.steps) || [];
    for (let i = 0; i < stepIdx; i++) {
      const n = findSvgNodeForStep(steps[i]);
      if (n) n.classList.add("flow-visited");
    }
    const curNode = findSvgNodeForStep(step);
    if (curNode) {
      curNode.classList.add("flow-active");
      if (meta && meta.autoFocus) focusEl(curNode, 0.75);
    }
  }

  function setFlowOpen(open) {
    if (!flowPanelEl || !flowBtn) return;
    flowPanelEl.classList.toggle("hide", !open);
    flowBtn.classList.toggle("on", open);
    document.body.classList.toggle("flow-open", open);
    if (svgEl && !open) {
      svgEl.classList.remove("flow-dim-mode");
      svgEl.querySelectorAll(".flow-active, .flow-visited").forEach((el) => {
        el.classList.remove("flow-active", "flow-visited");
      });
    } else if (open && flowPanel && activeTrace) {
      flowPanel.render();
    }
    apply();
  }

  if (window.SvgLensFlowPanel && flowPanelEl) {
    flowPanel = new window.SvgLensFlowPanel(flowPanelEl, {
      onStepChange: applyFlowHighlights,
      onClose: () => setFlowOpen(false),
    });
  }

  function buildFallbackTraceFromSvg() {
    if (!svgEl) return null;
    const nodes = Array.from(svgEl.querySelectorAll("g.ctr, g.chip"));
    if (nodes.length === 0) return null;
    const steps = nodes.map((el, idx) => {
      const title = (el.querySelector(":scope > g.hdr .hdr-txt, :scope > g.hdr text, text")?.textContent || "").trim();
      const diag = (el.querySelector(".diag-tag text")?.textContent || "").trim();
      return {
        step: idx + 1,
        node_id: el.id || "",
        label: title || el.id || `Node ${idx + 1}`,
        phase: el.classList.contains("ctr") ? "module" : "op",
        diagnostics: diag ? { summary: diag } : undefined,
      };
    });
    return { source_code: "", steps };
  }

  function loadTrace(traceObj, autoOpen = true) {
    if (!flowPanel || !traceObj || !Array.isArray(traceObj.steps) || traceObj.steps.length === 0) return;
    activeTrace = traceObj;
    flowPanel.setTrace(traceObj, 0);
    if (autoOpen) setFlowOpen(true);
  }

  if (window.__WASM_URI__) {
    fetch(window.__WASM_URI__)
      .then((r) => r.arrayBuffer())
      .then((buf) => WebAssembly.instantiate(buf, {}))
      .then((res) => { wasm = res.instance.exports; })
      .catch(() => {});
  }

  function currentScale() {
    return vp.clientWidth / Math.max(vw, 1);
  }

  function updateLodAndMacro() {
    if (!svgEl) return;
    const sc = currentScale();
    stage.classList.toggle("lod-far", useLod && sc < 0.22);
    stage.classList.toggle("lod-mid", useLod && sc >= 0.22 && sc < 0.45);
    macro.innerHTML = "";
    if (!useLod || sc >= 0.24) return;
    const w = vp.clientWidth, h = vp.clientHeight;
    let lastX = -1e9;
    macroNodes.forEach((m) => {
      const px = (m.x - vx) * sc;
      const py = (m.y - vy) * sc;
      if (px < -220 || px > w + 40 || py < 0 || py > h + 30) return;
      if (m.w * sc < 36) return;
      if (Math.abs(px - lastX) < 95 && m.depth > 0) return;
      lastX = px;
      const pill = document.createElement("div");
      pill.className = "m-pill";
      pill.style.left = `${Math.max(6, px)}px`;
      pill.style.top = `${Math.max(24, py)}px`;
      pill.textContent = m.title;
      pill.onclick = (e) => { e.stopPropagation(); focusEl(m.el, 0.55); };
      macro.appendChild(pill);
    });
  }

  function apply() {
    if (!svgEl) return;
    svgEl.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
    const sc = currentScale();
    zLbl.textContent = `${Math.round(sc * 100)}%`;
    const mw = mmBox.clientWidth, mh = mmBox.clientHeight;
    if (wasm) {
      const ptr = wasm.compute_minimap_vb(vx, vy, vw, vh, svgW, svgH, mw, mh);
      const arr = new Float64Array(wasm.memory.buffer, ptr, 4);
      mmRect.style.left = `${arr[0]}px`;
      mmRect.style.top = `${arr[1]}px`;
      mmRect.style.width = `${arr[2]}px`;
      mmRect.style.height = `${arr[3]}px`;
    } else {
      mmRect.style.left = `${(Math.max(0, vx) / svgW) * mw}px`;
      mmRect.style.top = `${(Math.max(0, vy) / svgH) * mh}px`;
      mmRect.style.width = `${Math.max(4, (Math.min(vw, svgW) / svgW) * mw)}px`;
      mmRect.style.height = `${Math.max(4, (Math.min(vh, svgH) / svgH) * mh)}px`;
    }
    updateLodAndMacro();
  }

  function fitH() {
    if (!svgEl) return;
    const aspect = Math.max(vp.clientWidth, 1) / Math.max(vp.clientHeight, 1);
    vh = svgH * 1.04;
    vw = vh * aspect;
    vx = -vw * 0.01;
    vy = -svgH * 0.02;
    apply();
  }

  function fitAll() {
    if (!svgEl) return;
    const aspect = Math.max(vp.clientWidth, 1) / Math.max(vp.clientHeight, 1);
    if (svgW / svgH > aspect) {
      vw = svgW * 1.02;
      vh = vw / aspect;
      vx = -svgW * 0.01;
      vy = (svgH - vh) / 2;
    } else {
      vh = svgH * 1.02;
      vw = vh * aspect;
      vx = (svgW - vw) / 2;
      vy = -svgH * 0.01;
    }
    apply();
  }

  function zoomBy(factor, cx = vp.clientWidth / 2, cy = vp.clientHeight / 2) {
    if (!svgEl) return;
    const fx = cx / Math.max(vp.clientWidth, 1);
    const fy = cy / Math.max(vp.clientHeight, 1);
    const wx = vx + fx * vw;
    const wy = vy + fy * vh;
    const nvw = Math.min(svgW * 3, Math.max(vp.clientWidth / 4.0, vw / factor));
    const nvh = nvw * (Math.max(vp.clientHeight, 1) / Math.max(vp.clientWidth, 1));
    vw = nvw;
    vh = nvh;
    vx = wx - fx * vw;
    vy = wy - fy * vh;
    apply();
  }

  function svgCoords(el) {
    const target = el.querySelector(":scope > .frame") || el;
    const b = target.getBBox();
    const ctm = target.getCTM(), sctm = svgEl.getCTM();
    let x = b.x, y = b.y;
    if (ctm && sctm) {
      const pt = svgEl.createSVGPoint();
      pt.x = x; pt.y = y;
      const p2 = pt.matrixTransform(sctm.inverse().multiply(ctm));
      x = p2.x; y = p2.y;
    }
    return { x, y, w: b.width, h: b.height };
  }

  function focusEl(el, minScale = 0.85) {
    if (!el || !svgEl) return;
    const c = svgCoords(el);
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    const sc = Math.max(currentScale(), minScale);
    vw = vp.clientWidth / sc;
    vh = vp.clientHeight / sc;
    vx = cx - vw / 2;
    vy = cy - vh / 2;
    apply();
    el.classList.add("hl");
    clearTimeout(hlTimer);
    hlTimer = setTimeout(() => el.classList.remove("hl"), 1400);
  }

  function buildModulesAndCollapse() {
    modList.innerHTML = "";
    macroNodes = [];
    const ctrs = Array.from(svgEl.querySelectorAll("g.ctr"));
    const ctrEntries = [];
    ctrs.forEach((ctr) => {
      const hdr = ctr.querySelector(":scope > g.hdr");
      if (hdr) {
        hdr.onclick = (e) => {
          e.stopPropagation();
          ctr.classList.toggle("collapsed");
        };
      }
      let depth = 0;
      let p = ctr.parentElement;
      while (p && p !== svgEl) {
        if (p.classList && p.classList.contains("ctr")) depth++;
        p = p.parentElement;
      }
      const title = (ctr.querySelector(":scope > g.hdr .hdr-txt, :scope > g.hdr text")?.textContent || "").trim();
      if (title) {
        ctrEntries.push({ el: ctr, title, depth, ...svgCoords(ctr) });
      }
    });

    let summary = null;
    const metaEl = svgEl.querySelector("#nn-summary");
    if (metaEl && metaEl.textContent) {
      try { summary = JSON.parse(metaEl.textContent.trim()); } catch (_) { summary = null; }
    }

    if (summary && Array.isArray(summary.stages) && summary.stages.length > 0) {
      summary.stages.forEach((st) => {
        const q = (st.match || st.title || "").toLowerCase();
        const hit = ctrEntries.find((c) => c.title.toLowerCase().includes(q)) || ctrEntries[0];
        if (hit) {
          macroNodes.push({ el: hit.el, title: st.title, depth: 0, x: hit.x, y: hit.y, w: hit.w, h: hit.h });
        }
        const row = document.createElement("div");
        row.className = "m-row";
        row.innerHTML = `<div class="t"></div><div class="m"></div>`;
        row.querySelector(".t").textContent = st.title || "";
        row.querySelector(".m").textContent = st.summary || "";
        if (hit) row.onclick = () => focusEl(hit.el, 0.55);
        modList.appendChild(row);
      });
      return;
    }

    ctrEntries.forEach((c) => {
      if (c.depth <= 1) {
        macroNodes.push(c);
        const row = document.createElement("div");
        row.className = "m-row" + (c.depth === 1 ? " d1" : "");
        row.innerHTML = `<div class="t"></div>`;
        row.querySelector(".t").textContent = c.title;
        row.onclick = () => focusEl(c.el, 0.55);
        modList.appendChild(row);
      }
    });
  }

  function buildIssues() {
    listEl.innerHTML = "";
    const nodes = svgEl.querySelectorAll(".ctr.breaks, .ctr.mayBreak, .chip.breaks, .chip.mayBreak");
    iCnt.textContent = String(nodes.length);
    nodes.forEach((el) => {
      const brk = el.classList.contains("breaks");
      const t = (el.querySelector(".hdr-txt, text")?.textContent || "").trim() || el.id || "node";
      const m = (el.querySelector(".diag-tag text")?.textContent || "").trim();
      const d = document.createElement("div");
      d.className = "item" + (brk ? " brk" : "");
      d.innerHTML = `<div class="t"></div><div class="m"></div>`;
      d.querySelector(".t").textContent = t;
      d.querySelector(".m").textContent = m;
      d.onclick = () => focusEl(el, 0.95);
      listEl.appendChild(d);
    });
  }

  function mount(svgText) {
    if (!svgText || !svgText.includes("<svg")) return;
    stage.innerHTML = svgText;
    svgEl = stage.querySelector("svg");
    if (!svgEl) return;
    if (wasm) {
      const bytes = new TextEncoder().encode(svgText.slice(0, 4096));
      const ptr = wasm.alloc(bytes.length);
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      const dPtr = wasm.parse_svg_dims(ptr, bytes.length);
      const dims = new Float64Array(wasm.memory.buffer, dPtr, 2);
      svgW = dims[0];
      svgH = dims[1];
      wasm.dealloc(ptr, bytes.length);
    } else {
      const vb = (svgEl.getAttribute("viewBox") || "").trim().split(/\s+/).map(Number);
      svgW = vb.length === 4 ? vb[2] : (parseFloat(svgEl.getAttribute("width")) || 2000);
      svgH = vb.length === 4 ? vb[3] : (parseFloat(svgEl.getAttribute("height")) || 1200);
    }
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svgEl.classList.toggle("no-diag", !showDiag);
    buildModulesAndCollapse();
    buildIssues();
    matches = []; mIdx = -1; qLbl.textContent = "0/0";
    fitH();

    const embeddedTrace = svgEl.querySelector("#nn-trace");
    if (embeddedTrace && embeddedTrace.textContent) {
      try {
        loadTrace(JSON.parse(embeddedTrace.textContent.trim()), true);
      } catch (_) {}
    } else if (activeTrace && flowPanel) {
      flowPanel.setTrace(activeTrace, flowPanel.curStep);
    } else {
      const fallback = buildFallbackTraceFromSvg();
      if (fallback) loadTrace(fallback, false);
    }
  }

  vp.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  vp.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    drag = true; vp.classList.add("drag");
    sx = e.clientX; sy = e.clientY; svx = vx; svy = vy;
  });
  window.addEventListener("mousemove", (e) => {
    if (drag) {
      const sc = currentScale();
      vx = svx - (e.clientX - sx) / sc;
      vy = svy - (e.clientY - sy) / sc;
      apply();
    }
    if (mmDrag) mmJump(e);
  });
  window.addEventListener("mouseup", () => { drag = false; mmDrag = false; vp.classList.remove("drag"); });
  window.addEventListener("resize", apply);

  function mmJump(e) {
    const r = mmBox.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    vx = fx * svgW - vw / 2;
    vy = fy * svgH - vh / 2;
    apply();
  }
  mm.addEventListener("mousedown", (e) => { mmDrag = true; mmJump(e); });

  function search() {
    const q = qIn.value.trim().toLowerCase();
    matches = []; mIdx = -1;
    if (!svgEl || !q) { qLbl.textContent = "0/0"; return; }
    svgEl.querySelectorAll("text").forEach((t) => {
      if ((t.textContent || "").toLowerCase().includes(q)) matches.push(t);
    });
    if (matches.length) { mIdx = 0; qLbl.textContent = `1/${matches.length}`; focusEl(matches[0], 0.9); }
    else qLbl.textContent = "0/0";
  }

  function jump(step) {
    if (!matches.length) return;
    mIdx = (mIdx + step + matches.length) % matches.length;
    qLbl.textContent = `${mIdx + 1}/${matches.length}`;
    focusEl(matches[mIdx], 0.9);
  }

  if (flowBtn) {
    flowBtn.onclick = () => setFlowOpen(flowPanelEl.classList.contains("hide"));
  }
  document.getElementById("modBtn").onclick = (e) => {
    mods.classList.toggle("hide");
    e.currentTarget.classList.toggle("on", !mods.classList.contains("hide"));
  };
  document.getElementById("fitH").onclick = fitH;
  document.getElementById("fitAll").onclick = fitAll;
  document.getElementById("z100").onclick = () => zoomBy(1.0 / currentScale());
  document.getElementById("zIn").onclick = () => zoomBy(1.3);
  document.getElementById("zOut").onclick = () => zoomBy(1 / 1.3);
  document.getElementById("prev").onclick = () => jump(-1);
  document.getElementById("next").onclick = () => jump(1);
  document.getElementById("lodBtn").onclick = (e) => {
    useLod = !useLod;
    e.currentTarget.classList.toggle("on", useLod);
    apply();
  };
  document.getElementById("colBtn").onclick = (e) => {
    if (!svgEl) return;
    allCollapsed = !allCollapsed;
    e.currentTarget.classList.toggle("on", allCollapsed);
    svgEl.querySelectorAll("g.ctr").forEach((c) => {
      const hasParentCtr = c.parentElement && c.parentElement.closest("g.ctr");
      if (hasParentCtr) c.classList.toggle("collapsed", allCollapsed);
    });
  };
  document.getElementById("diagBtn").onclick = (e) => {
    showDiag = !showDiag;
    e.currentTarget.classList.toggle("on", showDiag);
    if (svgEl) svgEl.classList.toggle("no-diag", !showDiag);
  };
  document.getElementById("listBtn").onclick = () => side.classList.toggle("hide");
  qIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (matches.length && qIn.dataset.last === qIn.value) jump(e.shiftKey ? -1 : 1);
      else { qIn.dataset.last = qIn.value; search(); }
    }
  });

  window.addEventListener("keydown", (e) => {
    if (!flowPanel || flowPanelEl.classList.contains("hide")) return;
    if (document.activeElement === qIn) return;
    if (e.key === "ArrowLeft") flowPanel.prev();
    if (e.key === "ArrowRight") flowPanel.next();
  });

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "svg") mount(e.data.text);
    if (e.data && e.data.type === "trace") loadTrace(e.data.trace, true);
  });
  vscode.postMessage({ type: "ready" });
})();
