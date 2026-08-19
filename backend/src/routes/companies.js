import express from 'express';
import { query } from '../db/index.js';

const router = express.Router();

// GET /api/companies/:id
router.get('/:id', async (req, res) => {
  const result = await query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ company: result.rows[0] });
});

// POST /api/companies — create / save company profile
router.post('/', async (req, res) => {
  const { name, registration_number, address, contact_email, contact_phone, expertise } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const result = await query(
    `INSERT INTO companies (name, registration_number, address, contact_email, contact_phone, expertise)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, registration_number, address, contact_email, contact_phone, expertise || []]
  );
  res.json({ company: result.rows[0] });
});

// PATCH /api/companies/:id
router.patch('/:id', async (req, res) => {
  const { name, registration_number, address, contact_email, contact_phone, expertise } = req.body;
  const result = await query(
    `UPDATE companies SET name=COALESCE($1,name), registration_number=COALESCE($2,registration_number),
     address=COALESCE($3,address), contact_email=COALESCE($4,contact_email),
     contact_phone=COALESCE($5,contact_phone), expertise=COALESCE($6,expertise)
     WHERE id=$7 RETURNING *`,
    [name, registration_number, address, contact_email, contact_phone, expertise, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ company: result.rows[0] });
});

export default router;
