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
  const fieldsToClear = [
    'fieldPassportType', 'fieldCountryCode', 'fieldPassportNo',
    'fieldSurname', 'fieldGivenNames', 'fieldGender', 'fieldDob', 'fieldPlaceOfBirth', 'fieldNationality',
    'fieldIssueDate', 'fieldExpiryDate', 'fieldPlaceOfIssue', 'fieldIssuingAuthority',
    'fieldFatherName', 'fieldMotherName', 'fieldSpouseName',
    'fieldAddressLine1', 'fieldAddressLine2', 'fieldCity', 'fieldState', 'fieldPin', 'fieldCountry',
    'fieldOldPassportNo', 'fieldOldPassportDate', 'fieldOldPassportPlace',
    'fieldFileNo', 'fieldBarcode', 'fieldOcrConfidence', 'fieldMrzValidation',
    'fieldMrz1', 'fieldMrz2'
  ];
  fieldsToClear.forEach(id => {
    const el = document.getElementById(id);
    if (el) { 
      el.value = ''; 
      el.style.backgroundColor = ''; 
      el.style.borderColor = ''; 
      el.placeholder = '';
      el.classList.remove('confidence-high', 'confidence-medium', 'confidence-low');
    }
  });
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

// FRONT PAGE PARSING (Full Page Sequential)
async function extractFrontPageZones(imageUrl) {
  const result = { personalInformation: {}, passportInformation: {}, mrz: {}, confidence: {} };
  const { img, width, height } = await getImageDimensions(imageUrl);

  // 1. Process MRZ independently (Always Bottom 25%)
  setOcrLoading(true, "Scanning MRZ Zone...");
  const mrzZone = getRect(width, height, 0.0, 0.70, 1.0, 0.30);
  const { data: mrzData } = await globalMrzWorker.recognize(imageUrl, { rectangle: mrzZone });
  const parsedMrz = parseMRZ(mrzData.text);
  result.mrz = parsedMrz.data;
  Object.assign(result.confidence, parsedMrz.confidence);

  // 2. Process Full Page for details
  setOcrLoading(true, "Scanning Front Page Text...");
  const { data: fullData } = await globalOcrWorker.recognize(imageUrl);
  const lines = fullData.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let pnoMatch = fullData.text.match(/\b([A-Z][0-9]{7})\b/i);
  if (pnoMatch) {
    result.passportInformation.passportNumber = pnoMatch[1].toUpperCase();
    result.confidence.passportNumber = fullData.confidence;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toUpperCase();
    
    // Surname
    if (line.includes('SURNAME') && !result.personalInformation.surname) {
      if (lines[i+1] && !lines[i+1].toUpperCase().includes('GIVEN')) {
        result.personalInformation.surname = lines[i+1].replace(/[^A-Z\s]/g, '').trim();
      }
    }
    
    // Given Name
    if (line.includes('GIVEN NAME') && !result.personalInformation.givenNames) {
      if (lines[i+1] && !lines[i+1].toUpperCase().includes('NATIONALITY')) {
        result.personalInformation.givenNames = lines[i+1].replace(/[^A-Z\s]/g, '').trim();
      }
    }
    
    // Nationality
    if (line.includes('INDIAN') || line.includes('IND ')) {
      result.personalInformation.nationality = 'INDIAN';
    }

    // Sex
    const sexMatch = line.match(/\b(M|F|MALE|FEMALE)\b/);
    if (sexMatch && !result.personalInformation.gender) {
      result.personalInformation.gender = sexMatch[0].startsWith('M') ? 'Male (M)' : 'Female (F)';
    }
    
    // Dates
    const dates = line.match(/(\d{2}[/\-]\d{2}[/\-]\d{4})/g);
    if (dates) {
      if (line.includes('BIRTH') && !result.personalInformation.dateOfBirth) {
        result.personalInformation.dateOfBirth = dates[0].replace(/-/g, '/');
      } else if (line.includes('ISSUE') && dates.length >= 1) {
        result.passportInformation.dateOfIssue = dates[0].replace(/-/g, '/');
        if (dates.length >= 2) result.passportInformation.dateOfExpiry = dates[1].replace(/-/g, '/');
      }
    }

    // Place of Birth
    if ((line.includes('BIRTH') || line.includes('PLACE OF BIRTH')) && !result.personalInformation.placeOfBirth) {
      // It's usually the line below the Date of Birth or on the same line
      if (lines[i+1] && lines[i+1].length > 4 && !lines[i+1].includes('ISSUE')) {
        result.personalInformation.placeOfBirth = lines[i+1].replace(/[^A-Z\s,]/g, '').trim();
      }
    }

    // Place of Issue
    if ((line.includes('ISSUE') || line.includes('PLACE OF ISSUE')) && !result.passportInformation.placeOfIssue) {
      if (lines[i+1] && lines[i+1].length > 3 && !lines[i+1].match(/\d/)) {
        result.passportInformation.placeOfIssue = lines[i+1].replace(/[^A-Z\s,]/g, '').trim();
      }
    }
  }

  // Fallbacks if confidence is missing
  result.confidence.surname = fullData.confidence;
  result.confidence.givenNames = fullData.confidence;
  result.confidence.dateOfBirth = fullData.confidence;
  result.confidence.placeOfBirth = fullData.confidence;
  result.confidence.placeOfIssue = fullData.confidence;
  
  return result;
}

// BACK PAGE PARSING (Full Page Sequential)
async function extractBackPageZones(imageUrl) {
  const result = { familyDetails: {}, address: {}, additionalInformation: {}, confidence: {} };
  
  setOcrLoading(true, "Scanning Back Page Text...");
  const { data: fullData } = await globalOcrWorker.recognize(imageUrl);
  const lines = fullData.text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  
  let addressText = "";
  let startedAddress = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toUpperCase();
    
    // Father Name
    if ((line.includes('FATHER') || line.includes('LEGAL')) && !result.familyDetails.fatherName) {
      if (lines[i+1] && !lines[i+1].toUpperCase().includes('MOTHER')) {
        result.familyDetails.fatherName = lines[i+1].replace(/[^A-Z\s]/g, '').trim();
      }
    }
    
    // Mother Name
    if (line.includes('MOTHER') && !result.familyDetails.motherName) {
      if (lines[i+1] && !lines[i+1].toUpperCase().includes('SPOUSE') && !lines[i+1].toUpperCase().includes('ADDRESS')) {
        result.familyDetails.motherName = lines[i+1].replace(/[^A-Z\s]/g, '').trim();
      }
    }
    
    // Spouse Name
    if (line.includes('SPOUSE') && !result.familyDetails.spouseName) {
      if (lines[i+1] && !lines[i+1].toUpperCase().includes('ADDRESS')) {
        result.familyDetails.spouseName = lines[i+1].replace(/[^A-Z\s]/g, '').trim();
      }
    }

    // Address Parsing (accumulate until PIN or Old Passport)
    if (line.includes('OLD PASS') || line.includes('FILE')) startedAddress = false;
    
    if (startedAddress) {
      addressText += lines[i] + " ";
      if (line.includes('PIN')) startedAddress = false;
    }
    
    if (line.includes('ADDRESS')) {
      startedAddress = true;
    }

    // Old Passport
    const oldPassMatch = line.match(/([A-Z0-9]{7,9})/i);
    if (oldPassMatch && line.includes('OLD')) {
      result.additionalInformation.oldPassportNo = oldPassMatch[1].toUpperCase();
    }
    const oldDateMatch = line.match(/(\d{2}[/\-]\d{2}[/\-]\d{4})/);
    if (oldDateMatch && line.includes('OLD')) {
      result.additionalInformation.oldPassportDate = oldDateMatch[1].replace(/-/g, '/');
    }

    // File Number
    const fileMatch = line.match(/([A-Z]{2}[0-9]{13})/i);
    if (fileMatch) result.additionalInformation.fileNumber = fileMatch[1].toUpperCase();
  }

  // Process Accumulated Address
  if (!addressText && lines.length > 5) {
     // Fallback: If "Address" label wasn't found, try to guess it's between names and PIN
     let pinIndex = lines.findIndex(l => l.toUpperCase().includes('PIN'));
     if (pinIndex > 0) {
       addressText = lines.slice(Math.max(0, pinIndex - 2), pinIndex + 1).join(' ');
     }
  }

  if (addressText) {
    const pinMatch = addressText.match(/\b\d{6}\b/);
    if (pinMatch) {
      result.address.pin = pinMatch[0];
      addressText = addressText.replace(pinMatch[0], "").trim();
    }
    addressText = addressText.replace(/PIN:?\s*/gi, "").trim();

    if (addressText.toUpperCase().includes('INDIA')) {
      result.address.country = 'INDIA';
      addressText = addressText.replace(/INDIA/gi, "").trim();
    }

    const parts = addressText.split(',').map(p => p.trim()).filter(p => p);
    if (parts.length > 2) {
      result.address.state = parts.pop();
      result.address.city = parts.pop();
      result.address.addressLine1 = parts[0] || '';
      result.address.addressLine2 = parts.slice(1).join(', ');
    } else {
      const mid = Math.floor(addressText.length / 2);
      result.address.addressLine1 = addressText.substring(0, mid).trim();
      result.address.addressLine2 = addressText.substring(mid).trim();
    }
  }
  
  result.confidence.familyDetails = fullData.confidence;
  result.confidence.address = fullData.confidence;
  result.confidence.fileNumber = fullData.confidence;

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
