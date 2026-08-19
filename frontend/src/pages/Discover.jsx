import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTenders } from '../utils/api';
import TenderCard from '../components/tender/TenderCard';
import TenderFetcher from '../components/tender/TenderFetcher';
import { useApp } from '../context/AppContext';

export default function Discover() {
  const navigate = useNavigate();
  const { setCurrentTender } = useApp();
  const [keyword, setKeyword] = useState('');
  const [tenders, setTenders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('search'); // 'search' | 'url'

  async function searchTenders() {
    setLoading(true);
    try {
      const res = await getTenders({ keyword, source: 'etenders' });
      setTenders(res.data.tenders || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    searchTenders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleTenderSelect(tender) {
    setCurrentTender(tender);
    if (tender.id) {
      navigate(`/tender/${tender.id}`);
    } else if (tender.source_url) {
      // Need to fetch full details first
      navigate('/tender/new', { state: { tenderData: tender } });
    }
  }

  function handleFetched(tender) {
    setCurrentTender(tender);
    navigate(`/tender/${tender.id}`);
  }

  return (
    <div className="discover-page">
      <h1>🔍 Discover Tenders</h1>

      <div className="tab-bar">
        <button className={`tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>
          🔎 Search eTenders.ie
        </button>
        <button className={`tab ${tab === 'url' ? 'active' : ''}`} onClick={() => setTab('url')}>
          🔗 Import from URL
        </button>
      </div>

      {tab === 'search' && (
        <div className="search-panel">
          <div className="search-bar">
            <input
              type="text"
              placeholder="Search tenders... (e.g. IT consulting, cloud, construction)"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchTenders()}
              className="search-input"
            />
            <button className="btn btn-primary" onClick={searchTenders} disabled={loading}>
              {loading ? '⏳' : '🔍 Search'}
            </button>
          </div>

          {loading && <p className="loading-msg">⏳ Fetching tenders from eTenders.ie...</p>}

          {!loading && tenders.length === 0 && (
            <div className="empty-state">
              <p>No results found. Try a different keyword or import a tender by URL.</p>
              <p className="hint">Note: Live data requires a working connection to eTenders.ie.</p>
            </div>
          )}

          <div className="tender-grid">
            {tenders.map((t, i) => (
              <TenderCard key={t.id || i} tender={t} onClick={handleTenderSelect} />
            ))}
          </div>
        </div>
      )}

      {tab === 'url' && (
        <div className="url-panel">
          <TenderFetcher onFetched={handleFetched} />
        </div>
      )}
    </div>
  );
}
