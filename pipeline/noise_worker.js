// Web worker entry for the ISO 9613-2 screening grid.
// Browser: new Worker('noise_worker.js') — this file importScripts screening.js and noise.js.
// Node: worker_threads entry. The calculation itself is nzRun in noise.js; this file only pumps messages.
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
    const ctx = {Math: Math, console: console, Number: Number, Array: Array, Object: Object, String: String, JSON: JSON, isFinite: isFinite, parseFloat: parseFloat, parseInt: parseInt, Infinity: Infinity, NaN: NaN, Error: Error, Map: Map, Set: Set, Uint8Array: Uint8Array, Float64Array: Float64Array, DataView: DataView, ArrayBuffer: ArrayBuffer};
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'screening.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'noise.js'), 'utf8'), ctx);
    parentPort.on('message', bind(m => parentPort.postMessage(m), ctx.nzHandle));
    return;
  }
  if (typeof importScripts === 'function') {
    if (typeof nzHandle !== 'function') importScripts('screening.js', 'noise.js');
    self.onmessage = bind(m => self.postMessage(m), nzHandle);
  }
})();
