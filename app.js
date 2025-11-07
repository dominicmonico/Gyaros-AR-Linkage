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

        //const detections = detectMarkers(gray, frame.width, frame.height);

        //overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
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

startButton.addEventListener('click', startCamera);
stopButton.addEventListener('click', stopCamera);
window.addEventListener('beforeunload', stopCamera);