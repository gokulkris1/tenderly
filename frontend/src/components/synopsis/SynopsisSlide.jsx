export default function SynopsisSlide({ slide, index, total }) {
  const icons = { overview: '📋', eligibility: '✅', action: '🚀' };

  return (
    <div className={`synopsis-slide slide-${slide.type}`}>
      <div className="slide-counter">{index + 1} / {total}</div>
      <div className="slide-icon">{icons[slide.type] || '📄'}</div>
      <h2 className="slide-title">{slide.title}</h2>
      {slide.highlight && (
        <div className="slide-highlight">{slide.highlight}</div>
      )}
      <ul className="slide-bullets">
        {(slide.bullets || []).map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
    </div>
  );
}
