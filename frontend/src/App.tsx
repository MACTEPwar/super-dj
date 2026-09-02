import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from './hooks/useAuth';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppShell } from './components/AppShell';
import Login from './pages/Login';
import Register from './pages/Register';
import Library from './pages/Library';
import Playlists from './pages/Playlists';
import PlaylistEditor from './pages/PlaylistEditor';
import Destinations from './pages/Destinations';
import Streams from './pages/Streams';
import StreamSessionPanel from './pages/StreamSessionPanel';

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Toaster richColors position="top-right" />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<AppShell />}>
                <Route path="/" element={<Navigate to="/library" replace />} />
                <Route path="/library" element={<Library />} />
                <Route path="/playlists" element={<Playlists />} />
                <Route path="/playlists/:id" element={<PlaylistEditor />} />
                <Route path="/destinations" element={<Destinations />} />
                <Route path="/streams" element={<Streams />} />
                <Route path="/streams/:id" element={<StreamSessionPanel />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
