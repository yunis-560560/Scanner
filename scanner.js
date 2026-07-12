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
const HOLD_DURATION_MS = 1000;   // ms held at capture confidence before snap
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
  rawFront:       null,
  rawBack:        null,
  reCropping:     null,         // 'FRONT' | 'BACK' | null
  prevEdgeMap:    null,         // for motion/steadiness detection
  qrTimerId:      null,
  qrSecsLeft:     QR_EXPIRE_SECS,
  cropImageSrc:   null,         // captured raw frame
  cropCorners:    { tl: {x:0, y:0}, tr: {x:0, y:0}, br: {x:0, y:0}, bl: {x:0, y:0} },
  cropImageSize:  { w: 0, h: 0 }, // raw image width and height
  demoTimerId:    null,         // timer ID for the 6-second onboarding guide
};

/* ============================================================
   DOM REFS
   ============================================================ */
const $ = id => document.getElementById(id);

const dom = {
  /* Desktop */
  desktopView:      $('desktopView'),
  openScannerBtn:   $('openScannerBtn'),
  uploadPassportBtn: $('uploadPassportBtn'),
  passportFileInput: $('passportFileInput'),
  qrImage:          $('qrImage'),
  qrCountdown:      $('qrCountdown'),

  /* Mobile view */
  mobileView:       $('mobileView'),
  scannerDemoOverlay: $('scannerDemoOverlay'),
  demoSkipBtn:       $('demoSkipBtn'),
  camVideo:         $('camVideo'),
  glareOverlayCanvas: $('glareOverlayCanvas'),
  camCanvas:        $('camCanvas'),
  mobTopbar:        null, // not individually referenced

  /* Mobile step UI */
  mobStep1:         $('mobStep1'),
  mobStep2:         $('mobStep2'),
  mobConnector:     $('mobConnector'),
  closeMobileBtn:   $('closeMobileBtn'),

  /* Instruction */
  glareCriticalWarning: $('glareCriticalWarning'),
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
  transUploadBtn:    $('transUploadBtn'),

  /* Success */
  successScreen:    $('successScreen'),
  thumbFrontImg:    $('thumbFrontImg'),
  thumbBackImg:     $('thumbBackImg'),
  successContinueBtn: $('successContinueBtn'),
  reCropFrontBtn:   $('reCropFrontBtn'),
  reCropBackBtn:    $('reCropBackBtn'),
  successBackBtn:   $('successBackBtn'),

  /* Interactive Crop */
  cropScreen:       $('cropScreen'),
  cropImgPreview:   $('cropImgPreview'),
  cropGlareWarning: $('cropGlareWarning'),
  cropMagnifier:    $('cropMagnifier'),
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
  overexposed: {
    text: 'Too bright. Move away from direct light.',
    icon: iconGlare(),
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
   DEVICE DETECTION
   Primary: CSS media query (viewport width < 1024px)
   Secondary: User-Agent + touch point hints
   Adds 'is-mobile' or 'is-desktop' to document.body.
   Works reliably with DevTools emulation, real phones & tablets.
   ============================================================ */
function detectAndApplyDeviceClass() {
  const ua = navigator.userAgent || navigator.vendor || window.opera;
  const isMobileUA = /android|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet|silk/i.test(ua);
  const isTouchDevice = navigator.maxTouchPoints > 0;

  // Primary: width-based (CSS breakpoint) — most reliable across all envs
  const isNarrowViewport = window.innerWidth < 1024;

  // Classify as mobile if: narrow viewport OR (mobile UA + touch device)
  const isMobile = isNarrowViewport || (isMobileUA && isTouchDevice);

  document.body.classList.toggle('is-mobile', isMobile);
  document.body.classList.toggle('is-desktop', !isMobile);
  return isMobile;
}

/* Live re-evaluate on resize/orientation change */
window.addEventListener('resize', () => {
  detectAndApplyDeviceClass();
});

/* ============================================================
   INIT
   ============================================================ */
window.addEventListener('DOMContentLoaded', () => {
  const isMobile = detectAndApplyDeviceClass();

  // QR code and countdown only make sense on desktop
  if (!isMobile) {
    drawQRCode();
    startQRCountdown();
  }

  dom.openScannerBtn.addEventListener('click', openMobileScanner);
  dom.closeMobileBtn.addEventListener('click', closeMobileScanner);
  dom.torchBtn.addEventListener('click', toggleTorch);
  dom.transContinueBtn.addEventListener('click', startBackScan);
  dom.reCropFrontBtn?.addEventListener('click', () => {
    if (state.rawFront) {
      state.reCropping = 'FRONT';
      dom.successScreen.style.display = 'none';
      openCropScreen(state.rawFront, state.rawFrontSize?.w || 1000, state.rawFrontSize?.h || 636);
    }
  });

  dom.reCropBackBtn?.addEventListener('click', () => {
    if (state.rawBack) {
      state.reCropping = 'BACK';
      dom.successScreen.style.display = 'none';
      openCropScreen(state.rawBack, state.rawBackSize?.w || 1000, state.rawBackSize?.h || 636);
    }
  });

  dom.successBackBtn?.addEventListener('click', () => {
    dom.successScreen.style.display = 'none';
    state.capturedBack = null;
    startBackScan();
  });

  dom.successContinueBtn.addEventListener('click', () => {
    // Show the passport application form with captured passport images
    const appFormScreen = document.getElementById('appFormScreen');
    const appThumbFront = document.getElementById('appThumbFront');
    const appThumbBack  = document.getElementById('appThumbBack');

    // Populate thumbnails from captured images
    if (appThumbFront && state.capturedFront) appThumbFront.src = state.capturedFront;
    if (appThumbBack  && state.capturedBack)  appThumbBack.src  = state.capturedBack;

    dom.successScreen.style.display = 'none';
    if (appFormScreen) {
      appFormScreen.style.display = 'block';
      appFormScreen.scrollTop = 0;
    }
  });

  // Back to Crop — from form header button
  const appBackBtn = document.getElementById('appBackBtn');
  if (appBackBtn) {
    appBackBtn.addEventListener('click', goBackToCropFromForm);
  }

  // Back to Crop — from form bottom cancel button
  const appCancelBtn = document.getElementById('appCancelBtn');
  if (appCancelBtn) {
    appCancelBtn.addEventListener('click', goBackToCropFromForm);
  }

  // Form submit
  const passportDetailsForm = document.getElementById('passportDetailsForm');
  if (passportDetailsForm) {
    passportDetailsForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const declaration = document.getElementById('appDeclaration');
      if (!declaration || !declaration.checked) {
        declaration && declaration.closest('.app-declaration').classList.add('shake');
        setTimeout(() => declaration && declaration.closest('.app-declaration').classList.remove('shake'), 500);
        return;
      }
      const btn = document.getElementById('appSubmitBtn');
      if (btn) {
        btn.textContent = 'Submitting…';
        btn.disabled = true;
      }
      // Simulate submission — in a real app this POSTs to your server
      setTimeout(() => {
        alert('✅ Passport verification submitted successfully!');
        if (btn) { btn.textContent = 'Submit Verification'; btn.disabled = false; }
      }, 1200);
    });
  }

  // Wire crop actions
  dom.cropConfirmBtn.addEventListener('click', confirmCropAdjustment);
  dom.cropResetBtn.addEventListener('click', resetCropCorners);
  setupDragHandlers();

  // Wire Shutter / Capture button
  dom.shutterBtn.addEventListener('click', triggerCapture);

  // Wire desktop upload buttons
  if (dom.uploadPassportBtn && dom.passportFileInput) {
    dom.uploadPassportBtn.addEventListener('click', () => {
      state.phase = 'FRONT_SCAN';
      dom.passportFileInput.value = ''; // Reset file input to allow uploading same image
      dom.passportFileInput.click();
    });
    dom.passportFileInput.addEventListener('change', handlePassportFileUpload);
  }

  if (dom.transUploadBtn) {
    dom.transUploadBtn.addEventListener('click', () => {
      state.phase = 'BACK_SCAN';
      dom.passportFileInput.value = ''; // Reset file input
      dom.passportFileInput.click();
    });
  }

  // Wire mobile-direct-flow buttons
  const mobScanBtn = document.getElementById('mobOpenScannerBtn');
  const mobUploadBtn = document.getElementById('mobUploadPassportBtn');

  if (mobScanBtn) {
    mobScanBtn.addEventListener('click', openMobileScanner);
  }
  if (mobUploadBtn && dom.passportFileInput) {
    mobUploadBtn.addEventListener('click', () => {
      state.phase = 'FRONT_SCAN';
      dom.passportFileInput.value = '';
      dom.passportFileInput.click();
    });
  }

  // Wire mock demo verification buttons
  const mobMockDirectBtn = document.getElementById('mobMockDirectBtn');
  const demoMockVerifyBtn = document.getElementById('demoMockVerifyBtn');

  if (mobMockDirectBtn) {
    mobMockDirectBtn.addEventListener('click', triggerMockVerification);
  }
  if (demoMockVerifyBtn) {
    demoMockVerifyBtn.addEventListener('click', triggerMockVerification);
  }
});

/* ============================================================
   QR CODE — Dynamic URL generator using standard free API
   ============================================================ */
function drawQRCode() {
  const img = dom.qrImage;
  if (!img) return;

  // Always use the deployed GitHub Pages URL so scanning on phone redirects to the live page
  const targetUrl = 'https://yunis-560560.github.io/Scanner/';
  
  // Use a completely free, open QR code generator API
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=190x190&data=${encodeURIComponent(targetUrl)}&ecc=M`;
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

  // Show the 6-second animated guide onboarding demo overlay before starting the camera
  showOnboardingGuide();
}

function closeMobileScanner() {
  // Clear guide onboarding timer if active
  if (state.demoTimerId) {
    clearInterval(state.demoTimerId);
    state.demoTimerId = null;
  }
  if (dom.scannerDemoOverlay) {
    dom.scannerDemoOverlay.style.display = 'none';
  }

  stopCamera();
  dom.mobileView.style.display = 'none';
  dom.desktopView.style.display = 'flex';
  document.body.style.overflow = '';
  state.phase = 'IDLE';
  resetDetectionState();
}

function showOnboardingGuide() {
  if (!dom.scannerDemoOverlay || !dom.demoSkipBtn) {
    // Fallback: start camera immediately if elements do not exist
    startCamera();
    return;
  }

  // Ensure camera is stopped during onboarding guide
  stopCamera();

  // Show overlay
  dom.scannerDemoOverlay.style.display = 'flex';

  let secsLeft = 6;
  dom.demoSkipBtn.textContent = `Skip (${secsLeft}s)`;

  // Reset timer
  if (state.demoTimerId) {
    clearInterval(state.demoTimerId);
  }

  const skipGuide = async () => {
    if (state.demoTimerId) {
      clearInterval(state.demoTimerId);
      state.demoTimerId = null;
    }
    dom.scannerDemoOverlay.style.display = 'none';
    await startCamera();
  };

  dom.demoSkipBtn.onclick = (e) => {
    e.preventDefault();
    skipGuide();
  };

  state.demoTimerId = setInterval(() => {
    secsLeft--;
    if (secsLeft <= 0) {
      skipGuide();
    } else {
      dom.demoSkipBtn.textContent = `Skip (${secsLeft}s)`;
    }
  }, 1000);
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

  // Draw glare highlights on the overlay canvas
  if (dom.glareOverlayCanvas) {
    const glCanvas = dom.glareOverlayCanvas;
    if (glCanvas.width !== vw || glCanvas.height !== vh) {
      glCanvas.width = vw;
      glCanvas.height = vh;
    }
    const glCtx = glCanvas.getContext('2d');
    glCtx.clearRect(0, 0, vw, vh);
    if (analysis.overexposed && analysis.glarePoints && analysis.glarePoints.length > 0) {
      glCtx.fillStyle = 'rgba(239, 68, 68, 0.45)'; // semi-transparent red
      glCtx.beginPath();
      for (const pt of analysis.glarePoints) {
        // map sampled coords back to full video coords
        const fullX = sx + pt.x;
        const fullY = sy + pt.y;
        glCtx.arc(fullX, fullY, 4, 0, Math.PI * 2);
      }
      glCtx.fill();
    }
  }

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

  const glarePoints = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      luma[y * w + x] = l;
      brightnessSum += l;
      if (l > 240) {
        glareCount++;
        // Sample glare points for drawing (don't push every single pixel to save memory/time)
        if (x % step === 0 && y % step === 0) {
          glarePoints.push({ x, y });
        }
      }
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

  // Overexposed detection flag
  const isOverexposed = (glareRatio > 0.035) || (avgBrightness > 195 && avgEdge < 15);

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
    overexposed: isOverexposed,
    glarePoints,
  };
}

/* ============================================================
   CONTEXTUAL INSTRUCTION SELECTION
   Picks the most relevant guidance based on analysis metrics
   ============================================================ */
function selectInstruction(a) {
  const { confidence, brightness, edgeDensity, steadiness, glareRatio, fillRatio, overexposed } = a;

  if (overexposed) return 'overexposed';

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

  // If overexposed, artificially clamp confidence so it never captures
  let conf = analysis.confidence;
  const isOverexposed = analysis.overexposed;
  if (isOverexposed) {
    conf = Math.min(conf, 0.5); // block capture
  }

  const instrKey = selectInstruction(analysis);

  // Toggle Critical Glare Warning Banner
  if (dom.glareCriticalWarning) {
    dom.glareCriticalWarning.style.display = isOverexposed ? 'flex' : 'none';
  }

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

  // Auto-capture logic: Must exceed capture confidence and hold (blocked if overexposed)
  if (conf >= CONF_CAPTURE && !state.captured && !isOverexposed) {
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

  // Output canvas = guide size (inside the box only)
  canvas.width  = srcW;
  canvas.height = srcH;

  // Draw only the cropped guide region
  ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

  const dataURL = canvas.toDataURL('image/jpeg', 0.95);

  // Camera flash
  flashCapture();

  await sleep(280);

  // Stop camera and open crop adjust screen with guide box cropped frame
  stopCamera();
  dom.mobileView.style.display = 'none';
  openCropScreen(dataURL, srcW, srcH);
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
   GO BACK TO CROP FROM APPLICATION FORM
   Hides the app form and re-opens the crop screen so the
   user can re-adjust the crop before re-submitting.
   ============================================================ */
function goBackToCropFromForm() {
  const appFormScreen = document.getElementById('appFormScreen');
  if (appFormScreen) appFormScreen.style.display = 'none';

  // Re-open the crop screen with the last captured raw image
  if (state.cropImageSrc) {
    openCropScreen(state.cropImageSrc, state.cropImageSize.w, state.cropImageSize.h);
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
  if (state.phase === 'FRONT_SCAN' && !state.reCropping) {
    state.rawFront = rawImageSrc;
    state.rawFrontSize = { w: width, h: height };
  } else if (state.phase === 'BACK_SCAN' && !state.reCropping) {
    state.rawBack = rawImageSrc;
    state.rawBackSize = { w: width, h: height };
  }

  state.cropImageSrc = rawImageSrc;
  state.cropImageSize = { w: width, h: height };
  
  // Hide glare warning initially
  if (dom.cropGlareWarning) dom.cropGlareWarning.style.display = 'none';

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

/* ============================================================
   FILE UPLOAD HANDLER
   Reads and processes uploaded passport images
   ============================================================ */
function handlePassportFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    const dataURL = event.target.result;
    const img = new Image();
    img.onload = function() {
      // Hide desktop view and transition overlay
      dom.desktopView.style.display = 'none';
      dom.transitionOverlay.style.display = 'none';
      
      // Stop camera if running
      stopCamera();
      
      // Open crop screen with the uploaded image and its dimensions
      openCropScreen(dataURL, img.width, img.height);
    };
    img.src = dataURL;
  };
  reader.readAsDataURL(file);
}

/**
 * Checks if a specific corner of the image contains bright document pixels (above adaptive threshold),
 * indicating that the document extends directly to the edge of the image (no background margin visible).
 */
function isCornerFlush(imgData, corner, threshold) {
  const w = imgData.width;
  const h = imgData.height;
  const data = imgData.data;

  const checkW = Math.round(w * 0.15); // Check 15% of width
  const checkH = Math.round(h * 0.15); // Check 15% of height

  let startX = 0, endX = 0;
  let startY = 0, endY = 0;

  if (corner === 'tr') {
    startX = w - checkW; endX = w;
    startY = 0; endY = checkH;
  } else if (corner === 'tl') {
    startX = 0; endX = checkW;
    startY = 0; endY = checkH;
  } else if (corner === 'br') {
    startX = w - checkW; endX = w;
    startY = h - checkH; endY = h;
  } else if (corner === 'bl') {
    startX = 0; endX = checkW;
    startY = h - checkH; endY = h;
  }

  let brightCount = 0;
  let totalCount = 0;

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * w + x) * 4;
      const r = data[idx], g = data[idx+1], b = data[idx+2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma > threshold) {
        brightCount++;
      }
      totalCount++;
    }
  }

  return (brightCount / totalCount) > 0.40;
}

function initCropUI() {
  const rect = dom.cropImgPreview.getBoundingClientRect();
  
  // Set up offscreen canvas for magnification zoom source
  offscreenCropCanvas = document.createElement('canvas');
  offscreenCropCanvas.width = state.cropImageSize.w;
  offscreenCropCanvas.height = state.cropImageSize.h;
  const offCtx = offscreenCropCanvas.getContext('2d');
  offCtx.drawImage(dom.cropImgPreview, 0, 0, state.cropImageSize.w, state.cropImageSize.h);

  dom.cropSvg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  dom.cropSvg.style.width = `${rect.width}px`;
  dom.cropSvg.style.height = `${rect.height}px`;

  // Try auto corner detection and glare check
  let detected = null;
  let trFlush = false;
  try {
    const canvas = document.createElement('canvas');
    // Using a low resolution (240x180) speeds up processing and filters out texture/text noise
    const w = 240, h = 180;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(dom.cropImgPreview, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    
    // Check for glare/over-lighting on captured image
    const hasGlare = checkImageGlare(imgData);
    if (hasGlare && dom.cropGlareWarning) {
      dom.cropGlareWarning.style.display = 'flex';
    }

    // Determine adaptive threshold for brightness
    let sumLuma = 0;
    const total = w * h;
    const step = 4;
    for (let i = 0; i < imgData.data.length; i += 4 * step) {
      const r = imgData.data[i], g = imgData.data[i+1], b = imgData.data[i+2];
      sumLuma += (0.299 * r + 0.587 * g + 0.114 * b);
    }
    const avgLuma = sumLuma / (total / step);
    const threshold = Math.max(90, Math.min(180, avgLuma * 1.15));

    trFlush = isCornerFlush(imgData, 'tr', threshold);

    const corners = detectDocumentCorners(imgData);
    if (corners) {
      // Map coordinates back to screen SVG coordinate space
      const scaleX = rect.width / w;
      const scaleY = rect.height / h;
      detected = {
        tl: { x: corners.tl.x * scaleX, y: corners.tl.y * scaleY },
        tr: { x: corners.tr.x * scaleX, y: corners.tr.y * scaleY },
        br: { x: corners.br.x * scaleX, y: corners.br.y * scaleY },
        bl: { x: corners.bl.x * scaleX, y: corners.bl.y * scaleY }
      };
    }
  } catch (err) {
    console.warn('Corner detection/glare check error:', err);
  }

  if (detected) {
    state.cropCorners = detected;
  } else {
    // Centered crop template fallback
    const padX = rect.width * 0.12;
    const padY = rect.height * 0.18;
    state.cropCorners = {
      tl: { x: padX, y: padY },
      tr: { x: rect.width - padX, y: padY },
      br: { x: rect.width - padX, y: rect.height - padY },
      bl: { x: padX, y: rect.height - padY }
    };
  }

  // Override top-right corner if it is flush against the edge (no background margin visible)
  if (trFlush) {
    state.cropCorners.tr = { x: rect.width, y: 0 };
  }

  updateCropPolygon();
}

/* ============================================================
   IMAGE GLARE DETECTION (Over-lighting Analyzer)
   ============================================================ */
function checkImageGlare(imgData) {
  const data = imgData.data;
  let glareCount = 0;
  const total = imgData.width * imgData.height;
  const step = 3; // sample every 3rd pixel
  
  for (let i = 0; i < data.length; i += 4 * step) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    // Highlighted pixels (pure white over-lit reflection)
    if (luma > 230) {
      glareCount++;
    }
  }
  
  const glareRatio = glareCount / (total / step);
  return glareRatio > 0.015; // Warning triggers if glare exceeds 1.5% of total pixels
}

/* ============================================================
   AUTOMATIC DOCUMENT CORNER DETECTION (Adaptive Edge Mapping)
   ============================================================ */
function detectDocumentCorners(imgData) {
  const w = imgData.width;
  const h = imgData.height;
  const data = imgData.data;
  
  // Calculate average brightness of the image to set an adaptive threshold
  let sumLuma = 0;
  const total = w * h;
  const step = 4; // Sample every 4th pixel to make it fast
  
  for (let i = 0; i < data.length; i += 4 * step) {
    const r = data[i], g = data[i+1], b = data[i+2];
    sumLuma += (0.299 * r + 0.587 * g + 0.114 * b);
  }
  const avgLuma = sumLuma / (total / step);
  
  // Set threshold slightly above average to distinguish white passport from darker background
  const threshold = Math.max(90, Math.min(180, avgLuma * 1.15));
  
  // Find extreme boundaries that form the document shape
  let minSum = Infinity, maxSum = -Infinity;
  let minDiff = Infinity, maxDiff = -Infinity;
  
  let tl = null, tr = null, br = null, bl = null;
  
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const idx = (y * w + x) * 4;
      const r = data[idx], g = data[idx+1], b = data[idx+2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      
      if (luma > threshold) {
        // Top-Left minimizes x + y
        const sum = x + y;
        if (sum < minSum) {
          minSum = sum;
          tl = { x, y };
        }
        // Bottom-Right maximizes x + y
        if (sum > maxSum) {
          maxSum = sum;
          br = { x, y };
        }
        // Top-Right maximizes x - y
        const diff = x - y;
        if (diff > maxDiff) {
          maxDiff = diff;
          tr = { x, y };
        }
        // Bottom-Left minimizes x - y
        if (diff < minDiff) {
          minDiff = diff;
          bl = { x, y };
        }
      }
    }
  }
  
  // Validate detected coordinate points
  if (!tl || !tr || !br || !bl) return null;
  
  // Quadrant-based constraints: corners must reside in their respective outer quadrants
  // (prevents incorrect internal locking onto faces, text blocks, stamps, etc.)
  if (tl.x > w * 0.40 || tl.y > h * 0.40) return null;
  if (tr.x < w * 0.60 || tr.y > h * 0.40) return null;
  if (br.x < w * 0.60 || br.y < h * 0.60) return null;
  if (bl.x > w * 0.40 || bl.y < h * 0.60) return null;
  
  // Check if coordinates represent a reasonable size block (e.g. at least 45% of image size)
  if (Math.abs(tr.x - tl.x) < w * 0.45 || Math.abs(br.y - tr.y) < h * 0.45) {
    return null;
  }
  
  return { tl, tr, br, bl };
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

async function resetCropCorners() {
  dom.cropScreen.style.display = 'none';
  state.captured = false;
  state.holdStart = null;
  state.confidence = 0;

  if (state.reCropping === 'FRONT') {
    state.reCropping = null;
    state.capturedFront = null;
    state.phase = 'FRONT_SCAN';
    dom.mobileView.style.display = 'flex';
    setMobSideUI('front');
    await startCamera();
  } else if (state.reCropping === 'BACK') {
    state.reCropping = null;
    state.capturedBack = null;
    state.phase = 'BACK_SCAN';
    dom.mobileView.style.display = 'flex';
    setMobSideUI('back');
    await startCamera();
  } else {
    dom.mobileView.style.display = 'flex';
    await startCamera();
  }
}

/* ============================================================
   DRAGGABLE SVG HANDLES
   ============================================================ */
let activeHandle = null;

let activeHandleId = null;
let offscreenCropCanvas = null;

function setupDragHandlers() {
  const svg = dom.cropSvg;
  const container = svg.parentElement; // .crop-view-container
  
  container.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Find closest handle within a generous 65px touch target area
    let closestId = null;
    let minD = 65;
    
    for (const [key, pos] of Object.entries(state.cropCorners)) {
      const dx = pos.x - x;
      const dy = pos.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minD) {
        minD = d;
        closestId = key;
      }
    }
    
    if (closestId) {
      activeHandleId = closestId;
      container.setPointerCapture(e.pointerId);
      updateMagnifier(state.cropCorners[activeHandleId].x, state.cropCorners[activeHandleId].y);
    }
  });

  container.addEventListener('pointermove', (e) => {
    if (!activeHandleId) return;
    e.preventDefault();

    const rect = container.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;

    x = Math.max(0, Math.min(rect.width, x));
    y = Math.max(0, Math.min(rect.height, y));

    state.cropCorners[activeHandleId] = { x, y };
    updateCropPolygon();
    updateMagnifier(x, y);
  });

  const release = (e) => {
    if (activeHandleId) {
      container.releasePointerCapture(e.pointerId);
      activeHandleId = null;
      if (dom.cropMagnifier) {
        dom.cropMagnifier.style.display = 'none';
      }
    }
  };

  container.addEventListener('pointerup', release);
  container.addEventListener('pointercancel', release);
}

/* ============================================================
   MAGNIFYING GLASS LOUPE PREVIEW
   ============================================================ */
function updateMagnifier(x, y) {
  const magnifier = dom.cropMagnifier;
  if (!magnifier || !offscreenCropCanvas) return;

  magnifier.style.display = 'block';
  const mCtx = magnifier.getContext('2d');
  const size = magnifier.width; // 90px

  // Map screen coordinates (x, y) to raw image coordinates
  const rect = dom.cropImgPreview.getBoundingClientRect();
  const scaleX = state.cropImageSize.w / rect.width;
  const scaleY = state.cropImageSize.h / rect.height;

  const rawX = x * scaleX;
  const rawY = y * scaleY;

  // Clear magnifier background
  mCtx.fillStyle = '#0F172A';
  mCtx.fillRect(0, 0, size, size);

  // Crop a 48x48 pixel square area around the raw point
  const srcSize = 48;
  const sx = rawX - srcSize / 2;
  const sy = rawY - srcSize / 2;

  // Draw magnified image slice
  mCtx.drawImage(offscreenCropCanvas, sx, sy, srcSize, srcSize, 0, 0, size, size);

  // Draw central green crosshair line overlay
  mCtx.strokeStyle = '#00C853';
  mCtx.lineWidth = 2.5;
  mCtx.beginPath();
  
  // Horizontal line
  mCtx.moveTo(0, size / 2);
  mCtx.lineTo(size, size / 2);
  
  // Vertical line
  mCtx.moveTo(size / 2, 0);
  mCtx.lineTo(size / 2, size);
  
  mCtx.stroke();
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

      if (state.reCropping === 'FRONT') {
        state.capturedFront = flattenedDataURL;
        state.reCropping = null;
        extractPassportData(state.capturedFront);
      } else if (state.reCropping === 'BACK') {
        state.capturedBack = flattenedDataURL;
        state.reCropping = null;
        updateSuccessScreenState();
        showSuccessScreen();
      } else if (state.phase === 'FRONT_SCAN') {
        state.capturedFront = flattenedDataURL;
        state.phase = 'TRANSITION';
        showTransitionOverlay();
      } else if (state.phase === 'BACK_SCAN') {
        state.capturedBack = flattenedDataURL;
        state.phase = 'SUCCESS';
        stopCamera();
        dom.mobileView.style.display = 'none';
        extractPassportData(state.capturedFront).then(() => {
          if (state.capturedBack) {
            extractBackPageData(state.capturedBack);
          }
        });
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


/* ============================================================
   MOCK DEMO FLOW AUTO-VERIFICATION
   Triggered by "Direct Demo Flow" button on mobile card or
   "Mock Verification" inside guide overlay.
   Populates state with sample passport images, fills form inputs,
   and skips directly to the Success/Verification Form views.
   ============================================================ */
function triggerMockVerification() {
  console.info('⚡ Starting Mock Demo Verification Flow...');

  // Reset/stop camera if active
  stopCamera();
  if (dom.mobileView) dom.mobileView.style.display = 'none';
  if (dom.desktopView) dom.desktopView.style.display = 'none';
  if (dom.scannerDemoOverlay) dom.scannerDemoOverlay.style.display = 'none';
  if (state.demoTimerId) {
    clearInterval(state.demoTimerId);
    state.demoTimerId = null;
  }

  // Sample passport cropped images (using relative paths for offline and local/server support)
  const mockFrontImage = 'sample_passport.png';
  const mockBackImage  = 'sample_passport_back.png';

  state.capturedFront = mockFrontImage;
  state.capturedBack  = mockBackImage;
  state.cropImageSrc  = mockFrontImage;
  state.cropImageSize = { w: 1000, h: 636 };

  state.rawFront      = mockFrontImage;
  state.rawBack       = mockBackImage;
  state.rawFrontSize  = { w: 1000, h: 636 };
  state.rawBackSize   = { w: 1000, h: 636 };

  extractPassportData(state.capturedFront);
}

async function extractPassportData(imageData) {
  try {
    if (dom.successContinueBtn) {
      dom.successContinueBtn.disabled = true;
      dom.successContinueBtn.textContent = 'Extracting Data...';
    }

    const worker = await Tesseract.createWorker('eng');
    const ret = await worker.recognize(imageData);
    const text = ret.data.text;
    await worker.terminate();

    // Clean lines by removing spaces and standardizing to uppercase
    const lines = text.split('\n').map(l => l.replace(/\s/g, '').toUpperCase());
    
    // MRZ lines are typically exactly 44 chars. We look for lines > 35 chars that contain common MRZ characters.
    const mrzLines = lines.filter(l => l.length > 35 && (l.includes('<') || /^[A-Z0-9]+$/.test(l.replace(/</g, ''))));
    
    if (mrzLines.length < 2) {
      alert("We couldn't accurately read this passport. Please scan or upload a clearer image.");
      if (dom.successContinueBtn) dom.successContinueBtn.textContent = 'Continue to Application';
      return;
    }
    
    const mrz1 = mrzLines[mrzLines.length - 2];
    const mrz2 = mrzLines[mrzLines.length - 1];
    
    let surname = '';
    let givenNames = '';
    // MRZ 1 format: P<IND[SURNAME]<<[GIVEN NAMES]
    // The surname starts at index 5 and ends at the first '<<'.
    const namePart = mrz1.substring(5).split('<<');
    if (namePart.length > 0) surname = namePart[0].replace(/</g, ' ').trim();
    if (namePart.length > 1) givenNames = namePart[1].replace(/</g, ' ').trim();
    
    const passportNo = mrz2.substring(0, 9).replace(/</g, '');
    const nat = mrz2.substring(10, 13);
    const dobRaw = mrz2.substring(13, 19);
    const gender = mrz2.substring(20, 21);
    const expRaw = mrz2.substring(21, 27);
    
    const visibleText = text.toUpperCase();

    // Validation
    if (!surname || !passportNo || passportNo.length < 5) {
       alert("We couldn't accurately read this passport. Please scan or upload a clearer image.");
       if (dom.successContinueBtn) dom.successContinueBtn.textContent = 'Continue to Application';
       return;
    }

    // Check if the extracted surname exists in the general passport text (excluding the MRZ lines to be strict)
    // We remove the MRZ lines from the search space to ensure it matches the upper visual fields.
    const textWithoutMRZ = visibleText.replace(mrz1, '').replace(mrz2, '');
    const surnameValid = textWithoutMRZ.includes(surname);
    
    if (!surnameValid) {
       alert("We couldn't accurately read this passport. Please scan or upload a clearer image.");
       if (dom.successContinueBtn) dom.successContinueBtn.textContent = 'Continue to Application';
       return;
    }

    const formatMRZDate = (yymmdd) => {
       const yr = parseInt(yymmdd.substring(0,2));
       const y = yr > 50 ? 1900 + yr : 2000 + yr;
       return `${yymmdd.substring(4,6)}/${yymmdd.substring(2,4)}/${y}`;
    };

    const parsedData = {
      surname: surname,
      givenNames: givenNames,
      passportNo: passportNo,
      countryCode: nat,
      nationality: nat === 'IND' ? 'INDIAN' : nat,
      dob: formatMRZDate(dobRaw),
      expiryDate: formatMRZDate(expRaw),
      gender: gender,
      mrz1: mrz1,
      mrz2: mrz2
    };

    // Attempt full text extraction for front page fields
    const placeOfBirthMatch = visibleText.match(/PLACE\s*OF\s*BIRTH[\s\S]*?\n\s*([A-Z\s,]+)\n/);
    if (placeOfBirthMatch) parsedData.placeOfBirth = placeOfBirthMatch[1].trim();

    const placeOfIssueMatch = visibleText.match(/PLACE\s*OF\s*ISSUE[\s\S]*?\n\s*([A-Z\s]+)\n/);
    if (placeOfIssueMatch) parsedData.placeOfIssue = placeOfIssueMatch[1].trim();

    const issueDateMatch = visibleText.match(/DATE\s*OF\s*ISSUE[\s\S]*?(\d{2}\/\d{2}\/\d{4})/);
    if (issueDateMatch) parsedData.issueDate = issueDateMatch[1];

    for (const [idSuffix, value] of Object.entries(parsedData)) {
      const elId = 'field' + idSuffix.charAt(0).toUpperCase() + idSuffix.slice(1);
      const inputEl = document.getElementById(elId);
      if (inputEl) inputEl.value = value;
    }
    
    const decCheck = document.getElementById('appDeclaration');
    if (decCheck) decCheck.checked = true;

    updateSuccessScreenState();
    showSuccessScreen();

    if (dom.successContinueBtn) {
      dom.successContinueBtn.disabled = false;
      dom.successContinueBtn.innerHTML = `Continue to Application <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,18 15,12 9,6"/></svg>`;
    }

  } catch (err) {
    console.error("OCR Error:", err);
    alert("We couldn't accurately read this passport. Please scan or upload a clearer image.");
    if (dom.successContinueBtn) dom.successContinueBtn.textContent = 'Continue to Application';
  }
}

async function extractBackPageData(imageData) {
  try {
    if (dom.successContinueBtn) {
      dom.successContinueBtn.disabled = true;
      dom.successContinueBtn.textContent = 'Extracting Back Page Data...';
    }

    const worker = await Tesseract.createWorker('eng');
    const ret = await worker.recognize(imageData);
    const text = ret.data.text.toUpperCase();
    await worker.terminate();

    const parsedData = {};

    const fatherMatch = text.match(/LEGAL\s*GUARDIAN'S\s*NAME[\s\S]*?\n\s*([A-Z\s]+)\n/);
    if (fatherMatch) parsedData.fatherName = fatherMatch[1].trim();

    const motherMatch = text.match(/MOTHER(?:'S)?\s*NAME[\s\S]*?\n\s*([A-Z\s]+)\n/);
    if (motherMatch) parsedData.motherName = motherMatch[1].trim();

    const spouseMatch = text.match(/SPOUSE(?:'S)?\s*NAME[\s\S]*?\n\s*([A-Z\s]+)\n/);
    if (spouseMatch) parsedData.spouseName = spouseMatch[1].trim();

    const addressMatch = text.match(/ADDRESS[\s\S]*?\n([\s\S]*?)(?:PIN|$)/);
    if (addressMatch) {
      parsedData.address = addressMatch[1].replace(/\n/g, ', ').trim();
      const pinMatch = text.match(/PIN\s*[:\-]?\s*(\d{6})/);
      if (pinMatch) parsedData.pin = pinMatch[1];
    }
    
    const fileNoMatch = text.match(/FILE\s*NO[\s\S]*?([A-Z0-9]{15})/);
    if (fileNoMatch) parsedData.fileNo = fileNoMatch[1];

    for (const [idSuffix, value] of Object.entries(parsedData)) {
      const elId = 'field' + idSuffix.charAt(0).toUpperCase() + idSuffix.slice(1);
      const inputEl = document.getElementById(elId);
      if (inputEl && value) inputEl.value = value;
    }

    updateSuccessScreenState();
    showSuccessScreen();

    if (dom.successContinueBtn) {
      dom.successContinueBtn.disabled = false;
      dom.successContinueBtn.innerHTML = `Continue to Application <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,18 15,12 9,6"/></svg>`;
    }

  } catch (err) {
    console.error("OCR Back Page Error:", err);
    updateSuccessScreenState();
    showSuccessScreen();
    if (dom.successContinueBtn) {
      dom.successContinueBtn.disabled = false;
      dom.successContinueBtn.innerHTML = `Continue to Application <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,18 15,12 9,6"/></svg>`;
    }
  }
}

function updateSuccessScreenState() {
  if (dom.thumbFrontImg && state.capturedFront) dom.thumbFrontImg.src = state.capturedFront;
  if (dom.thumbBackImg && state.capturedBack) {
    dom.thumbBackImg.src = state.capturedBack;
    const backThumb = dom.thumbBackImg.closest('.success-thumb');
    if (backThumb) backThumb.style.display = 'block';
  }

  const appThumbFront = document.getElementById('appThumbFront');
  const appThumbBack  = document.getElementById('appThumbBack');
  if (appThumbFront && state.capturedFront) appThumbFront.src = state.capturedFront;
  if (appThumbBack && state.capturedBack)  appThumbBack.src  = state.capturedBack;

  if (dom.successContinueBtn) {
    if (state.capturedFront && state.capturedBack) {
      dom.successContinueBtn.disabled = false;
      dom.successContinueBtn.style.opacity = '1';
    } else {
      dom.successContinueBtn.disabled = true;
      dom.successContinueBtn.style.opacity = '0.5';
    }
  }
}


