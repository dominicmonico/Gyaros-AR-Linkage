const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const decimateCheckbox = document.getElementById('decimate');
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

