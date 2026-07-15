/**
 * ocr.js
 * Production-ready e-KYC OCR Pipeline with Zone-Based Extraction and ICAO 9303 Validation
 */

let globalOcrWorker = null;
let globalMrzWorker = null;

// Initialize workers once to speed up consecutive scans
async function initWorkers() {
  if (!globalOcrWorker) {
    globalOcrWorker = await Tesseract.createWorker('eng');
  }
  if (!globalMrzWorker) {
    globalMrzWorker = await Tesseract.createWorker('eng');
    await globalMrzWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
    });
  }
}

// Show/Hide OCR Loading UI
function setOcrLoading(show, message = "Analyzing Document...") {
  const overlay = document.getElementById('ocrLoadingOverlay');
  const status = document.getElementById('ocrLoadingStatus');
  if (overlay && status) {
    overlay.style.display = show ? 'flex' : 'none';
    status.textContent = message;
  }
}

// Clear OCR Caches and State
function resetOCRCache() {
  console.log("Clearing OCR caches and session data...");
  sessionStorage.clear();
  localStorage.clear();
  if (typeof resetApp === 'function' && !window.isResettingApp) {
    window.isResettingApp = true;
    resetApp();
    window.isResettingApp = false;
  }
}

// -------------------------------------------------------------
// MAIN ENTRY POINT
// -------------------------------------------------------------
async function startDocumentOCR(frontDataUrl, backDataUrl) {
  try {
    resetOCRCache(); // Absolute state isolation
    setOcrLoading(true, "Initializing Production OCR Engine...");
    
    await initWorkers();

    let finalData = {
      personalInformation: {},
      passportInformation: {},
      familyDetails: {},
      address: {},
      additionalInformation: {},
      mrz: {},
      confidence: {},
      validation: {}
    };

    // Process Front Page
    if (frontDataUrl) {
      setOcrLoading(true, "Validating Front Page Quality...");
      await validateImageQuality(frontDataUrl);
      setOcrLoading(true, "Enhancing Front Page Image...");
      const enhancedFront = await preprocessImage(frontDataUrl);

      setOcrLoading(true, "Scanning Front Page Zones...");
      const frontResult = await extractFrontPageZones(enhancedFront);
      finalData = mergeOCRData(finalData, frontResult);
    }

    // Process Back Page
    if (backDataUrl) {
      setOcrLoading(true, "Validating Back Page Quality...");
      await validateImageQuality(backDataUrl);
      setOcrLoading(true, "Enhancing Back Page Image...");
      const enhancedBack = await preprocessImage(backDataUrl);

      setOcrLoading(true, "Scanning Back Page Zones...");
      const backResult = await extractBackPageZones(enhancedBack);
      finalData = mergeOCRData(finalData, backResult);
    }

    setOcrLoading(true, "Validating MRZ Check Digits...");
    finalData = validateAndResolveConflicts(finalData);

    console.log("FINAL OUTPUT JSON:\n", JSON.stringify(finalData, null, 2));

    setOcrLoading(true, "Populating Verification Form...");
    populateForm(finalData);

  } catch (error) {
    console.error("OCR Error:", error);
    alert("Passport image quality is insufficient. Please capture a clearer image with good lighting.\nDetails: " + error.message);
  } finally {
    setOcrLoading(false);
    if (typeof updateSuccessScreenState === 'function') {
      updateSuccessScreenState();
      showSuccessScreen();
    }
  }
}

function mergeOCRData(base, addition) {
  return {
    personalInformation: { ...base.personalInformation, ...addition.personalInformation },
    passportInformation: { ...base.passportInformation, ...addition.passportInformation },
    familyDetails: { ...base.familyDetails, ...addition.familyDetails },
    address: { ...base.address, ...addition.address },
    additionalInformation: { ...base.additionalInformation, ...addition.additionalInformation },
    mrz: { ...base.mrz, ...addition.mrz },
    confidence: { ...base.confidence, ...addition.confidence },
    validation: { ...base.validation, ...addition.validation }
  };
}

// -------------------------------------------------------------
// IMAGE PROCESSING & ZONE EXTRACTION
// -------------------------------------------------------------
function getImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ img, width: img.width, height: img.height });
    img.src = dataUrl;
  });
}

async function validateImageQuality(dataUrl) {
  const { img, width, height } = await getImageDimensions(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  
  let brightnessSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    brightnessSum += (0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]);
  }
  const avgBrightness = brightnessSum / (width * height);
  
  if (avgBrightness < 30) throw new Error("Underexposure detected. Image is too dark.");
  if (avgBrightness > 225) throw new Error("Overexposure detected. Image is too bright.");
  
  return true;
}

async function preprocessImage(dataUrl) {
  const { img, width, height } = await getImageDimensions(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'contrast(1.4) grayscale(100%) brightness(1.05)';
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.95);
}

// Converts relative percentages to absolute pixels for Tesseract
function getRect(imgWidth, imgHeight, relX, relY, relW, relH) {
  return {
    left: Math.floor(imgWidth * relX),
    top: Math.floor(imgHeight * relY),
    width: Math.floor(imgWidth * relW),
    height: Math.floor(imgHeight * relH)
  };
}

// FRONT PAGE ZONES
async function extractFrontPageZones(imageUrl) {
  const { img, width, height } = await getImageDimensions(imageUrl);
  
  // Define highly precise horizontal bands for Indian passports
  const zones = {
    topBand: getRect(width, height, 0.0, 0.05, 1.0, 0.15),      // Type, Country, Passport No
    surnameBand: getRect(width, height, 0.25, 0.18, 0.75, 0.10),  // Surname
    givenNameBand: getRect(width, height, 0.25, 0.28, 0.75, 0.10),// Given Name
    dobBand: getRect(width, height, 0.25, 0.38, 0.75, 0.12),      // Nationality, Sex, DOB
    pobBand: getRect(width, height, 0.25, 0.50, 0.75, 0.10),      // Place of Birth
    issueBand: getRect(width, height, 0.25, 0.60, 0.75, 0.15),    // Place of Issue, Date of Issue, Expiry
    mrz: getRect(width, height, 0.0, 0.75, 1.0, 0.25)
  };

  const result = { personalInformation: {}, passportInformation: {}, mrz: {}, confidence: {} };

  // 1. Process MRZ (Highest Priority)
  setOcrLoading(true, "Scanning MRZ Zone...");
  const { data: mrzData } = await globalMrzWorker.recognize(imageUrl, { rectangle: zones.mrz });
  const parsedMrz = parseMRZ(mrzData.text);
  result.mrz = parsedMrz.data;
  Object.assign(result.confidence, parsedMrz.confidence);

  // 2. Process Top Band (Passport Number)
  setOcrLoading(true, "Scanning Top Band...");
  const { data: topData } = await globalOcrWorker.recognize(imageUrl, { rectangle: zones.topBand });
  const pnoMatch = topData.text.match(/[A-Z][0-9]{7}/i);
  if (pnoMatch) {
    result.passportInformation.passportNumber = pnoMatch[0].toUpperCase();
    result.confidence.passportNumber = topData.confidence;
  }

  // 3. Process Surname Band
  setOcrLoading(true, "Scanning Surname...");
  const { data: surData } = await globalOcrWorker.recognize(imageUrl, { rectangle: zones.surnameBand });
  let surLines = surData.text.split('\n').map(l => l.replace(/[^A-Z\s]/gi, '').trim()).filter(l => l && !l.toUpperCase().includes('SURNAME'));
  if (surLines.length > 0) {
    result.personalInformation.surname = surLines[0];
    result.confidence.surname = surData.confidence;
  }

  // 4. Process Given Name Band
  setOcrLoading(true, "Scanning Given Names...");
  const { data: givenData } = await globalOcrWorker.recognize(imageUrl, { rectangle: zones.givenNameBand });
  let givenLines = givenData.text.split('\n').map(l => l.replace(/[^A-Z\s]/gi, '').trim()).filter(l => l && !l.toUpperCase().includes('GIVEN NAME'));
  if (givenLines.length > 0) {
    result.personalInformation.givenNames = givenLines[0];
    result.confidence.givenNames = givenData.confidence;
  }

  // 5. Process DOB Band (DOB, Sex, Nationality)
  setOcrLoading(true, "Scanning DOB/Sex/Nationality...");
  const { data: dobData } = await globalOcrWorker.recognize(imageUrl, { rectangle: zones.dobBand });
  const dobText = dobData.text.toUpperCase();
  const dobMatch = dobText.match(/(\d{2}[/\-]\d{2}[/\-]\d{4})/);
  if (dobMatch) {
    result.personalInformation.dateOfBirth = dobMatch[1].replace(/-/g, '/');
    result.confidence.dateOfBirth = dobData.confidence;
  }
  const sexMatch = dobText.match(/\b(M|F|MALE|FEMALE|SEX)\b/i);
  if (sexMatch && !sexMatch[0].includes('SEX')) {
    result.personalInformation.gender = sexMatch[0].startsWith('M') ? 'Male (M)' : 'Female (F)';
  }
  if (dobText.includes('INDI') || dobText.includes('IND')) {
    result.personalInformation.nationality = 'INDIAN';
  }

  // 6. Process POB Band
  setOcrLoading(true, "Scanning Place of Birth...");
  const { data: pobData } = await globalOcrWorker.recognize(imageUrl, { rectangle: zones.pobBand });
  let pobLines = pobData.text.split('\n').map(l => l.replace(/[^A-Z\s,]/gi, '').trim()).filter(l => l && !l.toUpperCase().includes('BIRTH'));
  if (pobLines.length > 0) {
    result.personalInformation.placeOfBirth = pobLines[0];
    result.confidence.placeOfBirth = pobData.confidence;
  }

  // 7. Process Issue Band
  setOcrLoading(true, "Scanning Issue Details...");
  const { data: issueData } = await globalOcrWorker.recognize(imageUrl, { rectangle: zones.issueBand });
  let issueLines = issueData.text.split('\n').map(l => l.trim().toUpperCase()).filter(l => l);
  const dates = issueData.text.match(/(\d{2}[/\-]\d{2}[/\-]\d{4})/g);
  if (dates && dates.length >= 1) result.passportInformation.dateOfIssue = dates[0].replace(/-/g, '/');
  if (dates && dates.length >= 2) result.passportInformation.dateOfExpiry = dates[1].replace(/-/g, '/');
  
  let poiMatch = issueLines.find(l => !l.includes('ISSUE') && !l.match(/\d/) && l.length > 3);
  if (poiMatch) {
    result.passportInformation.placeOfIssue = poiMatch.replace(/[^A-Z\s]/g, '').trim();
    result.confidence.placeOfIssue = issueData.confidence;
  }

  return result;
}

// BACK PAGE ZONES
async function extractBackPageZones(imageUrl) {
  const { img, width, height } = await getImageDimensions(imageUrl);
  
  // Define highly precise back page horizontal bands
  const zones = {
    parentsBand: getRect(width, height, 0.0, 0.05, 1.0, 0.35),
    addressBand: getRect(width, height, 0.0, 0.40, 1.0, 0.25),
    oldPassBand: getRect(width, height, 0.0, 0.65, 1.0, 0.15),
    fileNoBand: getRect(width, height, 0.0, 0.80, 1.0, 0.20)
  };

  const result = { familyDetails: {}, address: {}, additionalInformation: {}, confidence: {} };

  // 1. Process Parents Zone
  setOcrLoading(true, "Scanning Parents Zone...");
  const { data: parentsData } = await globalOcrWorker.recognize(imageUrl, { rectangle: zones.parentsBand });
  const pLines = parentsData.text.split('\n').map(l => l.replace(/[^A-Z\s]/gi, '').trim().toUpperCase()).filter(l => l.length > 2);
  
  let foundFather = false, foundMother = false, foundSpouse = false;
  for (let i = 0; i < pLines.length; i++) {
    const line = pLines[i];
    if ((line.includes('FATHER') || line.includes('LEGAL')) && !result.familyDetails.fatherName) {
      foundFather = true;
      if (pLines[i+1] && !pLines[i+1].includes('MOTHER')) result.familyDetails.fatherName = pLines[i+1];
      continue;
    }
    if (line.includes('MOTHER') && !result.familyDetails.motherName) {
      foundMother = true;
      if (pLines[i+1] && !pLines[i+1].includes('SPOUSE') && !pLines[i+1].includes('ADDRESS')) result.familyDetails.motherName = pLines[i+1];
      continue;
    }
    if (line.includes('SPOUSE') && !result.familyDetails.spouseName) {
      foundSpouse = true;
      if (pLines[i+1] && !pLines[i+1].includes('ADDRESS')) result.familyDetails.spouseName = pLines[i+1];
      continue;
    }
  }
  result.confidence.familyDetails = parentsData.confidence;

  // 2. Process Address Zone
  setOcrLoading(true, "Scanning Address Zone...");
  const { data: addressData } = await globalOcrWorker.recognize(imageUrl, { rectangle: zones.addressBand });
  const addressLines = addressData.text.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  
  let addressText = "";
  let startedAddress = false;
  for (let line of addressLines) {
    let upLine = line.toUpperCase();
    if (upLine.includes('OLD PASS') || upLine.includes('FILE')) break;
    if (upLine.includes('ADDRESS')) { startedAddress = true; continue; }
    if (startedAddress) {
      addressText += line + " ";
    }
  }
  if (!startedAddress) addressText = addressLines.join(" ");

  // Extract PIN (6 digits)
  const pinMatch = addressText.match(/\b\d{6}\b/);
  if (pinMatch) {
    result.address.pin = pinMatch[0];
    addressText = addressText.replace(pinMatch[0], "").trim();
  } else {
    // Check for 'PIN' explicitly
    const explicitPinMatch = addressText.match(/PIN.*?(\d{6})/i);
    if (explicitPinMatch) {
      result.address.pin = explicitPinMatch[1];
      addressText = addressText.replace(explicitPinMatch[0], "").trim();
    }
  }
  
  // Clean up 'PIN:' string if it exists alone
  addressText = addressText.replace(/PIN:?\s*/gi, "").trim();

  // Extract Country
  if (addressText.toUpperCase().includes('INDIA')) {
    result.address.country = 'INDIA';
    addressText = addressText.replace(/INDIA/gi, "").trim();
  }

  // A very basic extraction for State & City based on common commas
  const parts = addressText.split(',').map(p => p.trim()).filter(p => p);
  if (parts.length > 2) {
    result.address.state = parts.pop();
    result.address.city = parts.pop();
    result.address.addressLine1 = parts[0] || '';
    result.address.addressLine2 = parts.slice(1).join(', ');
  } else {
    // If not comma separated nicely, just split string in half roughly
    const mid = Math.floor(addressText.length / 2);
    result.address.addressLine1 = addressText.substring(0, mid).trim();
    result.address.addressLine2 = addressText.substring(mid).trim();
  }
  result.confidence.address = addressData.confidence;

  // 3. Process Old Passport Zone
  setOcrLoading(true, "Scanning Old Passport Zone...");
  const { data: oldPassData } = await globalOcrWorker.recognize(imageUrl, { rectangle: zones.oldPassBand });
  const oldPassMatch = oldPassData.text.match(/([A-Z0-9]{7,9})/i);
  if (oldPassMatch && oldPassData.text.toUpperCase().includes('OLD')) {
    result.additionalInformation.oldPassportNo = oldPassMatch[1].toUpperCase();
  }
  const oldDateMatch = oldPassData.text.match(/(\d{2}[/\-]\d{2}[/\-]\d{4})/);
  if (oldDateMatch) result.additionalInformation.oldPassportDate = oldDateMatch[1].replace(/-/g, '/');

  // 4. Process File No Zone
  setOcrLoading(true, "Scanning File No Zone...");
  const { data: fileData } = await globalOcrWorker.recognize(imageUrl, { rectangle: zones.fileNoBand });
  const fileMatch = fileData.text.match(/([A-Z]{2}[0-9]{13})/i);
  if (fileMatch) result.additionalInformation.fileNumber = fileMatch[1].toUpperCase();
  result.confidence.fileNumber = fileData.confidence;

  return result;
}

// -------------------------------------------------------------
// MRZ PARSING & ICAO 9303 VALIDATION
// -------------------------------------------------------------
function sanitizeMRZ(rawText) {
  let lines = rawText.split('\n').map(l => l.replace(/\s/g, '').trim()).filter(l => l.length >= 30);
  return lines.map(line => {
    let cleaned = line.toUpperCase();
    if (cleaned.startsWith('P') && cleaned.length > 5) {
       cleaned = 'P<IND' + cleaned.substring(5);
    }
    cleaned = cleaned.replace(/[LKE]{2,}/g, match => '<'.repeat(match.length));
    cleaned = cleaned.replace(/[LKE\.]+$/g, match => '<'.repeat(match.length));
    if (cleaned.length < 44) cleaned = cleaned.padEnd(44, '<');
    if (cleaned.length > 44) cleaned = cleaned.substring(0, 44);
    return cleaned;
  });
}

function calculateICAOCheckDigit(str) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    let val = 0;
    if (char >= '0' && char <= '9') val = parseInt(char, 10);
    else if (char >= 'A' && char <= 'Z') val = char.charCodeAt(0) - 55;
    else if (char === '<') val = 0;
    else return -1;
    sum += val * weights[i % 3];
  }
  return sum % 10;
}

function parseMRZ(rawText) {
  const lines = sanitizeMRZ(rawText);
  const data = {};
  const confidence = { mrz: 95 }; // Baseline if structured well

  if (lines.length >= 2) {
    const line1 = lines[lines.length - 2];
    const line2 = lines[lines.length - 1];

    data.mrz1 = line1;
    data.mrz2 = line2;

    if (line1.startsWith('P')) {
      data.passportType = line1.substring(0, 1);
      data.countryCode = line1.substring(2, 5).replace(/</g, '');
      const nameStr = line1.substring(5);
      const nameParts = nameStr.split('<<');
      if (nameParts.length > 0) data.surname = nameParts[0].replace(/</g, ' ').trim();
      if (nameParts.length > 1) data.givenNames = nameParts[1].replace(/</g, ' ').trim();
      
      data.passportNo = line2.substring(0, 9).replace(/</g, '');
      data.passportNoCheckDigit = line2.substring(9, 10);
      
      data.nationality = line2.substring(10, 13).replace(/</g, '');
      
      data.dob = line2.substring(13, 19);
      data.dobCheckDigit = line2.substring(19, 20);
      
      data.gender = line2.substring(20, 21);
      
      data.expiry = line2.substring(21, 27);
      data.expiryCheckDigit = line2.substring(27, 28);
      
      data.compositeCheckDigit = line2.substring(43, 44);
    }
  }
  return { data, confidence };
}

function validateAndResolveConflicts(finalData) {
  // Validate ICAO 9303 checksums
  const mrz = finalData.mrz;
  const v = { passportNoValid: false, dobValid: false, expiryValid: false };

  if (mrz.passportNo && mrz.passportNoCheckDigit) {
    const calc = calculateICAOCheckDigit(mrz.passportNo);
    v.passportNoValid = (calc === parseInt(mrz.passportNoCheckDigit, 10));
  }
  if (mrz.dob && mrz.dobCheckDigit) {
    const calc = calculateICAOCheckDigit(mrz.dob);
    v.dobValid = (calc === parseInt(mrz.dobCheckDigit, 10));
  }
  if (mrz.expiry && mrz.expiryCheckDigit) {
    const calc = calculateICAOCheckDigit(mrz.expiry);
    v.expiryValid = (calc === parseInt(mrz.expiryCheckDigit, 10));
  }
  
  finalData.validation = v;

  // Conflict Resolution: Prefer MRZ for Core Identifiers
  if (mrz.passportNo) {
    finalData.passportInformation.passportNumber = mrz.passportNo;
    finalData.confidence.passportNumber = 100; // MRZ is highly trusted
  }
  if (mrz.dob) {
    finalData.personalInformation.dateOfBirth = formatMRZDate(mrz.dob);
    finalData.confidence.dateOfBirth = 100;
  }
  if (mrz.expiry) {
    finalData.passportInformation.dateOfExpiry = formatMRZDate(mrz.expiry, true);
    finalData.confidence.dateOfExpiry = 100;
  }
  if (mrz.gender) {
    finalData.personalInformation.gender = mrz.gender === 'M' ? 'Male (M)' : (mrz.gender === 'F' ? 'Female (F)' : mrz.gender);
  }
  if (mrz.nationality) {
    finalData.personalInformation.nationality = mrz.nationality;
  }
  if (mrz.surname) {
    finalData.personalInformation.surname = mrz.surname;
    finalData.confidence.surname = 100;
  }
  if (mrz.givenNames) {
    finalData.personalInformation.givenNames = mrz.givenNames;
    finalData.confidence.givenNames = 100;
  }

  const mrzValid = v.passportNoValid && v.dobValid && v.expiryValid;
  finalData.validation.mrzValidationString = mrzValid ? '✅ Pass' : '❌ Fail';
  
  const confs = Object.values(finalData.confidence).filter(c => typeof c === 'number');
  if (confs.length > 0) {
    const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
    finalData.confidence.overall = Math.round(avg) + '%';
  } else {
    finalData.confidence.overall = 'N/A';
  }

  return finalData;
}

function formatMRZDate(yymmdd, isExpiry = false) {
  if (!yymmdd || yymmdd.length !== 6 || yymmdd.includes('<')) return '';
  const yy = parseInt(yymmdd.substring(0, 2), 10);
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);
  const currentYear = new Date().getFullYear() % 100;
  const fullYear = isExpiry ? 2000 + yy : (yy > currentYear ? 1900 + yy : 2000 + yy);
  return `${dd}/${mm}/${fullYear}`;
}

// -------------------------------------------------------------
// FORM POPULATION
// -------------------------------------------------------------
function populateForm(finalData) {
  const setVal = (id, val, conf) => {
    const el = document.getElementById(id);
    if (el) {
      if (val !== undefined && val !== null) {
         if (typeof conf === 'number' && conf < 80) {
            // Below 80%, leave empty per requirements and ask user to verify
            el.value = '';
            el.placeholder = "Please verify " + val;
         } else {
            el.value = val;
         }
      }
      
      el.classList.remove('confidence-high', 'confidence-medium', 'confidence-low');
      if (typeof conf === 'number') {
        if (conf >= 90) el.classList.add('confidence-high');
        else if (conf >= 80) el.classList.add('confidence-medium');
        else el.classList.add('confidence-low');
      }
    }
  };

  const pi = finalData.personalInformation || {};
  const pa = finalData.passportInformation || {};
  const fd = finalData.familyDetails || {};
  const ad = finalData.address || {};
  const ai = finalData.additionalInformation || {};
  const mz = finalData.mrz || {};
  const c = finalData.confidence || {};

  setVal('fieldPassportType', mz.passportType || pi.passportType);
  setVal('fieldCountryCode', mz.countryCode);
  setVal('fieldPassportNo', pa.passportNumber, c.passportNumber);
  setVal('fieldSurname', pi.surname, c.surname);
  setVal('fieldGivenNames', pi.givenNames, c.givenNames);
  setVal('fieldGender', pi.gender);
  setVal('fieldDob', pi.dateOfBirth, c.dateOfBirth);
  setVal('fieldPlaceOfBirth', pi.placeOfBirth, c.placeOfBirth);
  setVal('fieldNationality', pi.nationality);

  setVal('fieldIssueDate', pa.dateOfIssue, c.dateOfIssue);
  setVal('fieldExpiryDate', pa.dateOfExpiry, c.dateOfExpiry);
  setVal('fieldPlaceOfIssue', pa.placeOfIssue, c.placeOfIssue);
  setVal('fieldIssuingAuthority', pa.issuingAuthority);

  setVal('fieldFatherName', fd.fatherName, c.familyDetails);
  setVal('fieldMotherName', fd.motherName, c.familyDetails);
  setVal('fieldSpouseName', fd.spouseName, c.familyDetails);

  setVal('fieldAddressLine1', ad.addressLine1, c.address);
  setVal('fieldAddressLine2', ad.addressLine2, c.address);
  setVal('fieldCity', ad.city, c.address);
  setVal('fieldState', ad.state, c.address);
  setVal('fieldPin', ad.pin, c.address);
  setVal('fieldCountry', ad.country || 'India', c.address);

  setVal('fieldOldPassportNo', ai.oldPassportNo, c.oldPass);
  setVal('fieldOldPassportDate', ai.oldPassportDate, c.oldPass);
  setVal('fieldOldPassportPlace', ai.oldPassportPlace, c.oldPass);

  setVal('fieldFileNo', ai.fileNumber, c.fileNumber);
  setVal('fieldBarcode', ai.barcode);
  
  const overallField = document.getElementById('fieldOcrConfidence');
  if (overallField) overallField.value = finalData.confidence?.overall || '';
  
  const mrzField = document.getElementById('fieldMrzValidation');
  if (mrzField) mrzField.value = finalData.validation?.mrzValidationString || '';

  const mrz1 = document.getElementById('fieldMrz1');
  if (mrz1) mrz1.value = mz.mrz1 || '';
  
  const mrz2 = document.getElementById('fieldMrz2');
  if (mrz2) mrz2.value = mz.mrz2 || '';
}
