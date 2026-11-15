// Web worker entry for the photometric grid. Same contract as noise_worker.js.
(function () {
  function bind(post, handle) {
    return function (msg) {
      const data = msg && msg.data ? msg.data : msg;
      post(handle(data));
    };
  }
  if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
    const {parentPort} = require('worker_threads');
    const fs = require('fs');
    const path = require('path');
    const vm = require('vm');
    const ctx = {Math: Math, console: console, Number: Number, Array: Array, Object: Object, String: String, JSON: JSON, isFinite: isFinite, parseFloat: parseFloat, parseInt: parseInt, Infinity: Infinity, NaN: NaN, Error: Error, Map: Map, Uint8Array: Uint8Array, DataView: DataView};
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'screening.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'photometric.js'), 'utf8'), ctx);
    parentPort.on('message', bind(m => parentPort.postMessage(m), ctx.phHandle));
    return;
  }
  if (typeof importScripts === 'function') {
    if (typeof phHandle !== 'function') importScripts('screening.js', 'photometric.js');
    self.onmessage = bind(m => self.postMessage(m), phHandle);
  }
})();
