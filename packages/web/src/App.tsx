import { useEffect } from 'react';
import { useStore, loadAuthFromStorage } from './store';
import LoginPage from './pages/Login';
import ChatPage from './pages/Chat';
import './index.css';

export default function App() {
  const { user } = useStore();

  useEffect(() => {
    loadAuthFromStorage();
  }, []);

  return user ? <ChatPage /> : <LoginPage />;
}
