export default function TenderCard({ tender, onClick }) {
  const deadline = tender.deadline
    ? new Date(tender.deadline)
    : null;
  const daysLeft = deadline
    ? Math.ceil((deadline - Date.now()) / 86400000)
    : null;

  const urgency =
    daysLeft === null ? 'neutral'
    : daysLeft <= 0 ? 'expired'
    : daysLeft <= 7 ? 'urgent'
    : daysLeft <= 14 ? 'soon'
    : 'ok';

  return (
    <div className={`tender-card ${urgency}`} onClick={() => onClick && onClick(tender)}>
      <div className="tender-card-header">
        <h3 className="tender-title">{tender.title}</h3>
        {tender.framework_agreement && (
          <span className="badge badge-framework">Framework</span>
        )}
      </div>
      <div className="tender-card-meta">
        <span>🏛️ {tender.contracting_authority || 'Unknown authority'}</span>
        {tender.reference_number && <span>📄 {tender.reference_number}</span>}
        {tender.category && <span>🏷️ {tender.category}</span>}
      </div>
      <div className="tender-card-footer">
        {tender.estimated_value && (
          <span className="value-badge">
            💶 €{Number(tender.estimated_value).toLocaleString()}
          </span>
        )}
        {deadline && (
          <span className={`deadline-badge deadline-${urgency}`}>
            ⏰ {urgency === 'expired' ? 'Expired' : `${daysLeft}d left`} —{' '}
            {deadline.toLocaleDateString('en-IE')}
          </span>
        )}
        {!deadline && tender.deadline_text && (
          <span className="deadline-badge deadline-neutral">⏰ {tender.deadline_text}</span>
        )}
      </div>
    </div>
  );
}
