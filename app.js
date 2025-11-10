const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const status = document.getElementById('status');

let stream = null;
let rafId = null;
let hiddenCanvas = null;
let hiddenCtx = null;
let overlayCtx = null;
let processing = false;

let AT = {
  module: null,
  detectorPtr: 0,
  imgPtr: 0,
  imgSize: 0,
  initialized: false
};

async function initAprilTag() {
    if(typeof ApriltagModule === 'function'){
        AT.module = await ApriltagModule();
    } 
    else if (window.Module){
        AT.module = window.Module;
        if (AT.module.onRuntimeInitialized) {
            await new Promise(resolve => {
                const prev = AT.module.onRuntimeInitialized;
                AT.module.onRuntimeInitialized = () => { prev && prev(); resolve(); };
            });
        }
    }
    else {
        throw new Error('AprilTag loader not found. Ensure apriltag.js is loaded.');
    }

    const cwrap = AT.module.cwrap;

    // Create tag family and detector (common C API names)
    const tag16h5_create = cwrap('tag16h5_create', 'number', []);
    const apriltag_detector_create = cwrap('apriltag_detector_create', 'number', []);
    const apriltag_detector_add_family_bits = cwrap('apriltag_detector_add_family_bits', null, ['number','number']);

    const family = tag16h5_create();
    AT.detectorPtr = apriltag_detector_create();
    apriltag_detector_add_family_bits(AT.detectorPtr, family);

    AT.initialized = true;
    console.log('AprilTag initialized (tag16h5)');
}

async function startCamera() {
  try {
    const constraints = { video: { facingMode: 'environment' }, audio: false };
    stream = await navigator.mediaDevices.getUserMedia(constraints);

    // attach stream and ensure autoplay on mobile
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    // wait for metadata or the first frame so videoWidth/videoHeight are valid
    await new Promise(resolve => {
      if (video.readyState >= 1 && video.videoWidth && video.videoHeight) return resolve();
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('playing', resolve, { once: true });
    });

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;

    // create hidden canvas sized to actual video pixel dimensions
    hiddenCanvas = document.createElement('canvas');
    hiddenCanvas.width = vw;
    hiddenCanvas.height = vh;
    hiddenCtx = hiddenCanvas.getContext('2d');

    // make sure overlay canvas has sensible numeric dimensions (not undefined/0)
    overlay.width = vw;
    overlay.height = vh;
    overlay.style.width = video.clientWidth + 'px';
    overlay.style.height = video.clientHeight + 'px';
    overlayCtx = overlay.getContext('2d');

    overlay.style.position = 'absolute';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.pointerEvents = 'none';
    overlay.style.background = 'transparent';

    await(initAprilTag());

    startLoop();
    startButton.disabled = true;
    stopButton.disabled = false;
    status.textContent = 'running';
  } catch (err) {
    console.error('camera error', err);
    status.textContent = 'camera error';
  }
}


function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
    }
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
    if (overlayCtx) {
        overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    }
    stopButton.disabled = true;
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
}

function startLoop() {
    function step() {
        if (!video || video.readyState < 2){
            rafId = requestAnimationFrame(step);
            return;
        }

        const cw = hiddenCanvas.width;
        const ch = hiddenCanvas.height;

        hiddenCtx.drawImage(video, 0, 0, hiddenCanvas.width, hiddenCanvas.height);

        const frame = hiddenCtx.getImageData(0, 0, cw, ch);
        const gray = rgbaToGray(frame.data, frame.width, frame.height);

        const detections = detectAprilTags(gray, cw, ch)

        overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
        //drawDetections(overlayCtx, detections);

        rafId = requestAnimationFrame(step);
    }
    rafId = requestAnimationFrame(step);
}

function rgbaToGray(rgba, width, height) {
    const len = width * height;
    const out = new Uint8Array(len);
    let ri = 0;
    for (let i = 0; i < len; i++, ri += 4) {
        out[i] = Math.round(rgba[ri] * 0.299 + rgba[ri+1] * 0.587 + rgba[ri+2] * 0.114);
    }
    return out;
}

function detectAprilTags(gray, width, height) {
    if(!AT.initialized || !AT.module || !AT.detectorPtr) return [];

    const module = AT.module;
    const cwrap = module.cwrap;

    const bytesNeeded = width * height;
    if(bytesNeeded > AT.imgSize){
        if(AT.imgPtr){
            module._free(AT.imgPtr);
        }
        AT.imgPtr = module._malloc(bytesNeeded);
        AT.imgSize = bytesNeeded;
    }

    module.HEAPU8.set(gray, AT.imgPtr);

    const detect = cwrap("apriltag_detector_detect", 'number', ['number', 'number', 'number', 'number']);
    const detectionsPtr = detect(AT.detectorPtr, AT.imgPtr, width, height);
    if (!detectionsPtr) return [];

    const getSize = cwrap('apriltag_detections_size', 'number', ['number']);
    const getDet = cwrap('apriltag_detections_get', 'number', ['number', 'number']);
    const getId = cwrap('apriltag_detection_id', 'number', ['number']);
    const getPx = cwrap('apriltag_detection_px', 'number', ['number', 'number']);
    const getPy = cwrap('apriltag_detection_py', 'number', ['number', 'number']);
    const destroyList = cwrap('apriltag_detection_list_destroy', null, ['number']);

    const count = getSize(detectionsPtr);
    const detections = [];

    for(let i = 0; i < count; i++){
        const detPtr = getDet(detectionsPtr, i);
        const id = getId(detPtr);
        const corners = [];
        for(let j = 0; j < 4; j++){
            const px = getPx(detPtr, j);
            const py = getPy(detPtr, j);
            corners.push({x: px, y: py});
        }
        const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
        const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
        detections.push({id, corners, center: {x: cx, y: cy}});
    }
    destroyList(detectionsPtr);
    return detections;
}

function drawDetections(ctx, detections) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'lime';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = '18px sans-serif';

    detections.forEach(d => {
        const c = d.corners;
        ctx.beginPath();
        ctx.moveTo(c[0].x, c[0].y);
        ctx.lineTo(c[1].x, c[1].y);
        ctx.lineTo(c[2].x, c[2].y);
        ctx.lineTo(c[3].x, c[3].y);
        ctx.closePath();
        ctx.stroke();

        const label = `id:${d.id}`;
        const px = d.center.x, py = d.center.y;
        const metrics = ctx.measureText(label);
        const pad = 8;
        const w = metrics.width + pad;
        const h = 22;
        ctx.fillRect(px - w/2, py - h/2, w, h);
        ctx.fillStyle = 'lime';
        ctx.fillText(label, px - metrics.width/2, py + 6);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
    });
}


startButton.addEventListener('click', startCamera);
stopButton.addEventListener('click', stopCamera);
window.addEventListener('beforeunload', stopCamera);