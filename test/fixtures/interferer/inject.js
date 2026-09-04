// Mirrors what password managers and sign-in helpers do: mount an iframe whose
// src is a chrome-extension:// URL of a different extension than the one
// trying to attach the debugger. Chrome refuses chrome.debugger.attach on the
// tab while such a frame exists.
(function () {
  if (document.getElementById('interferer-frame')) return;
  const f = document.createElement('iframe');
  f.id = 'interferer-frame';
  f.src = chrome.runtime.getURL('frame.html');
  f.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;border:0;opacity:0.01';
  (document.body || document.documentElement).appendChild(f);
})();
