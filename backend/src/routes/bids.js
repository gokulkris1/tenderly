import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { rateLimit } from 'express-rate-limit';
import { query } from '../db/index.js';
import { generateBidZip } from '../services/bidBuilder.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/tenderly-uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt'];
const ALLOWED_MIMETYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext) && ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, DOCX, and TXT files are allowed'));
    }
  },
});

const zipRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many ZIP generation requests. Please try again later.' },
});

const router = express.Router();

// POST /api/bids — create a new bid submission
router.post('/', async (req, res) => {
  const { tender_id, company_id, form_data } = req.body;
  if (!tender_id) return res.status(400).json({ error: 'tender_id is required' });

  const result = await query(
    `INSERT INTO bid_submissions (tender_id, company_id, form_data, status)
     VALUES ($1, $2, $3, 'draft') RETURNING *`,
    [tender_id, company_id || null, JSON.stringify(form_data || {})]
  );
  res.json({ bid: result.rows[0] });
});

// GET /api/bids/:id
router.get('/:id', async (req, res) => {
  const result = await query('SELECT * FROM bid_submissions WHERE id = $1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ bid: result.rows[0] });
});

// PATCH /api/bids/:id — update form data / questions
router.patch('/:id', async (req, res) => {
  const { form_data, questions_responses, status } = req.body;
  const fields = [];
  const values = [];
  let idx = 1;

  if (form_data !== undefined) { fields.push(`form_data = $${idx++}`); values.push(JSON.stringify(form_data)); }
  if (questions_responses !== undefined) { fields.push(`questions_responses = $${idx++}`); values.push(JSON.stringify(questions_responses)); }
  if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
  fields.push(`updated_at = NOW()`);
  values.push(req.params.id);

  const result = await query(
    `UPDATE bid_submissions SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ bid: result.rows[0] });
});

// POST /api/bids/:id/upload-cv — upload CV files
router.post('/:id/upload-cv', upload.array('cvs', 10), async (req, res) => {
  const bidCheck = await query('SELECT id FROM bid_submissions WHERE id = $1', [req.params.id]);
  if (!bidCheck.rows.length) return res.status(404).json({ error: 'Bid not found' });

  const uploaded = [];
  for (const file of req.files || []) {
    const ins = await query(
      `INSERT INTO uploaded_files (bid_id, filename, original_name, file_type, file_size, storage_path)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, file.filename, file.originalname, file.mimetype, file.size, file.path]
    );
    uploaded.push(ins.rows[0]);
  }

  // Update bid's uploaded_cvs
  const fileRecords = uploaded.map((f) => ({ id: f.id, name: f.original_name, path: f.storage_path }));
  await query(
    `UPDATE bid_submissions SET uploaded_cvs = uploaded_cvs || $1::jsonb WHERE id = $2`,
    [JSON.stringify(fileRecords), req.params.id]
  );

  res.json({ uploaded });
});

// POST /api/bids/:id/generate-zip — generate final bid ZIP
router.post('/:id/generate-zip', zipRateLimiter, async (req, res) => {
  const bidResult = await query('SELECT * FROM bid_submissions WHERE id = $1', [req.params.id]);
  if (!bidResult.rows.length) return res.status(404).json({ error: 'Bid not found' });

  const bid = bidResult.rows[0];
  const tenderResult = await query('SELECT * FROM tenders WHERE id = $1', [bid.tender_id]);
  if (!tenderResult.rows.length) return res.status(404).json({ error: 'Tender not found' });

  const tender = tenderResult.rows[0];
  const company = bid.company_id
    ? (await query('SELECT * FROM companies WHERE id = $1', [bid.company_id])).rows[0]
    : null;

  const cvFiles = (bid.uploaded_cvs || []).map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean);

  try {
    const zipPath = await generateBidZip({ tender, bidSubmission: bid, company, cvPaths: cvFiles });

    // Update DB with zip path
    await query('UPDATE bid_submissions SET zip_path=$1, status=$2 WHERE id=$3', [zipPath, 'completed', bid.id]);

    res.download(zipPath, path.basename(zipPath), (err) => {
      if (err) console.error('Download error:', err);
    });
  } catch (err) {
    console.error('ZIP generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
