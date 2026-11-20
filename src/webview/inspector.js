(function(){
// Once per page and session: injecting again with the same token is a no-op
// (pages attached in Cursor's browser get the script both immediately and on
// every new document).
if (window.__domInspectorToken === '__DI_TOKEN__') return;
window.__domInspectorToken = '__DI_TOKEN__';
// ---------------------------------------------------------------------------
// OverlayRenderer
// ---------------------------------------------------------------------------
var COLORS = {
  content: 'rgba(66, 153, 225, 0.20)',
  padding: 'rgba(72, 199, 142, 0.20)',
  border: 'rgba(66, 153, 225, 0.15)',
  margin: 'rgba(239, 68, 68, 0.20)'
};
var OVERLAY_Z = '2147483646';
var BASE_STYLES = {position:'fixed',pointerEvents:'none',zIndex:OVERLAY_Z,display:'none',boxSizing:'border-box'};
var TOOLTIP_STYLES = {position:'fixed',pointerEvents:'none',zIndex:'2147483647',display:'none',boxSizing:'border-box'};

function parsePx(v){ return parseFloat(v)||0; }

function buildTooltipLabel(tag, classNames, id){
  var label = tag.toLowerCase();
  if(id) label += '#' + id;
  if(classNames.length>0) label += '.' + classNames.join('.');
  return label;
}

function rgbToHex(rgb){
  var m=rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if(!m) return rgb;
  return '#'+((1<<24)+(+m[1]<<16)+(+m[2]<<8)+ +m[3]).toString(16).slice(1);
}

function shorthandPadding(cs){
  var t=cs.paddingTop,r=cs.paddingRight,b=cs.paddingBottom,l=cs.paddingLeft;
  if(t===r&&r===b&&b===l) return t;
  if(t===b&&r===l) return t+' '+r;
  if(r===l) return t+' '+r+' '+b;
  return t+' '+r+' '+b+' '+l;
}

function fontSummary(cs){
  var size=cs.fontSize||'';
  var family=(cs.fontFamily||'').replace(/"/g,'');
  return size+(family?' '+family:'');
}

function computeBoxModelRects(contentRect, padding, border, margin){
  var pr = {x:contentRect.x-padding.left, y:contentRect.y-padding.top, width:contentRect.width+padding.left+padding.right, height:contentRect.height+padding.top+padding.bottom};
  var br = {x:pr.x-border.left, y:pr.y-border.top, width:pr.width+border.left+border.right, height:pr.height+border.top+border.bottom};
  var mr = {x:br.x-margin.left, y:br.y-margin.top, width:br.width+margin.left+margin.right, height:br.height+margin.top+margin.bottom};
  return {content:contentRect, padding:pr, border:br, margin:mr};
}

var OverlayRenderer = (function(){
  function OR(){ this.contentDiv=null; this.paddingDiv=null; this.borderDiv=null; this.marginDiv=null; this.tooltipDiv=null; this.initialized=false; this._styleEl=null; this._pinnedEl=null; }
  OR.prototype.init = function(){
    if(this.initialized) return;
    this.marginDiv = mkDiv(COLORS.margin);
    this.borderDiv = mkDiv(COLORS.border);
    this.paddingDiv = mkDiv(COLORS.padding);
    this.contentDiv = mkDiv(COLORS.content);
    this.tooltipDiv = mkTooltip();
    var root = document.documentElement;
    root.appendChild(this.marginDiv); root.appendChild(this.borderDiv);
    root.appendChild(this.paddingDiv); root.appendChild(this.contentDiv);
    root.appendChild(this.tooltipDiv);
    if(!this._styleEl){
      this._styleEl = document.createElement('style');
      this._styleEl.dataset.domInspectorOverlay='true';
      // Outline only: never touch the element's own background (it replaced e.g. a dark
      // <body> background with a near-transparent tint).
      this._styleEl.textContent = '.dom-inspector-selected{outline:2px solid rgba(66,153,225,0.8)!important;outline-offset:-2px!important;}';
      root.appendChild(this._styleEl);
    }
    this.initialized = true;
  };
  OR.prototype.draw = function(el){
    this._ensureInit();
    var rect = el.getBoundingClientRect();
    var cs; try{ cs = getComputedStyle(el); }catch(e){
      this._positionOverlays({x:rect.x,y:rect.y,width:rect.width,height:rect.height},{top:0,right:0,bottom:0,left:0},{top:0,right:0,bottom:0,left:0},{top:0,right:0,bottom:0,left:0});
      this._updateTooltip(el, rect); return;
    }
    var pad = {top:parsePx(cs.paddingTop),right:parsePx(cs.paddingRight),bottom:parsePx(cs.paddingBottom),left:parsePx(cs.paddingLeft)};
    var bdr = {top:parsePx(cs.borderTopWidth),right:parsePx(cs.borderRightWidth),bottom:parsePx(cs.borderBottomWidth),left:parsePx(cs.borderLeftWidth)};
    var mar = {top:parsePx(cs.marginTop),right:parsePx(cs.marginRight),bottom:parsePx(cs.marginBottom),left:parsePx(cs.marginLeft)};
    var cr = {x:rect.x+bdr.left+pad.left, y:rect.y+bdr.top+pad.top, width:rect.width-bdr.left-bdr.right-pad.left-pad.right, height:rect.height-bdr.top-bdr.bottom-pad.top-pad.bottom};
    this._positionOverlays(cr, pad, bdr, mar);
    this._updateTooltip(el, rect);
  };
  OR.prototype.hideTooltip = function(){ if(this.tooltipDiv) this.tooltipDiv.style.display='none'; };
  OR.prototype.hideBoxes = function(){
    var divs=[this.contentDiv,this.paddingDiv,this.borderDiv,this.marginDiv,this.tooltipDiv];
    for(var i=0;i<divs.length;i++) if(divs[i]) divs[i].style.display='none';
  };
  OR.prototype.pin = function(el){ this.unpin(); el.classList.add('dom-inspector-selected'); this._pinnedEl=el; };
  OR.prototype.unpin = function(){ if(this._pinnedEl){ this._pinnedEl.classList.remove('dom-inspector-selected'); this._pinnedEl=null; } };
  OR.prototype.clear = function(){
    this.unpin();
    var divs=[this.contentDiv,this.paddingDiv,this.borderDiv,this.marginDiv,this.tooltipDiv];
    for(var i=0;i<divs.length;i++) if(divs[i]) divs[i].style.display='none';
  };
  OR.prototype._ensureInit = function(){ if(!this.initialized||!this.contentDiv||!this.contentDiv.parentNode){ this.initialized=false; this.init(); } };
  OR.prototype._positionOverlays = function(cr,pad,bdr,mar){
    var rects = computeBoxModelRects(cr,pad,bdr,mar);
    applyRect(this.contentDiv, rects.content); applyRect(this.paddingDiv, rects.padding);
    applyRect(this.borderDiv, rects.border); applyRect(this.marginDiv, rects.margin);
  };
  OR.prototype._updateTooltip = function(el, rect){
    if(!this.tooltipDiv) return;
    var tag=el.tagName.toLowerCase(), id=el.id||null;
    var cn=(el.className&&typeof el.className==='string')?el.className.trim().split(/\s+/).filter(Boolean):[];
    var cs; try{ cs=getComputedStyle(el); }catch(e){ cs={}; }
    var selector=buildTooltipLabel(tag,cn,id);
    var dims=Math.round(rect.width)+' \u00d7 '+Math.round(rect.height);
    var color=cs.color||''; var hex=rgbToHex(color);
    var font=fontSummary(cs);
    var pad=shorthandPadding(cs);
    // Build HTML
    var h='<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:4px">';
    h+='<span style="color:#e8eaed;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">'+selector+'</span>';
    h+='<span style="color:#9aa0a6;white-space:nowrap;flex-shrink:0">'+dims+'</span></div>';
    h+='<div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:center">';
    // Color row
    h+='<span style="color:#9aa0a6">Color</span>';
    h+='<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px">';
    h+='<span style="display:inline-block;width:8px;height:8px;border-radius:1px;border:1px solid rgba(255,255,255,0.2);flex-shrink:0;background:'+color+'"></span>'+hex+'</span>';
    // Font row
    h+='<span style="color:#9aa0a6">Font</span>';
    h+='<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+font+'</span>';
    // Padding row
    h+='<span style="color:#9aa0a6">Padding</span>';
    h+='<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+pad+'</span>';
    h+='</div>';
    if(typeof inspecting!=='undefined' && inspecting){
      h+='<div style="margin-top:4px;padding-top:4px;border-top:1px solid #3c4043;color:#9aa0a6;font-size:10px">\u2191\u2193 parent/child \u00b7 \u2190\u2192 layers \u00b7 Enter pick \u00b7 Esc cancel</div>';
    }
    this.tooltipDiv.innerHTML=h;
    // Position: prefer above element, fall back below
    var tw=this.tooltipDiv.offsetWidth||280, th=this.tooltipDiv.offsetHeight||60;
    var vw=window.innerWidth, vh=window.innerHeight;
    var tx=Math.max(4, Math.min(rect.left, vw-tw-4));
    var ty=rect.top-th-6;
    if(ty<4) ty=rect.bottom+6;
    if(ty+th>vh-4) ty=vh-th-4;
    this.tooltipDiv.style.top=ty+'px'; this.tooltipDiv.style.left=tx+'px'; this.tooltipDiv.style.display='block';
  };
  function mkDiv(color){ var d=document.createElement('div'); d.dataset.domInspectorOverlay='true'; Object.assign(d.style,BASE_STYLES,{background:color}); return d; }
  function mkTooltip(){ var d=document.createElement('div'); d.dataset.domInspectorOverlay='true'; Object.assign(d.style,TOOLTIP_STYLES,{background:'#202124',color:'#e8eaed',font:'11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',padding:'6px 8px',borderRadius:'4px',border:'1px solid #3c4043',maxWidth:'380px',boxShadow:'0 2px 8px rgba(0,0,0,0.5)'}); return d; }
  function applyRect(div,r){ div.style.top=r.y+'px'; div.style.left=r.x+'px'; div.style.width=Math.max(0,r.width)+'px'; div.style.height=Math.max(0,r.height)+'px'; div.style.display='block'; }
  return OR;
})();

// ---------------------------------------------------------------------------
// DOMExtractor
// ---------------------------------------------------------------------------
function getClassNames(el){
  // getAttribute works for SVG too (className is an SVGAnimatedString there); drop the inspector's own classes.
  var c = el && el.getAttribute ? el.getAttribute('class') : null;
  if(!c) return [];
  return c.trim().split(/\s+/).filter(function(x){ return x && x.indexOf('dom-inspector-') !== 0; });
}
function getAttributes(el){ var a={}; for(var i=0;i<el.attributes.length;i++){ var at=el.attributes[i]; a[at.name]=at.value; } return a; }

function cssEsc(s){ try{ return (window.CSS && CSS.escape) ? CSS.escape(s) : s; }catch(e){ return s; } }
function isUniqueSel(sel, el){ try{ var r=document.querySelectorAll(sel); return r.length===1 && r[0]===el; }catch(e){ return false; } }
// Build-generated class names (CSS modules, emotion, styled-components…) change between builds.
var HASHED_CLASS_RE = /^(css|sc|jsx|emotion|svelte|astro)-[a-zA-Z0-9]{4,}$|^_[a-zA-Z0-9_-]{5,}$|__[a-zA-Z0-9_-]{5}$/;
var TEST_ATTRS = ['data-testid','data-test-id','data-test','data-cy','data-qa'];
var SEMANTIC_ATTRS = ['name','aria-label','placeholder','alt','title','for','href','role','type'];
function stableClasses(el){ return getClassNames(el).filter(function(c){ return !HASHED_CLASS_RE.test(c); }); }
function attrSel(el, a){ var v = el.getAttribute(a); if(v == null || v === '' || v.length > 80 || /[\n\r]/.test(v)) return null; return '[' + a + '="' + v.replace(/["\\]/g, '\\$&') + '"]'; }

// One path segment: unique among same-tag siblings (used for tree paths / cssSelectorPath).
function pathSegment(el){
  var tag=el.tagName.toLowerCase();
  if(el.id) return tag+'#'+cssEsc(el.id);
  var cls=getClassNames(el);
  if(cls.length>0){ var cs=tag+'.'+cls.map(cssEsc).join('.'); try{ if(document.querySelectorAll(cs).length===1) return cs; }catch(e){} }
  var par=el.parentElement; if(!par) return tag;
  var sibs=par.children, idx=0, cnt=0;
  for(var i=0;i<sibs.length;i++){ if(sibs[i].tagName===el.tagName){ cnt++; if(sibs[i]===el) idx=cnt; } }
  return cnt===1?tag:tag+':nth-of-type('+idx+')';
}

// Short, readable segment for uniqueSelector's fallback path.
function levelSelector(el){
  var tag = el.tagName.toLowerCase();
  if (el.id) return tag + '#' + cssEsc(el.id);
  var par = el.parentElement; if (!par) return tag;
  var same = [];
  for (var i=0;i<par.children.length;i++) if (par.children[i].tagName === el.tagName) same.push(par.children[i]);
  if (same.length === 1) return tag;
  var cls = stableClasses(el);
  for (var c=0; c<cls.length && c<8; c++){
    var uniq = true;
    for (var k=0;k<same.length;k++){ if (same[k] !== el && same[k].classList.contains(cls[c])){ uniq = false; break; } }
    if (uniq) return tag + '.' + cssEsc(cls[c]);
  }
  return tag + ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
}

function anchorSelector(el){
  if (el.id){ var s = '#' + cssEsc(el.id); if (isUniqueSel(s, el)) return s; }
  for (var i=0;i<TEST_ATTRS.length;i++){ var a = attrSel(el, TEST_ATTRS[i]); if (a && isUniqueSel(a, el)) return a; }
  return null;
}

// Shortest stable selector that matches exactly this element:
// #id → test ids → one/two classes → semantic attributes → anchored path → full path.
function uniqueSelector(el){
  if (!el || el.nodeType !== 1) return '';
  var tag = el.tagName.toLowerCase(), s, i, j;
  if (el === document.documentElement || el === document.body || el === document.head) return tag;
  if (el.id){ s = tag + '#' + cssEsc(el.id); if (isUniqueSel(s, el)) return s; }
  for (i=0;i<TEST_ATTRS.length;i++){ var ta = attrSel(el, TEST_ATTRS[i]); if (ta && isUniqueSel(ta, el)) return ta; }
  var cls = stableClasses(el).slice(0, 12).map(cssEsc);
  for (i=0;i<cls.length;i++){ s = tag + '.' + cls[i]; if (isUniqueSel(s, el)) return s; }
  for (i=0;i<cls.length;i++) for (j=i+1;j<cls.length;j++){ s = tag + '.' + cls[i] + '.' + cls[j]; if (isUniqueSel(s, el)) return s; }
  for (i=0;i<SEMANTIC_ATTRS.length;i++){ var sa = attrSel(el, SEMANTIC_ATTRS[i]); if (sa){ s = tag + sa; if (isUniqueSel(s, el)) return s; } }
  if (cls.length > 2){ s = tag + '.' + cls.join('.'); if (isUniqueSel(s, el)) return s; }
  var parts = [], cur = el, guard = 0;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement && guard++ < 40){
    parts.unshift(levelSelector(cur));
    s = parts.join(' > ');
    if (isUniqueSel(s, el)) return s;
    var parent = cur.parentElement;
    if (!parent) break;
    var anchor = anchorSelector(parent);
    if (anchor){ s = anchor + ' > ' + parts.join(' > '); if (isUniqueSel(s, el)) return s; }
    cur = parent;
  }
  return computeCssSelectorPath(el);
}

function buildSelectorPath(el){
  var parts=[]; var cur=el;
  while(cur&&cur!==document.documentElement){ parts.unshift(pathSegment(cur)); cur=cur.parentElement; }
  return parts.join(' > ');
}

function extractBoxModel(el){
  var rect=el.getBoundingClientRect();
  var cs; try{ cs=getComputedStyle(el); }catch(e){
    return {content:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},padding:{top:0,right:0,bottom:0,left:0},border:{top:0,right:0,bottom:0,left:0},margin:{top:0,right:0,bottom:0,left:0}};
  }
  var pad={top:parsePx(cs.paddingTop),right:parsePx(cs.paddingRight),bottom:parsePx(cs.paddingBottom),left:parsePx(cs.paddingLeft)};
  var bdr={top:parsePx(cs.borderTopWidth),right:parsePx(cs.borderRightWidth),bottom:parsePx(cs.borderBottomWidth),left:parsePx(cs.borderLeftWidth)};
  var mar={top:parsePx(cs.marginTop),right:parsePx(cs.marginRight),bottom:parsePx(cs.marginBottom),left:parsePx(cs.marginLeft)};
  var cr={x:rect.x+bdr.left+pad.left,y:rect.y+bdr.top+pad.top,width:rect.width-bdr.left-bdr.right-pad.left-pad.right,height:rect.height-bdr.top-bdr.bottom-pad.top-pad.bottom};
  return {content:cr,padding:pad,border:bdr,margin:mar};
}

function extractComputedStyles(el){
  try{ var cs=getComputedStyle(el); return {display:cs.display,position:cs.position,color:cs.color,backgroundColor:cs.backgroundColor,fontSize:cs.fontSize,fontFamily:cs.fontFamily,width:cs.width,height:cs.height,boxSizing:cs.boxSizing}; }
  catch(e){ return {display:'',position:'',color:'',backgroundColor:'',fontSize:'',fontFamily:'',width:'',height:'',boxSizing:''}; }
}

function computeXPath(el){
  try{
    var segs = [];
    var cur = el;
    while(cur && cur.nodeType === 1){
      var tag = cur.tagName.toLowerCase();
      var idx = 0;
      var cnt = 0;
      var par = cur.parentNode;
      if(par){
        for(var i = 0; i < par.children.length; i++){
          if(par.children[i].tagName && par.children[i].tagName.toLowerCase() === tag){
            cnt++;
            if(par.children[i] === cur) idx = cnt;
          }
        }
      }
      var seg = '/' + tag;
      if(cnt > 1) seg += '[' + idx + ']';
      segs.unshift(seg);
      cur = cur.parentNode;
      if(cur === document) break;
    }
    return segs.join('');
  }catch(e){ return ''; }
}

function computeCssSelectorPath(el){
  try{
    var parts = [];
    var cur = el;
    while(cur && cur.nodeType === 1){
      parts.unshift(pathSegment(cur));
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }catch(e){ return ''; }
}

function extractAllComputedStyles(el){
  try{
    var cs = getComputedStyle(el);
    // Build a baseline by creating a bare element of the same tag
    var baseline = {};
    var tmp = document.createElement(el.tagName);
    tmp.style.cssText = 'position:absolute!important;visibility:hidden!important;pointer-events:none!important;';
    (el.parentElement || document.body).appendChild(tmp);
    var dcs = getComputedStyle(tmp);
    for(var i = 0; i < dcs.length; i++) baseline[dcs[i]] = dcs.getPropertyValue(dcs[i]);
    tmp.remove();
    var all = {}, nonDefault = {};
    for(var i = 0; i < cs.length; i++){
      var prop = cs[i], val = cs.getPropertyValue(prop);
      all[prop] = val;
      if(val !== baseline[prop]) nonDefault[prop] = val;
    }
    return {all:all, nonDefault:nonDefault};
  }catch(e){ return {all:{},nonDefault:{}}; }
}

function getActiveStyles(el){
  var rules = [];
  var cs; try{ cs=getComputedStyle(el); }catch(e){ cs=null; }
  function resolveVal(prop, val){
    if(cs&&(val==='inherit'||val==='initial'||val==='unset'||val==='revert')){
      return cs.getPropertyValue(prop).trim()||val;
    }
    return val;
  }
  var SIDES=['top','right','bottom','left'];
  var SHORTHAND_GROUPS=[
    {short:'margin',subs:SIDES.map(function(s){return 'margin-'+s;})},
    {short:'padding',subs:SIDES.map(function(s){return 'padding-'+s;})},
    {short:'border-color',subs:SIDES.map(function(s){return 'border-'+s+'-color';})},
    {short:'border-width',subs:SIDES.map(function(s){return 'border-'+s+'-width';})},
    {short:'border-style',subs:SIDES.map(function(s){return 'border-'+s+'-style';})},
    {short:'border-radius',subs:['border-top-left-radius','border-top-right-radius','border-bottom-right-radius','border-bottom-left-radius']},
    {short:'inset',subs:['top','right','bottom','left']},
    {short:'overflow',subs:['overflow-x','overflow-y']},
    {short:'gap',subs:['row-gap','column-gap']}
  ];
  function collapseProps(props){
    for(var g=0;g<SHORTHAND_GROUPS.length;g++){
      var grp=SHORTHAND_GROUPS[g];
      var vals=[],idxs=[],allFound=true;
      for(var si=0;si<grp.subs.length;si++){
        var found=false;
        for(var pi=0;pi<props.length;pi++){
          if(props[pi].property===grp.subs[si]){vals.push(props[pi].value);idxs.push(pi);found=true;break;}
        }
        if(!found){allFound=false;break;}
      }
      if(!allFound||vals.length<grp.subs.length) continue;
      var allEqual=true;
      for(var vi=1;vi<vals.length;vi++){if(vals[vi]!==vals[0]){allEqual=false;break;}}
      if(allEqual){
        // Replace first sub with shorthand, remove the rest
        props[idxs[0]]={property:grp.short,value:vals[0],enabled:props[idxs[0]].enabled,editable:props[idxs[0]].editable};
        for(var ri=idxs.length-1;ri>=1;ri--) props.splice(idxs[ri],1);
      }
    }
    return props;
  }
  // 1. Collect matching CSS rule blocks
  // Build a set of the element's classes for fast pre-filtering
  var elClasses = {};
  try { var cl = el.classList; for (var ci = 0; ci < cl.length; ci++) elClasses[cl[ci]] = true; } catch(e){}

  function matchesQuick(selectorText) {
    // Quick reject: if selector contains a class-like token (.foo), check if element has that class
    // This avoids expensive el.matches() on thousands of non-matching Tailwind rules
    var dot = selectorText.indexOf('.');
    if (dot !== -1) {
      // Extract first class name from selector
      var end = dot + 1;
      while (end < selectorText.length && /[a-zA-Z0-9_-]/.test(selectorText[end])) end++;
      var cls = selectorText.substring(dot + 1, end);
      if (cls && !elClasses[cls]) return false;
    }
    try { return el.matches(selectorText); } catch(e) { return false; }
  }

  function collectStyleRule(rule) {
    if (rule.selectorText.indexOf('dom-inspector-selected') !== -1) return;
    if (rule.selectorText.indexOf('dom-inspector-cursor') !== -1) return;
    if (/(?:^|,)\s*\*\s*(?:,|$)/.test(rule.selectorText) || rule.selectorText.trim() === '*' || rule.selectorText.indexOf('*, ') === 0 || rule.selectorText.indexOf(', *') !== -1) return;
    if (!matchesQuick(rule.selectorText)) return;
    var props = [];
    var style = rule.style;
    for (var p = 0; p < style.length; p++) {
      var prop = style[p], val = resolveVal(prop, style.getPropertyValue(prop).trim());
      props.push({property: prop, value: val, enabled: true, editable: true});
    }
    if (props.length) rules.push({selector: rule.selectorText, properties: collapseProps(props)});
  }

  function collectFromRuleList(cssRules, depth) {
    if (depth > 4) return;
    for (var r = 0; r < cssRules.length; r++) {
      var rule = cssRules[r];
      try {
        if (rule.type === 1 && rule.selectorText && rule.style) {
          collectStyleRule(rule);
        } else if (rule.cssRules) {
          collectFromRuleList(rule.cssRules, depth + 1);
        }
      } catch(e) { continue; }
    }
  }

  try {
    for (var s = 0; s < document.styleSheets.length; s++) {
      var sheet; try { sheet = document.styleSheets[s]; if (!sheet.cssRules) continue; } catch(e) { continue; }
      collectFromRuleList(sheet.cssRules, 0);
    }
  } catch(e) {}
  // Also check adoptedStyleSheets (Tailwind v4 Vite plugin, etc.)
  try {
    var adopted = document.adoptedStyleSheets || [];
    for (var a = 0; a < adopted.length; a++) {
      var aSheet; try { aSheet = adopted[a]; if (!aSheet.cssRules) continue; } catch(e) { continue; }
      collectFromRuleList(aSheet.cssRules, 0);
    }
  } catch(e) {}

  // 2. Inline styles as a rule block
  if(el.style&&el.style.length){
    var inlineProps=[];
    for(var i=0;i<el.style.length;i++){
      var ip=el.style[i];
      inlineProps.push({property:ip,value:resolveVal(ip,el.style.getPropertyValue(ip).trim()),enabled:true,editable:true});
    }
    if(inlineProps.length) rules.unshift({selector:'element.style',properties:collapseProps(inlineProps)});
  }
  return rules;
}

// Live style editing
function setElementStyle(selector, property, value){
  var el=document.querySelector(selector); if(!el) return;
  el.style.setProperty(property, value);
}
function toggleElementStyle(selector, property, enabled){
  var el=document.querySelector(selector); if(!el) return;
  if(!enabled){
    el.dataset['domInspectorDisabled_'+property.replace(/-/g,'_')]=el.style.getPropertyValue(property);
    el.style.removeProperty(property);
  } else {
    var saved=el.dataset['domInspectorDisabled_'+property.replace(/-/g,'_')];
    if(saved) el.style.setProperty(property, saved);
  }
}

var DOMExtractor = (function(){
  function DE(){}
  DE.prototype.getHoverData = function(el){
    var rect=el.getBoundingClientRect();
    return {tag:el.tagName.toLowerCase(),id:el.id||null,classNames:getClassNames(el),width:rect.width,height:rect.height,boxModel:extractBoxModel(el)};
  };
  DE.prototype.getFullData = function(el){
    // Read the element as the app renders it: without our selection mark (its
    // outline would show up in the computed styles, its class in the HTML).
    var pinned = !!(el.classList && el.classList.contains('dom-inspector-selected'));
    if (pinned) el.classList.remove('dom-inspector-selected');
    try {
      var tag=el.tagName.toLowerCase(), id=el.id||null, cn=getClassNames(el), attrs=getAttributes(el);
      var text=(el.textContent||'').slice(0,200), outerSnippet=el.outerHTML.slice(0,2000);
      var selector=uniqueSelector(el), domPath=this.getDOMPath(el), children=this._getDirectChildren(el);
      var boxModel=extractBoxModel(el), computedStyles=extractComputedStyles(el);
      var xpath=computeXPath(el)||'', cssSelectorPath=computeCssSelectorPath(el)||'', allComputedStyles=extractAllComputedStyles(el);
      var activeStyles=getActiveStyles(el);
      return {selector:selector,tag:tag,id:id,classNames:cn,attrs:attrs,text:text,outerSnippet:outerSnippet,domPath:domPath,children:children,boxModel:boxModel,computedStyles:computedStyles,xpath:xpath,cssSelectorPath:cssSelectorPath,allComputedStyles:allComputedStyles,activeStyles:activeStyles,componentInfo:null};
    } finally {
      if (pinned) el.classList.add('dom-inspector-selected');
    }
  };
  DE.prototype.getChildren = function(selector){ var el=document.querySelector(selector); return el?this._getDirectChildren(el):[]; };
  DE.prototype.getDOMPath = function(el){
    var path=[]; var cur=el;
    while(cur){ var tag=cur.tagName.toLowerCase(); var seg=tag; if(cur.id) seg+='#'+cur.id; var cls=getClassNames(cur); if(cls.length>0) seg+='.'+cls.join('.'); path.unshift(seg); cur=cur.parentElement; }
    return path;
  };
  DE.prototype.getFullTree = function(){
    var SKIP_TAGS = {head:1,script:1,link:1,style:1,noscript:1};
    function buildNode(el){
      var tag = el.tagName.toLowerCase();
      var id = el.id || null;
      var cn = getClassNames(el);
      var sp = el === document.documentElement ? tag : buildSelectorPath(el);
      var children = [];
      for(var i = 0; i < el.children.length; i++){
        var childTag = el.children[i].tagName.toLowerCase();
        if(!SKIP_TAGS[childTag]){
          children.push(buildNode(el.children[i]));
        }
      }
      return { tag: tag, id: id, classNames: cn, childCount: children.length, selectorPath: sp, children: children };
    }
    return buildNode(document.documentElement);
  };
  DE.prototype._getDirectChildren = function(el){
    var children=[];
    for(var i=0;i<el.children.length;i++){ var ch=el.children[i]; children.push({tag:ch.tagName.toLowerCase(),id:ch.id||null,classNames:getClassNames(ch),childCount:ch.children.length,selectorPath:buildSelectorPath(ch)}); }
    return children;
  };
  return DE;
})();

// ---------------------------------------------------------------------------
// FrameworkDetector
// ---------------------------------------------------------------------------
function safeGet(fn){ try{ return fn(); }catch(e){ return undefined; } }
function findKeyWithPrefix(obj, prefix){ try{ var ks=Object.keys(obj); for(var i=0;i<ks.length;i++) if(ks[i].indexOf(prefix)===0) return ks[i]; }catch(e){} return undefined; }
function fileBase(f){ if(!f) return null; var p=String(f).split('/'); return p[p.length-1].replace(/\.(vue|svelte|jsx|tsx|js|ts)$/,''); }

// Stack frames from libraries/runtime are skipped when looking for the app's JSX call site.
// Library code, by URL: plain paths (/node_modules/, Vite's /.vite/deps/) and bundler chunks
// that flatten them (Turbopack: node_modules__bun_….js, …_next_dist_compiled_react-dom_….js).
var LIB_URL_RE = /node_modules[\/_]|[\/_.]next[\/_]dist[\/_]|\/\.vite\/deps\/|\/@vite\/|\/@react-refresh|\/@id\/|react-dom|jsx-dev-runtime|jsx-runtime|\/_next\/static\/chunks\/(?:framework|main|webpack|polyfills)/;
// React's own frames, by function name. Every _debugStack starts inside jsxDEV/createElement,
// whatever the bundle containing it is called, so the URL alone can't be trusted.
var REACT_FRAME_FN_RE = /(?:^|\.)(?:jsxDEV|jsxs?|jsxWithValidation\w*|createElement|cloneElement|react_stack_bottom_frame|renderWithHooks\w*)$/;
var FRAME_RE = /at (?:(.+?) \()?((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/;

function userFrame(stackErr){
  var st = safeGet(function(){ return typeof stackErr === 'string' ? stackErr : (stackErr && stackErr.stack); });
  if (typeof st !== 'string') return null;
  var lines = st.split('\n');
  for (var i=0;i<lines.length;i++){
    var m = lines[i].match(FRAME_RE);
    if (!m || LIB_URL_RE.test(m[2]) || REACT_FRAME_FN_RE.test(m[1] || '')) continue;
    return { fn: m[1] || '', url: m[2], line: +m[3], column: +m[4] };
  }
  return null;
}

function typeName(t){
  return safeGet(function(){
    if (!t) return null;
    if (typeof t === 'function') return t.displayName || t.name || null;
    if (typeof t === 'object'){
      if (t.displayName) return t.displayName;
      if (t.render) return t.render.displayName || t.render.name || null; // forwardRef
      if (t.type) return typeName(t.type);                               // memo
    }
    return null;
  }) || null;
}

function reactFiberFor(el){
  var cur = el;
  while (cur && cur.nodeType === 1){
    var k = findKeyWithPrefix(cur, '__reactFiber$') || findKeyWithPrefix(cur, '__reactInternalInstance$');
    if (k) return cur[k];
    cur = cur.parentElement;
  }
  return null;
}

function reactInfo(el){
  var fiber = reactFiberFor(el); if (!fiber) return null;
  var info = {framework:'react', componentName:null, componentPath:[], sourceFile:null, sourceLine:null, stackUrl:null, stackLine:null, stackColumn:null};
  // 1. Where this element's JSX was written (React 19 owner stacks). Elements created inside
  //    libraries (an icon's <svg>) walk up to the first fiber whose JSX lives in app code.
  var f = fiber, site = null, guard = 0;
  while (f && !site && guard++ < 300){
    var cur = f;
    site = userFrame(safeGet(function(){ return cur._debugStack; }));
    if (!site) f = f.return;
  }
  if (site){ info.stackUrl = site.url; info.stackLine = site.line; info.stackColumn = site.column; }
  // 2. React <= 18: _debugSource carries the original file/line.
  var g = fiber; guard = 0;
  while (g && guard++ < 300){
    var gg = g;
    var ds = safeGet(function(){ return gg._debugSource; });
    if (ds && ds.fileName && !/\/node_modules\//.test(ds.fileName)){ info.sourceFile = ds.fileName; info.sourceLine = ds.lineNumber || null; break; }
    g = g.return;
  }
  // 3. Owning component: whose render produced that element.
  var ownerSrc = f || fiber;
  var owner = safeGet(function(){ return ownerSrc._debugOwner; });
  var ownerName = owner ? (typeName(owner.type) || owner.name || null) : null;
  if (!ownerName && site && /^[A-Z]/.test(site.fn.split('.').pop())) ownerName = site.fn.split('.').pop();
  // 4. Component path, root first, without consecutive duplicates (memo/forwardRef wrappers).
  var path = [], h = fiber, last = null; guard = 0;
  while (h && guard++ < 1000){
    var ty = h.type;
    var n = (typeof ty === 'function' || (ty && typeof ty === 'object')) ? typeName(ty) : null;
    if (n && n !== last){ path.push(n); last = n; }
    h = h.return;
  }
  path.reverse();
  // Keep the components written in the app: those whose render function shows up as a JSX call
  // site in app code somewhere up the tree. This drops framework internals (Next.js routers,
  // error boundaries, providers…) and library components (an icon's own wrapper).
  var app = {}; h = fiber; guard = 0;
  while (h && guard++ < 1000){
    var hh = h;
    var cf = userFrame(safeGet(function(){ return hh._debugStack; }));
    var fnName = cf && cf.fn ? cf.fn.split('.').pop() : '';
    if (/^[A-Z]/.test(fnName)) app[fnName] = true;
    h = h.return;
  }
  var appPath = path.filter(function(n){ return app[n]; });
  info.componentPath = appPath.length ? appPath : path;
  info.componentName = ownerName || path[path.length-1] || null;
  return info.componentName ? info : null;
}

function vueInfo(el){
  var cur = el, inst = null, v2 = null;
  while (cur && cur.nodeType === 1){
    var c = cur;
    inst = safeGet(function(){ return c.__vueParentComponent; }) || null;
    v2 = safeGet(function(){ return c.__vue__; }) || null;
    if (inst || v2) break;
    cur = cur.parentElement;
  }
  if (inst){
    var t = safeGet(function(){ return inst.type; }) || {};
    var file = safeGet(function(){ return t.__file; }) || null;
    var name = safeGet(function(){ return t.name || t.__name; }) || fileBase(file) || 'Anonymous';
    var cp = [], p = inst, guard = 0;
    while (p && guard++ < 200){
      var pt = safeGet(function(){ return p.type; }) || {};
      var pn = safeGet(function(){ return pt.name || pt.__name; }) || fileBase(safeGet(function(){ return pt.__file; }));
      if (pn && pn !== cp[cp.length-1]) cp.push(pn);
      p = safeGet(function(){ return p.parent; });
    }
    return {framework:'vue', componentName:name, componentPath:cp.reverse(), sourceFile:file, sourceLine:null};
  }
  if (v2){
    var o = safeGet(function(){ return v2.$options; }) || {};
    var nm = o.name || o._componentTag || fileBase(o.__file) || 'Anonymous';
    var cp2 = [], q = v2, g2 = 0;
    while (q && g2++ < 200){
      var qo = safeGet(function(){ return q.$options; }) || {};
      var qn = qo.name || qo._componentTag;
      if (qn) cp2.push(qn);
      q = safeGet(function(){ return q.$parent; });
    }
    return {framework:'vue', componentName:nm, componentPath:cp2.reverse(), sourceFile:o.__file || null, sourceLine:null};
  }
  return null;
}

function svelteInfo(el){
  var cur = el, meta = null;
  while (cur && cur.nodeType === 1){
    var c = cur;
    meta = safeGet(function(){ return c.__svelte_meta; });
    if (meta) break;
    cur = cur.parentElement;
  }
  if (!meta) return null;
  var loc = safeGet(function(){ return meta.loc; }) || {};
  var file = loc.file || null;
  var cp = [], a = el;
  while (a && a.nodeType === 1){
    var aa = a;
    var m = safeGet(function(){ return aa.__svelte_meta; });
    var f = m && m.loc && m.loc.file;
    if (f){ var b = fileBase(f); if (b !== cp[cp.length-1]) cp.push(b); }
    a = a.parentElement;
  }
  return {framework:'svelte', componentName:fileBase(file) || 'Unknown', componentPath:cp.reverse(), sourceFile:file, sourceLine:typeof loc.line === 'number' ? loc.line : null};
}

function angularInfo(el){
  var ng = safeGet(function(){ return window.ng; });
  if (!ng) return null;
  var comp = safeGet(function(){ return typeof ng.getOwningComponent === 'function' ? ng.getOwningComponent(el) : null; })
          || safeGet(function(){ return ng.getComponent(el); });
  if (!comp) return null;
  var nm = safeGet(function(){ return comp.constructor && comp.constructor.name; }) || 'Unknown';
  var cp = [], cur = el;
  while (cur && cur.nodeType === 1){
    var cc = cur;
    var c = safeGet(function(){ return ng.getComponent(cc); });
    var n = c ? safeGet(function(){ return c.constructor && c.constructor.name; }) : null;
    if (n && n !== cp[cp.length-1]) cp.push(n);
    cur = cur.parentElement;
  }
  cp.reverse();
  if (cp[cp.length-1] !== nm) cp.push(nm);
  return {framework:'angular', componentName:nm, componentPath:cp, sourceFile:null, sourceLine:null};
}

var FrameworkDetector = (function(){
  function FD(){}
  // Detect from what is actually rendered (fiber keys, Vue/Svelte element props), not only from devtools hooks.
  FD.prototype.detect = function(){
    try{
      var els = document.body ? document.body.getElementsByTagName('*') : [];
      var n = Math.min(els.length, 400);
      for (var i=0;i<n;i++){
        var e = els[i];
        if (findKeyWithPrefix(e,'__reactFiber$') || findKeyWithPrefix(e,'__reactInternalInstance$')) return 'react';
        if (e.__vueParentComponent || e.__vue__ || e.__vue_app__) return 'vue';
        if (e.__svelte_meta) return 'svelte';
      }
      if (window.ng || document.querySelector('[ng-version]')) return 'angular';
      if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ && window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers && window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size) return 'react';
      if (window.__VUE__) return 'vue';
    }catch(e){ console.warn('[dom-inspector] Framework detection error:', e); }
    return null;
  };
  FD.prototype.getComponentInfo = function(el){
    var probes = [reactInfo, vueInfo, svelteInfo, angularInfo];
    for (var i=0;i<probes.length;i++){
      try{ var info = probes[i](el); if (info) return info; }
      catch(e){ console.warn('[dom-inspector] component info error:', e); }
    }
    return null;
  };
  return FD;
})();

// ---------------------------------------------------------------------------
// InspectorScript
// ---------------------------------------------------------------------------
// Transport: inside DOM Inspector's own panel (an iframe named "dom-inspector-panel")
// messages go through window.parent. In any other browser (VS Code's integrated
// browser, Cursor's browser tab, Simple Browser, Chrome…) they go over HTTP to
// the proxy this page was served from: SSE for incoming, POST for outgoing.
var DI_TOKEN = '__DI_TOKEN__';
// '' for pages served through the proxy (same origin); the proxy's own origin
// (http://127.0.0.1:<port>) for pages attached directly in Cursor's browser.
var DI_CHANNEL = '__DI_BASE__' + '/__dom-inspector__/';
var DI_IN_PANEL = window.name === 'dom-inspector-panel';
// One id per page load: duplicated tabs and reloads never collide.
var DI_CLIENT = Math.random().toString(36).slice(2) + Date.now().toString(36);
function channelUrl(route){ return DI_CHANNEL + route + '?t=' + encodeURIComponent(DI_TOKEN) + '&c=' + encodeURIComponent(DI_CLIENT); }
// Page-level listeners, tracked so detachInspector() can remove every one.
var diListeners = [];
var diEventSource = null;
var diDetached = false;
function diOn(target, type, fn, opts){ target.addEventListener(type, fn, opts); diListeners.push([target, type, fn, opts]); }

function postToParent(msg){
  if (diDetached) return;
  if (DI_IN_PANEL){ try{ window.parent.postMessage(msg,'*'); }catch(e){ console.warn('[dom-inspector] Failed to post message:', e); } return; }
  try{ fetch(channelUrl('message'), {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(msg)}).catch(function(){}); }
  catch(e){ console.warn('[dom-inspector] Failed to send message:', e); }
}
function connectChannel(){
  if (DI_IN_PANEL){ diOn(window, 'message', handleMessage); return; }
  try{
    var es = diEventSource = new EventSource(channelUrl('events'));
    es.onmessage = function(ev){ try{ handleMessage({data: JSON.parse(ev.data)}); }catch(e){} };
  }catch(e){ console.warn('[dom-inspector] Cannot open the inspector channel:', e); }
}
function isOverlayElement(el){ return !!(el&&el.closest&&el.closest('[data-dom-inspector-overlay="true"]')); }

var overlay = new OverlayRenderer();
var extractor = new DOMExtractor();
var detector = new FrameworkDetector();
var inspecting = false;
var rafPending = false;
var lastMouseEvent = null;
// Hover state: hoverBase = element under the cursor; hoverEl = what will be picked
// (differs after keyboard navigation); hoverPoint = last cursor position.
var hoverBase = null, hoverEl = null, hoverPoint = null;

// SVG internals (<path>, <g>, <use>…) are almost never what you mean: promote to the
// outermost <svg>. ArrowDown still reaches the inside.
function normalizeTarget(el){
  if (!el || el.nodeType !== 1 || isOverlayElement(el)) return null;
  if (typeof SVGElement !== 'undefined' && el instanceof SVGElement){
    var top = el; while (top.ownerSVGElement) top = top.ownerSVGElement;
    return top;
  }
  return el;
}

function setHover(el){
  if (!el || isOverlayElement(el)) return;
  hoverEl = el;
  overlay.draw(el);
  postToParent({type:'element_hovered', data:extractor.getHoverData(el)});
}

function startInspection(){
  if(inspecting) return;
  inspecting = true;
  overlay.init();
  if(!document.getElementById('dom-inspector-cursor')){
    var s=document.createElement('style');
    s.id='dom-inspector-cursor';
    s.textContent='*{cursor:default!important}';
    document.head.appendChild(s);
  }
  // Take keyboard focus so arrow keys reach the page (we live in an iframe).
  try{ window.focus(); }catch(e){}
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onInspectKey, true);
}

function stopInspection(){
  if(!inspecting) return;
  inspecting = false; rafPending = false; lastMouseEvent = null;
  hoverBase = null; hoverEl = null; hoverPoint = null;
  var cs=document.getElementById('dom-inspector-cursor');
  if(cs) cs.remove();
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onInspectKey, true);
  overlay.clear();
}

function onMouseMove(e){
  e.preventDefault(); e.stopPropagation();
  lastMouseEvent = e;
  if(!rafPending){ rafPending = true; requestAnimationFrame(function(){ rafPending = false; processMouseMove(); }); }
}

function processMouseMove(){
  var e = lastMouseEvent; if(!e||!inspecting) return;
  hoverPoint = {x:e.clientX, y:e.clientY};
  var el = normalizeTarget(document.elementFromPoint(e.clientX, e.clientY));
  if(!el) return;
  // Moving within the same element keeps a keyboard-navigated selection.
  if (el !== hoverBase){ hoverBase = el; setHover(el); }
  else if (hoverEl) overlay.draw(hoverEl);
}

function pickElement(el){
  var data = extractor.getFullData(el);
  data.componentInfo = detector.getComponentInfo(el);
  postToParent({type:'element_picked', data:data});
  stopInspection();
  // Pin the selected element with a CSS class so it survives layout shifts
  overlay.init(); overlay.pin(el);
}

function onClick(e){
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  var base = normalizeTarget(document.elementFromPoint(e.clientX, e.clientY));
  if(!base) return;
  pickElement(base === hoverBase && hoverEl ? hoverEl : base);
}

// Child of el under the cursor (includes pointer-events:none children), else the first visible child.
function childAtPoint(el){
  var kids = el.children, hit = null, first = null;
  for (var i=0;i<kids.length;i++){
    var k = kids[i];
    if (isOverlayElement(k)) continue;
    var r = k.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (!first) first = k;
    if (hoverPoint && hoverPoint.x >= r.left && hoverPoint.x <= r.right && hoverPoint.y >= r.top && hoverPoint.y <= r.bottom) hit = k;
  }
  return hit || first;
}

// Everything stacked under the cursor, topmost first — reaches content beneath transparent overlays.
function layersAtPoint(){
  if (!hoverPoint || !document.elementsFromPoint) return [];
  var raw = document.elementsFromPoint(hoverPoint.x, hoverPoint.y), out = [];
  for (var i=0;i<raw.length;i++){
    var e = normalizeTarget(raw[i]);
    if (e && out.indexOf(e) === -1 && e !== document.documentElement && e !== document.body) out.push(e);
  }
  return out;
}

function onInspectKey(e){
  if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); postToParent({type:'element_pick_cancelled'}); stopInspection(); return; }
  if (!hoverEl) return;
  var next = null;
  if (e.key === 'ArrowUp'){ next = hoverEl.parentElement; if (next === document.documentElement) next = null; }
  else if (e.key === 'ArrowDown'){ next = childAtPoint(hoverEl); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
    var layers = layersAtPoint();
    if (layers.length){
      var idx = layers.indexOf(hoverEl);
      idx = idx === -1 ? 0 : (idx + (e.key === 'ArrowRight' ? 1 : -1) + layers.length) % layers.length;
      next = layers[idx];
    }
  }
  else if (e.key === 'Enter'){ e.preventDefault(); e.stopPropagation(); pickElement(hoverEl); return; }
  else return;
  e.preventDefault(); e.stopPropagation();
  if (next) setHover(next);
}

function handleMessage(e){
  var msg=e.data; if(!msg||typeof msg.type!=='string') return;
  console.log('[dom-inspector] received message:', msg.type);
  switch(msg.type){
    case 'start_inspector': startInspection(); break;
    case 'stop_inspector': stopInspection(); break;
    case 'get_children': if(typeof msg.selector==='string'){ postToParent({type:'children_response',selector:msg.selector,children:extractor.getChildren(msg.selector)}); } break;
    case 'get_full_tree': postToParent({type:'full_tree_response',tree:extractor.getFullTree()}); break;
    case 'inspect_node': if(typeof msg.selector==='string'){ var iel=document.querySelector(msg.selector); if(iel){ var idata=extractor.getFullData(iel); idata.componentInfo=detector.getComponentInfo(iel); overlay.init(); overlay.pin(iel); postToParent({type:'element_picked',data:idata}); } } break;
    case 'set_style': if(msg.selector&&msg.property) setElementStyle(msg.selector,msg.property,msg.value||''); break;
    case 'toggle_style': if(msg.selector&&msg.property) toggleElementStyle(msg.selector,msg.property,!!msg.enabled); break;
    case 'ai_targets': if(typeof msg.primary==='string' && msg.primary) aiTargetLabel = msg.primary; break;
    case 'detach': detachInspector(); break;
  }
}

// ---------------------------------------------------------------------------
// Context menu (right-click). Shift+right-click falls through to the page.
// ---------------------------------------------------------------------------
var ctxMenu = null, ctxHeader = null, ctxTarget = null;
var aiTargetLabel = 'AI';   // set by the extension (ai_targets message)
var CTX_ACTIONS = [
  {action:'send_ai', label:function(){ return 'Send to ' + aiTargetLabel; }},
  {action:'send_ai_pick', label:function(){ return 'Send to\u2026'; }},
  {action:'copy_md', label:function(){ return 'Copy as Markdown'; }},
  {action:'inspect', label:function(){ return 'Inspect element'; }}
];

function mkOverlayNode(tag){ var n=document.createElement(tag); n.dataset.domInspectorOverlay='true'; return n; }

function buildContextMenu(){
  var m = mkOverlayNode('div');
  Object.assign(m.style,{position:'fixed',zIndex:'2147483647',display:'none',minWidth:'200px',maxWidth:'320px',padding:'4px',boxSizing:'border-box',background:'#202124',color:'#e8eaed',border:'1px solid #3c4043',borderRadius:'6px',boxShadow:'0 4px 16px rgba(0,0,0,0.5)',font:'12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',userSelect:'none'});
  ctxHeader = mkOverlayNode('div');
  Object.assign(ctxHeader.style,{padding:'4px 10px 6px',color:'#9aa0a6',fontSize:'11px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',borderBottom:'1px solid #3c4043',marginBottom:'4px'});
  m.appendChild(ctxHeader);
  for(var i=0;i<CTX_ACTIONS.length;i++){
    var it = mkOverlayNode('div');
    it.dataset.domInspectorAction = CTX_ACTIONS[i].action;
    it.textContent = CTX_ACTIONS[i].label();
    Object.assign(it.style,{padding:'6px 10px',borderRadius:'4px',cursor:'pointer'});
    it.addEventListener('mouseenter', function(){ this.style.background='#3c4043'; });
    it.addEventListener('mouseleave', function(){ this.style.background='transparent'; });
    m.appendChild(it);
  }
  // Keep menu interactions away from the app and from focus changes.
  m.addEventListener('mousedown', function(e){ e.preventDefault(); e.stopPropagation(); }, true);
  m.addEventListener('contextmenu', function(e){ e.preventDefault(); e.stopPropagation(); }, true);
  m.addEventListener('click', function(e){
    e.preventDefault(); e.stopPropagation();
    var item = e.target && e.target.closest ? e.target.closest('[data-dom-inspector-action]') : null;
    var target = ctxTarget;
    hideContextMenu();
    if(item && target) runContextAction(item.dataset.domInspectorAction, target);
  }, true);
  document.documentElement.appendChild(m);
  return m;
}

function showContextMenu(el, x, y){
  if(!ctxMenu || !ctxMenu.parentNode) ctxMenu = buildContextMenu();
  ctxTarget = el;
  ctxHeader.textContent = buildTooltipLabel(el.tagName, getClassNames(el), el.id||null);
  var items = ctxMenu.querySelectorAll('[data-dom-inspector-action]');
  for (var k=0;k<items.length;k++){ for (var a=0;a<CTX_ACTIONS.length;a++) if (CTX_ACTIONS[a].action === items[k].dataset.domInspectorAction) items[k].textContent = CTX_ACTIONS[a].label(); }
  overlay.draw(el);
  overlay.hideTooltip();
  ctxMenu.style.display = 'block';
  var mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  var left = Math.max(4, Math.min(x, window.innerWidth - mw - 4));
  var top = Math.max(4, Math.min(y, window.innerHeight - mh - 4));
  ctxMenu.style.left = left + 'px'; ctxMenu.style.top = top + 'px';
}

function hideContextMenu(){
  if(!ctxMenu || ctxMenu.style.display === 'none') return;
  ctxMenu.style.display = 'none';
  ctxTarget = null;
  overlay.hideBoxes();
}

function runContextAction(action, el){
  var data = extractor.getFullData(el);
  data.componentInfo = detector.getComponentInfo(el);
  overlay.init(); overlay.pin(el);
  if(action === 'send_ai') postToParent({type:'send_to_ai', target:'primary', data:data});
  else if(action === 'send_ai_pick') postToParent({type:'send_to_ai', target:'pick', data:data});
  else if(action === 'copy_md') postToParent({type:'send_to_ai', target:'clipboard', data:data});
  else postToParent({type:'element_picked', data:data});
}

function onContextMenu(e){
  if(e.shiftKey) return;
  var raw = document.elementFromPoint(e.clientX, e.clientY);
  if(!raw) return;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  var el = normalizeTarget(raw);
  if(!el) return;
  if(inspecting){ stopInspection(); postToParent({type:'element_pick_cancelled'}); }
  showContextMenu(el, e.clientX, e.clientY);
}

function initContextMenu(){
  diOn(document, 'contextmenu', onContextMenu, true);
  diOn(document, 'mousedown', function(e){ if(ctxMenu && !isOverlayElement(e.target)) hideContextMenu(); }, true);
  diOn(document, 'keydown', function(e){ if(e.key === 'Escape' && ctxMenu && ctxMenu.style.display !== 'none'){ e.preventDefault(); e.stopPropagation(); hideContextMenu(); } }, true);
  diOn(window, 'scroll', hideContextMenu, true);
  diOn(window, 'resize', hideContextMenu);
  diOn(window, 'blur', hideContextMenu);
}

// Leave the page as if the inspector had never been there: no listeners, no
// connection, no overlays, menu or selection mark. Live style edits made from
// the sidebar stay, since they're the user's.
function detachInspector(){
  if (diDetached) return;
  stopInspection();
  hideContextMenu();
  diDetached = true;
  for (var i = 0; i < diListeners.length; i++){ var l = diListeners[i]; try{ l[0].removeEventListener(l[1], l[2], l[3]); }catch(e){} }
  diListeners = [];
  if (diEventSource){ try{ diEventSource.close(); }catch(e){} diEventSource = null; }
  var marked = document.querySelectorAll('.dom-inspector-selected');
  for (var m = 0; m < marked.length; m++) marked[m].classList.remove('dom-inspector-selected');
  var nodes = document.querySelectorAll('[data-dom-inspector-overlay="true"]');
  for (var n = 0; n < nodes.length; n++) if (nodes[n].parentNode) nodes[n].parentNode.removeChild(nodes[n]);
  try{ delete window.__domInspectorToken; }catch(e){ window.__domInspectorToken = undefined; }
  console.log('[dom-inspector] detached');
}

function initInspector(){
  connectChannel();
  initContextMenu();

  // Wait for DOM to stabilize after hydration before signalling ready.
  // Listen for mutations; once quiet for 300ms (or 2s max), fire ready.
  var fired = false;
  function fireReady(){
    if(fired) return;
    fired = true;
    if(obs) obs.disconnect();
    postToParent({type:'inspector_ready'});
    var fw = detector.detect();
    if(fw) postToParent({type:'framework_detected', framework:fw});
  }
  var timer = setTimeout(fireReady, 2000);
  var obs = new MutationObserver(function(){
    clearTimeout(timer);
    timer = setTimeout(fireReady, 300);
  });
  obs.observe(document.documentElement, {childList:true, subtree:true});
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', initInspector);
} else {
  initInspector();
}
})();
