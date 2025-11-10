// worker.js
// Make sure this filename matches what your Network showed (e.g., 'apriltag_wasm.js')
// Keep importScripts at top-level (classic worker)
postMessage({ type: 'worker-started' });
try {
  importScripts('apriltag_wasm.js'); // use the exact loader filename shown in Network
  postMessage({ type: 'debug', msg: 'importScripts succeeded' });
} catch (err) {
  postMessage({ type: 'error', error: 'importScripts threw: ' + String(err) });
}

// shared module and detector state
let module = null;
let detectorPtr = 0;
let imgPtr = 0;
let imgSize = 0;

// cached cwraps to avoid calling cwrap repeatedly
let cwrapFns = {
  tagCreate: null,
  apriltag_detector_create: null,
  add_family_bits: null,
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

// helper to initialize the Emscripten module in common loader shapes
async function initModuleFromLoader() {
  // If loader exposes AprilTagWasm namespace with a ready promise
  if (typeof AprilTagWasm !== 'undefined' && AprilTagWasm) {
    const maybe = AprilTagWasm.Module || AprilTagWasm;
    if (maybe && maybe.ready && typeof maybe.ready.then === 'function') {
      await maybe.ready;
      return maybe;
    }
    // sometimes the wrapper itself is a factory function
    if (typeof AprilTagWasm === 'function') {
      return await AprilTagWasm();
    }
    // fallback: assume maybe is synchronous module container
    return maybe;
  }

  // Emscripten factory
  if (typeof ApriltagModule === 'function') {
    return await ApriltagModule();
  }

  // classic Module global
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

// robust family creator: try cwrap(name), then raw _name, then scan exports
function findAndCreateFamily(module, familyNames = ['tag36h11_create','tag16h5_create','tag25h9_create','tag36h10_create']) {
  for (const name of familyNames) {
    // 1) try module.cwrap (safe: cwrap throws if symbol missing, catch it)
    if (typeof module.cwrap === 'function') {
      try {
        const fn = module.cwrap(name, 'number', []);
        if (typeof fn === 'function') {
          const ptr = fn();
          postMessage({ type: 'debug', msg: `family created via cwrap: ${name} -> ptr ${ptr}` });
          return ptr;
        }
      } catch (e) {
        // symbol not found via cwrap
      }
    }

    // 2) try raw exported symbol (underscore-prefixed)
    const raw = '_' + name;
    if (raw in module && typeof module[raw] === 'function') {
      try {
        const ptr = module[raw]();
        postMessage({ type: 'debug', msg: `family created via raw export: ${raw} -> ptr ${ptr}` });
        return ptr;
      } catch (e) {
        // calling raw export failed
      }
    }
  }

  // 3) scan module keys for anything that looks like a tag-family creator
  const scan = Object.keys(module).find(k => /tag.*create/i.test(k));
  if (scan) {
    try {
      // if it's raw (starts with _), call it; else try cwrap then raw fallback
      if (scan[0] === '_') {
        const ptr = module[scan]();
        postMessage({ type: 'debug', msg: `family created via scanned raw: ${scan} -> ptr ${ptr}` });
        return ptr;
      } else {
        try {
          const fn = module.cwrap(scan, 'number', []);
          const ptr = fn();
          postMessage({ type: 'debug', msg: `family created via scanned cwrap: ${scan} -> ptr ${ptr}` });
          return ptr;
        } catch (e) {
          // fallback raw call if available
          if (typeof module[scan] === 'function') {
            const ptr = module[scan]();
            postMessage({ type: 'debug', msg: `family created via scanned function: ${scan} -> ptr ${ptr}` });
            return ptr;
          }
        }
      }
    } catch (e) {
      // ignore and continue
    }
  }

  // nothing found
  postMessage({ type: 'debug', msg: 'No family create function found. Module keys sample: ' + Object.keys(module).slice(0,80).join(',') });
  return 0;
}

function setupDetectorAndCwraps() {
  const cwrap = module.cwrap.bind(module);

  // detection helper cwraps (create wrappers but don't call them yet)
  cwrapFns.apriltag_detector_create = cwrap('apriltag_detector_create', 'number', []);
  cwrapFns.add_family_bits = cwrap('apriltag_detector_add_family_bits', 'void', ['number','number']);

  // find and create family using the now-initialized module
  const familyPtr = findAndCreateFamily(module, ['tag36h11_create','tag16h5_create','tag25h9_create','tag36h10_create']);
  if (!familyPtr) throw new Error('No usable tag family create function found in module');

  // create detector and attach family
  detectorPtr = cwrapFns.apriltag_detector_create();
  cwrapFns.add_family_bits(detectorPtr, familyPtr);

  // cached detection cwraps
  cwrapFns.detectFn = cwrap('apriltag_detector_detect', 'number', ['number','number','number','number']);
  cwrapFns.sizeFn = cwrap('apriltag_detections_size', 'number', ['number']);
  cwrapFns.getFn = cwrap('apriltag_detections_get', 'number', ['number','number']);
  cwrapFns.idFn = cwrap('apriltag_detection_id', 'number', ['number']);
  cwrapFns.pxFn = cwrap('apriltag_detection_px', 'number', ['number','number']);
  cwrapFns.pyFn = cwrap('apriltag_detection_py', 'number', ['number','number']);
  cwrapFns.destroyFn = cwrap('apriltag_detection_list_destroy', 'void', ['number']);

  postMessage({ type: 'debug', msg: 'Detector setup done, detectorPtr=' + detectorPtr });
}

// message handler (async so we can await loader promises)
self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === 'init') {
    try {
      module = await initModuleFromLoader();
    } catch (err) {
      postError('No apriltag module found in worker: ' + String(err));
      return;
    }

    if (!module || typeof module.cwrap !== 'function') {
      postError('Module loaded but module.cwrap not available. keys: ' + Object.keys(module || {}).slice(0,20).join(','));
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
    if (!module || !detectorPtr) {
      postMessage({ type: 'result', detections: [] });
      return;
    }

    const image = msg.image;
    if (!image || !image.data || !image.width || !image.height) {
      postError('Invalid image message to worker');
      return;
    }

    // Normalize data to Uint8Array
    let data = image.data;
    if (data instanceof Uint8ClampedArray) {
      data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (!(data instanceof Uint8Array)) {
      if (data && data.buffer) data = new Uint8Array(data.buffer);
      else data = new Uint8Array(data);
    }

    const width = image.width;
    const height = image.height;
    const bytesNeeded = width * height;
    if (data.length < bytesNeeded) {
      postError('Gray buffer too small: ' + data.length + ' < ' + bytesNeeded);
      postMessage({ type: 'result', detections: [] });
      return;
    }

    // allocate or reallocate image buffer in wasm heap
    if (bytesNeeded > imgSize) {
      if (imgPtr) module._free(imgPtr);
      imgPtr = module._malloc(bytesNeeded);
      imgSize = bytesNeeded;
    }

    // debug sample
    const checksum = data[0] + data[1] + data[2] + data[3];
    postMessage({ type: 'debug', imgInfo: { width, height, len: data.length, checksum } });

    // copy into wasm heap
    module.HEAPU8.set(data.subarray(0, bytesNeeded), imgPtr);

    // call detector
    const detListPtr = cwrapFns.detectFn(detectorPtr, imgPtr, width, height);
    if (!detListPtr) {
      postMessage({ type: 'result', detections: [] });
      return;
    }

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
  }

  postError('Unknown message type: ' + String(msg && msg.type));
};
