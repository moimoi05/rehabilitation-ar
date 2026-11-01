(function(){var e=Object.defineProperty,t=(e,t,n)=>()=>{if(n)throw n[0];try{return e&&(t=e(e=0)),t}catch(e){throw n=[e],e}},n=(t,n)=>{let r={};for(var i in t)e(r,i,{get:t[i],enumerable:!0});return n||e(r,Symbol.toStringTag,{value:`Module`}),r};function r(e){return e}var i=t((()=>{})),a,o=t((()=>{a=`:host { all: initial !important; }
*, *::before, *::after {
  box-sizing: border-box;
  text-decoration: none;
  text-transform: none;
  font-style: normal;
  font-weight: normal;
  letter-spacing: normal;
  word-spacing: normal;
  text-indent: 0;
  text-shadow: none;
  margin: 0;
  padding: 0;
}
.panel {
  position: fixed;
  max-width: 420px;
  min-width: 280px;
  max-height: 60vh;
  overflow: hidden;
  background: #ffffff;
  color: #1f1f1f;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #f6f7f9;
  color: #1f1f1f;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  font-weight: 600 !important;
  font-size: 12px;
  user-select: none;
}
.header > div:first-child {
  font-weight: 600 !important;
}
.toolbar {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #fafbfc;
  color: #1f1f1f;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  font-size: 11px;
  user-select: none;
}
.toolbar.visible {
  display: flex;
}
.toolbar .source {
  color: #1f1f1f;
  font-weight: 500;
}
.toolbar .arrow {
  color: #999;
}
.toolbar select {
  font: inherit;
  font-size: 11px;
  color: #1f1f1f;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 4px;
  padding: 2px 4px;
  cursor: pointer;
  max-width: 180px;
}
.toolbar select:focus {
  outline: 2px solid #1a73e8;
  outline-offset: 1px;
}
.body {
  padding: 10px 12px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-wrap: break-word;
  flex: 1;
}
.actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
button {
  font: inherit;
  background: #f0f0f0;
  color: #1f1f1f;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
  font-size: 11px;
}
button:hover {
  background: #e4e4e4;
}
button:disabled {
  cursor: default;
}
.theme-btn {
  font-size: 12px;
}
.footer {
  padding: 6px 12px;
  font-size: 10px;
  color: #888;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  user-select: none;
}
.loading {
  opacity: 0.65;
  font-style: italic !important;
}
.error {
  color: #d93025;
}
.panel.dark {
  background: #1f1f1f;
  color: #eaeaea;
  border-color: rgba(255, 255, 255, 0.12);
  color-scheme: dark;
}
.panel.dark .header {
  background: #2a2a2a;
  color: #eaeaea;
  border-bottom-color: rgba(255, 255, 255, 0.08);
}
.panel.dark button {
  background: #333;
  color: #eaeaea;
  border-color: rgba(255, 255, 255, 0.2);
}
.panel.dark button:hover {
  background: #3d3d3d;
}
.panel.dark .footer {
  color: #9a9a9a;
  border-top-color: rgba(255, 255, 255, 0.08);
}
.panel.dark .toolbar {
  background: #252525;
  color: #eaeaea;
  border-bottom-color: rgba(255, 255, 255, 0.08);
}
.panel.dark .toolbar .source {
  color: #eaeaea;
}
.panel.dark .toolbar .arrow {
  color: #777;
}
.panel.dark .toolbar select {
  background: #333;
  color: #eaeaea;
  border-color: rgba(255, 255, 255, 0.2);
}
`})),s=n({});async function c(){try{let e=(await chrome.storage.local.get(O))?.[O];if(e===`light`||e===`dark`)return e}catch{}return window.matchMedia?.(`(prefers-color-scheme: dark)`).matches?`dark`:`light`}async function l(e){try{let e=(await chrome.storage.local.get(D))?.[D];if(typeof e==`string`&&A.some(t=>t.code===e))return e}catch{}return j(e||`en`)}async function u(e){try{return await e()??`unavailable`}catch{return`unavailable`}}async function d(){let[e,t]=await Promise.all([typeof Summarizer<`u`&&Summarizer?.availability?u(()=>Summarizer.availability()):Promise.resolve(`unavailable`),typeof Translator<`u`&&Translator?.availability?u(()=>Translator.availability({sourceLanguage:`en`,targetLanguage:`vi`})):Promise.resolve(`unavailable`)]);try{let n=(await chrome.storage.local.get(E))?.[E];if(n?.summarizer===e&&n?.translator===t)return;await chrome.storage.local.set({[E]:{summarizer:e,translator:t}})}catch{}}function f(){let e=window.getSelection();if(!e||e.rangeCount===0)return null;let t=e.getRangeAt(0).getBoundingClientRect();return t.width===0&&t.height===0?null:t}function p(e,t){try{return chrome.i18n.getMessage(e)||t}catch{return t}}function m(e,t){let n=document.createElement(`div`);n.setAttribute(`data-j2team-ai-overlay`,``),n.style.cssText=[`all: initial !important`,`position: fixed !important`,`z-index: ${k} !important`,`top: 0 !important`,`left: 0 !important`,`width: 0 !important`,`height: 0 !important`,`margin: 0 !important`,`padding: 0 !important`,`color-scheme: light dark`].join(`;`);let r=n.attachShadow({mode:`closed`}),i=document.createElement(`style`);i.textContent=a,r.appendChild(i);let o=document.createElement(`div`);o.className=t===`dark`?`panel dark`:`panel`;let s=document.createElement(`div`);s.className=`header`;let c=document.createElement(`div`);c.textContent=e;let l=document.createElement(`div`);l.className=`actions`;let u=t,d=document.createElement(`button`);d.className=`theme-btn`,d.title=p(`ai_overlay_toggle_theme`,`Toggle theme`);let m=()=>{d.textContent=u===`dark`?`🌞`:`🌚`};m(),d.addEventListener(`click`,()=>{u=u===`dark`?`light`:`dark`,o.classList.toggle(`dark`,u===`dark`),m(),chrome.storage.local.set({[O]:u}).catch(()=>{})});let h=document.createElement(`button`);h.textContent=p(`ai_overlay_copy`,`Copy`),h.disabled=!0,h.style.opacity=`0.5`;let g=document.createElement(`button`);g.textContent=p(`ai_overlay_close`,`Close`),l.appendChild(d),l.appendChild(h),l.appendChild(g),s.appendChild(c),s.appendChild(l);let _=document.createElement(`div`);_.className=`toolbar`;let v=document.createElement(`div`);v.className=`body loading`,v.textContent=``;let y=document.createElement(`div`);y.className=`footer`,y.textContent=`J2TEAM Security`,o.appendChild(s),o.appendChild(_),o.appendChild(v),o.appendChild(y),r.appendChild(o),document.body.appendChild(n);let b=window.innerWidth,x=window.innerHeight,S=Math.min(Math.floor(x*.6),x-16),C=f();if(C){let e=C.left;e+420>b-8&&(e=b-420-8),e<8&&(e=8),o.style.left=`${e}px`;let t=Math.max(0,x-C.bottom-8-8),n=Math.max(0,C.top-8-8);t>=S||t>=n?(o.style.top=`${C.bottom+8}px`,o.style.maxHeight=`${Math.min(S,Math.max(120,t))}px`):(o.style.bottom=`${x-C.top+8}px`,o.style.maxHeight=`${Math.min(S,Math.max(120,n))}px`)}else o.style.top=`${Math.min(80,Math.max(8,x-8-S))}px`,o.style.left=`${Math.max(8,b-420-8)}px`;let w=new AbortController,T=new AbortController,E=()=>(T.abort(),T=new AbortController,T.signal),D=()=>{T.abort(),w.abort(),n.remove()};return document.addEventListener(`keydown`,e=>{e.key===`Escape`&&(e.stopPropagation(),D())},{capture:!0,signal:w.signal}),setTimeout(()=>{w.signal.aborted||document.addEventListener(`mousedown`,e=>{e.composedPath().includes(n)||D()},{capture:!0,signal:w.signal})},0),g.addEventListener(`click`,D),h.addEventListener(`click`,async()=>{try{await navigator.clipboard.writeText(v.textContent??``),h.textContent=p(`ai_overlay_copied`,`Copied`),setTimeout(()=>{h.textContent=p(`ai_overlay_copy`,`Copy`)},1500)}catch{}}),{root:r,host:n,body:v,title:c,copyBtn:h,toolbar:_,close:D,resetRun:E}}function h(e,t){e.body.className=`body loading`,e.body.textContent=t}function g(e,t){e.body.className=`body error`,e.body.textContent=t,e.copyBtn.disabled=!0,e.copyBtn.style.opacity=`0.5`}function _(e){e.body.className=`body`,e.body.textContent=``}function v(e){e.body.textContent&&e.body.textContent.length>0&&(e.copyBtn.disabled=!1,e.copyBtn.style.opacity=`1`)}async function y(e,t,n){if(typeof e.getReader==`function`){let r=e.getReader();for(;;){if(n.aborted){try{await r.cancel()}catch{}return}let{done:e,value:i}=await r.read();if(e)break;typeof i==`string`&&(t.body.textContent+=i)}}else for await(let r of e){if(n.aborted)return;t.body.textContent+=r}}async function b(e){let t=await c(),n=m(p(`context_menu_ai_summarize`,`Summarize selection`),t),r=n.resetRun();if(h(n,p(`ai_overlay_summarizing`,`Summarizing…`)),typeof Summarizer>`u`||!Summarizer?.create){g(n,p(`ai_overlay_error_unavailable`,`On-device AI is unavailable on this device.`));return}let i=null;try{i=await Summarizer.create({type:`key-points`,length:`medium`,format:`markdown`}),_(n),await y(i.summarizeStreaming(e),n,r),v(n)}catch(e){let t=e instanceof Error?e.message:String(e);g(n,`${p(`ai_overlay_error_generic`,`Something went wrong.`)} ${t}`)}finally{try{i?.destroy?.()}catch{}}}async function x(e){if(typeof LanguageDetector>`u`||!LanguageDetector?.create)return null;try{if(await LanguageDetector.availability()===`unavailable`)return null;let t=await LanguageDetector.create(),n=await t.detect(e);try{t.destroy?.()}catch{}let r=n?.[0];return r&&r.confidence>=.3?r.detectedLanguage:null}catch{return null}}function S(e){let t=A.find(t=>t.code===e);if(t)return t.label;let n=e.split(`-`)[0]?.toLowerCase(),r=A.find(e=>e.code===n);return r?r.label:e.toUpperCase()}function C(e,t,n,r){e.toolbar.textContent=``;let i=document.createElement(`span`);i.className=`source`,i.textContent=S(t);let a=document.createElement(`span`);a.className=`arrow`,a.textContent=`→`;let o=document.createElement(`select`);for(let e of A){let t=document.createElement(`option`);t.value=e.code,t.textContent=e.label,e.code===n&&(t.selected=!0),o.appendChild(t)}o.addEventListener(`change`,()=>{r(o.value)}),e.toolbar.appendChild(i),e.toolbar.appendChild(a),e.toolbar.appendChild(o),e.toolbar.classList.add(`visible`)}async function w(e,t,n,r){let i=e.resetRun();if(h(e,p(`ai_overlay_translating`,`Translating…`)),e.copyBtn.disabled=!0,e.copyBtn.style.opacity=`0.5`,typeof Translator>`u`||!Translator?.create){g(e,p(`ai_overlay_error_unavailable`,`On-device AI is unavailable on this device.`));return}if(n===r){_(e),e.body.textContent=p(`ai_overlay_same_language`,`Same language detected.`)+`

`+t,v(e);return}let a=null;try{let o=await Translator.availability({sourceLanguage:n,targetLanguage:r});if(i.aborted)return;if(o===`unavailable`){g(e,p(`ai_overlay_error_unavailable`,`On-device AI is unavailable on this device.`));return}if(a=await Translator.create({sourceLanguage:n,targetLanguage:r}),i.aborted)return;_(e),await y(a.translateStreaming(t),e,i),i.aborted||v(e)}catch(t){if(i.aborted)return;let n=t instanceof Error?t.message:String(t);g(e,`${p(`ai_overlay_error_generic`,`Something went wrong.`)} ${n}`)}finally{try{a?.destroy?.()}catch{}}}async function T(e,t){let[n,r,i]=await Promise.all([c(),x(e),l(t)]),a=r??`en`,o=m(p(`context_menu_ai_translate`,`Translate selection`),n),s=i;C(o,a,s,t=>{t!==s&&(s=t,chrome.storage.local.set({[D]:t}).catch(()=>{}),w(o,e,a,t))}),await w(o,e,a,s)}var E,D,O,k,A,j,M,N=t((()=>{i(),o(),E=`ai_availability`,D=`ai_translate_target_lang`,O=`ai_overlay_theme`,k=`2147483647`,A=[{code:`en`,label:`English`},{code:`vi`,label:`Tiếng Việt`},{code:`zh`,label:`中文 (简体)`},{code:`zh-Hant`,label:`中文 (繁體)`},{code:`ja`,label:`日本語`},{code:`ko`,label:`한국어`},{code:`es`,label:`Español`},{code:`fr`,label:`Français`},{code:`de`,label:`Deutsch`},{code:`ru`,label:`Русский`},{code:`pt`,label:`Português`},{code:`it`,label:`Italiano`},{code:`id`,label:`Bahasa Indonesia`},{code:`th`,label:`ไทย`},{code:`ar`,label:`العربية`},{code:`hi`,label:`हिन्दी`}],j=e=>{if(!e)return`en`;let[t,n]=e.replace(`_`,`-`).toLowerCase().split(`-`);return t===`zh`&&(n===`tw`||n===`hk`||n===`hant`)?`zh-Hant`:!t||!A.some(e=>e.code===t)?`en`:t},chrome.runtime.onMessage.addListener((e,t,n)=>{if(!e||typeof e.action!=`string`)return;let r=(e.text??``).trim();r?e.action===`ai_summarize_selection`?(b(r),n({ok:!0})):e.action===`ai_translate_selection`&&(T(r,e.uiLocale),n({ok:!0})):n({ok:!1,reason:`empty_text`})}),M=`j2_ai_probed`;try{sessionStorage.getItem(M)||(sessionStorage.setItem(M,`1`),d())}catch{d()}})),P=r({matches:[`http://*/*`,`https://*/*`],runAt:`document_idle`,allFrames:!1,async main(){await Promise.resolve().then(()=>(N(),s))}}),F={debug:(...e)=>([...e],void 0),log:(...e)=>([...e],void 0),warn:(...e)=>([...e],void 0),error:(...e)=>([...e],void 0)},I=globalThis.browser?.runtime?.id?globalThis.browser:globalThis.chrome,L=class e extends Event{static EVENT_NAME=R(`wxt:locationchange`);constructor(t,n){super(e.EVENT_NAME,{}),this.newUrl=t,this.oldUrl=n}};function R(e){return`${I?.runtime?.id}:ai-overlay:${e}`}var z=typeof globalThis.navigation?.addEventListener==`function`;function B(e){let t,n=!1;return{run(){n||(n=!0,t=new URL(location.href),z?globalThis.navigation.addEventListener(`navigate`,e=>{let n=new URL(e.destination.url);n.href!==t.href&&(window.dispatchEvent(new L(n,t)),t=n)},{signal:e.signal}):e.setInterval(()=>{let e=new URL(location.href);e.href!==t.href&&(window.dispatchEvent(new L(e,t)),t=e)},1e3))}}}var V=class e{static SCRIPT_STARTED_MESSAGE_TYPE=R(`wxt:content-script-started`);id;abortController;locationWatcher=B(this);constructor(e,t){this.contentScriptName=e,this.options=t,this.id=Math.random().toString(36).slice(2),this.abortController=new AbortController,this.stopOldScripts(),this.listenForNewerScripts()}get signal(){return this.abortController.signal}abort(e){return this.abortController.abort(e)}get isInvalid(){return I.runtime?.id??this.notifyInvalidated(),this.signal.aborted}get isValid(){return!this.isInvalid}onInvalidated(e){return this.signal.addEventListener(`abort`,e),()=>this.signal.removeEventListener(`abort`,e)}block(){return new Promise(()=>{})}setInterval(e,t){let n=setInterval(()=>{this.isValid&&e()},t);return this.onInvalidated(()=>clearInterval(n)),n}setTimeout(e,t){let n=setTimeout(()=>{this.isValid&&e()},t);return this.onInvalidated(()=>clearTimeout(n)),n}requestAnimationFrame(e){let t=requestAnimationFrame((...t)=>{this.isValid&&e(...t)});return this.onInvalidated(()=>cancelAnimationFrame(t)),t}requestIdleCallback(e,t){let n=requestIdleCallback((...t)=>{this.signal.aborted||e(...t)},t);return this.onInvalidated(()=>cancelIdleCallback(n)),n}addEventListener(e,t,n,r){t===`wxt:locationchange`&&this.isValid&&this.locationWatcher.run(),e.addEventListener?.(t.startsWith(`wxt:`)?R(t):t,n,{...r,signal:this.signal})}notifyInvalidated(){this.abort(`Content script context invalidated`),F.debug(`Content script "${this.contentScriptName}" context invalidated`)}stopOldScripts(){document.dispatchEvent(new CustomEvent(e.SCRIPT_STARTED_MESSAGE_TYPE,{detail:{contentScriptName:this.contentScriptName,messageId:this.id}})),this.options?.noScriptStartedPostMessage||window.postMessage({type:e.SCRIPT_STARTED_MESSAGE_TYPE,contentScriptName:this.contentScriptName,messageId:this.id},`*`)}verifyScriptStartedEvent(e){let t=e.detail?.contentScriptName===this.contentScriptName,n=e.detail?.messageId===this.id;return t&&!n}listenForNewerScripts(){let t=e=>{e instanceof CustomEvent&&this.verifyScriptStartedEvent(e)&&this.notifyInvalidated()};document.addEventListener(e.SCRIPT_STARTED_MESSAGE_TYPE,t),this.onInvalidated(()=>document.removeEventListener(e.SCRIPT_STARTED_MESSAGE_TYPE,t))}},H={debug:(...e)=>([...e],void 0),log:(...e)=>([...e],void 0),warn:(...e)=>([...e],void 0),error:(...e)=>([...e],void 0)};return(async()=>{try{let{main:e,...t}=P;return await e(new V(`ai-overlay`,t))}catch(e){throw H.error(`The content script "ai-overlay" crashed on startup!`,e),e}})()})();