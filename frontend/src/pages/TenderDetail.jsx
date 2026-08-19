import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { getTender, generateSynopsis, fetchTenderFromUrl, createBid } from '../utils/api';
import SynopsisDeck from '../components/synopsis/SynopsisDeck';
import { useApp } from '../context/AppContext';

export default function TenderDetail() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { company, setCurrentTender, setSynopsis, setCurrentBid } = useApp();

  const [tender, setTender] = useState(null);
  const [loading, setLoading] = useState(true);
  const [synopsisData, setSynopsisData] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [view, setView] = useState('detail'); // 'detail' | 'synopsis'
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        if (id && id !== 'new') {
          const res = await getTender(id);
          setTender(res.data.tender);
          setCurrentTender(res.data.tender);
        } else if (location.state?.tenderData) {
          // Fetch & save
          const t = location.state.tenderData;
          if (t.source_url) {
            const res = await fetchTenderFromUrl(t.source_url);
            setTender(res.data.tender);
            setCurrentTender(res.data.tender);
            navigate(`/tender/${res.data.tender.id}`, { replace: true });
          } else {
            setTender(t);
          }
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleGenerateSynopsis() {
    if (!tender?.id) return;
    setGenerating(true);
    try {
      const bidderProfile = company
        ? { name: company.name, expertise: company.expertise, annual_turnover: company.annual_turnover }
        : null;
      const res = await generateSynopsis(tender.id, bidderProfile);
      setSynopsisData(res.data);
      setSynopsis(res.data);
      setView('synopsis');
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleProceed() {
    if (!tender?.id) return;
    try {
      const bidRes = await createBid({
        tender_id: tender.id,
        company_id: company?.id || null,
        form_data: {
          company_name: company?.name || '',
          contact_email: company?.contact_email || '',
          competencies: (company?.expertise || []).join(', '),
        },
      });
      setCurrentBid(bidRes.data.bid);
      navigate(`/bid/${bidRes.data.bid.id}`);
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <div className="page-loading">⏳ Loading tender...</div>;
  if (error) return <div className="page-error">❌ {error}</div>;
  if (!tender) return <div className="page-error">Tender not found.</div>;

  const deadline = tender.deadline ? new Date(tender.deadline) : null;
  const daysLeft = deadline ? Math.ceil((deadline - Date.now()) / 86400000) : null;

  return (
    <div className="tender-detail-page">
      {view === 'detail' && (
        <>
          <button className="btn btn-ghost back-btn" onClick={() => navigate('/discover')}>
            ← Back to Discover
          </button>

          <div className="tender-detail-header">
            <h1>{tender.title}</h1>
            {tender.framework_agreement && (
              <span className="badge badge-framework badge-lg">🔗 Framework Agreement</span>
            )}
          </div>

          <div className="tender-meta-grid">
            <div className="meta-card">
              <label>Authority</label>
              <p>{tender.contracting_authority || 'Not specified'}</p>
            </div>
            <div className="meta-card">
              <label>Reference</label>
              <p>{tender.reference_number || 'N/A'}</p>
            </div>
            <div className="meta-card">
              <label>Category</label>
              <p>{tender.category || 'General'}</p>
            </div>
            <div className="meta-card">
              <label>Estimated Value</label>
              <p>{tender.estimated_value ? `€${Number(tender.estimated_value).toLocaleString()}` : 'Not disclosed'}</p>
            </div>
            <div className="meta-card">
              <label>Deadline</label>
              <p>
                {deadline ? deadline.toLocaleDateString('en-IE') : 'Check tender'}
                {daysLeft !== null && (
                  <span className={`days-badge ${daysLeft <= 0 ? 'expired' : daysLeft <= 7 ? 'urgent' : 'ok'}`}>
                    {daysLeft <= 0 ? ' (Expired)' : ` (${daysLeft} days left)`}
                  </span>
                )}
              </p>
            </div>
            {tender.source_url && (
              <div className="meta-card">
                <label>Source</label>
                <p><a href={tender.source_url} target="_blank" rel="noreferrer">View on eTenders.ie ↗</a></p>
              </div>
            )}
          </div>

          {tender.description && (
            <div className="tender-description">
              <h2>Description</h2>
              <p>{tender.description}</p>
            </div>
          )}

          <div className="tender-actions">
            <button
              className="btn btn-primary btn-large"
              onClick={handleGenerateSynopsis}
              disabled={generating}
            >
              {generating ? '⏳ Generating Synopsis...' : '📊 Generate Synopsis Deck'}
            </button>
          </div>
        </>
      )}

      {view === 'synopsis' && synopsisData && (
        <>
          <h2>📊 Synopsis Deck</h2>
          <SynopsisDeck
            slides={synopsisData.slides}
            eligibility={synopsisData.eligibility_result}
            onProceed={handleProceed}
            onBack={() => setView('detail')}
          />
        </>
      )}
    </div>
  );
}
