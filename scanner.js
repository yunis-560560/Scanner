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
const HOLD_DURATION_MS = 920;    // ms held at capture confidence before snap
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
};

/* ============================================================
   DOM REFS
   ============================================================ */
const $ = id => document.getElementById(id);

const dom = {
  /* Desktop */
  desktopView:      $('desktopView'),
  openScannerBtn:   $('openScannerBtn'),
  qrCanvas:         $('qrCanvas'),
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
    text: 'Reduce glare by tilting the passport slightly.',
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
});

/* ============================================================
   QR CODE — Canvas generator with proper finder patterns
   ============================================================ */
function drawQRCode() {
  const canvas = dom.qrCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const SIZE = 190;
  const CELLS = 25;
  const cell = SIZE / CELLS;

  // White background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Generate pseudo-random data modules
  const grid = makeQRGrid(CELLS);

  // Draw data modules
  ctx.fillStyle = '#0F172A';
  for (let y = 0; y < CELLS; y++) {
    for (let x = 0; x < CELLS; x++) {
      if (grid[y][x]) {
        const px = Math.round(x * cell);
        const py = Math.round(y * cell);
        const cw = Math.round((x + 1) * cell) - px;
        const ch = Math.round((y + 1) * cell) - py;
        roundRect(ctx, px, py, cw, ch, 1);
      }
    }
  }

  // Finder patterns (three corners)
  drawFinder(ctx, 0, 0, cell);
  drawFinder(ctx, CELLS - 7, 0, cell);
  drawFinder(ctx, 0, CELLS - 7, cell);
}

function makeQRGrid(size) {
  const g = Array.from({ length: size }, () => Array(size).fill(0));
  // Finder pattern zones (top-left, top-right, bottom-left) — leave them blank for now
  const inFinder = (x, y) =>
    (x < 9 && y < 9) ||
    (x >= size - 8 && y < 9) ||
    (x < 9 && y >= size - 8);

  // Timing patterns
  const onTiming = (x, y) => (x === 6 && y >= 8 && y < size - 8) || (y === 6 && x >= 8 && x < size - 8);

  // Use deterministic "random" for consistency
  let seed = 0x5CA1AB1E;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xFFFFFFFF;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inFinder(x, y)) continue;
      if (onTiming(x, y)) { g[y][x] = (x + y) % 2 === 0 ? 1 : 0; continue; }
      g[y][x] = rand() > 0.48 ? 1 : 0;
    }
  }
  return g;
}

function drawFinder(ctx, gx, gy, cell) {
  const ox = Math.round(gx * cell);
  const oy = Math.round(gy * cell);
  const c = cell;

  // Outer 7×7 square
  ctx.fillStyle = '#0F172A';
  roundRect(ctx, ox, oy, Math.round(7 * c), Math.round(7 * c), 2);

  // Inner white 5×5
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, ox + Math.round(c), oy + Math.round(c), Math.round(5 * c), Math.round(5 * c), 1);

  // Center 3×3
  ctx.fillStyle = '#0F172A';
  roundRect(ctx, ox + Math.round(2 * c), oy + Math.round(2 * c), Math.round(3 * c), Math.round(3 * c), 1);
}

function roundRect(ctx, x, y, w, h, r = 2) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
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
      // Redraw QR with dim effect (expired)
      redrawExpiredQR();
    }
  }, 1000);
}

function redrawExpiredQR() {
  const canvas = dom.qrCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#94A3B8';
  ctx.font = '600 13px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Expired — Refresh page', canvas.width / 2, canvas.height / 2 - 8);
  ctx.fillText('to get a new QR code', canvas.width / 2, canvas.height / 2 + 10);
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
  if (glareRatio > 0.12) return 'reduce_glare';

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

  // Auto-capture logic
  if (conf >= CONF_CAPTURE && !state.captured) {
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

  // Map to actual video pixel coordinates
  const srcX = Math.round((guideX + offsetX) * scaleX);
  const srcY = Math.round((guideY + offsetY) * scaleY);
  const srcW = Math.round(guideRect.width  * scaleX);
  const srcH = Math.round(guideRect.height * scaleY);

  // Output canvas = guide size (passport aspect ratio 1.42:1)
  const outW = Math.min(srcW, vw);
  const outH = Math.min(srcH, vh);
  canvas.width  = outW;
  canvas.height = outH;

  // Draw only the cropped guide region
  ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, outW, outH);

  const dataURL = canvas.toDataURL('image/jpeg', 0.95);

  // Camera flash
  flashCapture();

  await sleep(280);

  if (state.phase === 'FRONT_SCAN') {
    state.capturedFront = dataURL;
    state.phase = 'TRANSITION';
    showTransitionOverlay();
  } else if (state.phase === 'BACK_SCAN') {
    state.capturedBack = dataURL;
    state.phase = 'SUCCESS';
    stopCamera();
    dom.mobileView.style.display = 'none';
    showSuccessScreen();
  }
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
