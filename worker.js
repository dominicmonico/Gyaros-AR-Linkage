// worker.js (fast runtime fix)
// Top-level: import loader for worker environment
postMessage({ type: 'worker-started' });
try {
  importScripts('apriltag_wasm.js'); // use exact loader filename shown in Network
  postMessage({ type: 'debug', msg: 'importScripts succeeded' });
} catch (err) {
  postMessage({ type: 'error', error: 'importScripts threw: ' + String(err) });
}

// shared state
let module = null;
let detectorPtr = 0;
let imgPtr = 0;
let imgSize = 0;

// cached wrappers
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

// init helper (handles AprilTagWasm namespace, factory, or Module global)
async function initModuleFromLoader() {
  if (typeof AprilTagWasm !== 'undefined' && AprilTagWasm) {
    const maybe = AprilTagWasm.Module || AprilTagWasm;
    if (maybe && maybe.ready && typeof maybe.ready.then === 'function') {
      await maybe.ready;
      return maybe;
    }
    if (typeof AprilTagWasm === 'function') {
      return await AprilTagWasm();
    }
    return maybe;
  }
  if (typeof ApriltagModule === 'function') {
    return await ApriltagModule();
  }
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

// probe and create family safely
function findAndCreateFamily(mod, familyNames = ['tag36h11_create','tag16h5_create','tag25h9_create','tag36h10_create']) {
  // helper: try cwrap then raw underscore
  for (const name of familyNames) {
    if (typeof mod.cwrap === 'function') {
      try {
        const fn = mod.cwrap(name, 'number', []);
        if (typeof fn === 'function') {
          const ptr = fn();
          postMessage({ type: 'debug', msg: `family created via cwrap: ${name} -> ${ptr}` });
          return ptr;
        }
      } catch (e) { /* missing */ }
    }
    const raw = '_' + name;
    if (raw in mod && typeof mod[raw] === 'function') {
      try {
        const ptr = mod[raw]();
        postMessage({ type: 'debug', msg: `family created via raw export: ${raw} -> ${ptr}` });
        return ptr;
      } catch (e) { /* call failed */ }
    }
  }

  // scan for any "tag...create" symbol (raw or wrapped)
  const scan = Object.keys(mod).find(k => /tag.*create/i.test(k));
  if (scan) {
    try {
      if (scan[0] === '_') {
        const ptr = mod[scan]();
        postMessage({ type: 'debug', msg: `family created via scanned raw: ${scan} -> ${ptr}` });
        return ptr;
      } else {
        try {
          const fn = mod.cwrap(scan, 'number', []);
          const ptr = fn();
          postMessage({ type: 'debug', msg: `family created via scanned cwrap: ${scan} -> ${ptr}` });
          return ptr;
        } catch (e) {
          if (typeof mod[scan] === 'function') {
            const ptr = mod[scan]();
            postMessage({ type: 'debug', msg: `family created via scanned function: ${scan} -> ${ptr}` });
            return ptr;
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  postMessage({ type: 'debug', msg: 'No family create function found. Module keys sample: ' + Object.keys(mod).slice(0,80).join(',') });
  return 0;
}

// safe lookup helper: returns { fn } or null
function safeCwrapOrRaw(name, returnType = 'number', argTypes = []) {
  if (typeof module.cwrap === 'function') {
    try {
      const fn = module.cwrap(name, returnType, argTypes);
      if (typeof fn === 'function') return { type: 'cwrap', fn };
    } catch (e) { /* not exported via cwrap */ }
  }
  const raw = '_' + name;
  if (raw in module && typeof module[raw] === 'function') {
    return { type: 'raw', fn: (...args) => module[raw](...args) };
  }
  return null;
}

// setup detector and all wrappers (called after module assigned)
function setupDetectorAndCwraps() {
  // create detector (safe)
  const createDetector = safeCwrapOrRaw('apriltag_detector_create', 'number', []);
  if (!createDetector) throw new Error('apriltag_detector_create not exported; see module-candidate-keys debug.');
  detectorPtr = createDetector.fn();

  // create family
  const familyPtr = findAndCreateFamily(module, ['tag36h11_create','tag16h5_create','tag25h9_create','tag36h10_create']);
  if (!familyPtr) throw new Error('No usable tag family create function found in module');

  // add family (try a couple of likely names)
  const addFamily = safeCwrapOrRaw('apriltag_detector_add_family_bits', 'void', ['number','number'])
                 || safeCwrapOrRaw('apriltag_detector_add_family', 'void', ['number','number']);
  if (!addFamily) throw new Error('add-family function not exported; see module-candidate-keys debug.');
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
    // post candidate keys for debugging then throw
    const keys = Object.keys(module || {}).filter(k => /apriltag|tag|detect|create|_apriltag|_tag|_detect/i.test(k));
    postMessage({ type: 'debug', msg: 'Missing detection APIs. Candidate keys: ' + keys.join(',') });
    throw new Error('Missing one or more detection API exports; see module-candidate-keys debug.');
  }

  cwrapFns.detectFn = detectWrap.fn;
  cwrapFns.sizeFn   = sizeWrap.fn;
  cwrapFns.getFn    = getWrap.fn;
  cwrapFns.idFn     = idWrap.fn;
  cwrapFns.pxFn     = pxWrap.fn;
  cwrapFns.pyFn     = pyWrap.fn;
  cwrapFns.destroyFn= destroyWrap.fn;

  postMessage({ type: 'debug', msg: 'Detector setup done, detectorPtr=' + detectorPtr });
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

    // debug: list keys that look relevant so you can see actual exports
    const keys = Object.keys(module || {}).filter(k => /apriltag|tag|detect|create|_apriltag|_tag|_detect/i.test(k));
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
    if (!module || !detectorPtr) {
      postMessage({ type: 'result', detections: [] });
      return;
    }

    const image = msg.image;
    if (!image || !image.data || !image.width || !image.height) {
      postError('Invalid image message to worker');
      return;
    }

    // Normalize to Uint8Array grey buffer
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

    if (bytesNeeded > imgSize) {
      if (imgPtr) module._free(imgPtr);
      imgPtr = module._malloc(bytesNeeded);
      imgSize = bytesNeeded;
    }

    // debug sample
    const checksum = (data[0] || 0) + (data[1] || 0) + (data[2] || 0) + (data[3] || 0);
    postMessage({ type: 'debug', imgInfo: { width, height, len: data.length, checksum } });

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
