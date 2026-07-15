const Tesseract = require('tesseract.js');

const imgPathFront = 'C:\\\\Users\\\\APPLE\\\\.gemini\\\\antigravity-ide\\\\brain\\\\028ea1d6-714a-420c-b670-410303517887\\\\media__1784094756062.jpg';
const imgPathBack = 'C:\\\\Users\\\\APPLE\\\\.gemini\\\\antigravity-ide\\\\brain\\\\028ea1d6-714a-420c-b670-410303517887\\\\media__1784094756127.jpg';

async function run() {
  console.log('--- STARTING FRONT PAGE OCR ---');
  const worker1 = await Tesseract.createWorker('eng');
  const { data: { text: text1 } } = await worker1.recognize(imgPathFront);
  console.log(text1);
  await worker1.terminate();

  console.log('\\n--- STARTING BACK PAGE OCR ---');
  const worker2 = await Tesseract.createWorker('eng');
  const { data: { text: text2 } } = await worker2.recognize(imgPathBack);
  console.log(text2);
  await worker2.terminate();
}

run();
