import Navbar from './Navbar';

export default function Layout({ children }) {
  return (
    <div className="layout">
      <Navbar />
      <main className="main-content">{children}</main>
      <footer className="footer">
        <p>© 2025 Tenderly — Built for Irish public procurement · <a href="https://www.etenders.gov.ie" target="_blank" rel="noreferrer">eTenders.ie</a></p>
      </footer>
    </div>
  );
}
