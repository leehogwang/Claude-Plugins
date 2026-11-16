(() => {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  class FlowPanel {
    constructor(mountEl, options = {}) {
      this.mountEl = mountEl;
      this.onStepChange = typeof options.onStepChange === 'function' ? options.onStepChange : null;
      this.onClose = typeof options.onClose === 'function' ? options.onClose : null;
      this.traceData = null;
      this.curStep = 0;
      this.autoFocus = true;
      this.dimOthers = true;

      this._buildDOM();
      this._bindEvents();
    }

    _buildDOM() {
      this.mountEl.innerHTML = `
        <div class="flow-hdr">
          <span class="flow-title">Execution Flow</span>
          <span class="flow-phase-badge" data-role="phase-badge">-</span>
          <button type="button" class="flow-icon-btn" data-role="btn-close" title="Close Flow Panel">&times;</button>
        </div>

        <div class="flow-controls">
          <div class="flow-btn-row">
            <button type="button" data-role="btn-first" title="First step">&lt;&lt;</button>
            <button type="button" data-role="btn-prev" title="Previous step (Left Arrow)">&lt; Prev</button>
            <button type="button" data-role="btn-next" title="Next step (Right Arrow)">Next &gt;</button>
            <button type="button" data-role="btn-last" title="Last step">&gt;&gt;</button>
            <span class="flow-step-lbl" data-role="step-counter">0 / 0</span>
          </div>
          <input type="range" class="flow-slider" data-role="step-slider" min="0" max="0" value="0" />
          <div class="flow-toggles">
            <label><input type="checkbox" data-role="chk-autofocus" checked /> Auto-focus node</label>
            <label><input type="checkbox" data-role="chk-dim" checked /> Dim inactive</label>
          </div>
        </div>

        <div class="flow-section">
          <div class="flow-sec-hdr">
            <span>Source Code</span>
            <span class="flow-legend">
              <span style="color:#4ade80;">&#8594; prev</span>
              <span style="color:#f87171;">&#8594; next</span>
            </span>
          </div>
          <div class="flow-code-box" data-role="code-box">
            <div class="flow-empty">No source code in trace.</div>
          </div>
        </div>

        <div class="flow-section flow-inspector-sec">
          <div class="flow-sec-hdr">
            <span>Step Inspector (Tensors &amp; Diagnostics)</span>
          </div>
          <div class="flow-inspector" data-role="inspector">
            <div class="flow-empty">Select a step to inspect tensors &amp; bottlenecks.</div>
          </div>
        </div>
      `;

      const q = (r) => this.mountEl.querySelector(`[data-role="${r}"]`);
      this.elPhaseBadge = q('phase-badge');
      this.elBtnClose = q('btn-close');
      this.elBtnFirst = q('btn-first');
      this.elBtnPrev = q('btn-prev');
      this.elBtnNext = q('btn-next');
      this.elBtnLast = q('btn-last');
      this.elCounter = q('step-counter');
      this.elSlider = q('step-slider');
      this.elChkAutoFocus = q('chk-autofocus');
      this.elChkDim = q('chk-dim');
      this.elCodeBox = q('code-box');
      this.elInspector = q('inspector');
    }

    _bindEvents() {
      this.elBtnFirst.addEventListener('click', () => this.first());
      this.elBtnPrev.addEventListener('click', () => this.prev());
      this.elBtnNext.addEventListener('click', () => this.next());
      this.elBtnLast.addEventListener('click', () => this.last());
      this.elSlider.addEventListener('input', () => this.setStep(Number(this.elSlider.value)));
      this.elChkAutoFocus.addEventListener('change', () => {
        this.autoFocus = this.elChkAutoFocus.checked;
        this._emitStep();
      });
      this.elChkDim.addEventListener('change', () => {
        this.dimOthers = this.elChkDim.checked;
        this._emitStep();
      });
      this.elBtnClose.addEventListener('click', () => {
        if (this.onClose) this.onClose();
      });
    }

    setTrace(traceData, startStep = 0) {
      this.traceData = traceData;
      const steps = (traceData && Array.isArray(traceData.steps)) ? traceData.steps : [];
      this.curStep = steps.length > 0 ? Math.max(0, Math.min(steps.length - 1, startStep)) : 0;
      this.render();
    }

    setStep(idx) {
      if (!this.traceData || !Array.isArray(this.traceData.steps) || this.traceData.steps.length === 0) return;
      this.curStep = Math.max(0, Math.min(this.traceData.steps.length - 1, idx));
      this.render();
    }

    first() { this.setStep(0); }
    prev() { this.setStep(this.curStep - 1); }
    next() { this.setStep(this.curStep + 1); }
    last() {
      if (!this.traceData || !this.traceData.steps) return;
      this.setStep(this.traceData.steps.length - 1);
    }

    jumpToNode(nodeIdOrTitle) {
      if (!this.traceData || !Array.isArray(this.traceData.steps)) return false;
      const q = String(nodeIdOrTitle || '').toLowerCase();
      if (!q) return false;
      const idx = this.traceData.steps.findIndex((s) => {
        const nid = String(s.node_id || '').toLowerCase();
        const mod = String(s.module || '').toLowerCase();
        const lbl = String(s.label || '').toLowerCase();
        return nid === q || mod === q || lbl.includes(q) || q.includes(lbl);
      });
      if (idx >= 0) {
        this.setStep(idx);
        return true;
      }
      return false;
    }

    _emitStep() {
      if (!this.onStepChange || !this.traceData || !this.traceData.steps) return;
      const step = this.traceData.steps[this.curStep];
      if (!step) return;
      this.onStepChange(this.curStep, step, {
        autoFocus: this.autoFocus,
        dimOthers: this.dimOthers,
        steps: this.traceData.steps,
      });
    }

    _renderCode(step, prevStep) {
      const src = this.traceData && this.traceData.source_code;
      if (!src) {
        this.elCodeBox.innerHTML = '<div class="flow-empty">No source code in trace.</div>';
        return;
      }
      const lines = String(src).split('\n');
      const curLine = Number(step.line || 0);
      const prevLine = prevStep ? Number(prevStep.line || 0) : 0;

      const frag = document.createDocumentFragment();
      let activeRow = null;
      lines.forEach((text, i) => {
        const ln = i + 1;
        const isNext = curLine === ln;
        const isPrev = prevLine === ln && !isNext;
        const row = document.createElement('div');
        row.className = 'flow-code-row' + (isNext ? ' active-next' : isPrev ? ' active-prev' : '');
        const arrow = isNext
          ? '<span class="flow-arr-next">&#8594;</span>'
          : isPrev
            ? '<span class="flow-arr-prev">&#8594;</span>'
            : '';
        row.innerHTML = `<span class="flow-gutter">${arrow}</span><span class="flow-ln">${ln}</span><span class="flow-txt">${escapeHtml(text || ' ')}</span>`;
        if (isNext) activeRow = row;
        frag.appendChild(row);
      });
      this.elCodeBox.innerHTML = '';
      this.elCodeBox.appendChild(frag);
      if (activeRow) {
        activeRow.scrollIntoView({ block: 'nearest' });
      }
    }

    _renderTensorTable(title, tensors) {
      if (!Array.isArray(tensors) || tensors.length === 0) return '';
      const rows = tensors.map((t) => {
        const shape = Array.isArray(t.shape) ? `[${t.shape.join(', ')}]` : String(t.shape || '-');
        const stats = [];
        if (t.dtype) stats.push(escapeHtml(t.dtype));
        if (t.requires_grad !== undefined) stats.push(t.requires_grad ? 'grad' : 'frozen');
        if (t.min !== undefined && t.max !== undefined) stats.push(`min=${t.min} max=${t.max}`);
        if (t.mean !== undefined && t.std !== undefined) stats.push(`mean=${t.mean} std=${t.std}`);
        if (t.nan_count) stats.push(`<span class="flow-warn">NaN:${t.nan_count}</span>`);
        if (t.inf_count) stats.push(`<span class="flow-warn">Inf:${t.inf_count}</span>`);
        return `
          <tr>
            <td class="flow-kv-k">${escapeHtml(t.name || 'tensor')}</td>
            <td class="flow-kv-v"><code>${escapeHtml(shape)}</code><div class="flow-sub">${stats.join(' · ')}</div></td>
          </tr>
        `;
      }).join('');
      return `<div class="flow-sub-title">${escapeHtml(title)}</div><table class="flow-kv-tbl">${rows}</table>`;
    }

    _renderDiagnostics(step) {
      const parts = [];
      parts.push(`<div class="flow-node-title">${escapeHtml(step.label || step.node_id || 'Step')}</div>`);
      if (step.module || step.op) {
        parts.push(`<div class="flow-node-meta">${escapeHtml([step.module, step.op].filter(Boolean).join(' · '))}</div>`);
      }
      if (step.params !== undefined || step.trainable_params !== undefined) {
        parts.push(`<div class="flow-node-meta">Params: ${escapeHtml(String(step.params ?? '-'))} (trainable: ${escapeHtml(String(step.trainable_params ?? '-'))})</div>`);
      }

      parts.push(this._renderTensorTable('Inputs', step.inputs));
      parts.push(this._renderTensorTable('Outputs', step.outputs));

      if (step.diagnostics && typeof step.diagnostics === 'object') {
        const entries = Object.entries(step.diagnostics);
        if (entries.length > 0) {
          const rows = entries.map(([k, v]) => `
            <tr>
              <td class="flow-kv-k">${escapeHtml(k)}</td>
              <td class="flow-kv-v">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td>
            </tr>
          `).join('');
          parts.push(`<div class="flow-sub-title">5-Pass Diagnostics</div><table class="flow-kv-tbl">${rows}</table>`);
        }
      }

      if (Array.isArray(step.issues) && step.issues.length > 0) {
        const items = step.issues.map((iss) => {
          const sev = String(iss.severity || 'warn').toLowerCase();
          return `<div class="flow-issue ${sev === 'breaks' || sev === 'error' ? 'brk' : ''}"><strong>${escapeHtml(iss.title || iss.kind || 'Issue')}</strong><div>${escapeHtml(iss.detail || iss.message || '')}</div></div>`;
        }).join('');
        parts.push(`<div class="flow-sub-title">Bottleneck Warnings</div>${items}`);
      }

      this.elInspector.innerHTML = parts.join('');
    }

    render() {
      const steps = (this.traceData && Array.isArray(this.traceData.steps)) ? this.traceData.steps : [];
      if (steps.length === 0) {
        this.elCounter.textContent = '0 / 0';
        this.elSlider.max = 0;
        this.elSlider.value = 0;
        this.elBtnFirst.disabled = true;
        this.elBtnPrev.disabled = true;
        this.elBtnNext.disabled = true;
        this.elBtnLast.disabled = true;
        this.elPhaseBadge.textContent = '-';
        return;
      }

      const step = steps[this.curStep];
      const prevStep = this.curStep > 0 ? steps[this.curStep - 1] : null;

      this.elCounter.textContent = `${this.curStep + 1} / ${steps.length}`;
      this.elSlider.max = Math.max(0, steps.length - 1);
      this.elSlider.value = this.curStep;
      this.elBtnFirst.disabled = this.curStep === 0;
      this.elBtnPrev.disabled = this.curStep === 0;
      this.elBtnNext.disabled = this.curStep >= steps.length - 1;
      this.elBtnLast.disabled = this.curStep >= steps.length - 1;

      const phase = step.phase || 'forward';
      this.elPhaseBadge.textContent = phase;
      this.elPhaseBadge.dataset.phase = phase;

      this._renderCode(step, prevStep);
      this._renderDiagnostics(step);
      this._emitStep();
    }
  }

  window.SvgLensFlowPanel = FlowPanel;
})();
