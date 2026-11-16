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
  const mm = document.getElementById("mm");
  const mmBox = document.getElementById("mmBox");
  const mmRect = document.getElementById("mmRect");
  const tipEl = document.getElementById("tip");

  let svgEl = null, svgW = 1000, svgH = 1000;
  let vx = 0, vy = 0, vw = 1000, vh = 1000;
  let drag = false, sx = 0, sy = 0, svx = 0, svy = 0;
  let mmDrag = false, showDiag = true, useLod = true, allCollapsed = false;
  let matches = [], mIdx = -1, hlTimer = null;
  let macroNodes = [];
  let nnTips = { chips: {}, ops: {} };
  let wasm = null;

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

  const OP_TIPS = {
    gt: "원소별 > 비교로 불리언 마스크 생성",
    lt: "원소별 < 비교로 불리언 마스크 생성",
    ge: "원소별 >= 비교로 불리언 마스크 생성",
    le: "원소별 <= 비교로 불리언 마스크 생성",
    eq: "원소별 == 비교로 불리언 마스크 생성",
    ne: "원소별 != 비교로 불리언 마스크 생성",
    any: "조건이 하나라도 True인지 검사 (스칼라 bool 반환)",
    all: "모든 원소가 True인지 검사 (스칼라 bool 반환)",
    getitem: "인덱싱·슬라이싱 또는 None(축 추가)으로 텐서 형태 조정",
    unsqueeze: "크기 1인 새 차원을 추가 (브로드캐스팅·차원 맞춤)",
    squeeze: "크기 1인 차원을 제거",
    view: "원소 순서를 유지한 채 텐서 shape 재해석",
    reshape: "텐서 shape 변경 (필요 시 복사)",
    permute: "텐서 차원(축) 순서 재배열",
    transpose: "두 차원의 위치를 서로 교환",
    contiguous: "메모리 배치를 연속적으로 정렬",
    expand: "크기 1인 축을 메모리 복사 없이 목표 크기로 확장",
    repeat: "지정 배수만큼 텐서 데이터를 실제로 복제 확장",
    flatten: "지정 범위 차원을 1차원으로 펼침",
    cat: "여러 텐서를 지정 축(dim) 기준으로 이어 붙임",
    stack: "새 축을 추가해 여러 텐서를 쌓음",
    chunk: "텐서를 지정 개수로 균등 분할",
    split: "텐서를 지정 크기/개수로 분할",
    where: "조건 마스크에 따라 두 텐서 값 중 하나를 선택",
    masked_fill: "마스크가 True인 위치의 값을 지정 상수로 치환",
    clamp: "텐서 값을 지정 [min, max] 범위로 제한",
    sum: "지정 축 또는 전체 원소의 합 계산",
    mean: "지정 축 또는 전체 원소의 평균 계산",
    amax: "지정 축 기준 최댓값 추출",
    amin: "지정 축 기준 최솟값 추출",
    argmax: "가장 큰 값의 인덱스 반환",
    softmax: "로짓을 합이 1인 확률 분포로 정규화",
    sigmoid: "값을 (0, 1) 범위 확률/게이트로 변환",
    tanh: "값을 (-1, 1) 범위로 비선형 압축",
    silu: "SiLU/Swish 활성화 (x · sigmoid(x))",
    gelu: "GELU 활성화 함수 (Transformer 표준)",
    relu: "ReLU 활성화 (음수 0으로 클리핑)",
    matmul: "행렬 곱셈 수행",
    bmm: "배치 단위 행렬 곱셈 수행",
    einsum: "아인슈타인 표기법 기반 텐서 축약/곱",
    add: "원소별 덧셈 (잔차 연결 또는 바이어스 합)",
    sub: "원소별 뺄셈",
    mul: "원소별 곱셈 (게이팅·스케일링)",
    div: "원소별 나눗셈 (정규화·스케일링)",
    sqrt: "원소별 제곱근 계산",
    rsqrt: "원소별 역제곱근 (1 / sqrt(x)) 계산",
    exp: "원소별 지수 함수 e^x 계산",
    log: "원소별 자연로그 계산",
    linear: "선형 변환 (y = xW^T + b)",
    conv2d: "2D 합성곱 특징 추출",
    batchnorm2d: "배치 정규화 (채널별 평균·분산 정규화)",
    layernorm: "레이어 정규화 (마지막 차원 기준 정규화)",
    dropout: "학습 시 과적합 방지를 위해 일부 뉴런 무작위 비활성화",
    embedding: "정수 인덱스를 고정 차원 임베딩 벡터로 매핑",
    multiheadattention: "멀티헤드 어텐션 (Q·K^T 스케일 내적 후 V 가중합)",
  };

  function parseNnTips() {
    nnTips = { chips: {}, ops: {} };
    if (!svgEl) return;
    const meta = svgEl.querySelector("metadata#nn-tips");
    if (meta && meta.textContent) {
      try {
        const parsed = JSON.parse(meta.textContent.trim());
        if (parsed && typeof parsed === "object") {
          nnTips.chips = parsed.chips || {};
          nnTips.ops = parsed.ops || {};
        }
      } catch (_) {}
    }
    svgEl.querySelectorAll("g.chip, g.ctr").forEach((el) => {
      const t = el.querySelector(":scope > title");
      if (t && t.textContent) {
        if (!el.getAttribute("data-tip")) el.setAttribute("data-tip", t.textContent.trim());
        t.remove();
      }
    });
  }

  function resolveTip(el) {
    const label = Array.from(el.querySelectorAll(":scope > text"))
      .map((t) => (t.textContent || "").trim())
      .filter(Boolean)
      .join(" ");
    const id = el.getAttribute("id") || "";
    const metaHit = (id && nnTips.chips[id]) || (label && nnTips.chips[label]);
    const attrTip = el.getAttribute("data-tip");
    const attrCode = el.getAttribute("data-code");
    const attrIo = el.getAttribute("data-io");

    if (metaHit && typeof metaHit === "object") {
      return {
        title: label || id,
        desc: metaHit.meaning || metaHit.desc || "",
        code: metaHit.code || attrCode || "",
        io: metaHit.io || attrIo || "",
      };
    }
    if (typeof metaHit === "string") {
      return { title: label || id, desc: metaHit, code: attrCode || "", io: attrIo || "" };
    }
    if (attrTip) {
      return { title: label || id, desc: attrTip, code: attrCode || "", io: attrIo || "" };
    }

    if (!label) return null;
    const shapeMatch = label.match(/\(([^()]+)\)\s*$/);
    const shapeInfo = shapeMatch ? shapeMatch[1] : "";
    const rawHead = label.replace(/\s*\([^()]+\)\s*$/, "").trim();
    const opToken = rawHead.replace(/^[\[\]f\s]+/, "").split(/[\[\s.(]/)[0].toLowerCase();

    let desc = nnTips.ops[opToken] || OP_TIPS[opToken] || "";
    if (opToken === "getitem" && rawHead.includes("None")) {
      desc = "None 위치에 크기 1인 축을 추가 (unsqueeze / 브로드캐스팅 준비)";
    }
    if (!desc) return null;

    const parentCtr = el.parentElement && el.parentElement.closest("g.ctr");
    const ctrHdr = parentCtr && parentCtr.querySelector(":scope > .hdr text");
    const ctrTitle = ctrHdr ? (ctrHdr.textContent || "").trim() : "";

    return {
      title: label,
      desc,
      code: "",
      io: [shapeInfo ? `shape: ${shapeInfo}` : "", ctrTitle ? `블록: ${ctrTitle}` : ""].filter(Boolean).join(" · "),
    };
  }

  function showTip(e, info) {
    if (!info || !tipEl) return;
    tipEl.innerHTML = "";
    const hd = document.createElement("div");
    hd.className = "tip-hd";
    hd.textContent = info.title;
    tipEl.appendChild(hd);

    if (info.desc) {
      const d = document.createElement("div");
      d.className = "tip-desc";
      d.textContent = info.desc;
      tipEl.appendChild(d);
    }
    if (info.code) {
      const c = document.createElement("div");
      c.className = "tip-code";
      c.textContent = info.code;
      tipEl.appendChild(c);
    }
    if (info.io) {
      const io = document.createElement("div");
      io.className = "tip-io";
      io.textContent = info.io;
      tipEl.appendChild(io);
    }

    tipEl.classList.remove("hide");
    const pad = 14;
    const tw = tipEl.offsetWidth || 240;
    const th = tipEl.offsetHeight || 60;
    const left = Math.min(window.innerWidth - tw - 10, e.clientX + pad);
    const top = Math.min(window.innerHeight - th - 10, e.clientY + pad);
    tipEl.style.left = `${Math.max(8, left)}px`;
    tipEl.style.top = `${Math.max(46, top)}px`;
  }

  function hideTip() {
    if (tipEl) tipEl.classList.add("hide");
  }

  function mount(svgText) {
    if (!svgText || !svgText.includes("<svg")) return;
    hideTip();
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
    parseNnTips();
    buildModulesAndCollapse();
    buildIssues();
    matches = []; mIdx = -1; qLbl.textContent = "0/0";
    fitH();
  }

  vp.addEventListener("wheel", (e) => {
    e.preventDefault();
    hideTip();
    const r = vp.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  vp.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    hideTip();
    drag = true; vp.classList.add("drag");
    sx = e.clientX; sy = e.clientY; svx = vx; svy = vy;
  });
  vp.addEventListener("mouseleave", hideTip);
  window.addEventListener("mousemove", (e) => {
    if (drag) {
      const sc = currentScale();
      vx = svx - (e.clientX - sx) / sc;
      vy = svy - (e.clientY - sy) / sc;
      apply();
      return;
    }
    if (mmDrag) { mmJump(e); return; }
    if (svgEl && e.target && e.target.closest) {
      const chip = e.target.closest("g.chip");
      if (chip) {
        const info = resolveTip(chip);
        if (info) { showTip(e, info); return; }
      }
    }
    hideTip();
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

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "svg") mount(e.data.text);
  });
  vscode.postMessage({ type: "ready" });
})();
