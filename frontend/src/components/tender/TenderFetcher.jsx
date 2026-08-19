import { useState } from 'react';
import { fetchTenderFromUrl } from '../../utils/api';

export default function TenderFetcher({ onFetched }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleFetch(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetchTenderFromUrl(url.trim());
      onFetched && onFetched(res.data.tender);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="tender-fetcher">
      <h2>📥 Import a Tender</h2>
      <p className="hint">Paste an eTenders.ie notice URL or any procurement portal link</p>
      <form onSubmit={handleFetch} className="fetcher-form">
        <input
          type="url"
          placeholder="https://www.etenders.gov.ie/epps/cft/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="url-input"
          required
        />
        <button type="submit" disabled={loading} className="btn btn-primary">
          {loading ? '⏳ Fetching...' : '🔍 Fetch Tender'}
        </button>
      </form>
      {error && <p className="error-msg">❌ {error}</p>}
    </div>
  );
}
