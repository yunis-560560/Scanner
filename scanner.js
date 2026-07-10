/**
 * ============================================================
 * Passport Verification — e-KYC Scanner Engine
 * © 2026 yunis-560560. All Rights Reserved.
 * Original work — no third-party licensed code used.
 * ============================================================
 *
 * State Machine:
 *   IDLE → FRONT_SCAN → TRANSITION → BACK_SCAN → SUCCESS
 *
 * Features:
 *  - Canvas-based real-time frame analysis (brightness, edges, glare)
 *  - 9 contextual guidance instructions mapped to detection states
 *  - Animated guide border: white → pulse → green (#00C853)
 *  - Auto-capture after sustained 920ms high-confidence hold
 *  - Front → transition card → back scan → success screen
 *  - Canvas QR code generator with proper finder patterns
 *  - QR countdown timer
 *  - Torch / flashlight toggle
 * ============================================================
 */

'use strict';

/* ============================================================
   CONSTANTS
   ============================================================ */
const CONF_THRESHOLD   = 0.60;   // confidence to enter "almost" state
const CONF_CAPTURE     = 0.82;   // confidence to trigger auto-capture
const HOLD_DURATION_MS = 1500;   // ms held at capture confidence before snap
const ANALYSIS_RATE_MS = 180;    // frame analysis interval
const QR_EXPIRE_SECS   = 300;    // 5 minutes

/* ============================================================
   STATE
   ============================================================ */
const state = {
  phase:          'IDLE',       // IDLE | FRONT_SCAN | TRANSITION | BACK_SCAN | SUCCESS
  stream:         null,
  facingMode:     'environment',
  torchOn:        false,
  scanning:       false,
  rafId:          null,
  lastAnalysis:   0,
  confidence:     0,
  holdStart:      null,
  captured:       false,
  capturedFront:  null,
  capturedBack:   null,
  prevEdgeMap:    null,         // for motion/steadiness detection
  qrTimerId:      null,
  qrSecsLeft:     QR_EXPIRE_SECS,
  cropImageSrc:   null,         // captured raw frame
  cropCorners:    { tl: {x:0, y:0}, tr: {x:0, y:0}, br: {x:0, y:0}, bl: {x:0, y:0} },
  cropImageSize:  { w: 0, h: 0 }, // raw image width and height
};

/* ============================================================
   DOM REFS
   ============================================================ */
const $ = id => document.getElementById(id);

const dom = {
  /* Desktop */
  desktopView:      $('desktopView'),
  openScannerBtn:   $('openScannerBtn'),
  qrImage:          $('qrImage'),
  qrCountdown:      $('qrCountdown'),

  /* Mobile view */
  mobileView:       $('mobileView'),
  camVideo:         $('camVideo'),
  camCanvas:        $('camCanvas'),
  mobTopbar:        null, // not individually referenced

  /* Mobile step UI */
  mobStep1:         $('mobStep1'),
  mobStep2:         $('mobStep2'),
  mobConnector:     $('mobConnector'),
  closeMobileBtn:   $('closeMobileBtn'),

  /* Instruction */
  mobInstruction:   $('mobInstruction'),
  mobInstrIcon:     $('mobInstrIcon'),
  mobInstrText:     $('mobInstrText'),

  /* Guide */
  scanGuide:        $('scanGuide'),

  /* Side label */
  mobSideLabel:     $('mobSideLabel'),
  mobSideBadge:     $('mobSideBadge'),
  mobSideDesc:      $('mobSideDesc'),

  /* Status */
  mobStatusDot:     $('mobStatusDot'),
  mobStatusText:    $('mobStatusText'),
  mobDetectBarWrap: $('mobDetectBarWrap'),
  mobDetectFill:    $('mobDetectFill'),

  /* Shutter / Capture */
  shutterBtn:       $('shutterBtn'),

  /* Torch */
  torchBtn:         $('torchBtn'),

  /* Transition */
  transitionOverlay: $('transitionOverlay'),
  transContinueBtn:  $('transContinueBtn'),

  /* Success */
  successScreen:    $('successScreen'),
  thumbFrontImg:    $('thumbFrontImg'),
  thumbBackImg:     $('thumbBackImg'),
  successContinueBtn: $('successContinueBtn'),

  /* Interactive Crop */
  cropScreen:       $('cropScreen'),
  cropImgPreview:   $('cropImgPreview'),
  cropSvg:          $('cropSvg'),
  cropPolygon:      $('cropPolygon'),
  cropResetBtn:     $('cropResetBtn'),
  cropConfirmBtn:   $('cropConfirmBtn'),
  hTL:              $('hTL'),
  hTR:              $('hTR'),
  hBR:              $('hBR'),
  hBL:              $('hBL'),
};

/* ============================================================
   INSTRUCTION DEFINITIONS
   Each instruction maps to a contextual state
   ============================================================ */
const INSTRUCTIONS = {
  fit_frame: {
    text: 'Fit the passport inside the frame.',
    icon: iconPassport(),
  },
  move_closer: {
    text: 'Move closer.',
    icon: iconZoomIn(),
  },
  move_farther: {
    text: 'Move farther away.',
    icon: iconZoomOut(),
  },
  hold_steady: {
    text: 'Hold your phone steady.',
    icon: iconSteady(),
  },
  brighter: {
    text: 'Move to a brighter place.',
    icon: iconSun(),
  },
  reduce_glare: {
    text: 'Avoid direct light. Tilt or change the passport position so the passport number is clearly visible.',
    icon: iconGlare(),
  },
  edges_only: {
    text: 'Hold the passport from the edges only.',
    icon: iconHands(),
  },
  align: {
    text: 'Align the passport straight.',
    icon: iconAlign(),
  },
  tap_focus: {
    text: 'Tap to focus.',
    icon: iconFocus(),
  },
  hold_almost: {
    text: 'Hold steady…',
    icon: iconSteady(),
  },
  detected: {
    text: 'Passport detected successfully',
    icon: iconCheck(),
  },
  capturing: {
    text: 'Capturing…',
    icon: iconCheck(),
  },
};

/* ============================================================
   SVG ICON HELPERS
   ============================================================ */
function makeSVG(path, w = 15, h = 15) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

function iconPassport()  { return makeSVG('<rect x="3" y="2" width="18" height="20" rx="3"/><circle cx="12" cy="9" r="3"/>'); }
function iconZoomIn()    { return makeSVG('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>'); }
function iconZoomOut()   { return makeSVG('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>'); }
function iconSteady()    { return makeSVG('<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>'); }
function iconSun()       { return makeSVG('<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>'); }
function iconGlare()     { return makeSVG('<path d="M12 3v1m0 16v1M3 12h1m16 0h1M5.6 5.6l.7.7m11.4 11.4.7.7M18.4 5.6l-.7.7M6.3 17.3l-.7.7"/><circle cx="12" cy="12" r="4"/>'); }
function iconHands()     { return makeSVG('<path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'); }
function iconAlign()     { return makeSVG('<line x1="3" y1="12" x2="21" y2="12"/><polyline points="8,7 3,12 8,17"/><polyline points="16,7 21,12 16,17"/>'); }
function iconFocus()     { return makeSVG('<circle cx="12" cy="12" r="3"/><path d="M3 9V6a3 3 0 0 1 3-3h3M21 9V6a3 3 0 0 0-3-3h-3M3 15v3a3 3 0 0 0 3 3h3M21 15v3a3 3 0 0 1-3 3h-3"/>'); }
function iconCheck()     { return makeSVG('<polyline points="20,6 9,17 4,12"/>'); }

/* ============================================================
   INIT
   ============================================================ */
window.addEventListener('DOMContentLoaded', () => {
  drawQRCode();
  startQRCountdown();
  dom.openScannerBtn.addEventListener('click', openMobileScanner);
  dom.closeMobileBtn.addEventListener('click', closeMobileScanner);
  dom.torchBtn.addEventListener('click', toggleTorch);
  dom.transContinueBtn.addEventListener('click', startBackScan);
  dom.successContinueBtn.addEventListener('click', () => {
    // In a real app this navigates to next step
    dom.successScreen.style.display = 'none';
    dom.desktopView.style.display = 'flex';
    // Update desktop stepper to step 3 complete
    completeDeskStep3();
  });
  
  // Wire crop actions
  dom.cropConfirmBtn.addEventListener('click', confirmCropAdjustment);
  dom.cropResetBtn.addEventListener('click', resetCropCorners);
  setupDragHandlers();

  // Wire Shutter / Capture button
  dom.shutterBtn.addEventListener('click', triggerCapture);
});

/* ============================================================
   QR CODE — Dynamic URL generator using standard free API
   ============================================================ */
function drawQRCode() {
  const img = dom.qrImage;
  if (!img) return;

  // Use the current page URL so scanning directly opens this exact page on mobile
  const currentUrl = window.location.href || 'https://yunis-560560.github.io/Scanner/';
  
  // Use a completely free, open QR code generator API
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=190x190&data=${encodeURIComponent(currentUrl)}&ecc=M`;
}

/* ============================================================
   QR COUNTDOWN TIMER
   ============================================================ */
function startQRCountdown() {
  state.qrTimerId = setInterval(() => {
    state.qrSecsLeft = Math.max(0, state.qrSecsLeft - 1);
    const m = String(Math.floor(state.qrSecsLeft / 60)).padStart(2, '0');
    const s = String(state.qrSecsLeft % 60).padStart(2, '0');
    if (dom.qrCountdown) dom.qrCountdown.textContent = `${m}:${s}`;
    if (state.qrSecsLeft === 0) {
      clearInterval(state.qrTimerId);
      redrawExpiredQR();
    }
  }, 1000);
}

function redrawExpiredQR() {
  const img = dom.qrImage;
  if (!img) return;

  // Dim the QR code
  img.style.opacity = '0.12';
  img.style.filter = 'blur(1px)';

  // Overlay an expiration message inside the parent frame container
  const frame = img.parentElement;
  if (frame) {
    // Check if error overlay already exists
    if (frame.querySelector('.qr-expired-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'qr-expired-overlay';
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.background = 'rgba(255, 255, 255, 0.85)';
    overlay.style.color = '#475569';
    overlay.style.font = '600 13px Inter, system-ui, sans-serif';
    overlay.style.textAlign = 'center';
    overlay.style.padding = '16px';
    overlay.style.borderRadius = 'var(--radius-md)';
    overlay.innerHTML = `
      <div style="font-weight: 700; color: #EF4444; margin-bottom: 4px;">QR Code Expired</div>
      <div style="font-size: 11px; color: #64748B;">Refresh the page to get a new scannable code</div>
    `;
    frame.appendChild(overlay);
  }
}

/* ============================================================
   OPEN / CLOSE MOBILE SCANNER
   ============================================================ */
async function openMobileScanner() {
  dom.desktopView.style.display = 'none';
  dom.mobileView.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  state.phase   = 'FRONT_SCAN';
  state.captured = false;

  setMobSideUI('front');
  setMobStatus('init', 'Initializing camera…');
  setInstruction('fit_frame');
  setGuideState('default');

  await startCamera();
}

function closeMobileScanner() {
  stopCamera();
  dom.mobileView.style.display = 'none';
  dom.desktopView.style.display = 'flex';
  document.body.style.overflow = '';
  state.phase = 'IDLE';
  resetDetectionState();
}

/* ============================================================
   CAMERA MANAGEMENT
   ============================================================ */
async function startCamera() {
  stopCamera();

  const constraints = {
    video: {
      facingMode: state.facingMode,
      width:  { ideal: 1920 },
      height: { ideal: 1080 },
      focusMode: 'continuous',
    },
    audio: false,
  };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    dom.camVideo.srcObject = state.stream;
    await dom.camVideo.play();
    setMobStatus('ready', 'Position your passport in the frame');
    beginDetectionLoop();
  } catch (err) {
    let msg = 'Camera access denied. Please allow camera permission.';
    if (err.name === 'NotFoundError') msg = 'No camera detected on this device.';
    if (err.name === 'NotAllowedError') msg = 'Camera permission denied.';
    setMobStatus('error', msg);
    console.warn('Camera error:', err);
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  state.scanning = false;
}

/* ============================================================
   DETECTION LOOP
   ============================================================ */
function beginDetectionLoop() {
  state.scanning = true;

  const loop = (timestamp) => {
    if (!state.scanning) return;
    state.rafId = requestAnimationFrame(loop);

    if (timestamp - state.lastAnalysis < ANALYSIS_RATE_MS) return;
    state.lastAnalysis = timestamp;

    if (dom.camVideo.readyState < dom.camVideo.HAVE_ENOUGH_DATA) return;
    analyzeAndUpdate();
  };

  state.rafId = requestAnimationFrame(loop);
}

/* ============================================================
   FRAME ANALYSIS
   Returns analysis object with metrics + overall confidence
   ============================================================ */
function analyzeAndUpdate() {
  if (state.captured) return;

  const video = dom.camVideo;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  // Sample the center region (where the passport should be)
  const samplePct = 0.72;
  const sw = Math.round(vw * samplePct);
  const sh = Math.round(vh * (samplePct * 0.65));
  const sx = Math.round((vw - sw) / 2);
  const sy = Math.round((vh - sh) / 2);

  const canvas = dom.camCanvas;
  canvas.width  = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

  const imageData = ctx.getImageData(0, 0, sw, sh);
  const analysis  = computeAnalysis(imageData.data, sw, sh);

  updateDetection(analysis);
}

function computeAnalysis(data, w, h) {
  let brightnessSum = 0;
  let glareCount    = 0;
  let edgeSum       = 0;
  const step = 3;

  // Luminance map
  const luma = new Float32Array(w * h);
  const total = w * h;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      luma[y * w + x] = l;
      brightnessSum += l;
      if (l > 230) glareCount++;
    }
  }

  const avgBrightness = brightnessSum / total;
  const glareRatio    = glareCount / total;

  // Sobel edge detection (sampled)
  let sampledPixels = 0;
  let motionSum     = 0;

  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const gx =
        -luma[(y-1)*w + x-1] + luma[(y-1)*w + x+1]
        - 2*luma[y*w + x-1]  + 2*luma[y*w + x+1]
        - luma[(y+1)*w + x-1]+ luma[(y+1)*w + x+1];
      const gy =
        -luma[(y-1)*w + x-1] - 2*luma[(y-1)*w + x] - luma[(y-1)*w + x+1]
        + luma[(y+1)*w + x-1]+ 2*luma[(y+1)*w + x] + luma[(y+1)*w + x+1];
      const mag = Math.sqrt(gx*gx + gy*gy);
      edgeSum += mag;

      // Motion: compare with previous frame
      if (state.prevEdgeMap) {
        const pi = (Math.floor(y / step)) * Math.floor(w / step) + Math.floor(x / step);
        motionSum += Math.abs(mag - (state.prevEdgeMap[pi] || 0));
      }
      sampledPixels++;
    }
  }

  // Build edge map for next frame comparison
  const edgeMap = new Float32Array(sampledPixels);
  let ei = 0;
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const gx =
        -luma[(y-1)*w + x-1] + luma[(y-1)*w + x+1]
        - 2*luma[y*w + x-1]  + 2*luma[y*w + x+1]
        - luma[(y+1)*w + x-1]+ luma[(y+1)*w + x+1];
      const gy =
        -luma[(y-1)*w + x-1] - 2*luma[(y-1)*w + x] - luma[(y-1)*w + x+1]
        + luma[(y+1)*w + x-1]+ 2*luma[(y+1)*w + x] + luma[(y+1)*w + x+1];
      edgeMap[ei++] = Math.sqrt(gx*gx + gy*gy);
    }
  }
  state.prevEdgeMap = edgeMap;

  const avgEdge   = edgeSum / sampledPixels;
  const avgMotion = state.prevEdgeMap ? motionSum / sampledPixels : 0;

  // Steadiness: low motion = steady (score 0–1, 1 = very steady)
  const steadiness = Math.max(0, 1 - Math.min(1, avgMotion / 25));

  // Fill ratio: how well a bright rectangular area fills the sample
  let brightArea = 0;
  for (let i = 0; i < total; i++) {
    if (luma[i] > 140) brightArea++;
  }
  const fillRatio = brightArea / total;

  // Scores
  const brightScore  = Math.min(1, avgBrightness / 165);       // 0-1 (passport is white/bright)
  const edgeScore    = Math.min(1, avgEdge / 40);              // 0-1 (text/borders = edges)
  const balanceScore = Math.max(0, 1 - Math.abs(brightScore - 0.72) * 2.0);
  const glareScore   = Math.max(0, 1 - glareRatio * 6);        // penalize overexposure
  const fillScore    = fillRatio > 0.25 && fillRatio < 0.85    // reasonable fill
    ? 1 - Math.abs(fillRatio - 0.55) * 1.5
    : 0.15;

  // Overall confidence
  const raw = Math.max(0, Math.min(1,
    brightScore  * 0.28 +
    edgeScore    * 0.30 +
    balanceScore * 0.18 +
    glareScore   * 0.12 +
    fillScore    * 0.12
  ));

  // Smooth confidence
  state.confidence = state.confidence * 0.72 + raw * 0.28;

  return {
    brightness: avgBrightness / 255,
    edgeDensity: avgEdge / 50,
    steadiness,
    glareRatio,
    fillRatio,
    confidence: state.confidence,
  };
}

/* ============================================================
   CONTEXTUAL INSTRUCTION SELECTION
   Picks the most relevant guidance based on analysis metrics
   ============================================================ */
function selectInstruction(a) {
  const { confidence, brightness, edgeDensity, steadiness, glareRatio, fillRatio } = a;

  // High priority: critical issues
  if (confidence < 0.18) return 'fit_frame';

  // Distance issues
  if (fillRatio < 0.22) return 'move_closer';
  if (fillRatio > 0.82) return 'move_farther';

  // Lighting issues
  if (brightness < 0.30) return 'brighter';

  // Glare
  if (glareRatio > 0.08) return 'reduce_glare';

  // Steadiness
  if (steadiness < 0.45) return 'hold_steady';

  // Fingers / low-edge content in bright area (inferred)
  if (edgeDensity > 0.70 && confidence < 0.50) return 'edges_only';

  // Alignment (aspect-ratio proxy: moderate fill, moderate confidence)
  if (fillRatio > 0.28 && fillRatio < 0.50 && confidence < 0.55) return 'align';

  // Focus (low edges despite decent brightness)
  if (brightness > 0.55 && edgeDensity < 0.25 && confidence < 0.65) return 'tap_focus';

  // Near success
  if (confidence >= CONF_THRESHOLD && confidence < CONF_CAPTURE) return 'hold_almost';

  // Full success
  if (confidence >= CONF_CAPTURE) return 'detected';

  return 'fit_frame';
}

/* ============================================================
   UPDATE DETECTION STATE — main control loop
   ============================================================ */
function updateDetection(analysis) {
  if (state.captured) return;

  const conf     = analysis.confidence;
  const instrKey = selectInstruction(analysis);

  // Update confidence bar
  dom.mobDetectFill.style.width = `${Math.round(conf * 100)}%`;
  dom.mobDetectFill.setAttribute('aria-valuenow', Math.round(conf * 100));

  if (conf > 0.15) {
    dom.mobDetectBarWrap.classList.add('visible');
  }

  // Guide border state
  if (conf >= CONF_CAPTURE) {
    setGuideState('success');
    setMobStatus('success', 'Passport detected');
    dom.mobDetectFill.classList.add('fill-success');
  } else if (conf >= CONF_THRESHOLD) {
    setGuideState('almost');
    setMobStatus('almost', 'Almost ready…');
    dom.mobDetectFill.classList.remove('fill-success');
  } else {
    setGuideState('default');
    setMobStatus('detecting', 'Detecting…');
    dom.mobDetectFill.classList.remove('fill-success');
  }

  // Set instruction text
  setInstruction(instrKey);

  // Auto-capture logic: Must exceed capture confidence AND be held steady
  if (conf >= CONF_CAPTURE && analysis.steadiness >= 0.75 && !state.captured) {
    if (!state.holdStart) {
      state.holdStart = Date.now();
    } else if (Date.now() - state.holdStart >= HOLD_DURATION_MS) {
      triggerCapture();
    }
  } else {
    state.holdStart = null;
  }
}

/* ============================================================
   GUIDE STATE
   ============================================================ */
function setGuideState(st) { // 'default' | 'almost' | 'success'
  const guide = dom.scanGuide;
  guide.classList.remove('state-almost', 'state-success');
  if (st === 'almost') guide.classList.add('state-almost');
  if (st === 'success') guide.classList.add('state-success');

  // Mirror state on instruction pill
  const pill = dom.mobInstruction;
  pill.classList.remove('state-almost', 'state-success');
  if (st === 'almost') pill.classList.add('state-almost');
  if (st === 'success') pill.classList.add('state-success');
}

function resetDetectionState() {
  state.confidence = 0;
  state.holdStart  = null;
  state.captured   = false;
  state.prevEdgeMap= null;
  setGuideState('default');
  setMobStatus('init', 'Initializing…');
  setInstruction('fit_frame');
  dom.mobDetectFill.style.width = '0%';
  dom.mobDetectBarWrap.classList.remove('visible');
  dom.mobDetectFill.classList.remove('fill-success');
}

/* ============================================================
   INSTRUCTION DISPLAY
   ============================================================ */
function setInstruction(key) {
  const instr = INSTRUCTIONS[key] || INSTRUCTIONS['fit_frame'];
  const currentText = dom.mobInstrText.textContent;
  if (currentText === instr.text) return; // avoid unnecessary DOM thrash

  dom.mobInstrText.textContent = instr.text;
  dom.mobInstrIcon.innerHTML   = instr.icon;
}

/* ============================================================
   MOBILE STATUS
   ============================================================ */
function setMobStatus(type, label) {
  dom.mobStatusDot.className = 'mob-status-dot';
  if (type === 'init')      dom.mobStatusDot.classList.add('dot-ready');
  if (type === 'ready')     dom.mobStatusDot.classList.add('dot-ready');
  if (type === 'detecting') dom.mobStatusDot.classList.add('dot-detecting');
  if (type === 'almost')    dom.mobStatusDot.classList.add('dot-almost');
  if (type === 'success')   dom.mobStatusDot.classList.add('dot-success');
  if (type === 'error')     dom.mobStatusDot.classList.add('dot-detecting'); // amber for error
  if (dom.mobStatusText.textContent !== label) {
    dom.mobStatusText.textContent = label;
  }
}

/* ============================================================
   SIDE LABEL UI
   ============================================================ */
function setMobSideUI(side) {
  if (side === 'front') {
    dom.mobSideBadge.textContent = 'FRONT';
    dom.mobSideBadge.className   = 'mob-side-badge';
    dom.mobSideDesc.textContent  = 'Place the passport front page completely inside the frame. Ensure all four corners are visible.';
    // Step indicator
    dom.mobStep1.classList.add('mob-step--active');
    dom.mobStep2.classList.remove('mob-step--active', 'mob-step--done');
  } else {
    dom.mobSideBadge.textContent = 'BACK';
    dom.mobSideBadge.className   = 'mob-side-badge badge-back';
    dom.mobSideDesc.textContent  = 'Turn the passport over and place the back page completely inside the frame.';
    // Step indicator
    dom.mobStep1.classList.remove('mob-step--active');
    dom.mobStep1.classList.add('mob-step--done');
    dom.mobConnector.classList.add('mob-connector--done');
    dom.mobStep2.classList.add('mob-step--active');
  }
}

/* ============================================================
   AUTO CAPTURE
   ============================================================ */
async function triggerCapture() {
  if (state.captured) return;
  state.captured = true;

  // Update instruction
  setInstruction('capturing');

  // Short pause for "Capturing..." display
  await sleep(350);

  // Capture ONLY the guide frame region (crop out fingers & background)
  const video    = dom.camVideo;
  const vw       = video.videoWidth  || 1280;
  const vh       = video.videoHeight || 720;
  const canvas   = dom.camCanvas;
  const ctx      = canvas.getContext('2d');

  // Get the guide frame's bounding rect on screen
  const guide    = dom.scanGuide;
  const guideRect = guide.getBoundingClientRect();

  // Get the video element's bounding rect on screen
  // The video element fills the viewport (object-fit: cover)
  const videoEl  = video;
  const vidRect  = videoEl.getBoundingClientRect();

  // Calculate the scale between displayed video pixels and actual video pixels
  // object-fit: cover scales the video to FILL the element, cropping edges
  const displayW  = vidRect.width;
  const displayH  = vidRect.height;
  const videoAspect   = vw / vh;
  const displayAspect = displayW / displayH;

  let renderedW, renderedH, offsetX, offsetY;
  if (videoAspect > displayAspect) {
    // Video is wider — pillarboxed: height fills, width overflows
    renderedH = displayH;
    renderedW = displayH * videoAspect;
    offsetX   = (renderedW - displayW) / 2;
    offsetY   = 0;
  } else {
    // Video is taller — letterboxed: width fills, height overflows
    renderedW = displayW;
    renderedH = displayW / videoAspect;
    offsetX   = 0;
    offsetY   = (renderedH - displayH) / 2;
  }

  const scaleX = vw / renderedW;
  const scaleY = vh / renderedH;

  // Guide position relative to the video element display area
  const guideX = guideRect.left - vidRect.left;
  const guideY = guideRect.top  - vidRect.top;

  // Capture the FULL camera frame (so the user can adjust crop corners cleanly on the full photo)
  canvas.width  = vw;
  canvas.height = vh;
  ctx.drawImage(video, 0, 0, vw, vh);

  const dataURL = canvas.toDataURL('image/jpeg', 0.95);

  // Camera flash
  flashCapture();

  await sleep(280);

  // Stop camera and open crop adjust screen with full frame
  stopCamera();
  dom.mobileView.style.display = 'none';
  openCropScreen(dataURL, vw, vh);
}

/* ============================================================
   CAPTURE FLASH
   ============================================================ */
function flashCapture() {
  const flash = document.createElement('div');
  flash.className = 'capture-flash';
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 520);
}

/* ============================================================
   TRANSITION OVERLAY (Front → Back)
   ============================================================ */
function showTransitionOverlay() {
  stopCamera();
  dom.transitionOverlay.style.display = 'flex';
  dom.mobileView.style.display = 'none';
}

async function startBackScan() {
  dom.transitionOverlay.style.display = 'none';
  dom.mobileView.style.display = 'flex';

  state.phase    = 'BACK_SCAN';
  state.captured = false;
  resetDetectionState();
  setMobSideUI('back');

  await startCamera();
}

/* ============================================================
   SUCCESS SCREEN
   ============================================================ */
function showSuccessScreen() {
  // Populate thumbnails
  if (state.capturedFront) {
    dom.thumbFrontImg.src = state.capturedFront;
  }
  if (state.capturedBack) {
    dom.thumbBackImg.src = state.capturedBack;
  } else {
    // Hide back thumb if not captured
    const backThumb = dom.thumbBackImg.closest?.('.success-thumb');
    if (backThumb) backThumb.style.display = 'none';
  }

  dom.successScreen.style.display = 'flex';
  document.body.style.overflow = '';

  // Trigger SVG animation (re-trigger by cloning)
  const ring = dom.successScreen.querySelector('.success-ring');
  const tick = dom.successScreen.querySelector('.success-tick');
  if (ring && tick) {
    // Force reflow to restart CSS animation
    ring.style.animation = 'none';
    tick.style.animation = 'none';
    void ring.offsetWidth; // reflow
    ring.style.animation = '';
    tick.style.animation = '';
  }
}

function completeDeskStep3() {
  const step3 = $('dskStep3');
  if (step3) {
    step3.className = 'dsk-step dsk-step--done';
    const circle = step3.querySelector('.dsk-step-circle');
    if (circle) {
      circle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20,6 9,17 4,12"/></svg>`;
    }
    const label = step3.querySelector('.dsk-step-label');
    if (label) label.style.color = '#059669';
    const line2 = document.querySelector('.dsk-step-connector:last-of-type');
    if (line2) line2.classList.add('dsk-step-connector--done');
  }
}

/* ============================================================
   TORCH TOGGLE
   ============================================================ */
async function toggleTorch() {
  if (!state.stream) return;
  const track = state.stream.getVideoTracks()[0];
  if (!track) return;

  const caps = track.getCapabilities?.();
  if (caps && !caps.torch) {
    console.info('Torch not supported on this device/browser');
    return;
  }

  state.torchOn = !state.torchOn;

  try {
    await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    dom.torchBtn.classList.toggle('torch-on', state.torchOn);
    dom.torchBtn.setAttribute('aria-pressed', String(state.torchOn));
  } catch (err) {
    console.warn('Torch error:', err);
    state.torchOn = false;
  }
}

/* ============================================================
   UTILITIES
   ============================================================ */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ============================================================
   KEYBOARD ACCESSIBILITY — close on Escape
   ============================================================ */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (dom.successScreen.style.display !== 'none') {
      dom.successScreen.style.display = 'none';
      dom.desktopView.style.display = 'flex';
      return;
    }
    if (dom.transitionOverlay.style.display !== 'none') {
      dom.transitionOverlay.style.display = 'none';
      closeMobileScanner();
      return;
    }
    if (dom.mobileView.style.display !== 'none') {
      closeMobileScanner();
    }
  }
});

/* ============================================================
   VISIBILITY CHANGE — pause detection when tab hidden
   ============================================================ */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.scanning) {
    cancelAnimationFrame(state.rafId);
    state.scanning = false;
  } else if (!document.hidden && state.stream && !state.scanning && !state.captured) {
    beginDetectionLoop();
  }
});


/* ============================================================
   INTERACTIVE CROP & CORNER ADJUSTER
   ============================================================ */
function openCropScreen(rawImageSrc, width, height) {
  state.cropImageSrc = rawImageSrc;
  state.cropImageSize = { w: width, h: height };
  
  // Set the container aspect ratio to match the raw captured photo aspect ratio exactly
  const container = dom.cropImgPreview.parentElement;
  if (container) {
    container.style.aspectRatio = `${width} / ${height}`;
  }

  dom.cropImgPreview.src = rawImageSrc;
  
  dom.cropImgPreview.onload = () => {
    initCropUI();
  };

  dom.cropScreen.style.display = 'flex';
}

function initCropUI() {
  const rect = dom.cropImgPreview.getBoundingClientRect();
  
  dom.cropSvg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  dom.cropSvg.style.width = `${rect.width}px`;
  dom.cropSvg.style.height = `${rect.height}px`;

  // Place initial green handles as a centered rectangle (12% padding on sides, 18% on top/bottom)
  const padX = rect.width * 0.12;
  const padY = rect.height * 0.18;

  state.cropCorners = {
    tl: { x: padX, y: padY },
    tr: { x: rect.width - padX, y: padY },
    br: { x: rect.width - padX, y: rect.height - padY },
    bl: { x: padX, y: rect.height - padY }
  };

  updateCropPolygon();
}

function updateCropPolygon() {
  const { tl, tr, br, bl } = state.cropCorners;
  
  setHandlePos(dom.hTL, tl);
  setHandlePos(dom.hTR, tr);
  setHandlePos(dom.hBR, br);
  setHandlePos(dom.hBL, bl);

  dom.cropPolygon.setAttribute('points', `${tl.x},${tl.y} ${tr.x},${tr.y} ${br.x},${br.y} ${bl.x},${bl.y}`);
}

function setHandlePos(el, pos) {
  el.setAttribute('cx', String(pos.x));
  el.setAttribute('cy', String(pos.y));
}

function resetCropCorners() {
  initCropUI();
}

/* ============================================================
   DRAGGABLE SVG HANDLES
   ============================================================ */
let activeHandle = null;

function setupDragHandlers() {
  const handles = [dom.hTL, dom.hTR, dom.hBR, dom.hBL];
  
  handles.forEach(handle => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      activeHandle = handle;
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (activeHandle !== handle) return;
      e.preventDefault();

      const rect = dom.cropSvg.getBoundingClientRect();
      let x = e.clientX - rect.left;
      let y = e.clientY - rect.top;

      x = Math.max(0, Math.min(rect.width, x));
      y = Math.max(0, Math.min(rect.height, y));

      const key = handle.id.substring(1).toLowerCase(); // 'tl', 'tr', 'br', 'bl'
      state.cropCorners[key] = { x, y };

      updateCropPolygon();
    });

    const release = (e) => {
      if (activeHandle === handle) {
        handle.releasePointerCapture(e.pointerId);
        activeHandle = null;
      }
    };

    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
  });
}

/* ============================================================
   PERSPECTIVE WARPING & HOMOGRAPHY SOLVER
   ============================================================ */
function confirmCropAdjustment() {
  // Show loading indicator in button
  dom.cropConfirmBtn.textContent = 'Processing…';
  dom.cropConfirmBtn.disabled = true;

  // Let browser render the loading state
  setTimeout(() => {
    const rect = dom.cropImgPreview.getBoundingClientRect();
    const scaleX = state.cropImageSize.w / rect.width;
    const scaleY = state.cropImageSize.h / rect.height;

    // Map screen handles to original high-res captured coordinates
    const cornersInRaw = {
      tl: { x: state.cropCorners.tl.x * scaleX, y: state.cropCorners.tl.y * scaleY },
      tr: { x: state.cropCorners.tr.x * scaleX, y: state.cropCorners.tr.y * scaleY },
      br: { x: state.cropCorners.br.x * scaleX, y: state.cropCorners.br.y * scaleY },
      bl: { x: state.cropCorners.bl.x * scaleX, y: state.cropCorners.bl.y * scaleY }
    };

    const tempImg = new Image();
    tempImg.src = state.cropImageSrc;
    tempImg.onload = () => {
      const rawCanvas = document.createElement('canvas');
      rawCanvas.width = state.cropImageSize.w;
      rawCanvas.height = state.cropImageSize.h;
      const rawCtx = rawCanvas.getContext('2d');
      rawCtx.drawImage(tempImg, 0, 0);

      const srcImgData = rawCtx.getImageData(0, 0, rawCanvas.width, rawCanvas.height);

      // standard passport size aspect ratio output (1.42 : 1)
      const destW = 1000;
      const destH = 704;
      const destCanvas = document.createElement('canvas');
      destCanvas.width = destW;
      destCanvas.height = destH;
      const destCtx = destCanvas.getContext('2d');
      const destImgData = destCtx.createImageData(destW, destH);

      const srcPoints = [
        cornersInRaw.tl,
        cornersInRaw.tr,
        cornersInRaw.br,
        cornersInRaw.bl
      ];
      const destPoints = [
        { x: 0, y: 0 },
        { x: destW, y: 0 },
        { x: destW, y: destH },
        { x: 0, y: destH }
      ];

      const hMatrix = getHomographyMatrix(destPoints, srcPoints);

      warpPerspectiveJS(srcImgData, destImgData, hMatrix);
      destCtx.putImageData(destImgData, 0, 0);

      const flattenedDataURL = destCanvas.toDataURL('image/jpeg', 0.95);

      // Re-enable button
      dom.cropConfirmBtn.textContent = 'Done';
      dom.cropConfirmBtn.disabled = false;

      // Close crop overlay screen and advance scan state
      dom.cropScreen.style.display = 'none';

      if (state.phase === 'FRONT_SCAN') {
        state.capturedFront = flattenedDataURL;
        state.phase = 'TRANSITION';
        showTransitionOverlay();
      } else if (state.phase === 'BACK_SCAN') {
        state.capturedBack = flattenedDataURL;
        state.phase = 'SUCCESS';
        stopCamera();
        dom.mobileView.style.display = 'none';
        showSuccessScreen();
      }
    };
  }, 50);
}

function getHomographyMatrix(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i], d = dst[i];
    A.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y, d.x]);
    A.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y, d.y]);
  }
  return solveLinearSystem8(A);
}

function solveLinearSystem8(matrix) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(matrix[k][i]) > Math.abs(matrix[maxRow][i])) {
        maxRow = k;
      }
    }
    const temp = matrix[i];
    matrix[i] = matrix[maxRow];
    matrix[maxRow] = temp;

    const pivot = matrix[i][i];
    if (Math.abs(pivot) < 1e-10) continue;
    for (let j = i; j <= n; j++) {
      matrix[i][j] /= pivot;
    }

    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = matrix[k][i];
      for (let j = i; j <= n; j++) {
        matrix[k][j] -= factor * matrix[i][j];
      }
    }
  }
  const res = new Float32Array(9);
  for (let i = 0; i < n; i++) {
    res[i] = matrix[i][n];
  }
  res[8] = 1.0;
  return res;
}

function warpPerspectiveJS(srcImgData, destImgData, h) {
  const sw = srcImgData.width, sh = srcImgData.height;
  const dw = destImgData.width, dh = destImgData.height;
  const sData = srcImgData.data;
  const dData = destImgData.data;

  const h0 = h[0], h1 = h[1], h2 = h[2];
  const h3 = h[3], h4 = h[4], h5 = h[5];
  const h6 = h[6], h7 = h[7], h8 = h[8];

  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const w = h6 * x + h7 * y + h8;
      const sx = (h0 * x + h1 * y + h2) / w;
      const sy = (h3 * x + h4 * y + h5) / w;

      if (sx >= 0 && sx < sw - 1 && sy >= 0 && sy < sh - 1) {
        const xFloor = Math.floor(sx);
        const yFloor = Math.floor(sy);
        const xWeight = sx - xFloor;
        const yWeight = sy - yFloor;

        const idx00 = (yFloor * sw + xFloor) * 4;
        const idx10 = (yFloor * sw + (xFloor + 1)) * 4;
        const idx01 = ((yFloor + 1) * sw + xFloor) * 4;
        const idx11 = ((yFloor + 1) * sw + (xFloor + 1)) * 4;

        const destIdx = (y * dw + x) * 4;

        for (let c = 0; c < 4; c++) {
          const val = (1 - xWeight) * (1 - yWeight) * sData[idx00 + c] +
                      xWeight * (1 - yWeight) * sData[idx10 + c] +
                      (1 - xWeight) * yWeight * sData[idx01 + c] +
                      xWeight * yWeight * sData[idx11 + c];
          dData[destIdx + c] = Math.round(val);
        }
      } else {
        const destIdx = (y * dw + x) * 4;
        dData[destIdx] = 247;
        dData[destIdx + 1] = 248;
        dData[destIdx + 2] = 250;
        dData[destIdx + 3] = 255;
      }
    }
  }
}

