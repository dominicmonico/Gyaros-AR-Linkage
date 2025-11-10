importScripts('apriltag.js');

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

self.onmessage = async (ev) => {
    const msg = ev.data;
    if (msg.type === 'init') {
        if (typeof ApriltagModule === 'function') {
            module = await ApriltagModule();
        } 
        else if (self.Module) {
            module = self.Module;
            await new Promise(resolve => {
                if (module.onRuntimeInitialized) {
                    const prev = module.onRuntimeInitialized;
                    module.onRuntimeInitialized = () => {prev && prev(); resolve();}
                }
                else{
                    resolve();
                }
            });
        }
        else {
            postMessage({ type: 'error', error: 'No apriltag module found in worker' });
            return;
        }

        const tag16h5_create = module.cwrap('tag16h5_create', 'number', []);
        const apriltag_detector_create = module.cwrap('apriltag_detector_create', 'number', []);
        const apriltag_detector_add_family_bits = module.cwrap('apriltag_detector_add_family_bits', null, ['number','number']);

        const family = tag16h5_create();
        detectorPtr = apriltag_detector_create();
        apriltag_detector_add_family_bits(detectorPtr, family);

        cwrapFns.detectFn = module.cwrap('apriltag_detector_detect', 'number', ['number', 'number', 'number', 'number']);
        cwrapFns.sizeFn = module.cwrap('apriltag_detections_size', 'number', ['number']);
        cwrapFns.getFn = module.cwrap('apriltag_detections_get', 'number', ['number', 'number']);
        cwrapFns.idFn = module.cwrap('apriltag_detection_id', 'number', ['number']);
        cwrapFns.pxFn = module.cwrap('apriltag_detection_px', 'number', ['number', 'number']);
        cwrapFns.pyFn = module.cwrap('apriltag_detection_py', 'number', ['number', 'number']);
        cwrapFns.destroyFn = module.cwrap('apriltag_detection_list_destroy', 'void', ['number']);

        postMessage({type:'ready'});
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

        // Normalize data to Uint8Array (accept Uint8Array or Uint8ClampedArray or ArrayBuffer)
        let data = image.data;
        if (data instanceof Uint8ClampedArray || data instanceof Uint8Array) {
            // create a Uint8Array view if it's clamped; copy only if necessary
            if (data instanceof Uint8ClampedArray) data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else if (data && data.buffer) {
            data = new Uint8Array(data.buffer);
        } else {
            data = new Uint8Array(data);
        }

        const width = image.width;
        const height = image.height;
        const bytesNeeded = width * height;
        if (bytesNeeded > imgSize) {
            if (imgPtr) module._free(imgPtr);
            imgPtr = module._malloc(bytesNeeded);
            imgSize = bytesNeeded;
        }

        // copy into wasm heap (sized in bytesNeeded)
        module.HEAPU8.set(data.subarray(0, bytesNeeded), imgPtr);

        // call detector
        const detectFn = cwrapFns.detectFn;
        if (!detectFn) {
            postError('detect function not available in worker; check apriltag build');
            return;
        }

        const detListPtr = detectFn(detectorPtr, imgPtr, width, height);
        if (!detListPtr) {
            postMessage({ type: 'result', detections: [] });
            return;
        }

        // read detections
        const sizeFn = cwrapFns.sizeFn;
        const getFn = cwrapFns.getFn;
        const idFn = cwrapFns.idFn;
        const pxFn = cwrapFns.pxFn;
        const pyFn = cwrapFns.pyFn;
        const destroyFn = cwrapFns.destroyFn;

        const count = sizeFn(detListPtr);
        const out = [];
        for (let i = 0; i < count; i++) {
            const detPtr = getFn(detListPtr, i);
            const id = idFn(detPtr);
            const corners = [];
            for (let j = 0; j < 4; j++) {
            corners.push({ x: pxFn(detPtr, j), y: pyFn(detPtr, j) });
            }
            const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
            const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
            out.push({ id, corners, center: { x: cx, y: cy } });
        }

        destroyFn(detListPtr);
        postMessage({ type: 'result', detections: out });
        return;
    }
};

