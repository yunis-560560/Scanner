# 🛂 Passport Scanner — e-KYC Verification

A real-time dual-side passport scanning and identity verification tool built for visa and KYC application portals.

## ✨ Features

- **Dual-Side Scanning** — Scan both front (photo/data page) and back (address page) of the passport
- **Real-Time Camera Overlay** — Clean white rounded border frame with dark mask overlay
- **Auto-Capture** — Canvas edge/brightness analysis auto-detects passport and captures automatically
- **Cropped Output** — Captures only the passport area, no fingers or background
- **Guide Frame** — Corner markers and MRZ zone indicator to help align the passport
- **Torch & Camera Controls** — Flashlight toggle and camera controls
- **Fully Responsive** — Works on phone and laptop

## 📁 Files

| File | Description |
|---|---|
| `index.html` | Full scanner UI with dual-side flow, overlays, and success screen |
| `style.css` | Premium design, dark camera overlay, animations, responsive layout |
| `scanner.js` | Camera API, detection loop, auto-capture, guide frame crop logic |

## 🚀 Usage

Open `index.html` directly in Chrome/Safari on a device with a camera.

No server required — runs fully in the browser.

## 🔧 Tech Stack

- Vanilla HTML + CSS + JavaScript (100% original code)
- Google Fonts — Inter (SIL Open Font License — free for commercial use)
- WebRTC `getUserMedia` API for camera access (built-in browser API)
- Canvas API for frame analysis and image capture (built-in browser API)

## 📸 Scanner Flow

1. Click **"Open Passport Scanner"**
2. Position passport front page inside the white frame
3. Auto-capture fires when document is detected
4. Transition prompt: flip passport to back side
5. Scan back side
6. Success screen shows cropped passport images

---

## © Copyright

© 2026 yunis-560560. All rights reserved.

This project is original work. All HTML, CSS, and JavaScript code was written from scratch.
No third-party libraries with restrictive licenses are used.
