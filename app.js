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
        const contraints = { video: { facingmode : 'environment' }, audio: false };
        stream = await navigator.mediaDevices.getUserMedia(contraints);
        video.srcObject = stream;
        await video.play();

        hiddenCanvas = document.createElement('canvas');
        hiddenCanvas.width = video.videoWidth;
        hiddenCanvas.height = video.videoHeight;
        hiddenCtx = hiddenCanvas.getContext('2d');
        overlay.width = video.videoWidth;
        overlay.height = video.videoHeight;
        overlayCtx = overlay.getContext('2d');

        startLoop();
        startButton.disabled = true;
        stopButton.disabled = false;
    }
    catch (err) {
        console.error('camera error', err);
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
    startButton.disabled = false;
    stopButton.disabled = true;
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
}

function startLoop() {
    function step() {
        if (!video || video.readyState < 2){
            rafId = requestAnimationFrame(step);
            return;
        }

        hiddenCtx.drawImage(video, 0, 0, hiddenCanvas.width, hiddenCanvas.height);
        
        const frame = hiddenCtx.getImageData(0, 0, hiddenCanvas.width, hiddenCanvas.height);
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
        out[i] = (rgba[ri] * 0.299 + rgba[ri+1] * 0.587 + rgba[ri+2] * 0.114) | 0;
    }
    return out;
}