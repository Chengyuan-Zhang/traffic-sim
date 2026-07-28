// Minimal browser environment for running the simulator's modules under Node.
//
// The pages are plain <script> files that close over their state in an IIFE, so
// there is nothing to import. This module fakes just enough of the DOM, canvas
// and storage APIs to let them run, and optionally strips the IIFE wrapper so a
// test can reach the internals. Either way the code under test is the file that
// ships — nothing is re-implemented here.
//
// No dependencies. Run with any Node >= 14.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Slider and <select> defaults are read out of the real HTML so that a module
// booted here starts from the same state as the deployed page.
function scrapeControlDefaults(html) {
  const out = {};
  let m;
  const tag = /<(input|select)\b([^>]*)>/g;
  while ((m = tag.exec(html))) {
    const attrs = m[2];
    const id = (attrs.match(/id="([^"]+)"/) || [])[1];
    if (!id) continue;
    out[id] = {
      value: (attrs.match(/value="([^"]+)"/) || [])[1],
      min: (attrs.match(/min="([^"]+)"/) || [])[1],
      max: (attrs.match(/max="([^"]+)"/) || [])[1],
    };
  }
  const select = /<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g;
  while ((m = select.exec(html))) {
    const chosen = m[2].match(/<option value="([^"]+)"\s+selected/);
    if (chosen) out[m[1]] = Object.assign(out[m[1]] || {}, { value: chosen[1] });
  }
  return out;
}

// Every 2D-context method is a no-op; the few that must return something return
// a plausible shape. A Proxy keeps this to a few lines instead of a long list.
function createContext2D() {
  const state = {
    canvas: null, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    textAlign: '', textBaseline: '', globalAlpha: 1,
    shadowColor: '', shadowBlur: 0, lineCap: '', lineJoin: '',
  };
  const imageData = (w, h) => ({
    data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h,
  });
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (key === 'getImageData') return (x, y, w, h) => imageData(w, h);
      if (key === 'createImageData') return (w, h) => imageData(w, h);
      if (key === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function createDocument(controlDefaults) {
  const byId = new Map();

  function createElement(id, tagName) {
    const listeners = {};
    const el = {
      id,
      tagName: (tagName || 'div').toUpperCase(),
      nodeName: (tagName || 'div').toUpperCase(),
      value: controlDefaults[id] && controlDefaults[id].value !== undefined
        ? controlDefaults[id].value : '0',
      min: controlDefaults[id] ? controlDefaults[id].min : undefined,
      max: controlDefaults[id] ? controlDefaults[id].max : undefined,
      textContent: '', innerHTML: '', style: {}, dataset: {}, children: [],
      width: 600, height: 300, _w: 600, _h: 300,

      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener() {},
      // Test helper: fire a listener the module registered.
      dispatch(type, event) {
        for (const fn of listeners[type] || []) {
          fn(event || { target: el, preventDefault() {} });
        }
      },

      setAttribute(name, value) { if (name === 'max') el.max = value; el['attr:' + name] = value; },
      getAttribute(name) { return el['attr:' + name]; },
      removeAttribute() {},
      appendChild(child) { el.children.push(child); return child; },
      removeChild() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() {}, select() {}, blur() {},
      setPointerCapture() {}, releasePointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 300 }; },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getContext() {
        if (!el._ctx) { el._ctx = createContext2D(); el._ctx.canvas = el; }
        return el._ctx;
      },
    };
    return el;
  }

  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, createElement(id));
      return byId.get(id);
    },
    createElement(tagName) { return createElement('<' + tagName + '>', tagName); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    body: createElement('body', 'body'),
    head: createElement('head', 'head'),
    documentElement: createElement('html', 'html'),
    activeElement: null,
    execCommand() { return true; },
    _elementCount: () => byId.size,
  };
}

const IIFE_HEAD = '(() => {';
const IIFE_TAIL = '})();';

/**
 * Boot one of the site's scripts in a fake browser.
 *
 * @param {string} repoRoot          repository root
 * @param {string} jsFile            e.g. 'simulation.js'
 * @param {string} htmlFile          the page that hosts it, used for control defaults
 * @param {object} [opts]
 * @param {string} [opts.hash]       location.hash to boot with, without the '#'
 * @param {string} [opts.expose]     a JS object literal evaluated inside the module's
 *                                   scope, e.g. '{ params, step, get cars(){return cars;} }'.
 *                                   When given, the IIFE wrapper is stripped so the
 *                                   expression can see the module's internals.
 * @returns {{internals: object|null, el: function, elementCount: function, frames: function}}
 */
function loadModule(repoRoot, jsFile, htmlFile, opts) {
  const options = opts || {};
  const html = fs.readFileSync(path.join(repoRoot, htmlFile), 'utf8');
  let source = fs.readFileSync(path.join(repoRoot, jsFile), 'utf8');

  if (options.expose) {
    const head = source.indexOf(IIFE_HEAD);
    const tail = source.lastIndexOf(IIFE_TAIL);
    if (head !== 0 || tail < 0) {
      throw new Error(`${jsFile}: expected the file to be wrapped in ${IIFE_HEAD} ... ${IIFE_TAIL}`);
    }
    source = source.slice(head + IIFE_HEAD.length, tail) +
      `\n;globalThis.__internals = ${options.expose};\n`;
  }

  const document = createDocument(scrapeControlDefaults(html));
  const pendingFrames = [];
  const storage = {};
  let clock = 1000;   // virtual performance.now(), in ms

  const sandbox = {
    document, console,
    Math, JSON, Date, Number, String, Object, Array, Boolean, Error,
    isFinite, isNaN, parseFloat, parseInt,
    Float32Array, Float64Array, Uint8ClampedArray, Set, Map, URLSearchParams,
    performance: { now: () => clock },
    requestAnimationFrame(fn) { return pendingFrames.push(fn); },
    cancelAnimationFrame() {},
    setTimeout() { return 0; },      // suppress the debounced URL/storage writes
    clearTimeout() {},
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    location: {
      hash: options.hash ? '#' + options.hash : '',
      href: 'http://localhost/', pathname: '/', hostname: 'localhost',
    },
    history: { replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.window.devicePixelRatio = 1;
  sandbox.window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: jsFile });

  return {
    internals: sandbox.__internals || null,
    el: (id) => document.getElementById(id),
    elementCount: () => document._elementCount(),
    /** Drive the render loop. `msPerFrame` advances the virtual clock. */
    frames(count, msPerFrame) {
      const step = msPerFrame || 50;   // 50 ms saturates the module's own dt cap
      let ran = 0;
      for (let i = 0; i < count && pendingFrames.length; i++) {
        const fn = pendingFrames.shift();
        clock += step;
        fn(clock);
        ran++;
      }
      return ran;
    },
  };
}

module.exports = { loadModule };
