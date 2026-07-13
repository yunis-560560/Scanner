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
  setOcrLoading(true, "Scanning Front Page (VIZ)...");
  
  // PASS 1: VIZ (Full Image without whitelist)
  const workerViz = await Tesseract.createWorker('eng');
  const { data: { text: vizText } } = await workerViz.recognize(imageUrl);
  await workerViz.terminate();
  console.log("Raw VIZ Text:\n", vizText);

  const vizData = parseVIZ(vizText);

  setOcrLoading(true, "Scanning Front Page (MRZ)...");

  // PASS 2: MRZ (Cropped bottom with whitelist)
  const mrzImage = await cropBottomThird(imageUrl);
  const workerMrz = await Tesseract.createWorker('eng');
  await workerMrz.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
  });
  const { data: { text: mrzText } } = await workerMrz.recognize(mrzImage);
  await workerMrz.terminate();
  
  console.log("Raw MRZ Text:\n", mrzText);
  const mrzData = parseMRZ(mrzText);

  return { ...mrzData, ...vizData };
}

// -------------------------------------------------------------
// VIZ PARSER ENGINE
// -------------------------------------------------------------
function parseVIZ(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const result = {};

  for (let i = 0; i < lines.length; i++) {
    const upperLine = lines[i].toUpperCase();

    // Place of Birth
    if ((upperLine.includes('PLACE OF BIRTH') || upperLine.includes('BIRTH')) && !result.placeOfBirth) {
      const match = upperLine.match(/PLACE OF BIRTH[:\s]*(.*)/i);
      if (match && match[1].trim().length > 3) {
        result.placeOfBirth = match[1].trim();
      } else if (lines[i+1]) {
        result.placeOfBirth = lines[i+1].trim();
      }
    }

    // Place of Issue
    if ((upperLine.includes('PLACE OF ISSUE') || upperLine.includes('ISSUE')) && !upperLine.includes('DATE') && !result.placeOfIssue) {
      const match = upperLine.match(/PLACE OF ISSUE[:\s]*(.*)/i);
      if (match && match[1].trim().length > 3) {
        result.placeOfIssue = match[1].trim();
      } else if (lines[i+1]) {
        result.placeOfIssue = lines[i+1].trim();
      }
    }

    // Date of Issue
    if (upperLine.includes('DATE OF ISSUE') || upperLine.includes('ISSUE DATE')) {
       const dateMatch = upperLine.match(/(\d{2}[/\-]\d{2}[/\-]\d{4})/);
       if (dateMatch) {
         result.issueDate = dateMatch[1];
       } else if (lines[i+1]) {
         const nextDateMatch = lines[i+1].match(/(\d{2}[/\-]\d{2}[/\-]\d{4})/);
         if (nextDateMatch) result.issueDate = nextDateMatch[1];
       }
    }
  }

  return result;
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
  
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  const result = {
    fatherName: '',
    motherName: '',
    spouseName: '',
    fileNo: '',
    pin: '',
    address: ''
  };

  // Extract by line matching
  for (let i = 0; i < lines.length; i++) {
    const upperLine = lines[i].toUpperCase();
    
    if ((upperLine.includes('FATHER') || upperLine.includes('LEGAL GUARDIAN')) && !result.fatherName) {
      result.fatherName = lines[i+1] ? lines[i+1].trim() : '';
    }
    if (upperLine.includes('MOTHER') && !result.motherName) {
      result.motherName = lines[i+1] ? lines[i+1].trim() : '';
    }
    if (upperLine.includes('SPOUSE') && !result.spouseName) {
      result.spouseName = lines[i+1] ? lines[i+1].trim() : '';
    }
    if (upperLine.includes('PIN') || upperLine.includes('P I N')) {
      const pinMatch = upperLine.match(/(\d{6})/);
      if (pinMatch) result.pin = pinMatch[1];
    }
    // File number usually at the end or starts with two letters and 13 digits
    const fileMatch = upperLine.match(/([A-Z]{2}[0-9]{13})/i);
    if (fileMatch) result.fileNo = fileMatch[1].toUpperCase();
  }

  // Address extraction heuristic
  const addressMatch = text.match(/(?:Address|Old Address)[^\n]*\n([\s\S]*?PIN.*?)\n/i);
  if (addressMatch) {
    result.address = addressMatch[1].replace(/\n/g, ', ').replace(/\s+/g, ' ').trim();
  } else {
    // Just try to grab lines after Spouse or Mother until PIN
    let startIndex = -1;
    let endIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toUpperCase().includes('ADDRESS')) startIndex = i + 1;
      if (lines[i].toUpperCase().includes('PIN')) endIndex = i;
    }
    if (startIndex > -1 && endIndex >= startIndex) {
       result.address = lines.slice(startIndex, endIndex + 1).join(', ');
    }
  }
  
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
      // Take bottom 25% of the image height to focus strictly on MRZ
      const cropHeight = Math.floor(img.height * 0.25);
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
function sanitizeMRZ(rawText) {
  let lines = rawText.split('\n').map(l => l.replace(/\s/g, '').trim()).filter(l => l.length >= 30);
  
  return lines.map(line => {
    let cleaned = line.toUpperCase();
    
    // Force start of Line 1 to P<IND for Indian Passports
    if (cleaned.startsWith('P') && cleaned.length > 5) {
       cleaned = 'P<IND' + cleaned.substring(5);
    }
    
    // Replace contiguous L, K, or E blocks with < (e.g. LLLLLLKKLK -> <<<<<<<<<<)
    cleaned = cleaned.replace(/[LKE]{2,}/g, match => '<'.repeat(match.length));
    
    // Replace trailing noise
    cleaned = cleaned.replace(/[LKE\.]+$/g, match => '<'.repeat(match.length));
    
    // Fix length exactly to 44
    if (cleaned.length < 44) cleaned = cleaned.padEnd(44, '<');
    if (cleaned.length > 44) cleaned = cleaned.substring(0, 44);
    
    return cleaned;
  });
}

function parseMRZ(rawText) {
  const lines = sanitizeMRZ(rawText);
  
  if (lines.length < 2) {
    console.warn("Failed to detect 2 MRZ lines.");
    return { mrz1: lines[0] || '', mrz2: lines[1] || '' };
  }

  const line1 = lines[lines.length - 2];
  const line2 = lines[lines.length - 1];

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
  setVal('fieldPlaceOfBirth', data.placeOfBirth);
  setVal('fieldIssueDate', data.issueDate);
  setVal('fieldPlaceOfIssue', data.placeOfIssue);
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
