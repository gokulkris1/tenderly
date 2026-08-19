import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import Layout from './components/layout/Layout';
import Home from './pages/Home';
import Discover from './pages/Discover';
import TenderDetail from './pages/TenderDetail';
import BidBuilder from './pages/BidBuilder';
import CompanyProfile from './pages/CompanyProfile';
import './App.css';

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/discover" element={<Discover />} />
            <Route path="/tender/:id" element={<TenderDetail />} />
            <Route path="/bid/:id" element={<BidBuilder />} />
            <Route path="/profile" element={<CompanyProfile />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AppProvider>
  );
}
