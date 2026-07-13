/**
 * ocr.js
 * Production-ready client-side OCR pipeline using Tesseract.js
 * Extracts text from passport front (MRZ) and back (Address, Parents) pages.
 */

// Show/Hide OCR Loading UI
function setOcrLoading(show, message = "Analyzing Document...") {
  const overlay = document.getElementById('ocrLoadingOverlay');
  const status = document.getElementById('ocrLoadingStatus');
  if (overlay && status) {
    overlay.style.display = show ? 'flex' : 'none';
    status.textContent = message;
  }
}

// -------------------------------------------------------------
// MAIN ENTRY POINT
// -------------------------------------------------------------
async function startDocumentOCR(frontDataUrl, backDataUrl) {
  try {
    setOcrLoading(true, "Initializing OCR Engine...");

    let frontResult = {};
    let backResult = {};

    // Process Front Page
    if (frontDataUrl) {
      setOcrLoading(true, "Scanning Front Page (MRZ)...");
      frontResult = await extractFrontPage(frontDataUrl);
    }

    // Process Back Page
    if (backDataUrl) {
      setOcrLoading(true, "Scanning Back Page (Details)...");
      backResult = await extractBackPage(backDataUrl);
    }

    // Combine results
    const finalData = { ...frontResult, ...backResult };

    setOcrLoading(true, "Populating Verification Form...");
    populateForm(finalData);

  } catch (error) {
    console.error("OCR Error:", error);
    alert("Failed to process document: " + error.message);
  } finally {
    setOcrLoading(false);
    // Proceed to success screen automatically if we are in scanner logic
    if (typeof updateSuccessScreenState === 'function') {
      updateSuccessScreenState();
      showSuccessScreen();
    }
  }
}

// -------------------------------------------------------------
// FRONT PAGE (MRZ EXTRACTION)
// -------------------------------------------------------------
async function extractFrontPage(imageUrl) {
  // We crop the bottom 33% of the image to speed up Tesseract and improve MRZ accuracy
  const mrzImage = await cropBottomThird(imageUrl);
  
  const worker = await Tesseract.createWorker('eng');
  // Optimize for MRZ characters
  await worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
  });

  const { data: { text } } = await worker.recognize(mrzImage);
  await worker.terminate();

  console.log("Raw MRZ Text:\n", text);
  return parseMRZ(text);
}

// -------------------------------------------------------------
// BACK PAGE (ADDRESS & PARENTS)
// -------------------------------------------------------------
async function extractBackPage(imageUrl) {
  const worker = await Tesseract.createWorker('eng');
  
  // Back page needs standard english
  const { data: { text } } = await worker.recognize(imageUrl);
  await worker.terminate();

  console.log("Raw Back Page Text:\n", text);
  
  // Basic Regex/Keyword mapping for the back page
  const result = {
    fatherName: extractByRegex(text, /(?:Father|Legal Guardian).*?\n([A-Z\s]+)/i) || extractByRegex(text, /Father.*Name[^\n]*\n([A-Z\s]+)/i),
    motherName: extractByRegex(text, /(?:Mother).*?\n([A-Z\s]+)/i) || extractByRegex(text, /Mother.*Name[^\n]*\n([A-Z\s]+)/i),
    spouseName: extractByRegex(text, /(?:Spouse).*?\n([A-Z\s]+)/i),
    fileNo: extractByRegex(text, /([A-Z0-9]{15})/i) || extractByRegex(text, /([A-Z]{2}[0-9]{13})/i),
    pin: extractByRegex(text, /PIN[:\s]*(\d{6})/i),
    address: extractAddress(text)
  };
  
  return result;
}

// -------------------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------------------
function extractByRegex(text, regex) {
  const match = text.match(regex);
  return match && match[1] ? match[1].trim().replace(/\s+/g, ' ') : '';
}

function extractAddress(text) {
  // Simple heuristic for Indian passport back page address
  // Usually starts after spouse/mother name and ends with PIN
  const addressMatch = text.match(/(?:Address|Old Address)[^\n]*\n([\s\S]*?PIN.*?)\n/i);
  if (addressMatch) {
    let cleanAddress = addressMatch[1].replace(/\n/g, ', ').replace(/\s+/g, ' ');
    return cleanAddress.trim();
  }
  return '';
}

function cropBottomThird(imageUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      // Take bottom 35% of the image height
      const cropHeight = Math.floor(img.height * 0.35);
      const cropY = img.height - cropHeight;
      
      canvas.width = img.width;
      canvas.height = cropHeight;
      
      ctx.drawImage(img, 0, cropY, img.width, cropHeight, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg'));
    };
    img.src = imageUrl;
  });
}

// -------------------------------------------------------------
// MRZ PARSER ENGINE
// -------------------------------------------------------------
function parseMRZ(rawText) {
  const lines = rawText.split('\n').map(l => l.replace(/\s/g, '').trim()).filter(l => l.length >= 44);
  
  if (lines.length < 2) {
    console.warn("Failed to detect 2 MRZ lines.");
    return { mrz1: lines[0] || '', mrz2: lines[1] || '' };
  }

  const line1 = lines[lines.length - 2].toUpperCase();
  const line2 = lines[lines.length - 1].toUpperCase();

  const result = {
    mrz1: line1,
    mrz2: line2,
  };

  // Indian/TD3 MRZ Format:
  // Line 1: P<INDLASTNAME<<FIRSTNAME<<<<<<<<
  // Line 2: PASSPORTNO<CHK NAT YYMMDD CHK M/F YYMMDD CHK ...
  
  if (line1.startsWith('P')) {
    result.countryCode = line1.substring(2, 5).replace(/</g, '');
    
    // Parse Names
    const nameStr = line1.substring(5);
    const nameParts = nameStr.split('<<');
    if (nameParts.length > 0) {
      result.surname = nameParts[0].replace(/</g, ' ').trim();
    }
    if (nameParts.length > 1) {
      result.givenNames = nameParts[1].replace(/</g, ' ').trim();
    }
    
    // Parse Line 2
    result.passportNo = line2.substring(0, 9).replace(/</g, '');
    result.nationality = line2.substring(10, 13).replace(/</g, '');
    
    // DOB: YYMMDD
    const dobRaw = line2.substring(13, 19);
    result.dob = formatMRZDate(dobRaw);
    
    // Gender
    result.gender = line2.substring(20, 21) === 'M' ? 'Male (M)' : (line2.substring(20, 21) === 'F' ? 'Female (F)' : line2.substring(20, 21));
    
    // Expiry: YYMMDD
    const expRaw = line2.substring(21, 27);
    result.expiryDate = formatMRZDate(expRaw, true);
  }

  return result;
}

function formatMRZDate(yymmdd, isExpiry = false) {
  if (!yymmdd || yymmdd.length !== 6 || yymmdd.includes('<')) return '';
  const yy = parseInt(yymmdd.substring(0, 2), 10);
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);
  
  const currentYear = new Date().getFullYear() % 100;
  
  let fullYear;
  if (isExpiry) {
    fullYear = 2000 + yy;
  } else {
    // DOB: If YY > current year, it's 1900s, else 2000s
    fullYear = yy > currentYear ? 1900 + yy : 2000 + yy;
  }
  
  return `${dd}/${mm}/${fullYear}`;
}

// -------------------------------------------------------------
// FORM POPULATION
// -------------------------------------------------------------
function populateForm(data) {
  // Safely sets value if field exists
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined) {
      el.value = val;
    }
  };

  // Clear everything first (as requested: "Remove all hardcoded values")
  const fieldsToClear = [
    'fieldSurname', 'fieldGivenNames', 'fieldDob', 'fieldGender', 'fieldNationality', 'fieldPlaceOfBirth',
    'fieldPassportNo', 'fieldCountryCode', 'fieldIssueDate', 'fieldExpiryDate', 'fieldPlaceOfIssue',
    'fieldFatherName', 'fieldMotherName', 'fieldSpouseName', 'fieldFileNo', 'fieldAddress', 'fieldCity',
    'fieldState', 'fieldPin', 'fieldCountry', 'fieldMrz1', 'fieldMrz2'
  ];
  fieldsToClear.forEach(id => setVal(id, ''));

  // Set Extracted Values
  setVal('fieldSurname', data.surname);
  setVal('fieldGivenNames', data.givenNames);
  setVal('fieldDob', data.dob);
  setVal('fieldGender', data.gender);
  setVal('fieldNationality', data.nationality);
  setVal('fieldPassportNo', data.passportNo);
  setVal('fieldCountryCode', data.countryCode);
  setVal('fieldExpiryDate', data.expiryDate);
  setVal('fieldMrz1', data.mrz1);
  setVal('fieldMrz2', data.mrz2);
  
  // Back page details
  setVal('fieldFatherName', data.fatherName);
  setVal('fieldMotherName', data.motherName);
  setVal('fieldSpouseName', data.spouseName);
  setVal('fieldFileNo', data.fileNo);
  setVal('fieldPin', data.pin);
  setVal('fieldAddress', data.address);
}
