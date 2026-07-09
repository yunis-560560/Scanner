# 🛂 eVisa Website — Passport Scanner

A real-time dual-side passport scanning feature for visa application forms, inspired by the South African eVisa website (eta.dha.gov.za).

## ✨ Features

- **Dual-Side Scanning** — Scan both front (photo/data page) and back (visa/stamps page) of the passport
- **Real-Time Camera Overlay** — Clean white rounded border frame with dark mask, exactly like SA eVisa
- **Circular Crosshair Target** — Concentric rings + crosshair arms to help align the passport
- **"Fit the document into the frame"** — Semi-transparent instruction banner
- **Auto-Capture** — Canvas edge/brightness analysis auto-detects passport and captures
- **Tesseract.js OCR** — Real in-browser OCR engine reads all text from the passport image
- **MRZ Parsing** — ICAO 9303 Type P MRZ zone parser (2-line, 44 chars)
- **Auto-Fill Form** — Animated typing fills all fields: name, DOB, nationality, passport number, sex, expiry, issue date, place of issue, visa type, authority
- **Image Upload** — Drag & drop front + back images as alternative to camera
- **Torch & Camera Flip** — Flashlight and front/back camera controls
- **Fully Responsive** — Works on phone and laptop

## 📁 Files

| File | Description |
|---|---|
| `index.html` | Full visa form with dual-side scanner, tabs, all form fields |
| `style.css` | Dark premium design, scanner overlay, crosshair, animations |
| `scanner.js` | Camera API, detection loop, Tesseract OCR, MRZ parser, form auto-fill |

## 🚀 Usage

Open `index.html` directly in Chrome/Safari on a device with a camera.

No server required — runs fully in the browser.

## 🔧 Tech Stack

- Vanilla HTML + CSS + JavaScript
- [Tesseract.js](https://github.com/naptha/tesseract.js) — OCR engine (CDN)
- WebRTC `getUserMedia` API for camera access
- Canvas API for frame analysis and image capture
- ICAO 9303 MRZ parsing

## 📸 Scanner Flow

1. Click **"Start Scanning — Front Side First"**
2. Position passport photo page in the white frame
3. Auto-capture fires when document is detected
4. Transition prompt: **"Flip passport — Scan Back Side"**
5. Scan back side (visa page)
6. Tesseract OCR reads both images
7. All form fields auto-populated with typing animation

---

*Built for eVisa portal — passport scanning feature*
