import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getBid, getTender, generateZip } from '../utils/api';
import BidForm from '../components/bid/BidForm';
import { useApp } from '../context/AppContext';

export default function BidBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { company } = useApp();

  const [bid, setBid] = useState(null);
  const [tender, setTender] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const bidRes = await getBid(id);
        const b = bidRes.data.bid;
        setBid(b);
        const tenderRes = await getTender(b.tender_id);
        setTender(tenderRes.data.tender);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  async function handleGenerateZip() {
    setGenerating(true);
    try {
      const res = await generateZip(id);
      const blob = new Blob([res.data], { type: 'application/zip' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bid-${id.substring(0, 8)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return <div className="page-loading">⏳ Loading bid...</div>;
  if (error) return <div className="page-error">❌ {error}</div>;
  if (!bid || !tender) return <div className="page-error">Bid or tender not found.</div>;

  return (
    <div className="bid-builder-page">
      <button className="btn btn-ghost back-btn" onClick={() => navigate(`/tender/${tender.id}`)}>
        ← Back to Tender
      </button>

      <div className="bid-builder-header">
        <h1>📝 Bid Builder</h1>
        <div className="tender-ref-label">
          <span>📋 {tender.title}</span>
          {tender.deadline && (
            <span className="deadline-chip">
              ⏰ Deadline: {new Date(tender.deadline).toLocaleDateString('en-IE')}
            </span>
          )}
        </div>
      </div>

      <BidForm
        bid={bid}
        tender={tender}
        company={company}
        onComplete={() => setDone(true)}
      />

      <div className="generate-section">
        <h2>🎁 Generate Bid Document Package</h2>
        <p>
          When you&apos;re happy with your bid details, click below to generate a complete ZIP
          file containing all required documents — ready to submit on eTenders.ie.
        </p>
        {done && (
          <div className="success-banner">
            ✅ Your bid ZIP has been downloaded! Check your downloads folder.
          </div>
        )}
        {error && <p className="error-msg">❌ {error}</p>}
        <button
          className="btn btn-success btn-large"
          onClick={handleGenerateZip}
          disabled={generating}
        >
          {generating ? '⏳ Generating ZIP...' : '📦 Download Bid ZIP'}
        </button>
      </div>
    </div>
  );
}
