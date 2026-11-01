(()=>{const e="chrome",n="edge",o="firefox",r="main";const t="edge";parseInt("1792702576",10);if(Boolean(void 0))throw new Error("Must have REGISTER_SELF_URL when DEBUG=undefined");chrome.runtime.onInstalled.addListener((function(e){if("install"===e.reason){const e=chrome.runtime.getURL("/welcome.html");chrome.tabs.create({url:e})}}))})();
//# sourceMappingURL=index.js.map
