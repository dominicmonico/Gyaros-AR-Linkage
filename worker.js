// worker.js
postMessage({ type: 'worker-started' });

try {
  importScripts('apriltag_wasm.js');
  postMessage({ type: 'debug', msg: 'importScripts succeeded' });
} catch (err) {
  postMessage({ type: 'error', error: 'importScripts threw: ' + String(err) });
}

// shared state
let module = null;
let detectorPtr = 0;
let imgPtr = 0;
let imgSize = 0;

let cwrapFns = {
  detectFn: null,
  sizeFn: null,
  getFn: null,
  idFn: null,
  pxFn: null,
  pyFn: null,
  destroyFn: null
};

function postError(msg) {
  postMessage({ type: 'error', error: String(msg) });
}

// initialize module (handles AprilTagWasm namespace, factory, or Module global)
async function initModuleFromLoader() {
  if (typeof AprilTagWasm !== 'undefined' && AprilTagWasm) {
    const maybe = AprilTagWasm.Module || AprilTagWasm;
    if (maybe && maybe.ready && typeof maybe.ready.then === 'function') {
      await maybe.ready;
      return maybe;
    }
    if (typeof AprilTagWasm === 'function') return await AprilTagWasm();
    return maybe;
  }
  if (typeof ApriltagModule === 'function') return await ApriltagModule();
  if (typeof Module !== 'undefined') {
    const m = Module;
    if (m.onRuntimeInitialized) {
      await new Promise(resolve => {
        const prev = m.onRuntimeInitialized;
        m.onRuntimeInitialized = () => { prev && prev(); resolve(); };
      });
    }
    return m;
  }
  throw new Error('No apriltag loader found in worker (checked AprilTagWasm, ApriltagModule, Module)');
}

// safe lookup: try cwrap(name) then raw _name; returns {fn} or null
function safeCwrapOrRaw(name, returnType = 'number', argTypes = []) {
  try {
    if (module && typeof module.cwrap === 'function') {
      try {
        const fn = module.cwrap(name, returnType, argTypes);
        if (typeof fn === 'function') return { type: 'cwrap', fn };
      } catch (e) {
        // missing via cwrap
      }
    }
    const raw = '_' + name;
    if (module && raw in module && typeof module[raw] === 'function') {
      return { type: 'raw', fn: (...args) => module[raw](...args) };
    }
  } catch (e) {}
  return null;
}

// build-adapter: checks for atagjs_* style exports and wraps them
function buildAdapterIfAtagjs() {
  const keys = Object.keys(module || {});
  const hasAtag = keys.some(k => /^_?atagjs_/i.test(k));
  if (!hasAtag) return null;

  // helper wrapper
  function wrap(name) {
    const short = name.replace(/^_/, '');
    if (typeof module.cwrap === 'function') {
      try {
        const fn = module.cwrap(short, 'number', []);
        if (typeof fn === 'function') return fn;
      } catch (e) {}
    }
    const raw = '_' + short;
    if (raw in module && typeof module[raw] === 'function') {
      return (...args) => module[raw](...args);
    }
    return null;
  }

  // Based on your build keys, try to map the common functions
  return {
    init: wrap('atagjs_init'),
    destroy: wrap('atagjs_destroy'),
    set_img_buffer: wrap('atagjs_set_img_buffer'), // likely (ptr,w,h)
    set_tag_size: wrap('atagjs_set_tag_size'),
    detect: wrap('atagjs_detect'),
    // If your build exposes helpers to read results, they will appear in keys
    keys
  };
}

// try to discover and wire the canonical apriltag API or the atagjs adapter
function setupDetectorAndCwraps() {
  // prefer canonical apriltag_* exports when present
  const createDetector = safeCwrapOrRaw('apriltag_detector_create', 'number', []);
  if (createDetector) {
    detectorPtr = createDetector.fn();

    // create & add family (probe a few family names)
    const familyNames = ['tag36h11_create','tag16h5_create','tag25h9_create','tag36h10_create'];
    let familyPtr = 0;
    for (const fnName of familyNames) {
      const fwrap = safeCwrapOrRaw(fnName, 'number', []);
      if (fwrap) {
        try { familyPtr = fwrap.fn(); postMessage({ type: 'debug', msg: 'family created via ' + fnName + ' -> ' + familyPtr }); break; } catch(e) {}
      }
      const raw = '_' + fnName;
      if (raw in module && typeof module[raw] === 'function') {
        try { familyPtr = module[raw](); postMessage({ type: 'debug', msg: 'family created via raw ' + raw + ' -> ' + familyPtr }); break; } catch(e) {}
      }
    }
    if (!familyPtr) throw new Error('No tag-family creator found in module');

    // add family
    const addFamily = safeCwrapOrRaw('apriltag_detector_add_family_bits', 'void', ['number','number'])
                   || safeCwrapOrRaw('apriltag_detector_add_family', 'void', ['number','number']);
    if (!addFamily) throw new Error('add-family function not exported');

    addFamily.fn(detectorPtr, familyPtr);

    // detection cwraps
    const detectWrap = safeCwrapOrRaw('apriltag_detector_detect', 'number', ['number','number','number','number']);
    const sizeWrap   = safeCwrapOrRaw('apriltag_detections_size', 'number', ['number']);
    const getWrap    = safeCwrapOrRaw('apriltag_detections_get', 'number', ['number','number']);
    const idWrap     = safeCwrapOrRaw('apriltag_detection_id', 'number', ['number']);
    const pxWrap     = safeCwrapOrRaw('apriltag_detection_px', 'number', ['number','number']);
    const pyWrap     = safeCwrapOrRaw('apriltag_detection_py', 'number', ['number','number']);
    const destroyWrap= safeCwrapOrRaw('apriltag_detection_list_destroy', 'void', ['number']);

    if (!detectWrap || !sizeWrap || !getWrap || !idWrap || !pxWrap || !pyWrap || !destroyWrap) {
      const keys = Object.keys(module || {}).filter(k => /apriltag|tag|detect|create|_apriltag|_tag|_detect/i.test(k));
      postMessage({ type: 'debug', msg: 'Missing detection APIs. Candidate keys: ' + keys.join(',') });
      throw new Error('Missing one or more detection API exports');
    }

    cwrapFns.detectFn = detectWrap.fn;
    cwrapFns.sizeFn   = sizeWrap.fn;
    cwrapFns.getFn    = getWrap.fn;
    cwrapFns.idFn     = idWrap.fn;
    cwrapFns.pxFn     = pxWrap.fn;
    cwrapFns.pyFn     = pyWrap.fn;
    cwrapFns.destroyFn= destroyWrap.fn;

    postMessage({ type: 'debug', msg: 'Canonical apriltag API wired, detectorPtr=' + detectorPtr });
    return;
  }

  // fallback: adapt to atagjs_* style build present in your module
  const adapter = buildAdapterIfAtagjs();
  if (adapter) {
    postMessage({ type: 'debug', msg: 'Using atagjs adapter; keys sample count=' + adapter.keys.length });

    // minimal usage path for atagjs-style API:
    // we will call init (if present), then for each frame copy image into WASM heap
    // then call set_img_buffer(ptr,w,h) and detect(); reading results depends on build-specific helpers.
    // Wire generic wrappers that worker.detect handler will use:
    cwrapFns.atag = adapter;
    return;
  }

  // neither API found
  const keys = Object.keys(module || {}).slice(0,80);
  postMessage({ type: 'debug', msg: 'No usable apriltag or atagjs API found. module keys sample: ' + keys.join(',') });
  throw new Error('No usable API exported by module');
}

// helper: read number from HEAP (signed or unsigned) — used only if build returns pointers to result buffers
function readFloat64(ptr) {
  return module ? module.getValue(ptr, 'double') : 0;
}

// main message handler
self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === 'init') {
    try {
      module = await initModuleFromLoader();
    } catch (err) {
      postError('No apriltag module found in worker: ' + String(err));
      return;
    }

    // debug: list candidate keys so we can see exact exports
    const keys = Object.keys(module || {}).filter(k => /apriltag|atagjs|tag|detect|create|_apriltag|_atag|_tag|_detect/i.test(k));
    postMessage({ type: 'debug', msg: 'module-candidate-keys: ' + keys.join(',') });

    if (!module || typeof module.cwrap !== 'function') {
      postError('Module loaded but module.cwrap not available. keys: ' + (Object.keys(module || {}).slice(0,20).join(',')));
      return;
    }

    try {
      setupDetectorAndCwraps();
    } catch (err) {
      postError('Detector setup failed: ' + String(err));
      return;
    }

    postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'detect') {
    if (!module) {
      postMessage({ type: 'result', detections: [] });
      return;
    }

    // If using atag adapter, handle separately (custom per-build)
    if (cwrapFns.atag) {
      const adapter = cwrapFns.atag;
      const image = msg.image;
      if (!image || !image.data || !image.width || !image.height) {
        postError('Invalid image message to worker');
        return;
      }

      // normalize buffer to Uint8Array (grayscale)
      let data = image.data;
      if (data instanceof Uint8ClampedArray) data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (!(data instanceof Uint8Array)) data = data && data.buffer ? new Uint8Array(data.buffer) : new Uint8Array(data);

      const width = image.width, height = image.height;
      const bytesNeeded = width * height;
      if (data.length < bytesNeeded) {
        postError('Gray buffer too small: ' + data.length + ' < ' + bytesNeeded);
        postMessage({ type: 'result', detections: [] });
        return;
      }

      if (bytesNeeded > imgSize) {
        if (imgPtr) module._free(imgPtr);
        imgPtr = module._malloc(bytesNeeded);
        imgSize = bytesNeeded;
      }

      module.HEAPU8.set(data.subarray(0, bytesNeeded), imgPtr);
      // try calling set_img_buffer(ptr,w,h)
      try {
        if (adapter.set_img_buffer) {
          adapter.set_img_buffer(imgPtr, width, height);
        } else if (adapter.setImgBuffer) {
          adapter.setImgBuffer(imgPtr, width, height);
        }
        // call detect (signature may vary; try both variants)
        let detectRes = null;
        if (adapter.detect) {
          detectRes = adapter.detect();
        } else if (adapter.atagjs_detect) {
          detectRes = adapter.atagjs_detect();
        }
        postMessage({ type: 'debug', msg: 'atag detect result (opaque): ' + String(detectRes) });
        // Most atagjs builds return results in module memory or via additional getters.
        // Inspect module exports (candidate keys) and implement result extraction as needed.
        postMessage({ type: 'result', detections: [] });
        return;
      } catch (e) {
        postError('atag adapter detect failed: ' + String(e));
        postMessage({ type: 'result', detections: [] });
        return;
      }
    }

    // canonical apriltag flow
    const image = msg.image;
    if (!image || !image.data || !image.width || !image.height) {
      postError('Invalid image message to worker');
      return;
    }

    let data = image.data;
    if (data instanceof Uint8ClampedArray) data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (!(data instanceof Uint8Array)) data = data && data.buffer ? new Uint8Array(data.buffer) : new Uint8Array(data);

    const width = image.width, height = image.height;
    const bytesNeeded = width * height;
    if (data.length < bytesNeeded) {
      postError('Gray buffer too small: ' + data.length + ' < ' + bytesNeeded);
      postMessage({ type: 'result', detections: [] });
      return;
    }

    if (bytesNeeded > imgSize) {
      if (imgPtr) module._free(imgPtr);
      imgPtr = module._malloc(bytesNeeded);
      imgSize = bytesNeeded;
    }

    const checksum = (data[0] || 0) + (data[1] || 0) + (data[2] || 0) + (data[3] || 0);
    postMessage({ type: 'debug', imgInfo: { width, height, len: data.length, checksum } });

    module.HEAPU8.set(data.subarray(0, bytesNeeded), imgPtr);

    try {
      const detListPtr = cwrapFns.detectFn(detectorPtr, imgPtr, width, height);
      if (!detListPtr) { postMessage({ type: 'result', detections: [] }); return; }

      const count = cwrapFns.sizeFn(detListPtr);
      const out = [];
      for (let i = 0; i < count; i++) {
        const detPtr = cwrapFns.getFn(detListPtr, i);
        const id = cwrapFns.idFn(detPtr);
        const corners = [];
        for (let j = 0; j < 4; j++) {
          corners.push({ x: cwrapFns.pxFn(detPtr, j), y: cwrapFns.pyFn(detPtr, j) });
        }
        const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
        const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
        out.push({ id, corners, center: { x: cx, y: cy } });
      }

      cwrapFns.destroyFn(detListPtr);
      postMessage({ type: 'result', detections: out });
      return;
    } catch (e) {
      postError('Detection call failed: ' + String(e));
      postMessage({ type: 'result', detections: [] });
      return;
    }
  }

  postError('Unknown message type: ' + String(msg && msg.type));
};
