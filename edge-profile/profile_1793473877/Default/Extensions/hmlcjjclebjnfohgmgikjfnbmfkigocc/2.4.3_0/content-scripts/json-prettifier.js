(function(){var e=Object.defineProperty,t=(e,t,n)=>()=>{if(n)throw n[0];try{return e&&(t=e(e=0)),t}catch(e){throw n=[e],e}},n=(t,n)=>{let r={};for(var i in t)e(r,i,{get:t[i],enumerable:!0});return n||e(r,Symbol.toStringTag,{value:`Module`}),r};function r(e){return e}var i,a=t((()=>{i=`html.j2s-json-prettified,
html.j2s-json-prettified body {
  margin: 0;
  padding: 0;
  background: #f6f8fa;
}
html.j2s-json-prettified body > *:not(pre.j2s-json-pretty):not(.j2s-json-controls):not(.j2s-brand) {
  display: none !important;
}
html.j2s-json-prettified pre.j2s-json-pretty {
  margin: 0;
  padding: 16px 20px 24px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', monospace;
  font-size: 13px;
  line-height: 1.55;
  color: #24292f;
  background: #f6f8fa;
  white-space: pre;
  tab-size: 2;
  word-wrap: normal;
  overflow-x: visible;
}
html.j2s-json-prettified pre.j2s-json-pretty.j2s-wrap {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: hidden;
}
html.j2s-json-prettified pre.j2s-json-pretty ::selection {
  background: #0969da;
  color: #ffffff;
  text-shadow: none;
}
html.j2s-json-prettified.j2s-dark pre.j2s-json-pretty ::selection {
  background: #1f6feb;
  color: #ffffff;
}

.j2s-json-key {
  color: #0550ae;
}
.j2s-json-string {
  color: #0a7d21;
}
.j2s-json-number {
  color: #953800;
}
.j2s-json-boolean {
  color: #8250df;
  font-weight: 600;
}
.j2s-json-null {
  color: #6e7781;
  font-style: italic;
}

.j2s-node {
  display: inline;
}
.j2s-tri {
  display: inline-block;
  width: 1em;
  margin-left: -1em;
  color: #6e7781;
  cursor: pointer;
  user-select: none;
  text-align: center;
  font-size: 0.9em;
}
.j2s-tri:hover {
  color: #24292f;
}
.j2s-brace {
  color: #24292f;
}
.j2s-count {
  display: inline-block;
  margin: 0 6px;
  padding: 0 6px;
  border-radius: 10px;
  background: #eaeef2;
  color: #57606a;
  font-size: 11px;
  line-height: 1.5;
  vertical-align: 1px;
}
.j2s-ellipsis {
  display: none;
  color: #6e7781;
  padding: 0 4px;
}
.j2s-children {
  display: block;
  border-left: 1px dashed #d0d7de;
  margin-left: 0.25em;
  padding-left: 1em;
}
.j2s-prop {
  display: block;
}
.j2s-actions {
  display: none;
  margin-left: 8px;
  user-select: none;
  vertical-align: 1px;
  gap: 2px;
}
.j2s-prop:hover:not(:has(.j2s-prop:hover)) > .j2s-actions {
  display: inline-flex;
}
.j2s-copy-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid #d0d7de;
  background: #f6f8fa;
  color: #57606a;
  padding: 2px 7px;
  font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
  border-radius: 4px;
  cursor: pointer;
  line-height: 1.4;
}
.j2s-copy-icon {
  display: inline-flex;
  opacity: 0.7;
}
.j2s-copy-btn:hover .j2s-copy-icon {
  opacity: 1;
}
.j2s-copy-btn:hover {
  background: #ffffff;
  color: #24292f;
  border-color: #8c959f;
}
.j2s-copy-btn.j2s-copied {
  background: #dafbe1;
  color: #1a7f37;
  border-color: #2da44e;
}
.j2s-colon,
.j2s-comma {
  color: #24292f;
}
.j2s-link {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: rgba(10, 125, 33, 0.4);
  text-underline-offset: 2px;
}
.j2s-link:hover {
  text-decoration-color: currentColor;
}
.j2s-jsonp-callback {
  color: #6639ba;
  font-weight: 600;
}

.j2s-node[data-open='0'] > .j2s-children {
  display: none;
}
.j2s-node[data-open='0'] > .j2s-ellipsis {
  display: inline;
}
.j2s-node[data-open='0'] > .j2s-count {
  display: none;
}

.j2s-json-controls {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 2147483647;
  display: inline-flex;
  gap: 6px;
  align-items: stretch;
  user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px;
  line-height: 1;
  height: 32px;
}
.j2s-json-controls > * {
  height: 32px;
  box-sizing: border-box;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  border-radius: 8px;
}
.j2s-view-group {
  display: inline-flex;
  align-items: stretch;
  background: #ffffff;
  border: 1px solid #d0d7de;
  overflow: hidden;
}
.j2s-view-group > * + * {
  border-left: 1px solid #d0d7de;
}
.j2s-copy-all {
  appearance: none;
  border: 1px solid #d0d7de;
  background: #ffffff;
  color: #24292f;
  padding: 0 14px;
  cursor: pointer;
  font: inherit;
  font-weight: 500;
}
.j2s-wrap-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-weight: 500;
  color: #24292f;
}
.j2s-wrap-toggle:hover {
  background: #f6f8fa;
}
.j2s-wrap-toggle input {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  margin: 0;
  border: 1.5px solid #8c959f;
  border-radius: 3px;
  background: #ffffff;
  cursor: pointer;
  position: relative;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}
.j2s-wrap-toggle input:hover {
  border-color: #0969da;
}
.j2s-wrap-toggle input:checked {
  background: #0969da;
  border-color: #0969da;
}
.j2s-wrap-toggle input:checked::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 0;
  width: 4px;
  height: 8px;
  border: solid #ffffff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.j2s-brand {
  position: fixed;
  bottom: 10px;
  right: 12px;
  z-index: 2147483646;
  padding: 5px 10px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid #d0d7de;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 10px;
  font-weight: 500;
  color: #57606a;
  line-height: 1;
  user-select: none;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
  opacity: 0.7;
  transition: opacity 0.15s ease;
}
.j2s-brand:hover {
  opacity: 1;
}
.j2s-brand-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #1f6feb;
  margin-right: 6px;
  vertical-align: 0;
}
.j2s-dark .j2s-brand {
  background: rgba(22, 27, 34, 0.85);
  border-color: #30363d;
  color: #8b949e;
}
.j2s-theme-btn {
  appearance: none;
  width: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: #57606a;
  cursor: pointer;
  padding: 0;
}
.j2s-theme-btn:hover {
  background: #f6f8fa;
  color: #24292f;
}
.j2s-copy-all:hover {
  background: #f6f8fa;
  border-color: #8c959f;
}
.j2s-copy-all.j2s-copied {
  background: #dafbe1;
  color: #1a7f37;
  border-color: #2da44e;
}
.j2s-json-toggle {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  background: #e6e9ef;
  border: 1px solid #d0d7de;
}
.j2s-json-toggle button {
  appearance: none;
  border: 0;
  background: transparent;
  color: #57606a;
  padding: 0 14px;
  height: 100%;
  border-radius: 5px;
  cursor: pointer;
  font: inherit;
  font-weight: 500;
}
.j2s-json-toggle button:hover {
  color: #24292f;
}
.j2s-json-toggle button[aria-pressed='true'] {
  background: #ffffff;
  color: #24292f;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

html.j2s-json-prettified.j2s-dark,
html.j2s-json-prettified.j2s-dark body {
  background: #0d1117;
}
html.j2s-json-prettified.j2s-dark pre.j2s-json-pretty {
  color: #c9d1d9;
  background: #0d1117;
}
.j2s-dark .j2s-json-key {
  color: #79c0ff;
}
.j2s-dark .j2s-json-string {
  color: #7ee787;
}
.j2s-dark .j2s-json-number {
  color: #ffa657;
}
.j2s-dark .j2s-json-boolean {
  color: #d2a8ff;
}
.j2s-dark .j2s-json-null {
  color: #8b949e;
}
.j2s-dark .j2s-tri {
  color: #8b949e;
}
.j2s-dark .j2s-tri:hover {
  color: #c9d1d9;
}
.j2s-dark .j2s-brace,
.j2s-dark .j2s-colon,
.j2s-dark .j2s-comma {
  color: #c9d1d9;
}
.j2s-dark .j2s-count {
  background: #21262d;
  color: #8b949e;
}
.j2s-dark .j2s-ellipsis {
  color: #8b949e;
}
.j2s-dark .j2s-children {
  border-left-color: #30363d;
}
.j2s-dark .j2s-link {
  text-decoration-color: rgba(126, 231, 135, 0.4);
}
.j2s-dark .j2s-jsonp-callback {
  color: #d2a8ff;
}
.j2s-dark .j2s-json-toggle {
  background: #21262d;
  border-color: #30363d;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.j2s-dark .j2s-json-toggle button {
  color: #8b949e;
}
.j2s-dark .j2s-json-toggle button:hover {
  color: #c9d1d9;
}
.j2s-dark .j2s-json-toggle button[aria-pressed='true'] {
  background: #0d1117;
  color: #c9d1d9;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}
.j2s-dark .j2s-copy-btn {
  background: #161b22;
  border-color: #30363d;
  color: #8b949e;
}
.j2s-dark .j2s-copy-btn:hover {
  background: #21262d;
  color: #c9d1d9;
  border-color: #484f58;
}
.j2s-dark .j2s-copy-btn.j2s-copied {
  background: #0f2e1a;
  color: #3fb950;
  border-color: #238636;
}
.j2s-dark .j2s-copy-all {
  background: #21262d;
  border-color: #30363d;
  color: #c9d1d9;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.j2s-dark .j2s-copy-all:hover {
  background: #30363d;
  border-color: #484f58;
}
.j2s-dark .j2s-copy-all.j2s-copied {
  background: #0f2e1a;
  color: #3fb950;
  border-color: #238636;
}
.j2s-dark .j2s-view-group {
  background: #21262d;
  border-color: #30363d;
}
.j2s-dark .j2s-view-group > * + * {
  border-left-color: #30363d;
}
.j2s-dark .j2s-wrap-toggle {
  color: #c9d1d9;
}
.j2s-dark .j2s-wrap-toggle:hover {
  background: #30363d;
}
.j2s-dark .j2s-wrap-toggle input {
  background: #0d1117;
  border-color: #484f58;
}
.j2s-dark .j2s-wrap-toggle input:hover {
  border-color: #58a6ff;
}
.j2s-dark .j2s-wrap-toggle input:checked {
  background: #1f6feb;
  border-color: #1f6feb;
}
.j2s-dark .j2s-theme-btn {
  color: #8b949e;
}
.j2s-dark .j2s-theme-btn:hover {
  background: #30363d;
  color: #c9d1d9;
}
`})),o=n({});async function s(){try{let e=(await chrome.storage.local.get(D))?.[D];if(e===`light`||e===`dark`)return e}catch{}return window.matchMedia?.(`(prefers-color-scheme: dark)`).matches?`dark`:`light`}function c(e){let t=e.trim();if(!t)return;let n=t[0];if(n===`{`||n===`[`)try{return{parsed:JSON.parse(t)}}catch{return}let r=t.match(O);if(!r?.[2])return;let i=r[2].trim(),a=i[0];if(a===`{`||a===`[`)try{return{parsed:JSON.parse(i),callback:r[1]}}catch{return}}function l(){let e=document.body?.querySelectorAll(`:scope > pre`);if(!e||e.length===0||document.body.children.length>3)return null;for(let t of e){let e=c(t.textContent??``);if(e!==void 0)return{pre:t,parsed:e}}return null}function u(e,t){let n=0;for(let r of t.matchAll(k)){let i=r.index??0;i>n&&e.appendChild(document.createTextNode(t.slice(n,i)));let a=document.createElement(`a`);a.className=`j2s-link`,a.href=r[0],a.target=`_blank`,a.rel=`noopener noreferrer`,a.textContent=r[0],e.appendChild(a),n=i+r[0].length}n<t.length&&e.appendChild(document.createTextNode(t.slice(n)))}function d(e,t){let n=document.createElement(`span`);return n.className=e,t!==void 0&&(n.textContent=t),n}function f(e){if(e===null)return d(`j2s-json-null`,`null`);if(typeof e==`boolean`)return d(`j2s-json-boolean`,e?`true`:`false`);if(typeof e==`number`)return d(`j2s-json-number`,String(e));if(typeof e==`string`){let t=d(`j2s-json-string`);return t.appendChild(document.createTextNode(`"`)),u(t,e),t.appendChild(document.createTextNode(`"`)),t}return d(`j2s-json-null`,String(e))}function p(){let e=document.createElementNS(A,`svg`);e.setAttribute(`viewBox`,`0 0 16 16`),e.setAttribute(`width`,`14`),e.setAttribute(`height`,`14`),e.setAttribute(`aria-hidden`,`true`);let t=document.createElementNS(A,`circle`);t.setAttribute(`cx`,`8`),t.setAttribute(`cy`,`8`),t.setAttribute(`r`,`3.25`),t.setAttribute(`fill`,`currentColor`),e.appendChild(t);for(let[t,n,r,i]of[[8,.5,8,2.25],[8,13.75,8,15.5],[.5,8,2.25,8],[13.75,8,15.5,8],[2.7,2.7,3.95,3.95],[12.05,12.05,13.3,13.3],[13.3,2.7,12.05,3.95],[3.95,12.05,2.7,13.3]]){let a=document.createElementNS(A,`line`);a.setAttribute(`x1`,String(t)),a.setAttribute(`y1`,String(n)),a.setAttribute(`x2`,String(r)),a.setAttribute(`y2`,String(i)),a.setAttribute(`stroke`,`currentColor`),a.setAttribute(`stroke-width`,`1.5`),a.setAttribute(`stroke-linecap`,`round`),e.appendChild(a)}return e}function m(){let e=document.createElementNS(A,`svg`);e.setAttribute(`viewBox`,`0 0 16 16`),e.setAttribute(`width`,`14`),e.setAttribute(`height`,`14`),e.setAttribute(`aria-hidden`,`true`);let t=document.createElementNS(A,`path`);return t.setAttribute(`fill`,`currentColor`),t.setAttribute(`d`,`M6 .278a.77.77 0 0 1 .08.858 7.2 7.2 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.78.78 0 0 1 .81.316.73.73 0 0 1-.031.893A8.35 8.35 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.75.75 0 0 1 6 .278`),e.appendChild(t),e}function h(){let e=document.createElementNS(A,`svg`);e.setAttribute(`class`,`j2s-copy-icon`),e.setAttribute(`viewBox`,`0 0 16 16`),e.setAttribute(`width`,`11`),e.setAttribute(`height`,`11`),e.setAttribute(`aria-hidden`,`true`);for(let t of j){let n=document.createElementNS(A,`path`);n.setAttribute(`fill`,`currentColor`),n.setAttribute(`d`,t),e.appendChild(n)}return e}function g(e,t){return typeof e==`string`?t?JSON.stringify(e):e:e===void 0?`undefined`:JSON.stringify(e,null,2)}function _(e){e.classList.add(`j2s-copied`),window.setTimeout(()=>e.classList.remove(`j2s-copied`),900)}function v(e,t){navigator.clipboard.writeText(e).then(()=>_(t)).catch(()=>{})}function y(e,t){let n=document.createElement(`span`);n.className=`j2s-actions`;let r=(e,t,n)=>{let r=document.createElement(`button`);return r.type=`button`,r.className=`j2s-copy-btn`,r.appendChild(M.cloneNode(!0)),r.appendChild(document.createTextNode(e)),r.title=t,r.addEventListener(`click`,e=>{e.stopPropagation(),v(n(),r)}),r};return e===null?n.appendChild(r(`V`,`Copy value`,()=>g(t,!1))):(n.appendChild(r(`K`,`Copy key`,()=>e)),n.appendChild(r(`V`,`Copy value`,()=>g(t,!1))),n.appendChild(r(`K:V`,`Copy key & value (JSON)`,()=>JSON.stringify(e)+`: `+g(t,!0)))),n}function b(e,t){t.addEventListener(`click`,n=>{n.stopPropagation();let r=e.getAttribute(`data-open`)===`1`;e.setAttribute(`data-open`,r?`0`:`1`),t.textContent=r?`▸`:`▾`})}function x(e,t,n){if(n.length===0){let n=d(`j2s-brace`);return n.textContent=e+t,n}let r=document.createElement(`span`);r.className=`j2s-node`,r.setAttribute(`data-open`,`1`);let i=d(`j2s-tri`,`▾`);i.setAttribute(`role`,`button`),i.setAttribute(`aria-label`,`toggle`),r.appendChild(i),b(r,i),r.appendChild(d(`j2s-brace`,e)),r.appendChild(d(`j2s-count`,String(n.length))),r.appendChild(d(`j2s-ellipsis`,`…`));let a=document.createElement(`div`);return a.className=`j2s-children`,n.forEach(([e,t],r)=>{let i=document.createElement(`div`);if(i.className=`j2s-prop`,e!==null){let t=d(`j2s-json-key`);t.appendChild(document.createTextNode(`"`+e+`"`)),i.appendChild(t),i.appendChild(d(`j2s-colon`,`: `))}i.appendChild(S(t)),r<n.length-1&&i.appendChild(d(`j2s-comma`,`,`)),i.appendChild(y(e,t)),a.appendChild(i)}),r.appendChild(a),r.appendChild(d(`j2s-brace`,t)),r}function S(e){if(Array.isArray(e))return x(`[`,`]`,e.map(e=>[null,e]));if(typeof e==`object`&&e){let t=e;return x(`{`,`}`,Object.keys(t).map(e=>[e,t[e]]))}return f(e)}function C(){if(document.getElementById(E))return;let e=document.createElement(`style`);e.id=E,e.textContent=i,document.head.appendChild(e)}function w(e,t){let n=document.createElement(`div`);n.className=`j2s-json-toggle`;let r=document.createElement(`button`);r.type=`button`,r.textContent=`Raw`;let i=document.createElement(`button`);i.type=`button`,i.textContent=`Parsed`;let a=e,o=()=>{r.setAttribute(`aria-pressed`,a===`raw`?`true`:`false`),i.setAttribute(`aria-pressed`,a===`parsed`?`true`:`false`)};return o(),r.addEventListener(`click`,()=>{a!==`raw`&&(a=`raw`,o(),t(a))}),i.addEventListener(`click`,()=>{a!==`parsed`&&(a=`parsed`,o(),t(a))}),n.appendChild(r),n.appendChild(i),n}function T(e,t,n){let r=e.textContent??``;C(),document.documentElement.classList.add(`j2s-json-prettified`),document.documentElement.classList.toggle(`j2s-dark`,n===`dark`),e.parentElement!==document.body&&document.body.appendChild(e),e.classList.add(`j2s-json-pretty`);let i=document.createDocumentFragment();t.callback?(i.appendChild(d(`j2s-jsonp-callback`,t.callback)),i.appendChild(document.createTextNode(`(`)),i.appendChild(S(t.parsed)),i.appendChild(document.createTextNode(`)`))):i.appendChild(S(t.parsed));let a=Array.from(i.childNodes),o=t=>{if(e.textContent=``,t===`raw`)e.textContent=r;else for(let t of a)e.appendChild(t)};o(`parsed`);let s=document.createElement(`div`);s.className=`j2s-json-controls`;let c=document.createElement(`div`);c.className=`j2s-view-group`;let l=n,u=document.createElement(`button`);u.type=`button`,u.className=`j2s-theme-btn`,u.title=`Toggle theme`;let f=()=>{u.textContent=``,u.appendChild(l===`dark`?p():m())};f(),u.addEventListener(`click`,()=>{l=l===`dark`?`light`:`dark`,document.documentElement.classList.toggle(`j2s-dark`,l===`dark`),f(),chrome.storage.local.set({[D]:l}).catch(()=>{})}),c.appendChild(u);let h=document.createElement(`label`);h.className=`j2s-wrap-toggle`,h.title=`Wrap long lines`;let g=document.createElement(`input`);g.type=`checkbox`,g.addEventListener(`change`,()=>{e.classList.toggle(`j2s-wrap`,g.checked)}),h.appendChild(g),h.appendChild(document.createTextNode(`Wrap`)),c.appendChild(h),s.appendChild(c);let _=document.createElement(`button`);_.type=`button`,_.className=`j2s-copy-all`,_.textContent=`Copy JSON`,_.title=`Copy entire JSON (pretty-printed)`,_.addEventListener(`click`,()=>{v(t.callback?t.callback+`(`+JSON.stringify(t.parsed,null,2)+`)`:JSON.stringify(t.parsed,null,2),_)}),s.appendChild(_);let y=w(`parsed`,o);s.appendChild(y),document.body.appendChild(s);let b=document.createElement(`div`);b.className=`j2s-brand`,b.title=`Prettified by J2TEAM Security`;let x=document.createElement(`span`);x.className=`j2s-brand-dot`,b.appendChild(x),b.appendChild(document.createTextNode(`J2TEAM Security · JSON`)),document.body.appendChild(b)}var E,D,O,k,A,j,M,N,P=t((()=>{a(),E=`j2s-json-prettifier-style`,D=`json_prettifier_theme`,O=/^([\w$.]+)\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/,k=/https?:\/\/[^\s"<>\\]+/g,A=`http://www.w3.org/2000/svg`,j=[`M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z`,`M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z`],M=h(),N=l(),N&&chrome.storage.sync.get({json_prettifier:!1},async e=>{if(!e.json_prettifier)return;let t=await s();T(N.pre,N.parsed,t)})})),F=r({matches:[`http://*/*`,`https://*/*`,`file:///*`],runAt:`document_end`,allFrames:!1,async main(){await Promise.resolve().then(()=>(P(),o))}}),I={debug:(...e)=>([...e],void 0),log:(...e)=>([...e],void 0),warn:(...e)=>([...e],void 0),error:(...e)=>([...e],void 0)},L=globalThis.browser?.runtime?.id?globalThis.browser:globalThis.chrome,R=class e extends Event{static EVENT_NAME=z(`wxt:locationchange`);constructor(t,n){super(e.EVENT_NAME,{}),this.newUrl=t,this.oldUrl=n}};function z(e){return`${L?.runtime?.id}:json-prettifier:${e}`}var B=typeof globalThis.navigation?.addEventListener==`function`;function V(e){let t,n=!1;return{run(){n||(n=!0,t=new URL(location.href),B?globalThis.navigation.addEventListener(`navigate`,e=>{let n=new URL(e.destination.url);n.href!==t.href&&(window.dispatchEvent(new R(n,t)),t=n)},{signal:e.signal}):e.setInterval(()=>{let e=new URL(location.href);e.href!==t.href&&(window.dispatchEvent(new R(e,t)),t=e)},1e3))}}}var H=class e{static SCRIPT_STARTED_MESSAGE_TYPE=z(`wxt:content-script-started`);id;abortController;locationWatcher=V(this);constructor(e,t){this.contentScriptName=e,this.options=t,this.id=Math.random().toString(36).slice(2),this.abortController=new AbortController,this.stopOldScripts(),this.listenForNewerScripts()}get signal(){return this.abortController.signal}abort(e){return this.abortController.abort(e)}get isInvalid(){return L.runtime?.id??this.notifyInvalidated(),this.signal.aborted}get isValid(){return!this.isInvalid}onInvalidated(e){return this.signal.addEventListener(`abort`,e),()=>this.signal.removeEventListener(`abort`,e)}block(){return new Promise(()=>{})}setInterval(e,t){let n=setInterval(()=>{this.isValid&&e()},t);return this.onInvalidated(()=>clearInterval(n)),n}setTimeout(e,t){let n=setTimeout(()=>{this.isValid&&e()},t);return this.onInvalidated(()=>clearTimeout(n)),n}requestAnimationFrame(e){let t=requestAnimationFrame((...t)=>{this.isValid&&e(...t)});return this.onInvalidated(()=>cancelAnimationFrame(t)),t}requestIdleCallback(e,t){let n=requestIdleCallback((...t)=>{this.signal.aborted||e(...t)},t);return this.onInvalidated(()=>cancelIdleCallback(n)),n}addEventListener(e,t,n,r){t===`wxt:locationchange`&&this.isValid&&this.locationWatcher.run(),e.addEventListener?.(t.startsWith(`wxt:`)?z(t):t,n,{...r,signal:this.signal})}notifyInvalidated(){this.abort(`Content script context invalidated`),I.debug(`Content script "${this.contentScriptName}" context invalidated`)}stopOldScripts(){document.dispatchEvent(new CustomEvent(e.SCRIPT_STARTED_MESSAGE_TYPE,{detail:{contentScriptName:this.contentScriptName,messageId:this.id}})),this.options?.noScriptStartedPostMessage||window.postMessage({type:e.SCRIPT_STARTED_MESSAGE_TYPE,contentScriptName:this.contentScriptName,messageId:this.id},`*`)}verifyScriptStartedEvent(e){let t=e.detail?.contentScriptName===this.contentScriptName,n=e.detail?.messageId===this.id;return t&&!n}listenForNewerScripts(){let t=e=>{e instanceof CustomEvent&&this.verifyScriptStartedEvent(e)&&this.notifyInvalidated()};document.addEventListener(e.SCRIPT_STARTED_MESSAGE_TYPE,t),this.onInvalidated(()=>document.removeEventListener(e.SCRIPT_STARTED_MESSAGE_TYPE,t))}},U={debug:(...e)=>([...e],void 0),log:(...e)=>([...e],void 0),warn:(...e)=>([...e],void 0),error:(...e)=>([...e],void 0)};return(async()=>{try{let{main:e,...t}=F;return await e(new H(`json-prettifier`,t))}catch(e){throw U.error(`The content script "json-prettifier" crashed on startup!`,e),e}})()})();