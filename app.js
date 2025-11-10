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

const atWorker = new Worker('worker.js');
let workerReady = false;
atWorker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'ready') {
        workerReady = true;
        console.log('AprilTag worker ready');
    } else if (m.type === 'result') {
        // receive detections for the last frame
        const detections = m.detections;
        // draw them (call your drawDetections)
        overlayCtx.clearRect(0,0,overlay.width, overlay.height);
        drawDetections(overlayCtx, detections);
    } else if (m.type === 'error') {
        console.error('Worker error', m.error);
    }
};
atWorker.postMessage({ type: 'init' });

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

    const waitForWorker = () => new Promise(resolve => {
    if (workerReady){
        return resolve();
    } 
    const to = setTimeout(() => { console.warn('worker init timeout'); resolve(); }, 3000);
    const onReady = (ev) => {
        if (ev.data && ev.data.type === 'ready') {
        atWorker.removeEventListener('message', onReady);
        clearTimeout(to);
        resolve();
        }
    };
    atWorker.addEventListener('message', onReady);
    });
    await waitForWorker();

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
    if (overlayCtx && Array.isArray(m.detections)) {
        overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
        drawDetections(overlayCtx, m.detections);
    }
    stopButton.disabled = true;
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
}

function startLoop() {
    function step() {
        rafId = requestAnimationFrame(step);
        if (!video || video.readyState < 2) return;

        const cw = hiddenCanvas.width;
        const ch = hiddenCanvas.height;

        hiddenCtx.drawImage(video, 0, 0, cw, ch);
        const frame = hiddenCtx.getImageData(0, 0, cw, ch);
        const gray = rgbaToGray(frame.data, frame.width, frame.height);

        // Send the grayscale buffer to the worker for detection.
        // Transfer the underlying ArrayBuffer to avoid copying (high-performance).
        // After transfer the buffer is neutered here; we allocate a fresh gray on next frame (rgbaToGray returns a new Uint8Array).
        try {
        atWorker.postMessage({ type: 'detect', image: { data: gray, width: cw, height: ch } }, [gray.buffer]);
        } catch (e) {
        // Fallback if transfer isn't supported or fails: send without transferring (copy)
        atWorker.postMessage({ type: 'detect', image: { data: gray, width: cw, height: ch } });
        }

        // Note: do NOT clear or draw detections here. The worker will post back results and
        // your atWorker.onmessage handler already calls drawDetections when results arrive.
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