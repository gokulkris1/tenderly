import { createContext, useContext, useState } from 'react';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [company, setCompany] = useState(null);
  const [currentTender, setCurrentTender] = useState(null);
  const [currentBid, setCurrentBid] = useState(null);
  const [synopsis, setSynopsis] = useState(null);

  return (
    <AppContext.Provider value={{
      company, setCompany,
      currentTender, setCurrentTender,
      currentBid, setCurrentBid,
      synopsis, setSynopsis,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}
