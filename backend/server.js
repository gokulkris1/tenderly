import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDB } from './src/db/index.js';
import tendersRouter from './src/routes/tenders.js';
import bidsRouter from './src/routes/bids.js';
import companiesRouter from './src/routes/companies.js';
import { errorHandler } from './src/middleware/errorHandler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Routes
app.use('/api/tenders', tendersRouter);
app.use('/api/bids', bidsRouter);
app.use('/api/companies', companiesRouter);

// Error handler
app.use(errorHandler);

async function start() {
  try {
    if (process.env.DATABASE_URL) {
      await initDB();
    } else {
      console.warn('DATABASE_URL not set — DB features disabled');
    }
    app.listen(PORT, () => console.log(`Tenderly API running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
