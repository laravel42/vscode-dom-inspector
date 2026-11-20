(function() {
  const vscode = acquireVsCodeApi();
  const MAX_CHILDREN = 500;

  const $ = (id) => document.getElementById(id) || document.createElement('div');
  const emptyEl = $("empty");
  const contentEl = $("content");

  /* ---- DevTools tab switching (the chosen tab survives the view being re-created) ---- */
  function activateTab(panelId) {
    const tab = document.querySelector('.dt-tab[data-tab="' + panelId + '"]');
    if (!tab) return;
    document.querySelectorAll(".dt-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".dt-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    const panel = $(panelId);
    if (panel) panel.classList.add("active");
  }
  document.querySelectorAll(".dt-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      activateTab(tab.dataset.tab);
      vscode.setState(Object.assign({}, vscode.getState() || {}, { tab: tab.dataset.tab }));
    });
  });
  const savedState = vscode.getState() || {};
  if (savedState.tab) activateTab(savedState.tab);

  /* ---- Inspect button in tab bar ---- */
  // The extension owns the state (inspect_state): picking can also start from the
  // command or the panel toolbar, and ends on a pick, Escape, the right-click
  // menu or a page reload. A click flips the button at once and the extension
  // then confirms or corrects it.
  const dtInspect = $("dt-inspect");
  const INSPECT_TITLE = dtInspect.title;
  function setInspectActive(on) {
    dtInspect.classList.toggle("active", !!on);
    dtInspect.setAttribute("aria-pressed", on ? "true" : "false");
    dtInspect.title = on ? "Stop inspecting (Esc)" : INSPECT_TITLE;
  }
  dtInspect.addEventListener("click", () => {
    const on = !dtInspect.classList.contains("active");
    setInspectActive(on);
    vscode.postMessage({ type: on ? "start_inspect" : "stop_inspect" });
  });

  /* ---- State ---- */
  let treeData = {};
  let highlightedSel = null;
  let fullTreeLoaded = false;

  /* ---- Helpers ---- */
  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  function nodeLabel(tag, id, classNames, extra) {
    let h = '<span class="t-tag">' + esc(tag) + '</span>';
    if (id) h += '<span class="t-id">#' + esc(id) + '</span>';
    if (classNames && classNames.length) {
      h += classNames.map(c => '<span class="t-class">.' + esc(c) + '</span>').join("");
    }
    if (extra) h += ' ' + extra;
    return h;
  }

  /* ---- Element panel ---- */

  function showContent() {
    emptyEl.style.display = "none";
    contentEl.style.display = "block";
  }

  /* ---- Active Styles Tab ---- */
  let currentActiveStyles = [];
  let currentElementSelector = '';

  /* ---- CSS Property Metadata Registry ---- */
  var CSS_UNITS = ['px','rem','em','%','vh','vw','vmin','vmax','ch','ex','cm','mm','in','pt','pc'];
  var KEYWORD_PROPS = {
    display:['block','inline','inline-block','flex','grid','inline-flex','inline-grid','table','inline-table','table-row','table-cell','table-column','table-column-group','table-row-group','table-header-group','table-footer-group','list-item','contents','none'],
    position:['static','relative','absolute','fixed','sticky'],
    visibility:['visible','hidden','collapse'],
    overflow:['visible','hidden','scroll','auto','clip'],
    'overflow-x':['visible','hidden','scroll','auto','clip'],
    'overflow-y':['visible','hidden','scroll','auto','clip'],
    'float':['left','right','none','inline-start','inline-end'],
    clear:['none','left','right','both','inline-start','inline-end'],
    'box-sizing':['content-box','border-box'],
    direction:['ltr','rtl'],
    'unicode-bidi':['normal','embed','bidi-override','isolate','isolate-override','plaintext'],
    'white-space':['normal','nowrap','pre','pre-wrap','pre-line','break-spaces'],
    'word-break':['normal','break-all','keep-all','break-word'],
    'overflow-wrap':['normal','break-word','anywhere'],
    'text-align':['left','right','center','justify','start','end','match-parent'],
    'text-transform':['none','capitalize','uppercase','lowercase','full-width','full-size-kana'],
    'text-decoration-style':['solid','double','dotted','dashed','wavy'],
    'text-decoration-line':['none','underline','overline','line-through'],
    'text-rendering':['auto','optimizeSpeed','optimizeLegibility','geometricPrecision'],
    'font-style':['normal','italic','oblique'],
    'font-variant':['normal','small-caps'],
    'font-stretch':['ultra-condensed','extra-condensed','condensed','semi-condensed','normal','semi-expanded','expanded','extra-expanded','ultra-expanded'],
    'font-weight':['normal','bold','bolder','lighter'],
    'list-style-type':['disc','circle','square','decimal','decimal-leading-zero','lower-roman','upper-roman','lower-alpha','upper-alpha','none'],
    'list-style-position':['inside','outside'],
    'object-fit':['fill','contain','cover','none','scale-down'],
    'object-position':['left','center','right','top','bottom'],
    'background-repeat':['repeat','repeat-x','repeat-y','no-repeat','space','round'],
    'background-size':['auto','cover','contain'],
    'background-attachment':['scroll','fixed','local'],
    'background-clip':['border-box','padding-box','content-box','text'],
    'background-origin':['border-box','padding-box','content-box'],
    cursor:['auto','default','none','context-menu','help','pointer','progress','wait','cell','crosshair','text','vertical-text','alias','copy','move','no-drop','not-allowed','grab','grabbing','zoom-in','zoom-out'],
    'pointer-events':['auto','none'],
    'user-select':['auto','text','none','contain','all'],
    resize:['none','both','horizontal','vertical','block','inline'],
    'flex-direction':['row','row-reverse','column','column-reverse'],
    'flex-wrap':['nowrap','wrap','wrap-reverse'],
    'justify-content':['flex-start','flex-end','center','space-between','space-around','space-evenly','start','end','left','right'],
    'align-items':['stretch','flex-start','flex-end','center','baseline','start','end'],
    'align-self':['auto','stretch','flex-start','flex-end','center','baseline','start','end'],
    'align-content':['stretch','flex-start','flex-end','center','space-between','space-around','space-evenly'],
    'grid-auto-flow':['row','column','dense','row dense','column dense'],
    'table-layout':['auto','fixed'],
    'border-style':['none','hidden','dotted','dashed','solid','double','groove','ridge','inset','outset'],
    'outline-style':['none','auto','dotted','dashed','solid','double','groove','ridge','inset','outset'],
    'animation-direction':['normal','reverse','alternate','alternate-reverse'],
    'animation-fill-mode':['none','forwards','backwards','both'],
    'animation-play-state':['running','paused'],
    'transition-property':['none','all'],
  };
  var SIZE_PROPS = ['width','height','min-width','max-width','min-height','max-height','margin','margin-top','margin-right','margin-bottom','margin-left','padding','padding-top','padding-right','padding-bottom','padding-left','top','right','bottom','left','font-size','border-width','border-radius','gap','row-gap','column-gap'];
  var COLOR_PROPS = ['color','background-color','border-color','border-top-color','border-right-color','border-bottom-color','border-left-color','outline-color','text-decoration-color','fill','stroke','caret-color','accent-color','column-rule-color'];

  var ALL_CSS_PROPS = (function(){
    var s = getComputedStyle(document.documentElement);
    var set = {};
    for (var i = 0; i < s.length; i++) { var p = s[i]; if (p.charAt(0) !== '-') set[p] = 1; }
    return Object.keys(set).sort();
  })();

  var acPopup = null, acItems = [], acIdx = -1, acTarget = null;
  function acShow(inp) {
    var q = inp.value.toLowerCase();
    var matches = q ? ALL_CSS_PROPS.filter(function(p){return p.indexOf(q) !== -1;}).slice(0,20) : ALL_CSS_PROPS.slice(0,20);
    if (!matches.length) { acHide(); return; }
    if (!acPopup) { acPopup = document.createElement('div'); acPopup.className = 'ac-popup'; document.body.appendChild(acPopup); }
    acItems = matches; acIdx = 0; acTarget = inp;
    var h = ''; matches.forEach(function(m,i){ h += '<div class="ac-item' + (i===0?' active':'') + '" data-i="'+i+'">' + m + '</div>'; });
    acPopup.innerHTML = h;
    var r = inp.getBoundingClientRect();
    acPopup.style.left = r.left + 'px'; acPopup.style.top = (r.bottom+1) + 'px'; acPopup.style.minWidth = r.width + 'px'; acPopup.style.display = 'block';
    acPopup.querySelectorAll('.ac-item').forEach(function(el){
      el.addEventListener('mousedown', function(e){ e.preventDefault(); acPick(+el.dataset.i); });
    });
  }
  function acHide() { if(acPopup) acPopup.style.display='none'; acIdx=-1; acTarget=null; }
  function acPick(i) { if(!acTarget||!acItems[i]) return; acTarget.value=acItems[i]; acHide(); var next=acTarget.closest('.as-add-row').querySelector('.as-add-val'); if(next) next.focus(); }
  function acMove(d) { if(!acItems.length) return; acIdx=Math.max(0,Math.min(acItems.length-1,acIdx+d)); acPopup.querySelectorAll('.ac-item').forEach(function(el,i){ el.classList.toggle('active',i===acIdx); }); var act=acPopup.querySelector('.active'); if(act) act.scrollIntoView({block:'nearest'}); }
  document.addEventListener('click', function(e){ if(acPopup && !acPopup.contains(e.target)) acHide(); });

  function getEditorType(prop) {
    if (COLOR_PROPS.indexOf(prop) !== -1) return 'color';
    if (KEYWORD_PROPS[prop]) return 'keyword';
    if (SIZE_PROPS.indexOf(prop) !== -1) return 'size';
    return 'autocomplete';
  }

  function rgbToHex(rgb) {
    if (!rgb || rgb === 'transparent' || rgb === 'none') return '#000000';
    // Already hex
    if (rgb.charAt(0) === '#') {
      // Expand shorthand #rgb to #rrggbb
      if (rgb.length === 4) return '#' + rgb[1]+rgb[1]+rgb[2]+rgb[2]+rgb[3]+rgb[3];
      return rgb.slice(0, 7);
    }
    // Try comma-separated: rgb(r, g, b) or rgba(r, g, b, a)
    var m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    // Try space-separated: rgb(r g b) or rgb(r g b / a)
    if (!m) m = rgb.match(/rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)/);
    if (m) return '#' + ((1<<24)+(+m[1]<<16)+(+m[2]<<8)+ +m[3]).toString(16).slice(1);
    // Use a canvas to resolve named colors and other formats
    try {
      var ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = rgb;
      var resolved = ctx.fillStyle; // Returns #rrggbb or #rrggbbaa
      if (resolved.charAt(0) === '#') return resolved.slice(0, 7);
    } catch(e) {}
    return '#000000';
  }

  function emitStyle(prop, val) {
    vscode.postMessage({ type: 'set_style', selector: currentElementSelector, property: prop, value: val });
  }

  function renderActiveStyles(rules) {
    currentActiveStyles = rules || [];
    var el = $("active-styles");
    if (!el) return;
    if (!currentActiveStyles.length) { el.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:var(--fs-small)">No active styles</div>'; return; }
    var h = '';
    currentActiveStyles.forEach(function(rule, ri) {
      h += '<div class="as-rule">';
      h += '<div class="as-selector">' + esc(rule.selector) + ' {</div>';
      rule.properties.forEach(function(p, pi) {
        var key = ri + '-' + pi;
        var dis = p.enabled ? '' : ' disabled';
        h += '<div class="as-row' + dis + '" data-ri="' + ri + '" data-pi="' + pi + '">';
        h += '<input type="checkbox" class="as-cb" data-key="' + key + '"' + (p.enabled ? ' checked' : '') + ' />';
        h += '<span class="as-prop">' + esc(p.property) + ':</span>';
        h += '<div class="as-val-wrap">' + buildEditor(p, key) + '</div>';
        h += '</div>';
      });
      // Add property row inside rule
      h += '<div class="as-add-row" data-ri="' + ri + '">';
      h += '<input type="text" class="as-add-input as-add-prop" placeholder="property" data-ri="' + ri + '" />';
      h += '<input type="text" class="as-add-input as-add-val" placeholder="value" data-ri="' + ri + '" />';
      h += '</div>';
      h += '<div class="as-selector">}</div>';
      h += '</div>';
    });
    el.innerHTML = h;
    wireActiveStyleEvents(el);
  }

  function buildEditor(p, key) {
    var type = getEditorType(p.property);
    var h = '';
    if (type === 'color') {
      h += '<input type="color" class="as-color-input" data-key="' + key + '" value="' + esc(rgbToHex(p.value)) + '" />';
      h += '<input type="text" class="as-text as-text-color" data-key="' + key + '" value="' + esc(p.value) + '" />';
    } else if (type === 'keyword') {
      var vals = KEYWORD_PROPS[p.property];
      h += '<select class="as-select" data-key="' + key + '">';
      var found = false;
      vals.forEach(function(v) { var sel = v === p.value ? ' selected' : ''; if (v === p.value) found = true; h += '<option value="' + esc(v) + '"' + sel + '>' + esc(v) + '</option>'; });
      if (!found) h += '<option value="' + esc(p.value) + '" selected>' + esc(p.value) + '</option>';
      h += '</select>';
    } else if (type === 'size') {
      h += '<input type="text" class="as-text" data-key="' + key + '" value="' + esc(p.value) + '" />';
    } else {
      h += '<input type="text" class="as-text" data-key="' + key + '" value="' + esc(p.value) + '" />';
    }
    return h;
  }

  function getProp(key) {
    var parts = key.split('-'); var ri = +parts[0], pi = +parts[1];
    var rule = currentActiveStyles[ri]; if (!rule) return null;
    return rule.properties[pi] || null;
  }

  function wireActiveStyleEvents(el) {
    el.querySelectorAll('.as-cb').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var p = getProp(cb.dataset.key); if (!p) return;
        p.enabled = cb.checked;
        cb.closest('.as-row').classList.toggle('disabled', !cb.checked);
        vscode.postMessage({ type: 'toggle_style', selector: currentElementSelector, property: p.property, enabled: cb.checked });
      });
    });
    el.querySelectorAll('.as-select').forEach(function(sel) {
      sel.addEventListener('change', function() {
        var p = getProp(sel.dataset.key); if (!p) return;
        p.value = sel.value; emitStyle(p.property, sel.value);
      });
    });
    el.querySelectorAll('.as-color-input').forEach(function(ci) {
      ci.addEventListener('input', function() {
        var p = getProp(ci.dataset.key); if (!p) return;
        p.value = ci.value; emitStyle(p.property, ci.value);
        var txt = el.querySelector('.as-text-color[data-key="' + ci.dataset.key + '"]');
        if (txt) txt.value = ci.value;
      });
    });
    el.querySelectorAll('.as-text-color').forEach(function(txt) {
      var commit = function() {
        var p = getProp(txt.dataset.key); if (!p) return;
        p.value = txt.value; emitStyle(p.property, txt.value);
        var ci = el.querySelector('.as-color-input[data-key="' + txt.dataset.key + '"]');
        if (ci) { try { ci.value = rgbToHex(txt.value); } catch(e){} }
      };
      txt.addEventListener('change', commit);
      txt.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); txt.blur(); commit(); } });
    });
    el.querySelectorAll('.as-text:not(.as-text-color)').forEach(function(inp) {
      inp.addEventListener('change', function() {
        var p = getProp(inp.dataset.key); if (!p) return;
        p.value = inp.value; emitStyle(p.property, inp.value);
      });
      inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });
    // Autocomplete for add-property inputs
    el.querySelectorAll('.as-add-prop').forEach(function(inp) {
      inp.addEventListener('input', function(){ acShow(inp); });
      inp.addEventListener('focus', function(){ acShow(inp); });
      inp.addEventListener('blur', function(){ setTimeout(acHide, 150); });
      inp.addEventListener('keydown', function(e) {
        if(acPopup && acPopup.style.display==='block' && acItems.length) {
          if(e.key==='ArrowDown'){ e.preventDefault(); acMove(1); return; }
          if(e.key==='ArrowUp'){ e.preventDefault(); acMove(-1); return; }
          if(e.key==='Enter'||e.key==='Tab'){ if(acIdx>=0){ e.preventDefault(); acPick(acIdx); return; } }
          if(e.key==='Escape'){ acHide(); return; }
        }
      });
    });
    // Add property inside rule
    el.querySelectorAll('.as-add-val').forEach(function(addVal) {
      addVal.addEventListener('keydown', function(e) {
        if (e.key !== 'Enter') return;
        var ri = +addVal.dataset.ri;
        var propInput = el.querySelector('.as-add-prop[data-ri="' + ri + '"]');
        var prop = propInput.value.trim(), val = addVal.value.trim();
        if (!prop || !val) return;
        emitStyle(prop, val);
        var rule = currentActiveStyles[ri];
        if (rule) { rule.properties.push({ property: prop, value: val, enabled: true, editable: true }); }
        renderActiveStyles(currentActiveStyles);
      });
    });
  }

  /* ---- DOM Tree ---- */
  function renderTreeSection(children) {
    treeData = {};
    const container = $("dom-tree");
    container.innerHTML = "";
    renderNodes(container, children, 0);
  }

  function renderNodes(container, children, depth) {
    const limit = Math.min(children.length, MAX_CHILDREN);
    for (let i = 0; i < limit; i++) {
      const child = children[i];
      if (!treeData[child.selectorPath]) {
        treeData[child.selectorPath] = { node: child, children: null, expanded: false };
      }
      container.appendChild(createTreeRow(child, depth));
    }
    if (children.length > MAX_CHILDREN) {
      const more = document.createElement("div");
      more.className = "show-more";
      more.style.setProperty("--depth", depth);
      more.textContent = "\u2026 " + (children.length - MAX_CHILDREN) + " more nodes";
      container.appendChild(more);
    }
  }

  function createTreeRow(child, depth) {
    const row = document.createElement("div");
    row.className = "tree-node";
    row.style.setProperty("--depth", depth);
    row.dataset.selector = child.selectorPath;

    const toggle = document.createElement("span");
    toggle.className = "tree-toggle";
    toggle.textContent = child.childCount > 0 ? "\u25b6" : "";
    row.appendChild(toggle);

    const label = document.createElement("span");
    label.className = "tree-label";
    label.innerHTML = nodeLabel(child.tag, child.id, child.classNames,
      child.childCount > 0 ? '<span class="t-count">(' + child.childCount + ')</span>' : '');
    row.appendChild(label);

    function toggleRow() {
      if (child.childCount === 0) return;
      const entry = treeData[child.selectorPath];
      if (!entry) return;
      if (entry.expanded) {
        collapseNode(row, child.selectorPath);
      } else {
        expandNode(row, child, depth);
      }
    }

    // The arrow only expands/collapses.
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleRow();
    });

    // Clicking the row expands/collapses it and selects the element: the row is
    // marked at once, and the extension inspects it in the page (Styles,
    // Computed) — like picking it.
    row.addEventListener("click", () => {
      toggleRow();
      highlightNode(child.selectorPath);
      vscode.postMessage({ type: "select_node", selector: child.selectorPath });
    });

    return row;
  }

  function setToggleOpen(row, open) {
    const toggle = row.querySelector(".tree-toggle");
    if (toggle) toggle.classList.toggle("open", !!open);
  }

  function expandNode(row, child, depth) {
    const entry = treeData[child.selectorPath];
    if (!entry) return;
    entry.expanded = true;
    setToggleOpen(row, true);

    if (entry.children) {
      const frag = document.createDocumentFragment();
      renderNodes(frag, entry.children, depth + 1);
      row.after(frag);
    } else {
      vscode.postMessage({ type: "request_children", selector: child.selectorPath });
    }
  }

  function collapseNode(row, selectorPath) {
    const entry = treeData[selectorPath];
    if (!entry) return;
    entry.expanded = false;
    setToggleOpen(row, false);
    removeChildRows(row);
  }

  function removeChildRows(parentRow) {
    const parentDepth = parseInt(parentRow.style.getPropertyValue("--depth") || "0", 10);
    let next = parentRow.nextElementSibling;
    while (next) {
      const d = parseInt(next.style.getPropertyValue("--depth") || "0", 10);
      if (d <= parentDepth && !next.classList.contains("show-more")) break;
      const toRemove = next;
      next = next.nextElementSibling;
      toRemove.remove();
    }
  }

  function highlightNode(selectorPath) {
    document.querySelectorAll(".tree-node.highlighted").forEach(n => n.classList.remove("highlighted"));
    highlightedSel = selectorPath;
    const row = document.querySelector('.tree-node[data-selector="' + CSS.escape(selectorPath) + '"]');
    if (row) {
      row.classList.add("highlighted");
      row.scrollIntoView({ block: "nearest" });
    }
  }

  /* ---- Full tree rendering ---- */
  function renderFullTree(tree) {
    if (!tree) return;
    fullTreeLoaded = true;
    emptyEl.style.display = "none";
    contentEl.style.display = "block";

    // Recursively merge entire tree into treeData
    function mergeNode(node) {
      treeData[node.selectorPath] = { node: node, children: node.children.length > 0 ? node.children : null, expanded: false };
      for (var i = 0; i < node.children.length; i++) {
        mergeNode(node.children[i]);
      }
    }
    treeData = {};
    mergeNode(tree);

    // Clear and render — auto-expand first 2 levels (html + head/body)
    var container = $("dom-tree");
    container.innerHTML = "";

    function renderRecursive(node, depth, autoExpandDepth) {
      var row = createTreeRow(node, depth);
      container.appendChild(row);
      var entry = treeData[node.selectorPath];
      if (node.children.length > 0 && depth < autoExpandDepth) {
        entry.expanded = true;
        setToggleOpen(row, true);
        for (var i = 0; i < node.children.length; i++) {
          renderRecursive(node.children[i], depth + 1, autoExpandDepth);
        }
      }
    }
    renderRecursive(tree, 0, 2);
  }

  /* ---- Expand path to node ---- */
  let pendingExpandPath = null;
  let pendingExpandResolve = null;

  function expandPathToNode(selectorPath) {
    if (!selectorPath) return;
    // The cssSelectorPath includes 'html > ...' but tree selectorPaths
    // from buildSelectorPath() exclude the html root.
    // Build the list of tree selectorPaths to expand.
    var parts = selectorPath.split(" > ");
    var segments = [];
    // First segment is 'html' — the root node in our tree
    segments.push(parts[0]); // 'html'
    // Remaining segments use buildSelectorPath format (without html prefix)
    for (var i = 1; i < parts.length; i++) {
      segments.push(parts.slice(1, i + 1).join(" > "));
    }
    expandSegments(segments, 0);
  }

  function expandSegments(segments, idx) {
    if (idx >= segments.length - 1) {
      // All ancestors expanded (the target itself is left as it is): highlight it
      highlightNode(segments[segments.length - 1]);
      return;
    }
    const seg = segments[idx];
    const entry = treeData[seg];
    if (!entry) {
      // Node not in treeData yet, highlight what we can
      highlightNode(segments[segments.length - 1]);
      return;
    }
    if (entry.expanded) {
      // Already expanded, move to next
      expandSegments(segments, idx + 1);
      return;
    }
    // Need to expand this node
    const row = document.querySelector('.tree-node[data-selector="' + CSS.escape(seg) + '"]');
    if (!row) {
      expandSegments(segments, idx + 1);
      return;
    }
    if (entry.children) {
      // Children already loaded, just expand
      entry.expanded = true;
      setToggleOpen(row, true);
      const depth = parseInt(row.style.getPropertyValue("--depth") || "0", 10);
      const frag = document.createDocumentFragment();
      renderNodes(frag, entry.children, depth + 1);
      row.after(frag);
      expandSegments(segments, idx + 1);
    } else if (entry.node.childCount > 0) {
      // Need to request children, set up pending expand
      pendingExpandPath = { segments: segments, nextIdx: idx + 1, parentSelector: seg };
      entry.expanded = true;
      setToggleOpen(row, true);
      vscode.postMessage({ type: "request_children", selector: seg });
    } else {
      expandSegments(segments, idx + 1);
    }
  }

  /* ---- All computed styles rendering ---- */
  let allComputedStylesData = {};
  let nonDefaultStylesData = {};
  let showAllStyles = false;

  const csCategories = [
    { name: 'Typography', props: ['font-family','font-size','font-weight','font-style','line-height','text-align','text-decoration','text-transform','text-indent','letter-spacing','word-spacing'] },
    { name: 'Box Model', props: ['margin','margin-top','margin-right','margin-bottom','margin-left','padding','padding-top','padding-right','padding-bottom','padding-left','border-width','border-style','border-color','border-radius','width','height','min-width','max-width','box-sizing'] },
    { name: 'Layout & Positioning', props: ['display','visibility','position','top','right','bottom','left','z-index','flex-direction','justify-content','align-items','gap','grid-template-columns','float','clear'] },
    { name: 'Colors & Backgrounds', props: ['color','opacity','background-color','background-image','background-repeat','background-size','background-position'] },
    { name: 'Visual Effects', props: ['box-shadow','text-shadow','filter','backdrop-filter','rotate','scale','translate','skew'] },
    { name: 'Transitions & Animations', props: ['transition-property','transition-duration','transition-timing-function','animation-name','animation-duration','animation-iteration-count'] },
    { name: 'Generated Content & Lists', props: ['list-style-type','list-style-image','list-style-position','content','quotes','counter-reset','counter-increment'] },
    { name: 'Specialized', props: ['cursor','outline','appearance','user-select','table-layout','border-collapse','caption-side','empty-cells','column-count','column-gap','column-rule'] },
  ];
  const csCategoryLookup = {};
  csCategories.forEach(function(cat) { cat.props.forEach(function(p) { csCategoryLookup[p] = cat.name; }); });

  function isColorValueFull(v) {
    return v && (v.startsWith('rgb') || v.startsWith('rgba') || v.startsWith('#') || v.startsWith('hsl'));
  }

  function colorSwatchFull(v) {
    if (!isColorValueFull(v)) return '';
    return '<span class="color-swatch" style="background:' + esc(v) + '"></span>';
  }

  function renderStyleRow(k, v) {
    return '<span class="style-key">' + esc(k) + '</span><span class="style-val">' + colorSwatchFull(v) + esc(v) + '</span>';
  }

  function renderCategorizedStyles(styles, filterText) {
    if (!styles) return '';
    var filter = (filterText || '').toLowerCase();
    // Filter out vendor-prefixed and build per-category buckets
    var buckets = {};
    csCategories.forEach(function(cat) { buckets[cat.name] = []; });
    var uncategorized = [];
    var keys = Object.keys(styles).sort();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.charAt(0) === '-') continue;
      var v = styles[k];
      if (filter && !k.toLowerCase().includes(filter) && !v.toLowerCase().includes(filter)) continue;
      var cat = csCategoryLookup[k];
      if (cat) { buckets[cat].push(k); } else { uncategorized.push(k); }
    }
    var html = '';
    csCategories.forEach(function(cat) {
      var items = buckets[cat.name];
      if (!items.length) return;
      var open = filter ? ' open' : '';
      html += '<div class="cs-accordion' + open + '">';
      html += '<div class="cs-accordion-header" onclick="this.parentElement.classList.toggle(&#39;open&#39;)"><span class="cs-accordion-arrow">&#9654;</span>' + esc(cat.name) + ' <span class="cs-accordion-count">(' + items.length + ')</span></div>';
      html += '<div class="cs-accordion-body"><div class="all-styles-grid">';
      for (var j = 0; j < items.length; j++) { html += renderStyleRow(items[j], styles[items[j]]); }
      html += '</div></div></div>';
    });
    if (uncategorized.length) {
      var open = filter ? ' open' : '';
      html += '<div class="cs-accordion' + open + '">';
      html += '<div class="cs-accordion-header" onclick="this.parentElement.classList.toggle(&#39;open&#39;)"><span class="cs-accordion-arrow">&#9654;</span>Other <span class="cs-accordion-count">(' + uncategorized.length + ')</span></div>';
      html += '<div class="cs-accordion-body"><div class="all-styles-grid">';
      for (var j = 0; j < uncategorized.length; j++) { html += renderStyleRow(uncategorized[j], styles[uncategorized[j]]); }
      html += '</div></div></div>';
    }
    return html;
  }

  function renderComputedTab(boxModel, allStyles) {
    // Box model in computed tab
    const bmEl = $("computed-box-model");
    if (bmEl) {
      if (boxModel) {
        const c = boxModel.content, p = boxModel.padding, b = boxModel.border, m = boxModel.margin;
        const w = Math.round(c.width), h = Math.round(c.height);
        bmEl.innerHTML =
          '<div class="box-model"><div class="box-model-diagram">' +
            '<div class="bm-layer bm-margin"><span class="bm-label">margin</span>' +
              '<div class="bm-vals"><span>' + m.left + '</span><span>' + m.right + '</span></div>' +
              '<div class="bm-h"><span class="bm-vals-v"><span>' + m.top + '</span></span>' +
              '<div class="bm-layer bm-border"><span class="bm-label">border</span>' +
                '<div class="bm-vals"><span>' + b.left + '</span><span>' + b.right + '</span></div>' +
                '<div class="bm-h"><span class="bm-vals-v"><span>' + b.top + '</span></span>' +
                '<div class="bm-layer bm-padding"><span class="bm-label">padding</span>' +
                  '<div class="bm-vals"><span>' + p.left + '</span><span>' + p.right + '</span></div>' +
                  '<div class="bm-h"><span class="bm-vals-v"><span>' + p.top + '</span></span>' +
                  '<div class="bm-layer bm-content">' +
                    '<span class="bm-content-size">' + w + ' \u00d7 ' + h + '</span>' +
                  '</div>' +
                  '<span class="bm-vals-v"><span>' + p.bottom + '</span></span></div>' +
                '</div>' +
                '<span class="bm-vals-v"><span>' + b.bottom + '</span></span></div>' +
              '</div>' +
              '<span class="bm-vals-v"><span>' + m.bottom + '</span></span></div>' +
            '</div>' +
          '</div></div>';
      } else {
        bmEl.innerHTML = '';
      }
    }
    // All computed styles with filter
    var stylesObj = allStyles || {};
    allComputedStylesData = stylesObj.all || stylesObj;
    nonDefaultStylesData = stylesObj.nonDefault || allComputedStylesData;
    const csEl = $("computed-styles");
    if (csEl) {
      renderComputedStylesList(csEl);
    }
  }

  function activeStylesData() { return showAllStyles ? allComputedStylesData : nonDefaultStylesData; }

  function renderComputedStylesList(csEl) {
    let html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">';
    html += '<input type="text" class="computed-filter-input" id="computed-filter" placeholder="Filter styles…" style="flex:1" />';
    html += '<label style="display:flex;align-items:center;gap:4px;font-size:var(--fs-small);color:var(--text-muted);white-space:nowrap;cursor:pointer"><input type="checkbox" id="show-all-styles"' + (showAllStyles ? ' checked' : '') + ' /> Show all</label>';
    html += '</div>';
    html += '<div id="all-styles-list">' + renderCategorizedStyles(activeStylesData(), '') + '</div>';
    csEl.innerHTML = html;
    const filterInput = $("computed-filter");
    const showAllCb = $("show-all-styles");
    if (filterInput) {
      filterInput.addEventListener("input", function() {
        const listEl = $("all-styles-list");
        if (listEl) listEl.innerHTML = renderCategorizedStyles(activeStylesData(), filterInput.value);
      });
    }
    if (showAllCb) {
      showAllCb.addEventListener("change", function() {
        showAllStyles = showAllCb.checked;
        const listEl = $("all-styles-list");
        const fi = $("computed-filter");
        if (listEl) listEl.innerHTML = renderCategorizedStyles(activeStylesData(), fi ? fi.value : '');
      });
    }
  }

  /* ---- Incoming messages from extension host ---- */
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "update_element":
        currentElementSelector = msg.data.cssSelectorPath || msg.data.selector || '';
        showContent();
        renderActiveStyles(msg.data.activeStyles);
        renderComputedTab(msg.data.boxModel, msg.data.allComputedStyles);
        // Auto-expand tree to picked element
        if (msg.data.cssSelectorPath) {
          expandPathToNode(msg.data.cssSelectorPath);
        } else if (msg.data.selector) {
          highlightNode(msg.data.selector);
        }
        break;

      case "update_full_tree":
        renderFullTree(msg.tree);
        break;

      case "update_dom_tree":
        // Only use update_dom_tree if we don't have a full tree yet
        if (!fullTreeLoaded) {
          renderTreeSection(msg.children || []);
        }
        break;

      case "expand_to_node": {
        expandPathToNode(msg.selector);
        break;
      }

      case "update_hover_preview":
        if (msg.data) showContent();
        break;

      case "children_loaded": {
        const sel = msg.selector;
        const children = msg.children || [];
        const entry = treeData[sel];
        if (entry) entry.children = children;
        // Register children in treeData
        for (const child of children) {
          if (!treeData[child.selectorPath]) {
            treeData[child.selectorPath] = { node: child, children: null, expanded: false };
          }
        }
        const parentRow = document.querySelector('.tree-node[data-selector="' + CSS.escape(sel) + '"]');
        if (parentRow) {
          const parentDepth = parseInt(parentRow.style.getPropertyValue("--depth") || "0", 10);
          const frag = document.createDocumentFragment();
          renderNodes(frag, children, parentDepth + 1);
          parentRow.after(frag);
        }
        // Continue pending expand path if applicable
        if (pendingExpandPath && pendingExpandPath.parentSelector === sel) {
          const pending = pendingExpandPath;
          pendingExpandPath = null;
          expandSegments(pending.segments, pending.nextIdx);
        }
        break;
      }

      case "browser_state": {
        if (msg.open) {
          emptyEl.style.display = "none";
        } else {
          emptyEl.style.display = "";
          contentEl.style.display = "none";
        }
        detachBtn.hidden = !msg.open;
        pageStatus.hidden = !msg.open;
        pageStatus.textContent = msg.open ? (msg.url ? "Attached to " + shortUrl(msg.url) : "Attached") : "";
        pageStatus.title = msg.url || "";
        break;
      }

      case "inspect_state":
        setInspectActive(msg.active);
        break;

      case "attach_available":
        attachBtn.hidden = !msg.available;
        break;
    }
  });

  /* ---- Start screen: inspect the page open in Cursor's browser, or open a URL ---- */
  const attachBtn = $("attach-tab");
  attachBtn.addEventListener("click", () => vscode.postMessage({ type: "attach_browser_tab" }));
  $("open-url").addEventListener("click", () => vscode.postMessage({ type: "open_url_command" }));

  /* ---- Bottom bar: detach from the current page ---- */
  const detachBtn = $("detach");
  detachBtn.addEventListener("click", () => vscode.postMessage({ type: "detach" }));
  const pageStatus = $("page-status");
  function shortUrl(u) {
    try { const x = new URL(u); return x.host + (x.pathname === "/" ? "" : x.pathname); } catch (e) { return u; }
  }

  // Ask the extension to replay the session (tree, selection, console…) into this view.
  vscode.postMessage({ type: "sidebar_ready" });

})();
